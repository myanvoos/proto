import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRecord, logger, readSseEvents, readSseJson } from "@oh-my-pi/pi-utils";
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
import { readBoundedText } from "../../tools/fetch";
import { sanitizeMCPDiagnostic } from "../errors";
import { RequestIdAllocator } from "../request-id";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { type MCPFetchInit, mcpFetch, withoutHeader } from "./header-policy";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_SSE_RETRY_MS = 3_000;
const MIN_SSE_RETRY_MS = 250;
const MAX_SSE_RETRY_MS = 30_000;
const MAX_SSE_RESUME_ATTEMPTS = 3;
const SSE_RETRY_JITTER_RATIO = 0.2;
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HTTP_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

interface SSEResumeState {
	lastEventId: string | null;
	retryMs: number;
}

class SSEResumeError extends Error {}

function clampSSERetryMs(retryMs: number): number {
	return Math.min(MAX_SSE_RETRY_MS, Math.max(MIN_SSE_RETRY_MS, retryMs));
}

function getSSERetryDelay(retryMs: number, attempt: number): number {
	const exponential = Math.min(MAX_SSE_RETRY_MS, clampSSERetryMs(retryMs) * 2 ** attempt);
	const jitter = 1 - SSE_RETRY_JITTER_RATIO + Math.random() * SSE_RETRY_JITTER_RATIO * 2;
	return Math.max(MIN_SSE_RETRY_MS, Math.min(MAX_SSE_RETRY_MS, Math.round(exponential * jitter)));
}

function parseJsonRpcResponse(value: unknown, expectedId: string | number): JsonRpcResponse {
	if (!isRecord(value) || value.jsonrpc !== "2.0" || !("id" in value) || "method" in value) {
		throw new Error("Invalid JSON-RPC response envelope");
	}
	if (value.id !== expectedId) {
		throw new Error(`JSON-RPC response ID ${String(value.id)} did not match request ID ${String(expectedId)}`);
	}
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (hasResult === hasError) {
		throw new Error("Invalid JSON-RPC response: expected exactly one of result or error");
	}
	if (hasError) {
		const error = value.error;
		if (!isRecord(error) || !Number.isInteger(error.code) || typeof error.message !== "string") {
			throw new Error("Invalid JSON-RPC response error");
		}
	}
	return value as unknown as JsonRpcResponse;
}

async function readResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
	const text = await readBoundedText(response, maxBytes);
	if (text === null) throw new Error(`${label} exceeded ${maxBytes} bytes`);
	return text;
}

async function readDiagnosticText(response: Response): Promise<string> {
	return (
		(await readBoundedText(response, MAX_HTTP_DIAGNOSTIC_BYTES)) ??
		`MCP HTTP diagnostic exceeded ${MAX_HTTP_DIAGNOSTIC_BYTES} bytes`
	);
}

function limitSSEEventBytes(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	let eventBytes = 0;
	let lineBytes = 0;
	let previousByte = -1;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				for (let index = 0; index < chunk.length; index++) {
					const byte = chunk[index] as number;
					eventBytes++;
					if (eventBytes > MAX_SSE_EVENT_BYTES) {
						throw new Error(`MCP SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
					}
					if (byte !== 0x0a) {
						lineBytes++;
						previousByte = byte;
						continue;
					}
					if (lineBytes === 0 || (lineBytes === 1 && previousByte === 0x0d)) eventBytes = 0;
					lineBytes = 0;
					previousByte = byte;
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

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

	#transitionClosed(): string | null {
		const wasConnected = this.#connected;
		this.#connected = false;
		if (!this.#lifetime.signal.aborted) this.#lifetime.abort(new Error("MCP HTTP transport closed"));
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}
		const sessionId = this.#sessionId;
		this.#sessionId = null;
		const onClose = this.onClose;
		this.#clearCallbacks();
		if (wasConnected) onClose?.();
		return sessionId;
	}

	async #deleteSession(sessionId: string | null, signal?: AbortSignal): Promise<void> {
		if (!sessionId) return;
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, signal);
		try {
			const response = await this.#fetch(
				{ method: "DELETE", signal: operation.signal },
				{ "Mcp-Session-Id": sessionId },
			);
			await response.body?.cancel();
		} catch {
			// Session cleanup is best effort; the transport is already closed.
		} finally {
			operation.clear();
		}
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
			.finally(() => this.#deleteSession(this.#transitionClosed()))
			.catch(() => {});
	}

	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(limitSSEEventBytes(body), signal)) {
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
		let resumeAttempts = 0;
		for (;;) {
			try {
				for await (const event of readSseEvents(limitSSEEventBytes(body), signal)) {
					progressed = true;
					if (event.id !== undefined) resume.lastEventId = event.id || null;
					if (event.retry !== undefined) resume.retryMs = clampSSERetryMs(event.retry);
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
			if (resumeAttempts >= MAX_SSE_RESUME_ATTEMPTS) {
				this.onError?.(new SSEResumeError("MCP SSE resume retry budget exhausted"));
				return;
			}
			try {
				const response = await this.#fetchSSEResume(resume, signal, resumeAttempts++);
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

	async #fetchSSEResume(resume: SSEResumeState, signal: AbortSignal, attempt: number): Promise<Response> {
		if (resume.lastEventId === null) {
			throw new SSEResumeError("SSE stream ended without a resumable event ID");
		}
		await waitForSSERetry(getSSERetryDelay(resume.retryMs, attempt), signal);
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
			"Last-Event-ID": resume.lastEventId,
		};
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;
		const connectTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(connectTimeoutMs, signal);
		const resumeSignal = operation.signal ?? signal;
		try {
			let response = await this.#fetch({ method: "GET", signal: resumeSignal }, generated);
			if (this.onAuthError && (response.status === 401 || response.status === 403)) {
				await response.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (!newHeaders) {
					throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: auth refresh failed`);
				}

				this.config = { ...this.config, headers: newHeaders };
				response = await this.#fetch({ method: "GET", signal: resumeSignal }, generated);
			}
			if (!response.ok) {
				const text = await readDiagnosticText(response);
				throw new SSEResumeError(sanitizeMCPDiagnostic(`HTTP ${response.status} resuming MCP SSE stream: ${text}`));
			}
			const contentType = response.headers.get("Content-Type") ?? "";
			if (!contentType.includes("text/event-stream") || !response.body) {
				await response.body?.cancel();
				throw new SSEResumeError(`MCP SSE resume returned unsupported Content-Type: ${contentType || "(missing)"}`);
			}
			return response;
		} catch (error) {
			if (operation.timedOut()) {
				throw new SSEResumeError(`MCP SSE resume timed out after ${connectTimeoutMs}ms`);
			}
			throw error;
		} finally {
			operation.clear();
		}
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
				const text = await readDiagnosticText(response);
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

			const text = await readResponseText(response, MAX_JSON_RESPONSE_BYTES, "MCP JSON response");
			let decoded: unknown;
			try {
				decoded = JSON.parse(text) as unknown;
			} catch {
				throw new Error("Invalid JSON-RPC response: response body was not valid JSON");
			}
			const result = parseJsonRpcResponse(decoded, id);

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
		let resumeAttempts = 0;

		const drain = async (): Promise<void> => {
			let current = response;
			try {
				for (;;) {
					if (!current.body) throw new Error("SSE response did not include a body");
					try {
						for await (const event of readSseEvents(limitSSEEventBytes(current.body), responseSignal)) {
							if (event.id !== undefined) resume.lastEventId = event.id || null;
							if (event.retry !== undefined) resume.retryMs = clampSSERetryMs(event.retry);
							if (event.data === "") continue;
							const raw = JSON.parse(event.data) as unknown;
							const messages: unknown[] = Array.isArray(raw) ? raw : [raw];
							for (const message of messages) {
								if (!isRecord(message)) {
									throw new Error("Invalid JSON-RPC response envelope");
								}
								if (!captured && message.id === expectedId && !("method" in message)) {
									const validated = parseJsonRpcResponse(message, expectedId);
									captured = true;
									operation.clear();
									if (validated.error) {
										reject(
											new Error(
												sanitizeMCPDiagnostic(
													`MCP error ${validated.error.code}: ${validated.error.message}`,
												),
											),
										);
									} else {
										resolve(validated.result as T);
									}
									continue;
								}
								if (!this.#connected) continue;
								this.#dispatchSSEMessage(message as unknown as JsonRpcMessage);
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
					if (resumeAttempts >= MAX_SSE_RESUME_ATTEMPTS) {
						throw new SSEResumeError("MCP SSE response resume retry budget exhausted");
					}
					current = await this.#fetchSSEResume(resume, responseSignal, resumeAttempts++);
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
				const text = await readDiagnosticText(response);
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
		await this.#deleteSession(this.#transitionClosed(), options?.signal);
	}
}
