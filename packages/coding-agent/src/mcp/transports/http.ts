import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger, readSseEvents, readSseJson } from "@oh-my-pi/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { sanitizeMCPDiagnostic } from "../errors";
import { RequestIdAllocator } from "../request-id";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { type MCPFetchInit, mcpFetch, withoutHeader } from "./header-policy";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_SSE_RETRY_MS = 3_000;

interface SSEResumeState {
	lastEventId: string | null;
	retryMs: number;
}

class SSEResumeError extends Error {}

async function waitForSSERetry(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const onAbort = (): void => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function resolveSSEConnectTimeoutMs(configTimeout?: number): number {
	const requestTimeout = resolveMCPTimeoutMs(configTimeout);
	if (!isMCPTimeoutEnabled(requestTimeout)) return 0;
	const boundedTimeout = Math.min(HTTP_SSE_CONNECT_TIMEOUT_MS, Math.floor(requestTimeout / 4));
	return Math.max(1, boundedTimeout);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function abortPromise(signal: AbortSignal): { promise: Promise<null>; dispose: () => void } {
	const { promise, resolve } = Promise.withResolvers<null>();
	const onAbort = () => resolve(null);
	if (signal.aborted) {
		resolve(null);
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		promise,
		dispose: () => signal.removeEventListener("abort", onAbort),
	};
}

export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	#lifetime = new AbortController();
	readonly #requestIds = new RequestIdAllocator();

	#protocolVersion: string | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	#signal(signal?: AbortSignal): AbortSignal {
		if (!signal) return this.#lifetime.signal;
		return AbortSignal.any([this.#lifetime.signal, signal]);
	}

	#clearCallbacks(): void {
		this.onClose = undefined;
		this.onError = undefined;
		this.onNotification = undefined;
		this.onRequest = undefined;
		this.onAuthError = undefined;
	}

	#fetch(init: MCPFetchInit, generated: Record<string, string>): Promise<Response> {
		const configured = withoutHeader(this.config.headers, "MCP-Protocol-Version");
		const withVersion =
			this.#protocolVersion === null ? generated : { "MCP-Protocol-Version": this.#protocolVersion, ...generated };
		return mcpFetch(
			this.config.url,
			init,
			{ generated: withVersion, configured },
			this.config.headerPolicy === "origin-locked",
		);
	}

	setProtocolVersion(version: string): void {
		this.#protocolVersion = version;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	async connect(options?: MCPRequestOptions): Promise<void> {
		if (options?.signal?.aborted) throw abortReason(options.signal);
		if (this.#connected) return;
		if (this.#lifetime.signal.aborted) throw abortReason(this.#lifetime.signal);
		this.#connected = true;
	}

	async startSSEListener(options?: MCPRequestOptions): Promise<void> {
		if (!this.#connected) return;
		if (options?.signal?.aborted) throw abortReason(options.signal);
		if (this.#sseConnection) return;

		const connection = new AbortController();
		this.#sseConnection = connection;
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const startupTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const startup = createMCPTimeout(startupTimeoutMs, options?.signal);
		const startupSignal = this.#signal(startup.signal);
		const aborted = abortPromise(startupSignal);
		const fetchPromise = this.#fetch({ method: "GET", signal: startupSignal }, generated);
		let response: Response | null;
		try {
			response = await Promise.race([fetchPromise, aborted.promise]);
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			void fetchPromise.then(lateResponse => lateResponse.body?.cancel()).catch(() => {});
			if (options?.signal?.aborted) throw abortReason(options.signal);
			if (
				!startup.timedOut() &&
				!this.#lifetime.signal.aborted &&
				error instanceof Error &&
				error.name !== "AbortError"
			) {
				this.onError?.(error);
			}
			return;
		} finally {
			aborted.dispose();
			startup.clear();
		}

		if (response === null) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			void fetchPromise.then(lateResponse => lateResponse.body?.cancel()).catch(() => {});
			if (options?.signal?.aborted) throw abortReason(options.signal);
			return;
		}

		if (options?.signal?.aborted) {
			await response.body?.cancel();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			throw abortReason(options.signal);
		}
		if (this.#sseConnection !== connection) {
			await response.body?.cancel();
			return;
		}
		if (response.status === 405 || !response.ok || !response.body) {
			await response.body?.cancel();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			return;
		}

		const signal = this.#signal(options?.signal);
		void this.#runSSEListener(response.body, signal)
			.finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) {
					const onClose = this.onClose;
					this.#clearCallbacks();
					onClose?.();
				}
			})
			.catch(() => {});
	}

	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(body, signal)) {
				if (!this.#connected) break;
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	async #runSSEListener(initialBody: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let body = initialBody;
		let progressed = true;
		for (;;) {
			try {
				for await (const event of readSseEvents(body, signal)) {
					progressed = true;
					if (event.id !== undefined) resume.lastEventId = event.id || null;
					if (event.retry !== undefined) resume.retryMs = event.retry;
					if (event.data === "") continue;
					if (!this.#connected) return;
					this.#dispatchSSEMessage(JSON.parse(event.data) as JsonRpcMessage | JsonRpcMessage[]);
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return;
				logger.debug("HTTP SSE stream error", {
					url: this.config.url,
					error: error instanceof Error ? error.message : String(error),
				});
				if (resume.lastEventId === null) {
					if (error instanceof Error) this.onError?.(error);
					return;
				}
			}
			if (!this.#connected || signal.aborted || resume.lastEventId === null || !progressed) return;
			progressed = false;
			try {
				const response = await this.#fetchSSEResume(resume, signal);
				body = response.body as ReadableStream<Uint8Array>;
			} catch (error) {
				if (!(error instanceof Error && error.name === "AbortError")) {
					logger.debug("HTTP SSE listener resume failed", {
						url: this.config.url,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	async #fetchSSEResume(resume: SSEResumeState, signal: AbortSignal): Promise<Response> {
		if (resume.lastEventId === null) {
			throw new SSEResumeError("SSE stream ended without a resumable event ID");
		}
		await waitForSSERetry(resume.retryMs, signal);
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
			"Last-Event-ID": resume.lastEventId,
		};
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;
		let response = await this.#fetch({ method: "GET", signal }, generated);
		if (this.onAuthError && (response.status === 401 || response.status === 403)) {
			await response.body?.cancel();
			const newHeaders = await this.onAuthError();
			if (!newHeaders) {
				throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: auth refresh failed`);
			}

			this.config = { ...this.config, headers: newHeaders };
			response = await this.#fetch({ method: "GET", signal }, generated);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SSEResumeError(sanitizeMCPDiagnostic(`HTTP ${response.status} resuming MCP SSE stream: ${text}`));
		}
		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/event-stream") || !response.body) {
			await response.body?.cancel();
			throw new SSEResumeError(`MCP SSE resume returned unsupported Content-Type: ${contentType || "(missing)"}`);
		}
		return response;
	}

	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#dispatchSSEMessage(m);
			return;
		}

		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			const status = error instanceof Error ? AIError.status(error) : undefined;
			if (!(error instanceof SSEResumeError) && this.onAuthError && (status === 401 || status === 403)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config = { ...this.config, headers: newHeaders };
					return this.#executeRequest<T>(method, params, options);
				}
			}
			throw error;
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const id = this.#requestIds.next(this.config.requestIdFormat);
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#signal(options?.signal));

		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(body), signal: operation.signal },
				generated,
			);

			const newSessionId = response.headers.get("Mcp-Session-Id");
			if (newSessionId) {
				this.#sessionId = newSessionId;
			}

			if (!response.ok) {
				const text = await response.text();
				const wwwAuthenticate = response.headers.get("WWW-Authenticate");
				const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
				const authHints = [
					wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
					mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
				]
					.filter(Boolean)
					.join("; ");
				const suffix = authHints ? ` [${authHints}]` : "";
				throw new Error(sanitizeMCPDiagnostic(`HTTP ${response.status}: ${text}${suffix}`));
			}

			const contentType = response.headers.get("Content-Type") ?? "";

			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, this.#signal(options?.signal));
			}

			const result = (await response.json()) as JsonRpcResponse;

			if (result.error) {
				throw new Error(sanitizeMCPDiagnostic(`MCP error ${result.error.code}: ${result.error.message}`));
			}

			return result.result as T;
		} catch (error) {
			if (operation.isTimeoutAbort(error) || operation.timedOut()) {
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, signal: AbortSignal): Promise<T> {
		if (!response.body) {
			throw new Error("No response body");
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, signal);
		const responseSignal = operation.signal ?? getNeverAbortSignal();

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let captured = false;

		const drain = async (): Promise<void> => {
			let current = response;
			try {
				for (;;) {
					if (!current.body) throw new Error("SSE response did not include a body");
					try {
						for await (const event of readSseEvents(current.body, responseSignal)) {
							if (event.id !== undefined) resume.lastEventId = event.id || null;
							if (event.retry !== undefined) resume.retryMs = event.retry;
							if (event.data === "") continue;
							const raw = JSON.parse(event.data) as JsonRpcMessage | JsonRpcMessage[];
							const messages = Array.isArray(raw) ? raw : [raw];
							for (const message of messages) {
								if (
									!captured &&
									"id" in message &&
									message.id === expectedId &&
									("result" in message || "error" in message)
								) {
									captured = true;
									operation.clear();
									if (message.error) {
										reject(
											new Error(
												sanitizeMCPDiagnostic(`MCP error ${message.error.code}: ${message.error.message}`),
											),
										);
									} else {
										resolve(message.result as T);
									}
									continue;
								}
								if (!this.#connected) continue;
								this.#dispatchSSEMessage(message);
							}
						}
					} catch (error) {
						if (captured) return;
						if (responseSignal.aborted || resume.lastEventId === null) throw error;
						logger.debug("MCP SSE response stream dropped; resuming", {
							url: this.config.url,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					if (captured) return;
					if (resume.lastEventId === null) {
						throw new Error(`No response received for request ID ${expectedId}`);
					}
					current = await this.#fetchSSEResume(resume, responseSignal);
				}
			} catch (error) {
				if (captured) return;
				if (operation.isTimeoutAbort(error)) {
					reject(new Error(`SSE response timeout after ${timeout}ms`));
				} else {
					reject(error as Error);
				}
			} finally {
				operation.clear();
			}
		};

		void drain();
		return promise;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}
		const payload = JSON.stringify(body);
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#signal());
		try {
			const resp = await this.#fetch({ method: "POST", body: payload, signal: operation.signal }, generated);

			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				await resp.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					operation.clear();
					const retryOperation = createMCPTimeout(timeout, this.#signal());
					try {
						const retry = await this.#fetch(
							{ method: "POST", body: payload, signal: retryOperation.signal },
							generated,
						);
						await retry.body?.cancel();
					} finally {
						retryOperation.clear();
					}
					return;
				}
			}
			await resp.body?.cancel();
		} catch {
		} finally {
			operation.clear();
		}
	}

	async notify(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<void> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#signal(options?.signal));

		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(body), signal: operation.signal },
				generated,
			);

			if (!response.ok && response.status !== 202) {
				const text = await response.text();
				throw new Error(sanitizeMCPDiagnostic(`HTTP ${response.status}: ${text}`));
			}

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				if (this.#sseConnection) {
					void this.#readSSEStream(response.body, this.#sseConnection.signal);
				} else {
					const readOperation = createMCPTimeout(timeout, this.#signal());
					const signal = readOperation.signal ?? getNeverAbortSignal();
					void this.#readSSEStream(response.body, signal)
						.finally(() => readOperation.clear())
						.catch(() => {});
				}
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(`Notify timeout after ${timeout}ms`);
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	async close(options?: MCPRequestOptions): Promise<void> {
		if (!this.#connected && !this.#sseConnection && !this.#sessionId) {
			this.#clearCallbacks();
			return;
		}
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#lifetime.abort();

		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}

		const sessionId = this.#sessionId;
		this.#sessionId = null;
		if (sessionId) {
			const timeout = resolveMCPTimeoutMs(this.config.timeout);
			const operation = createMCPTimeout(timeout, options?.signal);
			try {
				await this.#fetch({ method: "DELETE", signal: operation.signal }, { "Mcp-Session-Id": sessionId });
			} catch {
				// Session cleanup is best effort; the transport is already closed.
			} finally {
				operation.clear();
			}
		}

		const onClose = this.onClose;
		this.#clearCallbacks();
		if (wasConnected) onClose?.();
	}
}
