import { extractRetryHint } from "@oh-my-pi/pi-utils";
import * as AIError from "./error";
import type { AssistantMessage } from "./types";
import { getHeadersFromError, getRetryAfterMsFromHeaders, type HeadersLike } from "./utils/retry-after";

export interface OneshotRetryOptions {
	maxAttempts?: number;

	baseDelayMs?: number;

	maxDelayMs?: number;

	signal?: AbortSignal;

	getResponseHeaders?: () => HeadersLike;

	onRetry?: (info: OneshotRetryInfo) => void;
}

export interface OneshotRetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;

	fromRetryHint: boolean;
	errorMessage: string;

	errorId: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

const BACKOFF_CEILING_MS = 8_000;
const RETRY_AFTER_MS_SUFFIX = /(?:^|\s)retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/i;

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
	const growth = Math.min(baseDelayMs * 2 ** (attempt - 1), BACKOFF_CEILING_MS);

	return Math.round(growth * (0.75 + Math.random() * 0.25));
}

function isRetryableOneshotFailure(errorId: number, errorStatus: number | undefined, errorMessage: string): boolean {
	if (AIError.LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(errorMessage)) return false;
	if (AIError.is(errorId, AIError.Flag.ContentBlocked)) return false;

	if (AIError.is(errorId, AIError.Flag.ContextOverflow)) return false;
	return (
		AIError.isTransientStatus(errorStatus) ||
		AIError.is(errorId, AIError.Flag.Transient) ||
		AIError.is(errorId, AIError.Flag.UsageLimit) ||
		AIError.retriable(errorId)
	);
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, delayMs);
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal?.reason ?? new AIError.AbortError("oneshot retry aborted"));
	};
	if (signal) {
		if (signal.aborted) {
			clearTimeout(timer);
			return Promise.reject(signal.reason ?? new AIError.AbortError("oneshot retry aborted"));
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return promise;
}

export async function retryTransientCompletion(
	run: (attempt: number) => Promise<AssistantMessage>,
	options?: OneshotRetryOptions,
): Promise<AssistantMessage> {
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const signal = options?.signal;

	for (let attempt = 1; ; attempt++) {
		let message: AssistantMessage | undefined;
		let thrown: unknown;
		try {
			message = await run(attempt);
			if (message.stopReason !== "error") return message;
		} catch (error) {
			thrown = error;
		}

		if (signal?.aborted) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}

		const errorId =
			thrown !== undefined ? AIError.classify(thrown) : AIError.classifyMessage(message as AssistantMessage);
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}
		const errorMessage =
			thrown !== undefined
				? thrown instanceof Error
					? thrown.message
					: String(thrown)
				: ((message as AssistantMessage).errorMessage ?? "unknown error");
		const errorStatus = thrown !== undefined ? AIError.status(thrown) : (message as AssistantMessage).errorStatus;
		const lastAttempt = attempt >= maxAttempts;
		if (lastAttempt || !isRetryableOneshotFailure(errorId, errorStatus, errorMessage)) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}

		const headers: HeadersLike = thrown !== undefined ? getHeadersFromError(thrown) : options?.getResponseHeaders?.();
		const headerHintMs = getRetryAfterMsFromHeaders(headers);
		const extractedTextHintMs = extractRetryHint(undefined, errorMessage);
		const suffixValue = RETRY_AFTER_MS_SUFFIX.exec(errorMessage)?.[1];
		const parsedSuffixMs = suffixValue === undefined ? undefined : Number(suffixValue);
		const suffixHintMs =
			parsedSuffixMs !== undefined && Number.isFinite(parsedSuffixMs) && parsedSuffixMs > 0
				? Math.ceil(parsedSuffixMs)
				: undefined;
		const textHintMs =
			extractedTextHintMs === undefined && suffixHintMs === undefined
				? undefined
				: Math.max(extractedTextHintMs ?? 0, suffixHintMs ?? 0);
		const hintMs =
			headerHintMs === undefined && textHintMs === undefined
				? undefined
				: Math.max(headerHintMs ?? 0, textHintMs ?? 0);

		if (hintMs !== undefined && hintMs > maxDelayMs) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}
		const backoff = backoffDelayMs(attempt, baseDelayMs);
		const delayMs = Math.min(Math.max(hintMs ?? 0, backoff), maxDelayMs);

		options?.onRetry?.({
			attempt,
			maxAttempts,
			delayMs,
			fromRetryHint: hintMs !== undefined && hintMs >= backoff,
			errorMessage,
			errorId,
		});

		await sleep(delayMs, signal);
	}
}
