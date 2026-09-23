import { fetchWithRetry, readSseJsonOrText, type SseEventObserver } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { OpenAIHttpError } from "../error";

export { OpenAIHttpError };

import type { FetchImpl } from "../types";
import type { CapturedHttpErrorResponse } from "./http-inspector";

const DEFAULT_MAX_ATTEMPTS = 6;

const MAX_DETAIL_CHARS = 4096;

const CONCURRENCY_ADMISSION_LIMITER = "max_parallel_requests";

const CONCURRENCY_ADMISSION_BODY_PATTERN = /"rate_limit_type"\s*:\s*"max_parallel_requests"/;

function isConcurrencyAdmissionRejection(response: Response, bodyText: string): boolean {
	return (
		response.headers.get("rate_limit_type")?.trim() === CONCURRENCY_ADMISSION_LIMITER ||
		CONCURRENCY_ADMISSION_BODY_PATTERN.test(bodyText)
	);
}

export interface OpenAIStreamRequestInit {
	url: string;
	headers: Record<string, string>;

	body: unknown;
	signal: AbortSignal;
	fetch?: FetchImpl;

	shouldRetryResponse?: (response: Response, bodyText: string) => boolean | Promise<boolean>;

	onSseEvent?: SseEventObserver;
}

export interface OpenAIStreamHandle<TEvent> {
	events: AsyncGenerator<TEvent>;
	response: Response;

	requestId: string | null;
}

export async function postOpenAIStream<TEvent>(init: OpenAIStreamRequestInit): Promise<OpenAIStreamHandle<TEvent>> {
	const response = await fetchWithRetry(init.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...init.headers },
		body: JSON.stringify(init.body),
		signal: init.signal,
		fetch: init.fetch,
		maxAttempts: DEFAULT_MAX_ATTEMPTS,

		shouldRetryResponse: async (response, bodyText) =>
			!isConcurrencyAdmissionRejection(response, bodyText) &&
			(init.shouldRetryResponse === undefined || (await init.shouldRetryResponse(response, bodyText))),

		timeout: false,
	});
	if (!response.ok) {
		throw await captureOpenAIHttpError(response);
	}
	if (!response.body) {
		throw new AIError.ProviderResponseError(`OpenAI stream response has no body (status ${response.status})`, {
			kind: "envelope",
		});
	}
	return {
		events: decodeStream<TEvent>(response.body, init.signal, init.onSseEvent),
		response,
		requestId: response.headers.get("x-request-id"),
	};
}

/**
 * A reverse proxy that already committed to HTTP 200 reports throttles as plain
 * text frames (`data: 429 Too Many Requests`, an HTML page); classify those as
 * in-band errors. Other non-JSON frames rethrow the strict parse error, and a
 * JSON-encoded string frame is dropped after classification.
 */
async function* decodeStream<TEvent>(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
	onSseEvent: SseEventObserver | undefined,
): AsyncGenerator<TEvent> {
	for await (const frame of readSseJsonOrText<TEvent>(body, signal, onSseEvent)) {
		if (typeof frame === "string") {
			const inBand = AIError.createInBandProviderErrorFromText(frame);
			if (inBand) throw inBand;
			JSON.parse(frame);
			continue;
		}
		yield frame;
	}
}

export async function captureOpenAIHttpError(response: Response): Promise<AIError.OpenAIHttpError> {
	let bodyText: string | undefined;
	let bodyJson: unknown;
	try {
		bodyText = await response.text();
		if (bodyText.trim().length > 0) {
			try {
				bodyJson = JSON.parse(bodyText);
			} catch {}
		} else {
			bodyText = undefined;
		}
	} catch {}
	const captured: CapturedHttpErrorResponse = {
		status: response.status,
		headers: response.headers,
		bodyText,
		bodyJson,
	};
	const { detail, code } = OpenAIHttpError.parseEnvelope(bodyJson, bodyText);

	const message = detail
		? `${response.status} ${detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail}`
		: `${response.status} status code (no body)`;
	return new AIError.OpenAIHttpError(message, captured, code);
}
