import * as path from "node:path";
import { getLogsDir, isBunTestRuntime } from "@oh-my-pi/pi-utils";
import * as AIError from "../error/flags";
import { appendRetryAfterHint, errorMessageText, getHeadersFromError } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

// Substring match, not an allow-list: provider-specific auth headers (`x-goog-api-key`, `x-amz-security-token`, …)
// must never reach a persisted dump. Redacting a benign match is harmless; dumps diagnose the body.
const SENSITIVE_HEADER_PATTERN = /key|token|secret|auth|credential|cookie/i;

export function buildHttp400DumpPayload(
	dump: RawHttpRequestDump,
	error: unknown,
	message: string,
): RawHttpRequestDump & { errorResponse: { status: number | undefined; message: string } } {
	return {
		...sanitizeDump(dump),
		errorResponse: { status: AIError.status(error), message },
	};
}

export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	if (!dump || isBunTestRuntime() || !shouldDumpRejectedRequest(error)) {
		return message;
	}

	const payload = buildHttp400DumpPayload(dump, error, message);
	const fileName = `${Date.now()}-${Bun.hash(JSON.stringify(payload)).toString(36)}.json`;
	const filePath = path.join(getLogsDir(), "http-400-requests", fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return `${message}\nraw-http-request=${filePath}`;
	} catch (writeError) {
		const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
		return `${message}\nraw-http-request-save-failed=${writeMessage}`;
	}
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	const captured = formatCapturedHttpErrorParts(capturedErrorResponse);
	const body = captured
		? mergeCapturedBody(errorMessageText(error), captured, capturedErrorResponse?.status)
		: errorMessageText(error);
	const message = appendRetryAfterHint(body, capturedErrorResponse?.headers ?? getHeadersFromError(error));
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

const STATUS_PREFIX_PATTERN = /^\s*\d{3}\s+/;

/**
 * Fold the captured provider body into the thrown message so it prints once.
 * Works on the message before any retry hint is appended: OpenAI-family errors
 * cap the body they interpolate, so the thrown message may hold only a prefix
 * of the captured body, which the captured copy then replaces.
 */
function mergeCapturedBody(message: string, captured: CapturedHttpErrorText, status: number | undefined): string {
	if (/\bstatus code\s*\(no body\)/i.test(message)) {
		return `${status ?? "HTTP"} status code: ${captured.text}`;
	}
	const statusPrefix = STATUS_PREFIX_PATTERN.exec(message)?.[0] ?? "";
	const body = message.slice(statusPrefix.length).trimEnd();
	const carriesTruncatedBody = body.length > 0 && body.length < captured.core.length && captured.core.startsWith(body);
	if (carriesTruncatedBody) return withSuffix(`${statusPrefix}${captured.core}`, captured);
	if (message.includes(captured.core)) return withSuffix(message, captured);
	return `${message}\n${captured.text}`;
}

function withSuffix(message: string, captured: CapturedHttpErrorText): string {
	return captured.suffix && !message.includes(captured.suffix) ? `${message}${captured.suffix}` : message;
}

export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = AIError.status(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your token is valid but the account may not have access to this model or feature. Check your Copilot plan or model policy settings. Business organizations can also restrict which clients may call the API: proto sends Copilot-Integration-Id copilot-chat by default (COPILOT_INTEGRATION_ID overrides it) and retries a denied default-identity request once as the Copilot CLI (copilot-developer-cli). If both identities are denied, ask your org admin to allow one of them; if you pinned an identity, try the other.`;
	}
	// 400s stay verbatim: GitHub's body names the cause (`model_not_supported`,
	// `model_not_available_for_integrator` with its `Available models` list).
	return errorMessage;
}

const CLINE_PASS_NOT_SUBSCRIBED_PATTERN =
	/not subscribed to required model plan|no access to clinepass subscription models/i;
const CLINE_PASS_ORG_ACCOUNT_PATTERN = /organization accounts cannot use individual model inference subscriptions/i;
const CLINE_PASS_MODEL_NOT_FOUND_PATTERN = /model not found/i;

/**
 * Actionable rewrites for ClinePass failures, gated to the provider because "model not found" is too generic
 * elsewhere. Quota windows ("clinepass limit", "free limit reached on model") are classified in error/rate-limit.
 */
export function rewriteClinePassError(errorMessage: string, provider: string): string {
	if (provider !== "cline-pass") return errorMessage;
	if (CLINE_PASS_NOT_SUBSCRIBED_PATTERN.test(errorMessage)) {
		return 'This model requires a ClinePass subscription. Free-tier models (marked "(free)" in the picker) work with any Cline account.';
	}
	if (CLINE_PASS_ORG_ACCOUNT_PATTERN.test(errorMessage)) {
		return "ClinePass is unavailable for organization accounts: individual inference subscriptions are personal-plan only. Log in with a personal Cline API key.";
	}
	if (AIError.isClinePassSurfaceGateMessage(errorMessage)) {
		return "Cline restricts this model to its official product surfaces and the mirrored CLI client identity was not accepted. Pick another model with /model and report the regression — the header mirror may need updating.";
	}
	if (CLINE_PASS_MODEL_NOT_FOUND_PATTERN.test(errorMessage)) {
		return "Cline removed this model from the roster since it was selected. Pick another with /model — the roster refreshes automatically while your API key is configured.";
	}
	return errorMessage;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		url: redactUrlQuery(dump.url),
		headers: redactHeaders(dump.headers),
	};
}

// The whole query goes: a configurable baseUrl (e.g. gateway routing) can carry an arbitrary query credential.
function redactUrlQuery(url: string | undefined): string | undefined {
	if (!url) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.search) return url;
		parsed.search = "";
		return `${parsed.toString()}[redacted-query]`;
	} catch {
		return url;
	}
}

/** Copy of `headers` with every credential value replaced by `[redacted]`; shared by every persisted dump. */
export function redactHeaders<T>(headers: Record<string, T> | undefined): Record<string, T | string> | undefined {
	if (!headers) {
		return undefined;
	}

	const redacted: Record<string, T | string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (SENSITIVE_HEADER_PATTERN.test(key)) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

interface CapturedHttpErrorText {
	/** Provider-supplied message with the envelope's structured fields removed. */
	core: string;
	/** `core` followed by the `(type=… param=… code=…)` suffix when the payload carries one. */
	text: string;
	/** Suffix alone, leading space included; absent when the payload has no type/param/code. */
	suffix?: string;
}

function formatCapturedHttpErrorParts(
	captured: CapturedHttpErrorResponse | undefined,
): CapturedHttpErrorText | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return { core: bodyText, text: bodyText };

	const errorPayload = getObjectProperty(payload, "error") ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getStringProperty(payload, "error") : undefined;
	const core =
		getStringProperty(errorPayload, "message") ?? getStringProperty(payload, "message") ?? stringError ?? bodyText;
	const extras = [
		getStringProperty(errorPayload, "type") ?? getStringProperty(payload, "type"),
		getStringProperty(errorPayload, "param") ?? getStringProperty(payload, "param"),
		getStringProperty(errorPayload, "code") ?? getStringProperty(payload, "code"),
	]
		.filter(Boolean)
		.map((value, index) => {
			if (index === 0) return `type=${value}`;
			if (index === 1) return `param=${value}`;
			return `code=${value}`;
		});
	if (extras.length === 0) return { core, text: core };
	const suffix = ` (${extras.join(" ")})`;
	return { core, text: `${core}${suffix}`, suffix };
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isObject(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		const parsed = JSON.parse(captured.bodyText);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getObjectProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const property = value[key];
	return isObject(property) ? property : undefined;
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const property = value[key];
	return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
