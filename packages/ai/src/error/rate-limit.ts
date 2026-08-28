import { extractRetryHint } from "@oh-my-pi/pi-utils/fetch-retry";

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "INSUFFICIENT_G1_CREDITS_BALANCE"
	| "RATE_LIMIT_EXCEEDED"
	| "CONCURRENT_LIMIT"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000;
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000;
const CONCURRENT_LIMIT_BACKOFF_MS = 5 * 1000;
const MODEL_CAPACITY_BASE_MS = 45 * 1000;
const MODEL_CAPACITY_JITTER_MS = 30 * 1000;
const SERVER_ERROR_BACKOFF_MS = 20 * 1000;

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
const SPEND_LIMIT_PATTERN = /spend.?limit/i;
const SUBSCRIPTION_CAP_PATTERN =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

function matchesSubscriptionCapText(errorMessage: string): boolean {
	return SUBSCRIPTION_CAP_PATTERN.test(errorMessage) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(errorMessage);
}
const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;

const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;
const CONCURRENT_LIMIT_PATTERN =
	/\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const ACCOUNT_SCOPED_403_PATTERN =
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;

const CN_QUOTA_EXHAUSTED_PATTERN = /使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;

const CN_TRANSIENT_CAP_PATTERN =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;

const CN_THROTTLE_PATTERN = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;

const DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN = /error-code[^()\s]*#token-limit/i;
const DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN =
	/\byou exceeded your current quota, please check your plan and billing details\b/i;

export function isDashScopeTokenLimitText(errorMessage: string): boolean {
	return (
		DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN.test(errorMessage) && DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN.test(errorMessage)
	);
}

const GOOGLE_RPC_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const LONG_RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseJsonBody(errorMessage: string): Record<string, unknown> | undefined {
	const start = errorMessage.indexOf("{");
	const end = errorMessage.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	try {
		const parsed: unknown = JSON.parse(errorMessage.slice(start, end + 1));
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

function parseGoogleRpcRateLimitReason(errorMessage: string): RateLimitReason | undefined {
	const body = parseJsonBody(errorMessage);
	const error = asRecord(body?.error);
	if (typeof error?.status !== "string" || error.status.trim().toUpperCase() !== "RESOURCE_EXHAUSTED") {
		return undefined;
	}
	if (!Array.isArray(error.details)) return undefined;

	for (const value of error.details) {
		const detail = asRecord(value);
		if (detail?.["@type"] !== GOOGLE_RPC_ERROR_INFO_TYPE || typeof detail.reason !== "string") continue;
		const reason = detail.reason.trim().toUpperCase();
		switch (reason) {
			case "QUOTA_EXHAUSTED":
				return "QUOTA_EXHAUSTED";
			case "INSUFFICIENT_G1_CREDITS_BALANCE":
				return "INSUFFICIENT_G1_CREDITS_BALANCE";
			case "RATE_LIMIT_EXCEEDED": {
				const retryDelayMs = extractRetryHint(undefined, errorMessage);
				return retryDelayMs !== undefined && retryDelayMs >= LONG_RATE_LIMIT_DELAY_MS
					? "QUOTA_EXHAUSTED"
					: "RATE_LIMIT_EXCEEDED";
			}
		}
	}
	return undefined;
}

function isQuotaExhaustedReason(reason: RateLimitReason): boolean {
	return reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE";
}

export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
	if (structuredReason !== undefined) return structuredReason;
	const lowerWithStatus = errorMessage.toLowerCase();
	const lower = lowerWithStatus.replace(RESOURCE_EXHAUSTED_PATTERN, "");
	const hasResourceExhaustedStatus = lower !== lowerWithStatus;

	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (isDashScopeTokenLimitText(errorMessage)) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (CONCURRENT_LIMIT_PATTERN.test(errorMessage)) {
		return "CONCURRENT_LIMIT";
	}

	if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (SPEND_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (matchesSubscriptionCapText(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	if (hasResourceExhaustedStatus) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	return "UNKNOWN";
}

export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "INSUFFICIENT_G1_CREDITS_BALANCE":
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "CONCURRENT_LIMIT":
			return CONCURRENT_LIMIT_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS;
	}
}

const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked/i;

export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}

export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	const structuredReason = message ? parseGoogleRpcRateLimitReason(message) : undefined;
	if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);

	const isBillingCapStatus = status === 402;
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (message && matchesUsageLimitText(message)) return true;

	if ((status === 403 || status === undefined) && message && isAccountScopedCapText(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	const reason = parseRateLimitReason(message);

	return isQuotaExhaustedReason(reason) || (isBillingCapStatus && reason === "CONCURRENT_LIMIT");
}

export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");

	return (
		!/[a-z\d]{3,}/i.test(cleaned) &&
		!CN_QUOTA_EXHAUSTED_PATTERN.test(cleaned) &&
		!CN_TRANSIENT_CAP_PATTERN.test(cleaned) &&
		!CN_THROTTLE_PATTERN.test(cleaned)
	);
}

export function matchesUsageLimitText(errorMessage: string): boolean {
	const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
	if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
	if (isDashScopeTokenLimitText(errorMessage)) return false;
	return (
		USAGE_LIMIT_PATTERN.test(errorMessage) ||
		(CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) ||
		SPEND_LIMIT_PATTERN.test(errorMessage) ||
		ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
		matchesSubscriptionCapText(errorMessage) ||
		OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)
	);
}

export function isAccountScopedCapText(message: string): boolean {
	return ACCOUNT_SCOPED_403_PATTERN.test(message);
}

export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}
