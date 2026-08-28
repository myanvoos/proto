import { fetchWithRetry, readSseJson, type SseEventObserver } from "@oh-my-pi/pi-utils";
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

		shouldRetryResponse: (response, bodyText) => !isConcurrencyAdmissionRejection(response, bodyText),

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
		events: readSseJson<TEvent>(response.body, init.signal, init.onSseEvent),
		response,
		requestId: response.headers.get("x-request-id"),
	};
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
