/**
 * In-band provider failures: 429/5xx payloads delivered inside an HTTP 200
 * response body or mid-stream after SSE headers were sent (Azure OpenAI,
 * LiteLLM-style aggregators, reverse proxies). Both probes produce the error the
 * classifier already trusts for an out-of-band failure, so retry and fallback
 * chains advance instead of treating the stream as an empty success.
 *
 * Invariants:
 *  - A status comes only from an error `status`/`code` field (or a known throttle
 *    code) and only for 429/5xx; prose never becomes a status, so 401/403 wording
 *    cannot route into the auth lane.
 *  - A synthesized message is never opaque: an opaque 429 rotates credentials,
 *    and that verdict must come from the server, not from our wording.
 *  - Unrecognised envelopes return `undefined` and keep their existing handling.
 */
import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";
import { ProviderResponseError } from "./provider";
import { isOpaqueStatusBody } from "./rate-limit";

const MAX_IN_BAND_DETAIL_CHARS = 4096;

const IN_BAND_DETAIL_PLACEHOLDER = "Provider returned an in-band provider error";

// Throttle/overload codes mapped to the status the upstream would have sent.
// Keys are compared after splitting camel case and collapsing `_`/`-`/`.`/spaces.
const RETRYABLE_STATUS_BY_CODE: Record<string, number> = {
	rate_limit_error: 429,
	rate_limit_exceeded: 429,
	rate_limit: 429,
	rate_limit_reached: 429,
	rate_limited: 429,
	ratelimit: 429,
	too_many_requests: 429,
	request_throttled: 429,
	throttled: 429,
	throttling: 429,
	throttling_error: 429,
	throttling_exception: 429,
	throttling_allocation_quota: 429,
	request_limit_exceeded: 429,
	retry_later: 429,
	overloaded_error: 503,
	server_overloaded: 503,
	model_overloaded: 503,
	overloaded: 503,
	service_unavailable: 503,
	server_busy: 503,
	high_demand: 503,
	capacity_exceeded: 503,
};

const IN_BAND_RETRYABLE_TEXT_PATTERN =
	/\brate.?limit|too many requests|too\s+many\s+concurren|service.{0,20}unavailable|temporarily\s+unavailable|server.?error|internal.?error|overloaded|capacity|throttl|retry\s+(?:your\s+)?request|please\s+retry/i;

// A proxy status line's leading status, word-bounded so ids such as
// `chatcmpl-500321` or `gpt-500x` never fabricate one.
const LEADING_STATUS_PATTERN = /^\s*(?:HTTP[/.]\d(?:\.\d)?\s+)?([45]\d{2})(?:\b|$)/i;

const NON_RETRYABLE_CODE_PATTERN =
	/insufficient.?quota|usage.?limit|quota.?(?:exceeded|reached|insufficient)|invalid_request|content_filter|context_length|context_window|billing|balance/i;

const IN_BAND_FLAGS = create(Flag.Transient);

function normalizeCodeToken(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return undefined;
	const spaced = value.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2");
	const collapsed = spaced
		.toLowerCase()
		.replace(/[-.\s]+/g, "_")
		.replace(/_+/g, "_");
	return collapsed.length > 0 ? collapsed : undefined;
}

function readInBandDetail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// Flatten HTML proxy pages and multi-line SSE data to one line of visible text.
	const flattened = value
		.replace(/<[^>]*>/g, " ")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (flattened.length === 0) return undefined;
	return flattened.length > MAX_IN_BAND_DETAIL_CHARS ? flattened.slice(0, MAX_IN_BAND_DETAIL_CHARS) : flattened;
}

function readStatusField(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
	if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
		const parsed = Number(value.trim());
		return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
	}
	return undefined;
}

function isRetryableStatus(status: number | undefined): status is number {
	return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function readLeadingStatus(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const match = LEADING_STATUS_PATTERN.exec(text);
	return match?.[1] ? Number(match[1]) : undefined;
}

interface InBandSignal {
	status?: number;
	code?: string;
	detail?: string;
}

/**
 * Reads nested `{ error: { code, type, status, message } }`, Responses
 * `response.error`, flat `{ code, status, message }`, and string `{ error }`
 * envelopes. A bare `type` (present on every Responses event) only counts when
 * it is itself throttle wording.
 */
function readInBandSignal(frame: unknown): InBandSignal | undefined {
	if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return undefined;
	const root = frame as Record<string, unknown>;
	const nested = root.error ?? (root.response as Record<string, unknown> | undefined)?.error;
	// Azure-compatible gates double-wrap (`{ error: { error: { ... } } }`); walk at most two levels.
	let error: Record<string, unknown> | undefined;
	if (typeof nested === "object" && nested !== null) {
		error = nested as Record<string, unknown>;
		for (let depth = 0; depth < 2; depth++) {
			const inner = error.error;
			if (typeof inner !== "object" || inner === null) break;
			error = inner as Record<string, unknown>;
		}
	}
	const code = normalizeCodeToken(error?.code ?? root.code) ?? normalizeCodeToken(error?.type ?? root.type);
	if (code !== undefined && NON_RETRYABLE_CODE_PATTERN.test(code)) return undefined;
	const retryableCode = code !== undefined && IN_BAND_RETRYABLE_TEXT_PATTERN.test(code);
	if (
		!retryableCode &&
		nested === undefined &&
		root.status === undefined &&
		root.code === undefined &&
		root.message === undefined
	) {
		return undefined;
	}
	const detail =
		readInBandDetail(error?.message) ??
		readInBandDetail(root.message) ??
		(typeof nested === "string" ? readInBandDetail(nested) : undefined);
	const holder = error ?? root;
	const reported = holder === root ? [root.status, root.code] : [holder.status, holder.code, root.status, root.code];
	const status =
		reported.map(readStatusField).find(isRetryableStatus) ??
		(code !== undefined && Object.hasOwn(RETRYABLE_STATUS_BY_CODE, code)
			? readStatusField(RETRYABLE_STATUS_BY_CODE[code])
			: undefined);
	if (status !== undefined) return { status, code, detail };
	// Without a status only unambiguous throttle wording qualifies; Azure's
	// terminal `server_error` envelopes keep their existing `<code>: <message>` report.
	if (detail === undefined || !IN_BAND_RETRYABLE_TEXT_PATTERN.test(detail)) return undefined;
	return { code, detail };
}

function formatInBandMessage(status: number, detail: string | undefined, code: string | undefined): string {
	const body = detail ?? IN_BAND_DETAIL_PLACEHOLDER;
	const suffix =
		code !== undefined && !/^\d+$/.test(code) && !body.toLowerCase().includes(code.toLowerCase()) ? ` (${code})` : "";
	let message = readLeadingStatus(body) === status ? body : `${status} ${body}`;
	if (isOpaqueStatusBody(message)) message = `${status} ${IN_BAND_DETAIL_PLACEHOLDER}`;
	return `${message}${suffix}`;
}

/**
 * Classified error for an in-band failure frame (decoded SSE `data:` payload, or
 * the `{ error, response }` subset of one), or `undefined` when the frame is not
 * a retryable in-band failure.
 */
export function createInBandProviderError(frame: unknown): Error | undefined {
	const signal = readInBandSignal(frame);
	if (!signal) return undefined;
	const { status, code, detail } = signal;
	if (isRetryableStatus(status)) {
		return attach(new ProviderHttpError(formatInBandMessage(status, detail, code), status, { code }), IN_BAND_FLAGS);
	}
	if (detail === undefined && code === undefined) return undefined;
	return attach(
		new ProviderResponseError(`${detail ?? IN_BAND_DETAIL_PLACEHOLDER}${code ? ` (${code})` : ""}`, {
			kind: "runtime",
		}),
		IN_BAND_FLAGS,
	);
}

/**
 * Classified error for a non-JSON SSE frame (`data: 429 Too Many Requests`, an
 * HTML throttle page), or `undefined` when the text is not a recognisable
 * throttle so malformed payloads keep failing loudly.
 */
export function createInBandProviderErrorFromText(text: string): Error | undefined {
	const detail = readInBandDetail(text);
	if (detail === undefined || !IN_BAND_RETRYABLE_TEXT_PATTERN.test(detail)) return undefined;
	const status = readLeadingStatus(detail);
	if (isRetryableStatus(status)) {
		return attach(new ProviderHttpError(formatInBandMessage(status, detail, undefined), status), IN_BAND_FLAGS);
	}
	return attach(new ProviderResponseError(detail, { kind: "runtime" }), IN_BAND_FLAGS);
}
