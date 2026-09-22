import { type } from "@oh-my-pi/omptype";
import type { FetchImpl, Provider } from "./types";
export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface UsageWindow {
	id: string;

	label: string;

	durationMs?: number;

	resetsAt?: number;

	resetLabel?: string;
}

export interface UsageAmount {
	used?: number;

	limit?: number;

	remaining?: number;

	usedFraction?: number;

	remainingFraction?: number;

	unit: UsageUnit;
}

export interface UsageScope {
	provider: Provider;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	modelId?: string;
	tier?: string;
	windowId?: string;
	shared?: boolean;
}

export interface UsageLimit {
	id: string;

	label: string;
	scope: UsageScope;
	window?: UsageWindow;
	amount: UsageAmount;
	status?: UsageStatus;
	notes?: string[];
}

/**
 * Per-credit detail for a saved/banked rate-limit reset.
 *
 * Populated when the provider's listing endpoint returns individual credit
 * metadata (e.g. OpenAI Codex credits or Claude Cedar grants). Callers that
 * only need the count can ignore this; display layers use `expiresAt` to show
 * when banked resets expire ([#3339](https://github.com/can1357/oh-my-pi/issues/3339)).
 */
export interface UsageResetCreditDetail {
	/** Opaque provider credit/grant identifier. */
	id?: string;
	/** Human-facing name for the reset. */
	title?: string;
	/** Provider reset program/family. */
	program?: string;
	/** Resets still banked in this credit/grant. */
	remainingCount?: number;
	/** Whether the provider says this credit can be redeemed now. */
	usable?: boolean;
	/** Whether redemption requires an exhausted covered limit. */
	requiresLimit?: boolean;
	/** Normalized {@link UsageLimit.id}s this credit resets. */
	clears?: string[];
	/** Normalized limit ids currently preventing redemption. */
	blocking?: string[];
	/** Used fractions for covered limits, keyed by normalized limit id. */
	usedFractions?: Record<string, number>;
	/** ISO timestamp when the credit was granted. */
	grantedAt?: string;

	expiresAt?: string;

	status?: string;
}

/** Reset credit carrying the provider id required by its consume endpoint. */
export interface UsageResetCredit extends UsageResetCreditDetail {
	id: string;
}

/**
 * Saved/banked rate-limit resets an account can redeem on demand.
 *
 * Surfaced by providers that let users defer a usage-window reset and spend it
 * later (OpenAI Codex and Claude Cedar resets). The redeem itself is a
 * separate, provider-specific action; this is the read-only state for display.
 */
export interface UsageResetCredits {
	/** Number of banked resets, including grants that are not currently usable. */
	availableCount: number;
	/** Number of resets the provider says can be redeemed now. */
	redeemableCount?: number;
	/** Provider-selected credit/grant eligible for the next redemption. */
	nextCreditId?: string;
	/** Whether this account is eligible for the reset program. */
	eligible?: boolean;
	/** Provider reason the program or its credits are unavailable. */
	reason?: string;
	/** ISO timestamp until which redemption is cooling down. */
	cooldownUntil?: string;
	/** Individual credit details (expiry dates, coverage, etc.) when exposed. */
	credits?: UsageResetCreditDetail[];
}

export interface UsageReport {
	provider: Provider;
	fetchedAt: number;
	limits: UsageLimit[];

	resetCredits?: UsageResetCredits;

	notes?: string[];
	metadata?: Record<string, unknown>;
	raw?: unknown;
}

export function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

export interface UsageHistoryEntry {
	recordedAt: number;
	provider: Provider;

	accountKey: string;
	email?: string;
	accountId?: string;

	limitId: string;

	label: string;
	windowLabel?: string;

	usedFraction?: number;
	status?: UsageStatus;

	resetsAt?: number;
}

export interface UsageHistoryQuery {
	provider?: string;

	sinceMs?: number;
}

export interface ObservedUsageEntry {
	at: number;
	provider: Provider;
	model: string;

	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;

	costUsd: number;
}

export interface ClientUsageReport {
	installId: string;

	hostname?: string;
	entries: ObservedUsageEntry[];
}

export interface ClientProviderUsage {
	provider: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

export interface ClientUsageClientSummary {
	installId: string;
	hostname?: string;
	firstSeen: number;
	lastSeen: number;
	providers: ClientProviderUsage[];
}

export interface ClientUsageSummary {
	clients: ClientUsageClientSummary[];
}

export const usageUnitSchema = type("'percent' | 'tokens' | 'requests' | 'usd' | 'minutes' | 'bytes' | 'unknown'");
export const usageStatusSchema = type("'ok' | 'warning' | 'exhausted' | 'unknown'");

export const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
	"resetLabel?": "string",
});

export const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: usageUnitSchema,
});

export const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
});

export const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": usageStatusSchema,
	"notes?": "string[]",
});

export const usageResetCreditDetailSchema = type({
	"id?": "string",
	"title?": "string",
	"program?": "string",
	"remainingCount?": "number",
	"usable?": "boolean",
	"requiresLimit?": "boolean",
	"clears?": "string[]",
	"blocking?": "string[]",
	"usedFractions?": { "[string]": "number" },
	"grantedAt?": "string",
	"expiresAt?": "string",
	"status?": "string",
});

export const usageResetCreditsSchema = type({
	availableCount: "number",
	"redeemableCount?": "number",
	"nextCreditId?": "string",
	"eligible?": "boolean",
	"reason?": "string",
	"cooldownUntil?": "string",
	"credits?": usageResetCreditDetailSchema.array(),
});

export const usageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"notes?": "string[]",
	"metadata?": { "[string]": "unknown" },

	"raw?": "unknown",
});

export interface UsageLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

export interface UsageCredential {
	type: "api_key" | "oauth";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	projectId?: string;
	email?: string;

	orgId?: string;

	orgName?: string;
	enterpriseUrl?: string;
	metadata?: Record<string, unknown>;
	apiEndpoint?: string;
}

export interface UsageFetchParams {
	provider: Provider;
	credential: UsageCredential;

	accountKey?: string;
	baseUrl?: string;
	signal?: AbortSignal;
}

export interface UsageFetchContext {
	fetch: FetchImpl;
	logger?: UsageLogger;
	retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface UsageProvider {
	id: Provider;
	fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null>;

	parseRateLimitHeaders?(headers: Record<string, string>, now?: number): UsageReport | null;
	supports?(params: UsageFetchParams): boolean;

	validatesCredentials?: boolean;

	retainLastGoodOnFailure?: boolean;
}

export interface CredentialRankingContext {
	modelId?: string;
}

export interface CredentialRankingStrategy {
	findWindowLimits(
		report: UsageReport,
		context?: CredentialRankingContext,
	): {
		primary?: UsageLimit;
		secondary?: UsageLimit;
	};

	scopeLimits?(report: UsageReport, context?: CredentialRankingContext): UsageLimit[];

	scopeLimitsForReserve?(report: UsageReport, context?: CredentialRankingContext): UsageLimit[];

	blockScope?(context?: CredentialRankingContext): string | undefined;

	/**
	 * Backoff scopes a fresh usage report can vouch for, each with the limits
	 * gating it. {@link AuthStorage} clears a stale block under a returned scope
	 * once every listed limit is below exhaustion, so a 429 whose retry-after
	 * overstated the real reset does not sideline a recovered account until the
	 * clock runs out. Scopes not returned expire by clock only. Codex heals
	 * through its meter metadata instead and omits this.
	 */
	healableBlockScopes?(report: UsageReport): { blockScope: string; limits: UsageLimit[] }[];

	blockScopes?(context?: CredentialRankingContext): string[];

	windowDefaults: {
		primaryMs: number;
		secondaryMs: number;
	};

	hasPriorityBoost?(primary: UsageLimit | undefined): boolean;
}
