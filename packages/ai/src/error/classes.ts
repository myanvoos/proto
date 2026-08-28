import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { AbortError } from "./abort";

export const STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

export interface ProviderHttpErrorOptions {
	headers?: Headers;

	code?: string;
	cause?: unknown;
}

export class ProviderHttpError extends Error {
	readonly status: number;
	readonly headers: Headers | undefined;
	readonly code: string | undefined;

	constructor(message: string, status: number, options?: ProviderHttpErrorOptions) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderHttpError";
		this.status = status;
		this.headers = options?.headers;
		this.code = options?.code;
	}
}

export class OpenAIHttpError extends ProviderHttpError {
	readonly captured: CapturedHttpErrorResponse;

	constructor(message: string, captured: CapturedHttpErrorResponse, code?: string, cause?: unknown) {
		super(message, captured.status, { headers: captured.headers, code, cause });
		this.name = "OpenAIHttpError";
		this.captured = captured;
	}

	static parseEnvelope(
		bodyJson: unknown,
		bodyText: string | undefined,
	): { detail: string | undefined; code: string | undefined } {
		if (typeof bodyJson === "object" && bodyJson !== null) {
			const envelope = bodyJson as { error?: unknown; message?: unknown };
			const error = envelope.error;
			if (typeof error === "object" && error !== null) {
				const { message, code, type } = error as { message?: unknown; code?: unknown; type?: unknown };
				return {
					detail: typeof message === "string" && message.length > 0 ? message : bodyText,
					code: typeof code === "string" ? code : typeof type === "string" ? type : undefined,
				};
			}
			if (typeof error === "string" && error.length > 0) {
				return { detail: error, code: undefined };
			}
			if (typeof envelope.message === "string" && envelope.message.length > 0) {
				return { detail: envelope.message, code: undefined };
			}
		}
		return { detail: bodyText, code: undefined };
	}
}

const DEFAULT_ANTHROPIC_ERROR_BODY_READ_TIMEOUT_MS = 5_000;
const MAX_ANTHROPIC_ERROR_BODY_BYTES = 64 * 1024;
const ANTHROPIC_ERROR_BODY_TRUNCATION_MARKER = "\n[Response body truncated after 64 KiB]";
let anthropicErrorBodyReadTimeoutMs = DEFAULT_ANTHROPIC_ERROR_BODY_READ_TIMEOUT_MS;

export const __anthropicApiErrorForTesting = {
	setBodyReadTimeoutMs(timeoutMs: number | undefined): void {
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new RangeError("Anthropic error-body timeout must be a non-negative finite number.");
		}
		anthropicErrorBodyReadTimeoutMs = timeoutMs ?? DEFAULT_ANTHROPIC_ERROR_BODY_READ_TIMEOUT_MS;
	},
};

export class AnthropicApiError extends ProviderHttpError {
	declare readonly headers: Headers;
	readonly requestId: string | null;

	constructor(status: number, message: string, headers: Headers) {
		super(message, status, { headers });
		this.name = "AnthropicApiError";
		this.requestId = headers.get("request-id");
	}

	static async fromResponse(response: Response, signal?: AbortSignal): Promise<AnthropicApiError> {
		const reader = response.body?.locked ? undefined : response.body?.getReader();

		if (!reader) {
			if (signal?.aborted) throw new AbortError("Request was aborted.");
			const detail = "status code (no body)";
			return new AnthropicApiError(response.status, `${response.status} ${detail}`, response.headers);
		}

		let aborted = false;
		let timedOut = false;
		let readerCancelled = false;
		const cancelReader = () => {
			if (readerCancelled) return;
			readerCancelled = true;
			void reader.cancel().catch(() => {});
		};
		const onAbort = () => {
			if (aborted) return;
			aborted = true;
			cancelReader();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		const deadline = performance.now() + anthropicErrorBodyReadTimeoutMs;
		let timeout: Timer | undefined;
		timeout = setTimeout(() => {
			timedOut = true;
			cancelReader();
		}, anthropicErrorBodyReadTimeoutMs);

		let capturedBytes = 0;
		let truncated = false;
		const bodyChunks: string[] = [];
		try {
			const decoder = new TextDecoder();
			let cleanEof = false;
			while (!aborted && !timedOut) {
				if (performance.now() >= deadline) {
					timedOut = true;
					cancelReader();
					break;
				}

				let result: { readonly done: boolean; readonly value?: Uint8Array };
				try {
					result = await reader.read();
				} catch {
					break;
				}
				if (aborted || timedOut) break;
				if (result.done) {
					cleanEof = true;
					break;
				}

				const chunk = result.value;
				if (!chunk) break;
				const bytesToCapture = Math.min(MAX_ANTHROPIC_ERROR_BODY_BYTES - capturedBytes, chunk.byteLength);
				if (bytesToCapture > 0) {
					bodyChunks.push(decoder.decode(chunk.subarray(0, bytesToCapture), { stream: true }));
					capturedBytes += bytesToCapture;
				}
				if (bytesToCapture < chunk.byteLength) {
					truncated = true;
					cancelReader();
					break;
				}
			}
			if (aborted || signal?.aborted) throw new AbortError("Request was aborted.");
			if (cleanEof) bodyChunks.push(decoder.decode());
			if (truncated) bodyChunks.push(ANTHROPIC_ERROR_BODY_TRUNCATION_MARKER);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reader.releaseLock();
		}

		const detail = bodyChunks.join("").trim() || "status code (no body)";
		return new AnthropicApiError(response.status, `${response.status} ${detail}`, response.headers);
	}
}

export class AnthropicConnectionError extends Error {
	constructor(cause: unknown) {
		super("Connection error.", { cause });
		this.name = "AnthropicConnectionError";
	}
}

export class AnthropicConnectionTimeoutError extends Error {
	constructor() {
		super("Request timed out.");
		this.name = "AnthropicConnectionTimeoutError";
	}
}

export class AnthropicStreamEnvelopeError extends Error {
	constructor(detail: string) {
		super(`${STREAM_ENVELOPE_ERROR_PREFIX} ${detail}`);
		this.name = "AnthropicStreamEnvelopeError";
	}
}

export class BedrockApiError extends ProviderHttpError {
	override readonly name = "BedrockApiError";
}

export class GeminiCliApiError extends ProviderHttpError {
	override readonly name = "GeminiCliApiError";
}

export class GoogleApiError extends ProviderHttpError {
	override readonly name = "GoogleApiError";
}

export class OllamaApiError extends ProviderHttpError {
	override readonly name = "OllamaApiError";
}

export class AuthGatewayError extends ProviderHttpError {
	constructor(message: string, status: number, headers?: Headers, code?: string) {
		super(message, status, { headers, code });
		this.name = "AuthGatewayError";
	}
}

export class CodexWebSocketTransportError extends Error {
	constructor(detail: string) {
		super(`Codex websocket transport failure: ${detail}`);
		this.name = "CodexWebSocketTransportError";
	}
}

export class CodexWhitespaceToolCallLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexWhitespaceToolCallLoopError";
	}
}

export class CodexProviderStreamError extends Error {
	readonly retryable: boolean;

	constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "CodexProviderStreamError";
		this.retryable = options?.retryable !== false;
	}
}

export class AuthBrokerError extends Error {
	readonly status: number | undefined;
	readonly body: string | undefined;
	constructor(message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
		super(message, { cause: opts.cause });
		this.name = "AuthBrokerError";
		this.status = opts.status;
		this.body = opts.body;
	}
}

export class AuthBrokerStreamUnsupportedError extends AuthBrokerError {
	constructor(message = "Auth broker does not support /v1/snapshot/stream") {
		super(message, { status: 404 });
		this.name = "AuthBrokerStreamUnsupportedError";
	}
}
