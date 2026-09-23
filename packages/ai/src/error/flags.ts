import { isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils/fetch-retry";
import type { Api, AssistantMessage, Usage } from "../types";
import { AwsCredentialsError } from "./aws";
import {
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	ProviderHttpError,
	STREAM_ENVELOPE_ERROR_PREFIX,
} from "./classes";
import {
	is402BillingCapBody,
	isAccountScopedCapText,
	isDashScopeTokenLimitText,
	isOpaqueStatusBody,
	isUsageLimitStatus,
	matchesUsageLimitText,
	parseRateLimitReason,
} from "./rate-limit";

export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	EmptyResponse: 0x0000_2000,
	ContentBlocked: 0x0000_8000,

	AccountPolicy: 0x0000_4000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,

	Grammar: 0x1000_0000,

	FastModeUnsupported: 0x2000_0000,

	OAuthExpiry: 0x4000_0000,

	PayloadRejected: 0x8000_0000,
} as const;

export type Flag = (typeof Flag)[keyof typeof Flag];

const KIND_MASK =
	Flag.ThinkingLoop |
	Flag.Transient |
	Flag.Timeout |
	Flag.UsageLimit |
	Flag.StaleResponsesItem |
	Flag.MalformedFunctionCall |
	Flag.ProviderFinishError |
	Flag.EmptyResponse |
	Flag.ContentBlocked |
	Flag.AccountPolicy |
	Flag.ContextOverflow |
	Flag.AuthFailed |
	Flag.PayloadRejected |
	Flag.UserInterrupt |
	Flag.Abort |
	Flag.Grammar |
	Flag.FastModeUnsupported |
	Flag.OAuthExpiry;

const RETRIABLE_KINDS =
	Flag.Transient |
	Flag.UsageLimit |
	Flag.ThinkingLoop |
	Flag.StaleResponsesItem |
	Flag.ProviderFinishError |
	Flag.EmptyResponse;

const CONTEXT_OVERFLOW_EVIDENCE_PATTERNS = [
	/prompt is too long/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds the available context size/i,
	/requested tokens?.*exceed.*context (window|length|size)/i,
	/context (window|length|size).*(exceeded|overflow|too small)/i,
	/(prompt|input).*(too long|too large).*(context|n_ctx)/i,
	/requested tokens?.*(exceeds?|greater than).*(n_ctx|context)/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/request_too_large[^\n]*\btokens?\b/i,
	/\btokens?\b[^\n]*request_too_large/i,
	/model_context_window_exceeded/i,
	/prompt filled the context window/i,
	/exceeds the limit of \d+ tokens?\b/i,
	/chat history exceeds the \d+-message limit/i, // Provider message-count cap
] as const;
// Generic numeric limits also match media budgets ("image count exceeds the limit of 20"), so they
// classify as overflow but never count as token evidence that vetoes a payload rejection.
const GENERIC_LIMIT_OVERFLOW_PATTERN = /exceeds the limit of \d+/i;
const OVERFLOW_PATTERNS = [...CONTEXT_OVERFLOW_EVIDENCE_PATTERNS, GENERIC_LIMIT_OVERFLOW_PATTERN];

function hasTokenContextOverflowEvidence(text: string): boolean {
	return CONTEXT_OVERFLOW_EVIDENCE_PATTERNS.some(p => p.test(text));
}

function hasCauseTokenContextOverflowEvidence(error: unknown): boolean {
	const seen = new Set<object>();
	let link: unknown = error;
	while (link !== undefined && link !== null) {
		if (typeof link !== "object") {
			if (typeof link === "string" && hasTokenContextOverflowEvidence(link)) return true;
			break;
		}
		if (seen.has(link)) break;
		seen.add(link);
		if ("message" in link) {
			const message: unknown = link.message;
			if (typeof message === "string" && hasTokenContextOverflowEvidence(message)) return true;
		}
		if ("cause" in link) {
			link = link.cause;
			continue;
		}
		break;
	}
	return false;
}

const OVERFLOW_NO_BODY_PATTERN = /\b4(00|13)\s*(status code)?\s*\(no body\)/i;
// Bare `413 (no body)` stays dual-flagged (payload + overflow): proxies strip bodies on genuine
// overflows too, so session maintenance arbitrates it against local headroom.
const PAYLOAD_REJECTION_PATTERNS = [
	/\b413\s*(?:status code\s*)?\(no body\)/i,
	/\b413\b[^.\n]{0,120}\b(?:request|payload|entity|body)\b[^.\n]{0,60}\b(?:exceed|too large|limit)/i,
	/request_too_large/i,
	/(?:payload|entity) too large/i,
	/request exceeds the maximum (?:size|number of bytes)/i,
] as const;

function matchesPayloadRejectionText(text: string): boolean {
	if (!PAYLOAD_REJECTION_PATTERNS.some(p => p.test(text))) return false;
	return !hasTokenContextOverflowEvidence(text);
}

const TIMEOUT_PATTERN = /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i;
const TRANSIENT_ENVELOPE_PATTERN = /anthropic stream envelope error:/i;
const TRANSIENT_ENVELOPE_TRUNCATION_PATTERN = /before message_(?:start|stop)/i;
export const STREAM_READ_ERROR_PATTERN = /stream[_ -]?read[_ -]?error/i;
export const PYTHON_HTTP2_STREAM_RESET_PATTERN = /<StreamReset stream_id:\d+, error_code:(?:2|7), remote_reset:True>/;
export const PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN =
	/peer closed connection without sending complete message body \(incomplete chunked read\)/;
export const CODEX_HTTP_BODY_READ_ERROR_PATTERN = /\btransport error reading codex response body\b/i;

const REQUEST_BODY_READ_TIMEOUT_PATTERN = /\btimed out reading request body\b/i;

/** Exact HTTP 408 diagnostic for a server that timed out reading the request body. */
export function isRequestBodyReadTimeout(status: number | undefined, message: string | undefined): boolean {
	return status === 408 && REQUEST_BODY_READ_TIMEOUT_PATTERN.test(message ?? "");
}

/** Pre-output Responses 408 on a full replay: resending the unchanged body would time out again. */
export function isResponsesRequestBodyReadTimeout(
	message: Pick<AssistantMessage, "api" | "errorStatus" | "errorMessage" | "requestBodyReadTimeoutFullReplay">,
): boolean {
	return (
		message.api === "openai-responses" &&
		message.requestBodyReadTimeoutFullReplay === true &&
		isRequestBodyReadTimeout(message.errorStatus, message.errorMessage)
	);
}
export const TRANSIENT_TRANSPORT_PATTERN =
	/\b(?:no[_ -]?capacity|(?:high|peak)[ _-]?demand|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?load)\b|overloaded|provider.?returned.?error|rate.?limit|too many requests|auth-gateway\s+5\d{2}(?=[:\s]|$)|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|unable.?to.?connect\.\s*is the computer able to access the url\?|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|nghttp2_(?:internal_error|refused_stream)|stream closed with error code nghttp2_(?:internal_error|refused_stream)|malformed.?function.?call/i;
const AUTH_FAILURE_PATTERN =
	/\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;
const MALFORMED_FUNCTION_CALL_PATTERN = /\bmalformed.?function.?call\b/i;
const PROVIDER_FINISH_ERROR_PATTERN = /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i;
const EMPTY_RESPONSE_PATTERN = /\bthought-only response without final output\b/i;
const CONTENT_FILTER_PATTERN = /\b(?:incomplete:\s*)?content_filter\b/i;
const ACCOUNT_POLICY_PATTERN = /\bcyber_policy\b|trusted access for cyber/i;
export const ANTHROPIC_ACCOUNT_POLICY_PATTERN =
	/\b(?:oauth_not_allowed_for_organization|permission_error)\b|\bOAuth authentication is currently not allowed for this organization\b/i;

/** Whether an error message represents an Anthropic account-scoped permission/policy denial. */
export function isAnthropicAccountPolicyText(text: string, provider?: string, statusArg?: number): boolean {
	if (provider !== undefined && provider !== "anthropic") return false;
	const statusCandidate = statusArg ?? (text ? status({ message: text }) : undefined);
	if (statusCandidate !== undefined && statusCandidate !== 403) return false;
	return ANTHROPIC_ACCOUNT_POLICY_PATTERN.test(text);
}
const CODEX_CHATGPT_ACCOUNT_MODEL_POLICY_PATTERN =
	/\bThe ['"]([^'"\r\n]+)['"] model is not supported when using Codex with a ChatGPT account\./i;
const CODEX_CHATGPT_ACCOUNT_MODEL_MAX_LENGTH = 256;
const CURSOR_PLAN_POLICY_MARKER_PATTERN = /\bERROR_RATE_LIMITED_CHANGEABLE\b/i;
const CURSOR_PLAN_POLICY_PATTERN = /\bNamed models unavailable\b|\bModel unavailable on\b|\bFree plans can only use\b/i;

function isCursorPlanPolicyText(text: string): boolean {
	return CURSOR_PLAN_POLICY_MARKER_PATTERN.test(text) && CURSOR_PLAN_POLICY_PATTERN.test(text);
}

function normalizeCodexChatGPTAccountPolicyModel(modelId: string | undefined): string | undefined {
	if (typeof modelId !== "string") return undefined;
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
	if (!bareModelId || bareModelId.length > CODEX_CHATGPT_ACCOUNT_MODEL_MAX_LENGTH || bareModelId.includes("\0")) {
		return undefined;
	}
	return bareModelId;
}

function codexChatGPTAccountPolicyModelFromText(text: string): string | undefined {
	const modelId = CODEX_CHATGPT_ACCOUNT_MODEL_POLICY_PATTERN.exec(text)?.[1]?.trim();
	return normalizeCodexChatGPTAccountPolicyModel(modelId) === undefined ? undefined : modelId;
}

function isCodexChatGPTAccountPolicyText(
	text: string,
	provider: string | undefined,
	modelId: string | undefined,
): boolean {
	if (provider !== "openai-codex") return false;
	const deniedModel = codexChatGPTAccountPolicyModelFromText(text);
	const deniedIdentity = normalizeCodexChatGPTAccountPolicyModel(deniedModel);
	const requestedIdentity = normalizeCodexChatGPTAccountPolicyModel(modelId);
	return deniedIdentity !== undefined && deniedIdentity === requestedIdentity;
}
const STALE_RESPONSE_ITEM_PATTERNS = [/\bItem with id ['"][^'"]+['"] not found\.?/i, /previous[ _]?response/i] as const;
const STALE_RESPONSE_ITEM_DETAIL_PATTERN = /not[ _]?found|invalid|expired|stale|zero[ _-]?data[ _-]?retention/i;

export const LLAMA_CPP_TOOL_CALL_PARSE_PATTERN =
	/failed to parse tool call arguments as json|\[json\.exception\.parse_error\.101\]/i;

// Fireworks can report a model-side decode fault as an invalid-request HTTP 400.
const GENERATION_NAN_PATTERN = /floating[ _-]?point nan\b.*\bdetected in generation/is;
const GITHUB_COPILOT_POLICY_DENIAL_PATTERN = /GitHub Copilot access denied \(HTTP 403\)/;

const GRAMMAR_TOO_LARGE_PATTERN = /compiled grammar/i;
const GRAMMAR_TOO_LARGE_DETAIL_PATTERN = /too large/i;
const SCHEMA_TOO_COMPLEX_PATTERN = /schema/i;
const SCHEMA_TOO_COMPLEX_DETAIL_PATTERN = /too complex/i;
const SCHEMA_COMPILE_PATTERN = /compil/i;
const INVALID_REQUEST_PATTERN = /invalid_request_error/i;
const STRUCTURED_OUTPUTS_PATTERN = /structured[_ -]?outputs?/i;
const FEATURE_NOT_SUPPORTED_PATTERN = /not (?:supported|available|enabled)|unsupported|does(?: not|n'?t) support/i;
const ANTHROPIC_STRICT_FIELD_PATTERN = /\btools\.\d+\.custom\.strict\b/i;
const EXTRA_INPUTS_NOT_PERMITTED_PATTERN = /extra inputs? (?:are|is) not permitted/i;
// Translating gateways (e.g. Vercel AI Gateway's Anthropic route to an OpenAI upstream) apply OpenAI strict-mode
// validation to `strict: true` tools, which rejects legally-optional parameters; only dropping `strict` recovers.
const STRICT_TOOL_SCHEMA_REJECTION_PATTERN = /invalid schema for function|invalid tool parameters schema/i;

const FAST_MODE_SPEED_PARAM_PATTERN = /\bspeed\b/i;
const FAST_MODE_NOT_SUPPORTED_PATTERN = /not support/i;
const FAST_MODE_RATE_LIMIT_PATTERN = /rate_limit_error/i;
const FAST_MODE_ENTITLEMENT_PATTERN = /fast mode/i;

const OAUTH_DEFINITIVE_FAILURE_PATTERN =
	/invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired/i;
const OAUTH_TRANSIENT_FAILURE_PATTERN =
	/timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const OAUTH_HTTP_AUTH_PATTERN = /\b401\b/;

function matchesStrictToolsRejection(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400) return false;
	if (ANTHROPIC_STRICT_FIELD_PATTERN.test(message) && EXTRA_INPUTS_NOT_PERMITTED_PATTERN.test(message)) {
		return true;
	}
	if (STRUCTURED_OUTPUTS_PATTERN.test(message) && FEATURE_NOT_SUPPORTED_PATTERN.test(message)) return true;
	if (STRICT_TOOL_SCHEMA_REJECTION_PATTERN.test(message)) return true;
	if (!INVALID_REQUEST_PATTERN.test(message)) return false;
	const grammarTooLarge = GRAMMAR_TOO_LARGE_PATTERN.test(message) && GRAMMAR_TOO_LARGE_DETAIL_PATTERN.test(message);
	const schemaTooComplex =
		SCHEMA_TOO_COMPLEX_PATTERN.test(message) &&
		SCHEMA_TOO_COMPLEX_DETAIL_PATTERN.test(message) &&
		SCHEMA_COMPILE_PATTERN.test(message);
	return grammarTooLarge || schemaTooComplex;
}

function matchesFastModeUnsupported(message: string, errorStatus: number | undefined): boolean {
	if (errorStatus !== 400 && errorStatus !== 429) return false;
	if (
		errorStatus === 400 &&
		INVALID_REQUEST_PATTERN.test(message) &&
		FAST_MODE_SPEED_PARAM_PATTERN.test(message) &&
		FAST_MODE_NOT_SUPPORTED_PATTERN.test(message)
	) {
		return true;
	}
	return (
		errorStatus === 429 && FAST_MODE_RATE_LIMIT_PATTERN.test(message) && FAST_MODE_ENTITLEMENT_PATTERN.test(message)
	);
}

export function isOAuthExpiry(errorMessage: string): boolean {
	if (OAUTH_DEFINITIVE_FAILURE_PATTERN.test(errorMessage)) return true;
	return OAUTH_HTTP_AUTH_PATTERN.test(errorMessage) && !OAUTH_TRANSIENT_FAILURE_PATTERN.test(errorMessage);
}

const ERROR_KIND_LABELS: readonly [Flag, string][] = [
	[Flag.ThinkingLoop, "thinking-loop"],
	[Flag.Transient, "transient"],
	[Flag.Timeout, "timeout"],
	[Flag.UsageLimit, "usage-limit"],
	[Flag.StaleResponsesItem, "stale-responses-item"],
	[Flag.MalformedFunctionCall, "malformed-function-call"],
	[Flag.ProviderFinishError, "provider-finish-error"],
	[Flag.EmptyResponse, "empty-response"],
	[Flag.ContentBlocked, "content-blocked"],
	[Flag.AccountPolicy, "account-policy"],
	[Flag.ContextOverflow, "context-overflow"],
	[Flag.PayloadRejected, "payload-rejected"],
	[Flag.AuthFailed, "auth-failed"],
	[Flag.UserInterrupt, "user-interrupt"],
	[Flag.Abort, "abort"],
];

const STATUS_MESSAGE_PATTERNS = [
	/\bstatus(?:_code)?[:=]\s*(\d{3})\b/i,
	/\bstatus\s+(\d{3})\b/i,
	/\bHTTP\s+(\d{3})\b/i,
	/\b(?:error|failed)\s*[:=]?\s*(\d{3})\b/i,
	/(?:^|\s)(\d{3})\s+(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
] as const;

export function create(...flags: number[]): number {
	let bits = 0;
	for (const f of flags) bits |= f;
	return bits | Flag.Class;
}

export function is(id: number | undefined, flag: Flag): boolean {
	return ((id ?? 0) & flag) !== 0;
}

export function retriable(id: number | undefined, opts?: { replayUnsafe?: boolean }): boolean {
	if (is(id, Flag.ContentBlocked)) return false;
	if (is(id, Flag.PayloadRejected)) return false;
	if (opts?.replayUnsafe) return false;
	if (is(id, Flag.MalformedFunctionCall)) return true;
	return ((id ?? 0) & RETRIABLE_KINDS) !== 0;
}

function isClassified(id: number | undefined): boolean {
	return ((id ?? 0) & Flag.Class) !== 0;
}

function statusFromId(id: number | undefined): number | undefined {
	return id && !isClassified(id) ? id : undefined;
}

export function status(error: unknown): number | undefined {
	return statusInternal(error, 0);
}

function statusInternal(error: unknown, depth: number): number | undefined {
	if (depth > 2 || error === undefined || error === null) return undefined;
	if (typeof error === "object") {
		const errObj = error as Record<string, unknown>;

		if (typeof errObj.status === "number" && errObj.status >= 100 && errObj.status <= 599) {
			return errObj.status;
		}
		if (typeof errObj.statusCode === "number" && errObj.statusCode >= 100 && errObj.statusCode <= 599) {
			return errObj.statusCode;
		}
		if (typeof errObj.errorStatus === "number" && errObj.errorStatus >= 100 && errObj.errorStatus <= 599) {
			return errObj.errorStatus;
		}
		if (typeof errObj.response === "object" && errObj.response !== null) {
			const resp = errObj.response as Record<string, unknown>;
			if (typeof resp.status === "number" && resp.status >= 100 && resp.status <= 599) {
				return resp.status;
			}
		}

		if ("cause" in errObj) {
			const nested = statusInternal(errObj.cause, depth + 1);
			if (nested !== undefined) return nested;
		}
	}

	if (error instanceof Error || (typeof error === "object" && error !== null && "message" in error)) {
		const message = (error as { message: string }).message;
		if (typeof message === "string") {
			for (const pattern of STATUS_MESSAGE_PATTERNS) {
				const match = pattern.exec(message);
				if (match) {
					const code = parseInt(match[1], 10);
					if (code >= 100 && code <= 599) return code;
				}
			}
		}
	}
	return undefined;
}

export function isStreamReadErrorText(text: string): boolean {
	return STREAM_READ_ERROR_PATTERN.test(text);
}

export function isStreamEnvelopeErrorText(text: string): boolean {
	return text.includes(STREAM_ENVELOPE_ERROR_PREFIX);
}

function isTransientErrorText(text: string): boolean {
	return (
		isUnexpectedSocketCloseMessage(text) ||
		isStreamReadErrorText(text) ||
		PYTHON_HTTP2_STREAM_RESET_PATTERN.test(text) ||
		PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN.test(text) ||
		(TRANSIENT_ENVELOPE_PATTERN.test(text) && TRANSIENT_ENVELOPE_TRUNCATION_PATTERN.test(text)) ||
		TRANSIENT_TRANSPORT_PATTERN.test(text)
	);
}

function isTimeoutText(text: string): boolean {
	return TIMEOUT_PATTERN.test(text);
}

function isAuthFailureText(text: string): boolean {
	return AUTH_FAILURE_PATTERN.test(text);
}

function isStaleResponsesText(text: string): boolean {
	return (
		STALE_RESPONSE_ITEM_PATTERNS[0].test(text) ||
		(STALE_RESPONSE_ITEM_PATTERNS[1].test(text) && STALE_RESPONSE_ITEM_DETAIL_PATTERN.test(text))
	);
}

function isMalformedFunctionCallText(text: string): boolean {
	return MALFORMED_FUNCTION_CALL_PATTERN.test(text);
}

function isProviderFinishErrorText(text: string): boolean {
	return PROVIDER_FINISH_ERROR_PATTERN.test(text);
}

function isContentBlockedText(text: string): boolean {
	return CONTENT_FILTER_PATTERN.test(text);
}

function matchesOverflowText(text: string): boolean {
	return OVERFLOW_PATTERNS.some(p => p.test(text)) || OVERFLOW_NO_BODY_PATTERN.test(text);
}

// Every 4xx except 408/429 replays identically, so transient wording riding on it stays terminal.
function isTerminalClientErrorStatus(status: number | undefined): boolean {
	return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function classifyText(
	errorMessage: string | undefined,
	errorStatus: number | undefined,
	priorTokenOverflowEvidence = false,
	api?: Api,
	provider?: string,
	modelId?: string,
): number {
	let kinds = 0;
	if (errorMessage) {
		if (matchesOverflowText(errorMessage)) kinds |= Flag.ContextOverflow;
		if (matchesPayloadRejectionText(errorMessage)) kinds |= Flag.PayloadRejected;
		if (isMalformedFunctionCallText(errorMessage)) kinds |= Flag.MalformedFunctionCall;
		if (isProviderFinishErrorText(errorMessage)) kinds |= Flag.ProviderFinishError;
		if (EMPTY_RESPONSE_PATTERN.test(errorMessage)) kinds |= Flag.EmptyResponse | Flag.Transient;
		if (isContentBlockedText(errorMessage)) kinds |= Flag.ContentBlocked;
		const statusClean = errorStatus ? errorStatus : (status({ message: errorMessage }) ?? undefined);
		if (
			ACCOUNT_POLICY_PATTERN.test(errorMessage) ||
			isCodexChatGPTAccountPolicyText(errorMessage, provider, modelId) ||
			(provider === "cursor" && isCursorPlanPolicyText(errorMessage))
		) {
			kinds |= Flag.AccountPolicy | Flag.ContentBlocked;
		}
		if (isAnthropicAccountPolicyText(errorMessage, provider, statusClean)) kinds |= Flag.AccountPolicy;
		if (isAuthFailureText(errorMessage)) kinds |= Flag.AuthFailed;

		const cleanMessage = errorMessage;
		const isOpaque = isOpaqueStatusBody(cleanMessage);

		const isLimitStatus = isUsageLimitStatus(statusClean);
		const reason = parseRateLimitReason(cleanMessage);

		const is402BillingCap = statusClean === 402 && is402BillingCapBody(cleanMessage);
		// A concurrency-worded 402 is still an exhausted billing cap, mirroring isUsageLimitOutcome.
		const concurrencyExcluded = reason === "CONCURRENT_LIMIT" && statusClean !== 402;
		if (
			!concurrencyExcluded &&
			(is402BillingCap ||
				matchesUsageLimitText(cleanMessage) ||
				((statusClean === 403 || statusClean === undefined) && isAccountScopedCapText(cleanMessage)) ||
				(isLimitStatus && (isOpaque || reason === "QUOTA_EXHAUSTED")))
		) {
			kinds |= Flag.UsageLimit;
		}

		if (isTimeoutText(errorMessage)) kinds |= Flag.Transient | Flag.Timeout;
		else if (isTransientErrorText(errorMessage)) kinds |= Flag.Transient;
		// Stream truncations, statusless stream drops, and forwarded Codex body-read failures replay cleanly
		// unless they ride on a terminal 4xx (classify() carries that status down the cause chain).
		if (
			!isTerminalClientErrorStatus(statusClean) &&
			(isTransientStreamParseError(errorMessage) ||
				isTransientStreamDropError(errorMessage) ||
				CODEX_HTTP_BODY_READ_ERROR_PATTERN.test(errorMessage))
		) {
			kinds |= Flag.Transient;
		}

		if (reason === "CONCURRENT_LIMIT") kinds |= Flag.Transient;
		if ((api === "openai-responses" || api === "openai-codex-responses") && isStaleResponsesText(errorMessage)) {
			kinds |= Flag.StaleResponsesItem;
		}

		if (statusClean === 400 && GENERATION_NAN_PATTERN.test(cleanMessage)) kinds |= Flag.Transient;
		if (matchesStrictToolsRejection(cleanMessage, statusClean)) kinds |= Flag.Grammar;
		if (matchesFastModeUnsupported(cleanMessage, statusClean)) kinds |= Flag.FastModeUnsupported;
	}
	// A status-only 413 (opaque reason phrase or empty body) is a payload rejection unless token-context
	// evidence (this text, or an earlier classification pass) proves a context overflow.
	const statusEvidence = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (
		statusEvidence === 413 &&
		!priorTokenOverflowEvidence &&
		!(errorMessage && hasTokenContextOverflowEvidence(errorMessage))
	) {
		kinds |= Flag.PayloadRejected;
	}
	if (statusEvidence === 402 && (errorMessage === undefined || isOpaqueStatusBody(errorMessage))) {
		kinds |= Flag.UsageLimit;
	}
	if (kinds !== 0) return create(kinds);
	const fallbackStatus = errorStatus ?? (errorMessage ? status({ message: errorMessage }) : undefined);
	if (fallbackStatus === 401 || fallbackStatus === 403) return create(Flag.AuthFailed);
	return fallbackStatus ?? 0;
}

export function classify(error: unknown, api?: Api): number {
	let kinds = 0;
	const seen = new Set<object>();
	const causeTokenEvidence = hasCauseTokenContextOverflowEvidence(error);
	let link: unknown = error;
	let governingTerminalStatus: number | undefined;
	while (link !== undefined && link !== null) {
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);

			if ("errorId" in link && typeof (link as { errorId: unknown }).errorId === "number") {
				kinds |= (link as { errorId: number }).errorId & KIND_MASK;
			}
			if ("code" in link && typeof link.code === "string") {
				if (ACCOUNT_POLICY_PATTERN.test(link.code)) {
					kinds |= Flag.AccountPolicy | Flag.ContentBlocked;
				} else if (ANTHROPIC_ACCOUNT_POLICY_PATTERN.test(link.code)) {
					kinds |= Flag.AccountPolicy;
				}
			}
		}

		if (link instanceof AwsCredentialsError) {
			kinds |= Flag.AuthFailed;
		} else if (link instanceof AnthropicConnectionTimeoutError) {
			kinds |= Flag.Timeout | Flag.Transient;
		} else if (link instanceof AnthropicConnectionError) {
			kinds |= Flag.Transient;
		} else if (
			typeof link === "object" &&
			"name" in link &&
			(link as { name: string }).name === "CodexWebSocketTransportError"
		) {
			kinds |= Flag.Transient;
		} else if (
			link instanceof Error &&
			link.name === "CodexProviderStreamError" &&
			"retryable" in link &&
			(link as { retryable: unknown }).retryable === true
		) {
			kinds |= Flag.Transient;
		} else if (link instanceof ProviderHttpError) {
			let linkKinds = 0;
			const { status: codeStatus, code } = link;
			if (
				code === "usage_limit_reached" ||
				(code === "insufficient_quota" && !isDashScopeTokenLimitText(link.message)) ||
				(codeStatus === 402 &&
					(code === "payment_required" || code === "deactivated_workspace" || is402BillingCapBody(link.message)))
			) {
				linkKinds |= Flag.UsageLimit;
			}
			if (code === "overloaded_error" || code === "rate_limit_error") {
				linkKinds |= Flag.Transient;
			}
			if (
				code === "oauth_not_allowed_for_organization" ||
				code === "permission_error" ||
				(codeStatus === 403 && ANTHROPIC_ACCOUNT_POLICY_PATTERN.test(link.message))
			) {
				linkKinds |= Flag.AccountPolicy;
			}
			if (
				(codeStatus === 401 || codeStatus === 403) &&
				!(codeStatus === 403 && parseRateLimitReason(link.message) === "CONCURRENT_LIMIT")
			) {
				linkKinds |= Flag.AuthFailed;
			} else if (codeStatus === 429) {
				if ((linkKinds & Flag.UsageLimit) === 0) {
					linkKinds |= Flag.Transient;
				}
			} else if (codeStatus >= 500) {
				linkKinds |= Flag.Transient;
			}
			kinds |= linkKinds;
		}

		let linkMessage: string | undefined;
		if (link instanceof Error) {
			linkMessage = link.message;
		} else if (typeof link === "string") {
			linkMessage = link;
		} else if (typeof link === "object") {
			if ("message" in link && typeof link.message === "string") {
				linkMessage = link.message;
			} else if ("errorMessage" in link && typeof link.errorMessage === "string") {
				linkMessage = link.errorMessage;
			}
		}

		const linkStatus = status(link);
		const textId = classifyText(linkMessage, linkStatus ?? governingTerminalStatus, causeTokenEvidence, api);
		kinds |= textId & KIND_MASK;
		if (isTerminalClientErrorStatus(linkStatus)) governingTerminalStatus = linkStatus;

		link = typeof link === "object" && "cause" in link ? (link as { cause: unknown }).cause : undefined;
	}

	return kinds !== 0 ? create(kinds) : (status(error) ?? 0);
}

export function isUsageLimit(error: unknown, api?: Api): boolean {
	return is(classify(error, api), Flag.UsageLimit);
}

export function isAccountPolicyError(error: unknown, api?: Api): boolean {
	return is(classify(error, api), Flag.AccountPolicy);
}

export function codexChatGPTAccountPolicyModel(error: unknown, depth = 0): string | undefined {
	if (depth > 6) return undefined;
	if (typeof error === "string") return codexChatGPTAccountPolicyModelFromText(error);
	if (!error || typeof error !== "object") return undefined;
	const errorMessage =
		"errorMessage" in error && typeof error.errorMessage === "string" ? error.errorMessage : undefined;
	const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
	const direct =
		(errorMessage ? codexChatGPTAccountPolicyModelFromText(errorMessage) : undefined) ??
		(message ? codexChatGPTAccountPolicyModelFromText(message) : undefined);
	if (direct !== undefined) return direct;
	return "cause" in error ? codexChatGPTAccountPolicyModel(error.cause, depth + 1) : undefined;
}

export function isCodexChatGPTAccountPolicyError(
	error: unknown,
	provider: string,
	modelId: string | undefined,
): boolean {
	const deniedModel = codexChatGPTAccountPolicyModel(error);
	const deniedIdentity = normalizeCodexChatGPTAccountPolicyModel(deniedModel);
	const requestedIdentity = normalizeCodexChatGPTAccountPolicyModel(modelId);
	return provider === "openai-codex" && deniedIdentity !== undefined && deniedIdentity === requestedIdentity;
}

/** Whether Cursor refused the requested model under the account's plan (not a quota or capacity exhaustion). */
export function isCursorPlanAccountPolicyError(error: unknown, provider: string, depth = 0): boolean {
	if (provider !== "cursor" || depth > 6) return false;
	if (typeof error === "string") return isCursorPlanPolicyText(error);
	if (!error || typeof error !== "object") return false;
	if (
		"errorMessage" in error &&
		typeof error.errorMessage === "string" &&
		isCursorPlanPolicyText(error.errorMessage)
	) {
		return true;
	}
	if ("message" in error && typeof error.message === "string" && isCursorPlanPolicyText(error.message)) return true;
	return "cause" in error && isCursorPlanAccountPolicyError(error.cause, provider, depth + 1);
}

export function isGrammarError(error: unknown): boolean {
	return is(classify(error), Flag.Grammar);
}

export function isFastModeUnsupported(error: unknown): boolean {
	return is(classify(error), Flag.FastModeUnsupported);
}

const CLINE_PASS_SURFACE_GATE_PATTERN = /only available via cline product surfaces/i;

/**
 * Cline's gateway 403s some roster entries (certain free-tier models) outside its own product surfaces. The key
 * is valid — the gate is per-model client policy — so it must neither rotate sibling credentials (they fail
 * identically) nor surface as an auth failure.
 */
export function isClinePassSurfaceGateMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && CLINE_PASS_SURFACE_GATE_PATTERN.test(errorMessage);
}

/**
 * GitHub Copilot 403s are plan/model-policy/org denials against a valid token,
 * while revoked credentials arrive as 401. Preserve credentials when the HTTP
 * status or the normalized user-facing error identifies that policy denial.
 */
export function isGitHubCopilotPolicyDenial(
	provider: string | undefined,
	status: number | undefined,
	errorMessage: string | undefined,
): boolean {
	if (provider !== "github-copilot") return false;
	if (status === 403) return true;
	return errorMessage !== undefined && GITHUB_COPILOT_POLICY_DENIAL_PATTERN.test(errorMessage);
}

export function classifyMessage(message: {
	api?: Api;
	provider?: string;
	model?: string;
	errorId?: number;
	errorMessage?: string;
	errorClassificationMessage?: string;
	errorStatus?: number;
}): number {
	const existingId = message.errorId;
	const currentStatus = message.errorStatus ?? statusFromId(existingId);
	const existingOverflowOnly =
		existingId !== undefined && is(existingId, Flag.ContextOverflow) && !is(existingId, Flag.PayloadRejected);
	const classificationMessage = message.errorClassificationMessage ?? message.errorMessage;
	const textId = classifyText(
		classificationMessage,
		currentStatus,
		existingOverflowOnly,
		message.api,
		message.provider,
		message.model,
	);

	let kinds = ((existingId ?? 0) | textId) & KIND_MASK;
	// A bare status-bearing error classified before its body was attached stamps a status-inferred payload bit;
	// drop it when the final text proves token overflow without independent payload wording.
	if (
		currentStatus === 413 &&
		classificationMessage &&
		hasTokenContextOverflowEvidence(classificationMessage) &&
		!(textId & Flag.PayloadRejected)
	) {
		kinds &= ~Flag.PayloadRejected;
	}
	if (classificationMessage && LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(classificationMessage)) {
		kinds &= ~Flag.Transient;
	}
	const id = kinds !== 0 ? create(kinds) : (statusFromId(textId) ?? statusFromId(existingId) ?? currentStatus ?? 0);

	message.errorId = id;
	return id;
}

export function attach<E extends object>(error: E, id: number): E {
	Object.defineProperty(error, "errorId", { value: id, enumerable: false, configurable: true });
	return error;
}

export interface ContextOverflowMessage extends Pick<AssistantMessage, "errorId" | "stopReason" | "errorMessage"> {
	readonly usage?: Pick<Usage, "input" | "cacheRead" | "cacheWrite">;
}

/** Provider-reported input usage above the window: authoritative overflow, owned by compaction. */
export function isUsageBackedContextOverflow(message: ContextOverflowMessage, contextWindow?: number): boolean {
	const usage = message.usage;
	if (!contextWindow || !usage) return false;
	return usage.input + usage.cacheRead + usage.cacheWrite > contextWindow;
}

export function isContextOverflow(message: ContextOverflowMessage, contextWindow?: number): boolean {
	if (is(message.errorId, Flag.ContextOverflow)) return true;
	if (isUsageBackedContextOverflow(message, contextWindow)) return true;
	return message.stopReason === "error" && !!message.errorMessage && matchesOverflowText(message.errorMessage);
}

/** HTTP 413 byte/media rejection: token compaction cannot shrink it. May co-occur with context overflow for
 *  bare `413 (no body)` and media-budget limits. */
export function isPayloadRejection(message: AssistantMessage): boolean {
	if (is(message.errorId, Flag.PayloadRejected)) return true;
	const { errorMessage } = message;
	if (message.stopReason !== "error" || !errorMessage) return false;
	return matchesPayloadRejectionText(errorMessage);
}

/** Overflow co-flagged as a payload rejection without provider-reported token excess: a different provider's
 *  larger byte/media budget may accept the same request. */
export function isTextAmbiguousContextOverflow(
	errorId: number,
	message: ContextOverflowMessage | undefined,
	contextWindow?: number,
): boolean {
	const overflowFlagged =
		is(errorId, Flag.ContextOverflow) || (message !== undefined && isContextOverflow(message, contextWindow));
	if (!overflowFlagged) return false;
	if (!is(errorId, Flag.PayloadRejected)) return false;
	return !(message !== undefined && isUsageBackedContextOverflow(message, contextWindow));
}

export function stringify(id: number | undefined): string {
	if (!id) return "none";
	if (!isClassified(id)) return `status:${id}`;
	const labels = ERROR_KIND_LABELS.filter(([kind]) => is(id, kind)).map(([, label]) => label);
	return labels.length > 0 ? labels.join("|") : `classified:0x${id.toString(16)}`;
}

const STREAM_PARSE_TRUNCATION_PATTERN =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
const STREAM_PARSE_DIAGNOSTIC_PATTERN =
	/(?:json parse error:\s*(?:unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated)|json\.parse:\s*(?:unterminated string|unexpected end of data)|unexpected end of json input|unexpected eof|eof while parsing)/i;
const STREAM_EVENT_ORDER_PATTERN = /stream event order|before message_start/i;

export function isTransientStreamParseError(error: unknown): boolean {
	if (typeof error === "string") return STREAM_PARSE_DIAGNOSTIC_PATTERN.test(error);
	return error instanceof Error && STREAM_PARSE_TRUNCATION_PATTERN.test(error.message);
}

// Transport-level stream drops before a terminal event: the statusless twin of `408 stream disconnected`.
const STREAM_DROP_PATTERN =
	/stream disconnected before completion|stream closed before response\.completed|stream was interrupted|stream ended before terminal (?:chunk|completion event)|socket disconnected before secure tls connection/i;

export function isTransientStreamDropError(error: unknown): boolean {
	if (typeof error === "string") return STREAM_DROP_PATTERN.test(error);
	return error instanceof Error && STREAM_DROP_PATTERN.test(error.message);
}

export function isStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) || STREAM_EVENT_ORDER_PATTERN.test(error.message))
	);
}

export function isRetryableStreamEnvelopeError(error: unknown): boolean {
	return error instanceof Error && STREAM_EVENT_ORDER_PATTERN.test(error.message);
}
