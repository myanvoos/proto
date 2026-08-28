import { scheduler } from "node:timers/promises";
import * as AIError from "../error";
import { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError } from "../error";

export { AnthropicApiError, AnthropicConnectionError, AnthropicConnectionTimeoutError };

import type { FetchImpl } from "../types";
import type { MessageCreateParams } from "./anthropic-wire";

const DEFAULT_TIMEOUT_MS = 600_000;

const DEFAULT_MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;

export interface AnthropicRequestOptions {
	signal?: AbortSignal;

	timeout?: number;

	maxRetries?: number;

	maxRetryDelayMs?: number;

	headers?: Record<string, string>;
}

export type AnthropicFetchOptions = RequestInit & {
	tls?: {
		rejectUnauthorized?: boolean;
		serverName?: string;
		ciphers?: string;
		ca?: string | string[];
		cert?: string;
		key?: string;
	};

	timeout?: number | false;
};

export interface AnthropicClientOptions {
	apiKey?: string | null;

	authToken?: string | null;
	baseURL?: string | null;
	maxRetries?: number;

	maxRetryDelayMs?: number;

	timeout?: number;
	defaultHeaders?: Record<string, string>;
	fetch?: FetchImpl;
	fetchOptions?: AnthropicFetchOptions;
}

function createAbortError(): Error {
	return new AIError.AbortError("Request was aborted.");
}

function shouldRetryResponse(response: Response): boolean {
	const shouldRetryHeader = response.headers.get("x-should-retry");
	if (shouldRetryHeader === "true") return true;
	if (shouldRetryHeader === "false") return false;
	const status = response.status;

	return AIError.isTransientStatus(status) || status === 409;
}

export function retryDelayFromHeaders(headers: Pick<Headers, "get"> | undefined): number | undefined {
	if (!headers) return undefined;
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const ms = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(ms) && ms >= 0) return ms;
	}
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		const dateMs = Date.parse(retryAfter) - Date.now();
		if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
	}
	return undefined;
}

export function calculateAnthropicRetryDelayMs(attempt: number): number {
	const sleepSeconds = Math.min(INITIAL_RETRY_DELAY_S * 2 ** attempt, MAX_RETRY_DELAY_S);
	const jitter = 1 - Math.random() * 0.25;
	return sleepSeconds * jitter * 1000;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, lowerName: string): boolean {
	for (const key in headers) {
		if (key.toLowerCase() === lowerName) return true;
	}
	return false;
}

export class AnthropicApiRequest {
	#start: () => Promise<Response>;
	#response: Promise<Response> | undefined;

	constructor(start: () => Promise<Response>) {
		this.#start = start;
	}

	asResponse(): Promise<Response> {
		this.#response ??= this.#start();
		return this.#response;
	}
}

export class AnthropicMessages {
	#client: AnthropicMessagesClient;
	#path: string;

	constructor(client: AnthropicMessagesClient, path: string) {
		this.#client = client;
		this.#path = path;
	}

	create(params: MessageCreateParams, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return this.#client.request(this.#path, params, options);
	}
}

export interface AnthropicMessagesClientLike {
	messages: { create(params: MessageCreateParams, options?: AnthropicRequestOptions): unknown };
	beta?: { messages: { create(params: MessageCreateParams, options?: AnthropicRequestOptions): unknown } };
}

export class AnthropicMessagesClient implements AnthropicMessagesClientLike {
	readonly messages: AnthropicMessages;
	readonly beta: { readonly messages: AnthropicMessages };
	#options: AnthropicClientOptions;

	constructor(options: AnthropicClientOptions) {
		this.#options = options;
		this.messages = new AnthropicMessages(this, "/v1/messages");
		this.beta = { messages: new AnthropicMessages(this, "/v1/messages?beta=true") };
	}

	request(path: string, params: MessageCreateParams, options?: AnthropicRequestOptions): AnthropicApiRequest {
		return new AnthropicApiRequest(() => this.#send(path, params, options));
	}

	#buildHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
		const opts = this.#options;
		const defaults = opts.defaultHeaders ?? {};
		const headers: Record<string, string> = {};
		if (opts.apiKey != null && !hasHeaderCaseInsensitive(defaults, "x-api-key")) {
			headers["X-Api-Key"] = opts.apiKey;
		}
		if (opts.authToken != null && !hasHeaderCaseInsensitive(defaults, "authorization")) {
			headers.Authorization = `Bearer ${opts.authToken}`;
		}
		Object.assign(headers, defaults);
		Object.assign(headers, requestHeaders);
		return headers;
	}

	async #send(path: string, params: MessageCreateParams, options?: AnthropicRequestOptions): Promise<Response> {
		const opts = this.#options;
		const fetchFn: FetchImpl = opts.fetch ?? fetch;
		const callerSignal = options?.signal;
		const timeoutMs = options?.timeout ?? opts.timeout ?? DEFAULT_TIMEOUT_MS;
		const maxRetries = Math.max(0, options?.maxRetries ?? opts.maxRetries ?? DEFAULT_MAX_RETRIES);
		const maxRetryDelayMs = options?.maxRetryDelayMs ?? opts.maxRetryDelayMs ?? 60_000;
		const url = `${opts.baseURL ?? "https://api.anthropic.com"}${path}`;
		const headers = this.#buildHeaders(options?.headers);
		const body = JSON.stringify(params);

		for (let attempt = 0; ; attempt++) {
			if (callerSignal?.aborted) throw createAbortError();

			let response: Response;
			try {
				response = await this.#fetchOnce(fetchFn, url, headers, body, timeoutMs, callerSignal);
			} catch (error) {
				if (callerSignal?.aborted) throw createAbortError();
				if (attempt < maxRetries) {
					await this.#backoff(attempt, undefined, callerSignal);
					continue;
				}
				if (error instanceof AIError.AnthropicConnectionTimeoutError) throw error;
				throw new AIError.AnthropicConnectionError(error);
			}

			if (response.ok) return response;

			if (attempt < maxRetries && shouldRetryResponse(response)) {
				const headerDelayMs = retryDelayFromHeaders(response.headers);
				if (headerDelayMs !== undefined && maxRetryDelayMs > 0 && headerDelayMs > maxRetryDelayMs) {
					throw await AIError.AnthropicApiError.fromResponse(response, callerSignal);
				}
				await response.body?.cancel().catch(() => {});
				await this.#backoff(attempt, response.headers, callerSignal);
				continue;
			}

			throw await AIError.AnthropicApiError.fromResponse(response, callerSignal);
		}
	}

	async #fetchOnce(
		fetchFn: FetchImpl,
		url: string,
		headers: Record<string, string>,
		body: string,
		timeoutMs: number,
		callerSignal: AbortSignal | undefined,
	): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		callerSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await fetchFn(url, {
				...(this.#options.fetchOptions ?? {}),
				method: "POST",
				headers,
				body,
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut && !callerSignal?.aborted) throw new AIError.AnthropicConnectionTimeoutError();
			throw error;
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onAbort);
		}
	}

	async #backoff(
		attempt: number,
		responseHeaders: Headers | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		const delayMs = retryDelayFromHeaders(responseHeaders) ?? calculateAnthropicRetryDelayMs(attempt);
		try {
			await scheduler.wait(delayMs, { signal });
		} catch {
			throw createAbortError();
		}
	}
}
