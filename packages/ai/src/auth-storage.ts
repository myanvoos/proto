import { createHash } from "node:crypto";
import { $env, $envExact, extractRetryHint, getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import {
	isSqliteCorruptionError,
	resolveCredentialIdentityKey,
	SqliteAuthCredentialStore,
	serializeCredential,
	USAGE_REPORT_TTL_MS,
} from "./auth/sqlite-credential-store";
import type { ApiKeyResolver } from "./auth-retry";
import * as AIError from "./error";
import { isUsageLimitOutcome } from "./error/rate-limit";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "./registry";
import { getOAuthApiKey, getOAuthProvider, refreshOAuthToken } from "./registry/oauth";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
} from "./registry/oauth/types";
import { getEnvApiKey, getEnvApiKeyName } from "./stream";
import type { Provider } from "./types";
import type {
	ClientUsageReport,
	ClientUsageSummary,
	CredentialRankingContext,
	CredentialRankingStrategy,
	ObservedUsageEntry,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";
import { resolveUsedFraction } from "./usage";
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./usage/alibaba-token-plan";
import { claudeRankingStrategy, claudeUsageProvider } from "./usage/claude";
import { cursorUsageProvider } from "./usage/cursor";
import { googleGeminiCliUsageProvider } from "./usage/gemini";
import { githubCopilotUsageProvider } from "./usage/github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./usage/google-antigravity";
import { kimiRankingStrategy, kimiUsageProvider } from "./usage/kimi";
import { minimaxCodeUsageProvider } from "./usage/minimax-code";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./usage/ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./usage/openai-codex";
import {
	type CodexResetConsumeCode,
	type CodexResetCredit,
	consumeCodexResetCredit,
	listCodexResetCredits,
	pickSoonestExpiringCredit,
} from "./usage/openai-codex-reset";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./usage/opencode-go";
import { syntheticUsageProvider } from "./usage/synthetic";
import { umansUsageProvider } from "./usage/umans";
import { xaiOauthUsageProvider } from "./usage/xai-oauth";
import { zaiRankingStrategy, zaiUsageProvider } from "./usage/zai";

export {
	isSqliteBusyError,
	isSqliteCorruptionError,
	SqliteAuthCredentialStore,
} from "./auth/sqlite-credential-store";

const USAGE_RANKING_METRIC_EPSILON = 1e-9;

const PRIMARY_WINDOW_HOT_FRACTION = 0.85;
const OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT = 8;

function fingerprintOAuthBearer(bearer: string): string {
	return createHash("sha256").update(bearer).digest("base64url");
}
const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";

const ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS = 60 * 60_000;

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	source?: "login";
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

export type CredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

export interface CredentialOrigin {
	kind: CredentialOriginKind;

	envVar?: string;
}

export interface SerializedAuthStorage {
	credentials: Record<
		string,
		Array<{
			id: number;
			type: "api_key" | "oauth";
			data: Record<string, unknown>;
		}>
	>;
	runtimeOverrides?: Record<string, string>;
	dbPath?: string;
}

export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}

export interface StoredCredentialBlock {
	credentialId: number;

	providerKey: string;

	blockScope: string;

	blockedUntilMs: number;

	updatedAtMs?: number;
}

export interface DisabledCredentialSummary {
	id: number;
	provider: string;
	type: AuthCredential["type"];
	email?: string;
	accountId?: string;

	orgId?: string;
	orgName?: string;

	cause: string;

	disabledAtMs?: number;
}

export interface CredentialHealthResult {
	id: number;
	provider: string;
	type: AuthCredential["type"];

	email?: string;

	accountId?: string;

	orgId?: string;
	orgName?: string;

	remoteRefresh?: true;
	ok: boolean | null;

	reason?: string;

	report?: Omit<UsageReport, "raw">;

	completion?: CredentialCompletionResult;
}

export interface CredentialCompletionResult {
	ok: boolean | null;

	reason?: string;

	modelId?: string;

	latencyMs?: number;
}

export type CompletionProbeCredential =
	| { type: "api_key"; apiKey: string }
	| {
			type: "oauth";
			accessToken: string;
			refreshToken?: string;
			expiresAt?: number;
			accountId?: string;
			projectId?: string;
			email?: string;
			enterpriseUrl?: string;
			apiEndpoint?: string;
	  };

export interface CompletionProbeInput {
	provider: Provider;
	credentialId: number;
	credential: CompletionProbeCredential;
	signal: AbortSignal;
}

export type CompletionProbe = (input: CompletionProbeInput) => Promise<CredentialCompletionResult>;

export interface CheckCredentialsOptions {
	signal?: AbortSignal;

	timeoutMs?: number;

	baseUrlResolver?: (provider: Provider) => string | undefined;

	completionProbe?: CompletionProbe;

	completionTimeoutMs?: number;
}

export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;
export type RemoteRefreshSentinel = typeof REMOTE_REFRESH_SENTINEL;

export type RemoteOAuthCredential = Omit<OAuthCredential, "refresh"> & {
	refresh: RemoteRefreshSentinel;
};

export type SnapshotCredential = ApiKeyCredential | RemoteOAuthCredential;

export interface AuthCredentialSnapshotEntry {
	id: number;
	provider: string;
	credential: SnapshotCredential;
	identityKey: string | null;
}

export interface AuthCredentialSnapshot {
	generation: number;
	generatedAt: number;
	credentials: AuthCredentialSnapshotEntry[];
}

export interface CredentialRefreshLeaseFence {
	owner: string;
	nowMs: number;
}

export interface AuthCredentialStore {
	close(): void;

	pollExternalChanges?(): boolean;

	acknowledgeLocalChanges?(): void;

	invalidateUsageCache?(signal?: AbortSignal): Promise<void>;
	listAuthCredentials(provider?: string): StoredAuthCredential[];

	refreshSnapshot?(): Promise<unknown>;

	listDisabledCredentials?(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]>;
	updateAuthCredential(id: number, credential: AuthCredential): void;
	deleteAuthCredential(id: number, disabledCause: string): void;
	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	tryUpdateAuthCredentialIfMatches?(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[];
	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[];
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void;
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;

	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;

	getCredentialBlock?(credentialId: number, providerKey: string, blockScope: string): number | undefined;

	getCredentialBlockReconcileAfter?(credentialId: number, providerKey: string, blockScope: string): number | undefined;

	upsertCredentialBlock?(block: StoredCredentialBlock): void;

	deleteCredentialBlock?(credentialId: number, providerKey: string, blockScope: string): void;

	deleteCredentialBlocks?(credentialId: number): void;

	cleanExpiredCredentialBlocks?(nowMs: number): void;

	listCredentialBlocks?(credentialIds: readonly number[]): StoredCredentialBlock[];
	tryAcquireCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;
	getCredentialRefreshLeaseExpiresAt?(credentialId: number): number | undefined;
	releaseCredentialRefreshLease?(credentialId: number, owner: string): void;
	renewCredentialRefreshLease?(credentialId: number, owner: string, expiresAtMs: number): boolean;

	recordUsageSnapshots?(entries: UsageHistoryEntry[]): void;

	listUsageHistory?(query?: UsageHistoryQuery): UsageHistoryEntry[];

	recordObservedUsage?(entries: ObservedUsageEntry[]): void;

	recordClientUsage?(report: ClientUsageReport): void;

	getClientUsageSummary?(sinceMs: number): ClientUsageSummary;

	refreshOAuthCredential?(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials>;

	prepareForRequest?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;

	fetchUsageReports?(signal?: AbortSignal): Promise<UsageReport[] | null>;

	getUsageReport?(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;

	ingestUsageReport?(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean;

	markCredentialSuspect?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;

	upsertAuthCredentialRemote?(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;

	replaceAuthCredentialsRemote?(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;

	deleteAuthCredentialRemote?(id: number, disabledCause: string): Promise<boolean>;

	deleteAuthCredentialsRemote?(provider: string, disabledCause: string): Promise<void>;
}

export interface CredentialDisabledEvent {
	provider: string;
	disabledCause: string;
}

export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;

	configValueResolver?: (config: string) => Promise<string | undefined>;

	onCredentialDisabled?: (event: CredentialDisabledEvent) => void | Promise<void>;

	refreshOAuthCredential?: (
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	) => Promise<OAuthCredentials>;

	sourceLabel?: string;

	fetchUsageReports?: (signal?: AbortSignal) => Promise<UsageReport[] | null>;
};

async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = $envExact(config);
	return envValue || config;
}

const DEFAULT_USAGE_PROVIDERS: UsageProvider[] = [
	alibabaTokenPlanUsageProvider,
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	zaiUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
	syntheticUsageProvider,
	xaiOauthUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

const USAGE_CACHE_PREFIX = "usage_cache:";
const USAGE_FORCE_REFRESH_CACHE_PREFIX = "force-refresh:";
const USAGE_HEADER_INGEST_INTERVAL_MS = 60_000;
const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;

const USAGE_FAILURE_BACKOFF_MS = 10_000;

const USAGE_FORCE_REFRESH_TTL_MS = 5 * 60_000;

const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES: Partial<Record<Provider, number>> = {
	"google-antigravity": 2,
	zai: 2,

	"opencode-go": 2,

	anthropic: 3,
};
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
const OAUTH_REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

const OAUTH_REFRESH_SKEW_MS = 60_000;
const OAUTH_REFRESH_LEASE_TTL_MS = 15_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 50;
const OAUTH_REFRESH_LEASE_RENEW_MS = 5_000;
const OAUTH_REFRESH_OPERATION_TIMEOUT_MS = 10_000;

const MAX_PENDING_DISABLED_EVENTS = 32;

export { isDefinitiveOAuthFailure } from "./error/auth-classify";

export interface UsageLimitMarkResult {
	switched: boolean;
	retryAtMs?: number;
}

export type ModelUsageHealthState = "healthy" | "reserve" | "depleted" | "unknown";

export interface ModelUsageAccountHealth {
	credentialId: number;
	credentialType: AuthCredential["type"];

	selected?: true;
	state: ModelUsageHealthState;
	remainingFraction?: number;
	resetsAt?: number;
}

export interface ModelUsageHealth {
	state: ModelUsageHealthState;
	accounts: ModelUsageAccountHealth[];
}

export interface ModelUsageHealthOptions {
	modelId?: string;
	sessionId?: string;
	baseUrl?: string;
	reserveFraction: number;
	signal?: AbortSignal;
}

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	deletePrefix(prefix: string): boolean;
	cleanup?(): void;
}

type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

type ForcedUsageRefresh = {
	all: boolean;
	providers: Set<Provider>;
};

type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;

	signal?: AbortSignal;

	forceRefresh?: boolean;
};
type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

export interface OAuthAccess {
	accessToken: string;
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;

	orgId?: string;
	orgName?: string;
}

export interface OAuthLoginIdentity {
	type: "oauth" | "api_key";
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
}

export interface OAuthAccessFailure {
	credentialId?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	apiEndpoint?: string;

	orgId?: string;
	orgName?: string;
	error: string;
}

export interface OAuthAccountIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;

	orgId?: string;
	orgName?: string;
}

export type OAuthAccessResolution = ({ ok: true } & OAuthAccess) | ({ ok: false } & OAuthAccessFailure);

export interface OAuthAccountSummary {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;

	orgId?: string;
	orgName?: string;

	active: boolean;
}
export interface InvalidateCredentialMatchingOptions {
	signal?: AbortSignal;
	sessionId?: string;
}

export interface StoredOAuthRefreshOptions<T extends OAuthCredential = OAuthCredential> {
	credentialId?: number;
	observedCredential?: T;
	credentialFromRow: (credential: OAuthCredential) => T | undefined;
	forceRefresh?: boolean;
	canRefresh?: (credential: T) => boolean;
	refreshSkewMs?: number;
	signal?: AbortSignal;
	keepCredentialOnRefreshFailure?: boolean | ((error: unknown) => boolean);
	onRefreshFailure?: (error: unknown) => void;
	refreshTimeoutMs?: number;
	refresh: (credential: T, signal?: AbortSignal) => Promise<OAuthCredentials>;
	mergeRefreshedCredential?: (credential: T, refreshed: OAuthCredentials) => T;
	isDefinitiveFailure?: (error: unknown) => boolean;
	disabledCause?: (error: unknown) => string;
}

export interface StoredOAuthRefreshResult<T extends OAuthCredential = OAuthCredential> {
	credential: T | undefined;
	refreshed: boolean;
	removed: boolean;
}

export interface ResetCreditTarget {
	credentialId?: number;
	accountId?: string;
	email?: string;
}

export interface ResetCreditRedeemOutcome {
	ok: boolean;

	code: CodexResetConsumeCode;
	accountId?: string;
	email?: string;

	creditId?: string;
}

export interface ResetCreditAccountStatus {
	credentialId?: number;
	accountId?: string;
	email?: string;

	availableCount: number;
	credits: CodexResetCredit[];

	active: boolean;

	error?: string;
}

function isAbortSignalOption(
	value: InvalidateCredentialMatchingOptions | AbortSignal | undefined,
): value is AbortSignal {
	return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

type OpenAICodexPlanRequirement = "none" | "paid" | "pro";
type OpenAICodexPlanClass = "free" | "paid" | "pro" | "unknown";

const GPT_56_PAID_CODEX_MODEL_PATTERN = /^gpt-5\.6-(?:sol|luna)(?:-pro)?$/;
const OPENAI_CODEX_PRO_PLAN_TOKENS: Record<string, true> = {
	pro: true,
};
const OPENAI_CODEX_PAID_PLAN_TOKENS: Record<string, true> = {
	plus: true,
	business: true,
	team: true,
	enterprise: true,
	edu: true,
	education: true,
	teacher: true,
	teachers: true,
	health: true,
	gov: true,
	government: true,
};
const OPENAI_CODEX_FREE_PLAN_TOKENS: Record<string, true> = {
	free: true,
	go: true,
};

function resolveOpenAICodexPlanRequirement(provider: string, modelId: string | undefined): OpenAICodexPlanRequirement {
	if (provider !== "openai-codex" || typeof modelId !== "string") return "none";
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).toLowerCase();
	if (bareModelId.includes("-spark")) return "pro";
	if (bareModelId === "gpt-5.6" || GPT_56_PAID_CODEX_MODEL_PATTERN.test(bareModelId)) return "paid";
	return "none";
}

const MODEL_ACCOUNT_POLICY_BLOCK_SCOPE_PREFIX = "model-policy:";

function modelAccountPolicyBlockScope(provider: string, modelId: string | undefined): string | undefined {
	if (provider !== "openai-codex" || typeof modelId !== "string") return undefined;
	const separator = modelId.lastIndexOf("/");
	const bareModelId = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
	if (!bareModelId || bareModelId.includes("\0")) return undefined;
	return `${MODEL_ACCOUNT_POLICY_BLOCK_SCOPE_PREFIX}${bareModelId}`;
}

function credentialBlockScopesForRequest(
	provider: string,
	strategy: CredentialRankingStrategy | undefined,
	rankingContext: CredentialRankingContext,
	blockScope: string | undefined,
): readonly string[] {
	const scopes = strategy?.blockScopes?.(rankingContext) ?? (blockScope ? [blockScope] : []);
	const modelPolicyScope = modelAccountPolicyBlockScope(provider, rankingContext.modelId);
	if (!modelPolicyScope || scopes.includes(modelPolicyScope)) return scopes;
	return [...scopes, modelPolicyScope];
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata) return undefined;
	const planType = metadata.planType;
	if (typeof planType !== "string") return undefined;
	const normalized = planType
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

function classifyOpenAICodexPlan(report: UsageReport | null): OpenAICodexPlanClass {
	const planType = getUsagePlanType(report);
	if (!planType) return "unknown";

	if (planType === "prolite" || planType === "pro_lite") return "paid";
	const tokens = planType.split("_");
	if (tokens.some(token => OPENAI_CODEX_PRO_PLAN_TOKENS[token] === true)) return "pro";
	if (tokens.some(token => OPENAI_CODEX_PAID_PLAN_TOKENS[token] === true)) return "paid";
	if (tokens.some(token => OPENAI_CODEX_FREE_PLAN_TOKENS[token] === true)) return "free";
	return "unknown";
}

function getOpenAICodexPlanEligibility(
	report: UsageReport | null,
	requirement: OpenAICodexPlanRequirement,
): boolean | undefined {
	if (requirement === "none") return true;
	const planClass = classifyOpenAICodexPlan(report);
	if (planClass === "unknown") return undefined;
	return requirement === "paid" ? planClass !== "free" : planClass === "pro";
}

function getOpenAICodexPlanPriority(report: UsageReport | null, requirement: OpenAICodexPlanRequirement): number {
	const eligibility = getOpenAICodexPlanEligibility(report, requirement);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
}

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return DEFAULT_USAGE_PROVIDER_MAP.get(provider);
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	["alibaba-token-plan", alibabaTokenPlanRankingStrategy],
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
]);

function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		return undefined;
	}
}

function raceUsageWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.AbortError("usage fetch aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new AIError.AbortError("usage fetch aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			err => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

function raceCredentialRefreshWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	message = "credential refresh aborted",
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.AbortError(message));
	const abort = Promise.withResolvers<never>();
	const onAbort = (): void => abort.reject(new AIError.AbortError(message));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, abort.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

function authCredentialEquals(left: AuthCredential, right: AuthCredential): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "api_key") {
		return right.type === "api_key" && left.key === right.key;
	}
	if (right.type !== "oauth") return false;
	return (
		left.access === right.access &&
		left.refresh === right.refresh &&
		left.expires === right.expires &&
		left.accountId === right.accountId &&
		left.email === right.email &&
		left.projectId === right.projectId &&
		left.enterpriseUrl === right.enterpriseUrl
	);
}

function storedCredentialArraysEqual(left: StoredCredential[], right: StoredCredential[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const leftEntry = left[index];
		const rightEntry = right[index];
		if (!leftEntry || !rightEntry) return false;
		if (leftEntry.id !== rightEntry.id) return false;
		if (!authCredentialEquals(leftEntry.credential, rightEntry.credential)) return false;
	}
	return true;
}

class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	getStale<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`, { includeExpired: true });
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({ value: entry.value, expiresAt: entry.expiresAt });
		const durableExpiresAt =
			entry.value === null ? entry.expiresAt : Math.max(entry.expiresAt, Date.now() + USAGE_LAST_GOOD_RETENTION_MS);
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(durableExpiresAt / 1000));
	}

	deletePrefix(prefix: string): boolean {
		if (!this.store.deleteCachePrefix) return false;
		this.store.deleteCachePrefix(`${USAGE_CACHE_PREFIX}${prefix}`);
		return true;
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}

type StoredCredential = { id: number; credential: AuthCredential };
type CredentialSelection<T extends AuthCredential> = { credential: T; index: number };
type OAuthSelection = CredentialSelection<OAuthCredential>;
type ApiKeySelection = CredentialSelection<ApiKeyCredential>;
type StoredOAuthSelection = { credentialId: number; credential: OAuthCredential; index: number };

type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
};

type OAuthCandidate = UsageCandidate<OAuthCredential>;
type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & { blockedUntil: number | undefined };

type CredentialBlockRouting = {
	providerKey: string;
	strategy: CredentialRankingStrategy | undefined;
	rankingContext: CredentialRankingContext;
	blockScope: string | undefined;
	siblingBlockScopes: readonly string[];
};

type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	hasPriorityBoost: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};
type RankedOAuthCandidate = UsageRankedCandidate<OAuthCredential>;
type RankedApiKeyCandidate = UsageRankedCandidate<ApiKeyCredential>;

export class AuthStorage {
	static readonly #defaultBackoffMs = 60_000;

	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();

	#providerRoundRobinIndex: Map<string, number> = new Map();

	#sessionLastCredential: Map<
		string,
		Map<string, { type: AuthCredential["type"]; index: number; lastUsedAtMs?: number }>
	> = new Map();

	#oauthBearerFingerprints: Map<string, Map<number, string[]>> = new Map();

	#credentialBackoff: Map<string, Map<number, number>> = new Map();

	#credentialBackoffProbeAfter: Map<string, Map<number, number>> = new Map();

	#persistedBlockStoreDamaged = false;
	#usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;

	#runtimeUsageProviderOverrides: Map<Provider, { provider: UsageProvider; apiKey?: string }> = new Map();
	#usageReportCacheKeysByProvider: Map<Provider, Set<string>> = new Map();
	#rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageCacheEpoch = 0;
	#usageRequestInFlight: Map<string, Promise<UsageReport | null>> = new Map();
	#usageHeaderIngestAt: Map<string, number> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	#usageFetch: typeof fetch;
	#usageRequestTimeoutMs: number;
	#usageLogger?: UsageLogger;
	#fallbackResolver?: (provider: string) => string | undefined;
	#store: AuthCredentialStore;
	#configValueResolver: (config: string) => Promise<string | undefined>;
	#refreshOAuthCredentialOverride?: AuthStorageOptions["refreshOAuthCredential"];
	#fetchUsageReportsOverride?: AuthStorageOptions["fetchUsageReports"];
	#sourceLabel?: string;
	#credentialDisabledListeners: Set<(event: CredentialDisabledEvent) => void | Promise<void>> = new Set();

	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	#generation = 1;
	#generationListeners: Set<(generation: number) => void> = new Set();
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#oauthCredentialRefreshInFlight: Map<number, Promise<OAuthCredentials>> = new Map();
	#closed = false;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#store = store;
		this.#configValueResolver = options.configValueResolver ?? defaultConfigValueResolver;
		this.#usageProviderResolver = options.usageProviderResolver ?? resolveDefaultUsageProvider;
		this.#rankingStrategyResolver = options.rankingStrategyResolver ?? resolveDefaultRankingStrategy;
		this.#usageCache = new AuthStorageUsageCache(this.#store);

		try {
			this.#store.cleanExpiredCache();
		} catch {}
		try {
			this.#store.cleanExpiredCredentialBlocks?.(Date.now());
		} catch (err) {
			this.#handlePersistedBlockStoreError(err);
		}
		this.#usageFetch = options.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#refreshOAuthCredentialOverride = options.refreshOAuthCredential;
		this.#fetchUsageReportsOverride = options.fetchUsageReports;
		this.#sourceLabel = options.sourceLabel;
		if (options.onCredentialDisabled) {
			this.onCredentialDisabled(options.onCredentialDisabled);
		}
		this.#usageLogger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
	}

	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#store.close();
	}

	getGeneration(): number {
		return this.#generation;
	}

	async pollExternalChanges(): Promise<boolean> {
		const pollExternalChanges = this.#store.pollExternalChanges?.bind(this.#store);
		if (!pollExternalChanges?.()) return false;
		const previousGeneration = this.#generation;
		await this.reload();
		if (this.#generation === previousGeneration) this.#bumpGeneration("external-store");
		return true;
	}

	onGenerationChanged(listener: (generation: number) => void): () => void {
		this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#generationListeners.delete(listener);
	}

	#bumpGeneration(reason: string): void {
		this.#generation += 1;
		this.#store.acknowledgeLocalChanges?.();
		for (const listener of [...this.#generationListeners]) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", { reason, error: String(error) });
			}
		}
	}

	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		const wasEmpty = this.#credentialDisabledListeners.size === 0;
		this.#credentialDisabledListeners.add(listener);
		if (wasEmpty && this.#pendingDisabledEvents.length > 0) {
			const drained = this.#pendingDisabledEvents;
			this.#pendingDisabledEvents = [];
			for (const event of drained) {
				this.#invokeListener(listener, event);
			}
		}
		return () => {
			this.#credentialDisabledListeners.delete(listener);
		};
	}

	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	removeRuntimeApiKey(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	setRuntimeUsageProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void {
		this.#runtimeUsageProviderOverrides.set(provider, { provider: usageProvider, apiKey });
		this.#invalidateUsageReportCacheForProvider(provider);
	}

	removeRuntimeUsageProvider(provider: Provider): void {
		if (!this.#runtimeUsageProviderOverrides.has(provider)) return;
		this.#invalidateUsageReportCacheForProvider(provider);
		this.#runtimeUsageProviderOverrides.delete(provider);
	}
	#resolveUsageProvider(provider: Provider): UsageProvider | undefined {
		return this.#runtimeUsageProviderOverrides.get(provider)?.provider ?? this.#usageProviderResolver?.(provider);
	}

	setConfigApiKey(provider: string, apiKey: string): void {
		this.#configOverrides.set(provider, apiKey);
	}

	removeConfigApiKey(provider: string): void {
		this.#configOverrides.delete(provider);
	}

	clearConfigApiKeys(): void {
		this.#configOverrides.clear();
	}

	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.#fallbackResolver = resolver;
	}

	async reload(): Promise<void> {
		let records: StoredAuthCredential[];
		try {
			records = this.#store.listAuthCredentials();
		} catch (err) {
			this.#handlePersistedBlockStoreError(err);
			throw err;
		}
		const grouped = new Map<string, StoredCredential[]>();
		for (const record of records) {
			const list = grouped.get(record.provider) ?? [];
			list.push({ id: record.id, credential: record.credential });
			grouped.set(record.provider, list);
		}

		const dedupedGrouped = new Map<string, StoredCredential[]>();
		for (const [provider, entries] of grouped.entries()) {
			const deduped = this.#pruneDuplicateStoredCredentials(provider, entries);
			if (deduped.length > 0) {
				dedupedGrouped.set(provider, deduped);
			}
		}

		const removedProviders = new Set(this.#data.keys());
		for (const [provider, entries] of dedupedGrouped) {
			this.#setStoredCredentials(provider, entries);
			removedProviders.delete(provider);
		}
		for (const provider of removedProviders) {
			this.#setStoredCredentials(provider, []);
		}
	}

	#getStoredCredentials(provider: string): StoredCredential[] {
		return this.#data.get(provider) ?? [];
	}

	#setStoredCredentials(provider: string, credentials: StoredCredential[]): void {
		const current = this.#data.get(provider) ?? [];
		if (storedCredentialArraysEqual(current, credentials)) return;
		const trackedBearerFingerprints = this.#oauthBearerFingerprints.get(provider);
		if (trackedBearerFingerprints) {
			const activeOAuthIds = new Set(
				credentials.filter(entry => entry.credential.type === "oauth").map(entry => entry.id),
			);
			for (const credentialId of trackedBearerFingerprints.keys()) {
				if (!activeOAuthIds.has(credentialId)) trackedBearerFingerprints.delete(credentialId);
			}
			if (trackedBearerFingerprints.size === 0) this.#oauthBearerFingerprints.delete(provider);
		}
		if (credentials.length === 0) {
			this.#data.delete(provider);
		} else {
			this.#data.set(provider, credentials);
		}
		this.#bumpGeneration("credentials");
	}

	#recordOAuthBearerCredentialId(provider: string, bearer: string, credentialId: number | undefined): void {
		if (credentialId === undefined) return;
		const fingerprint = fingerprintOAuthBearer(bearer);
		const byCredentialId = this.#oauthBearerFingerprints.get(provider) ?? new Map<number, string[]>();
		const history = byCredentialId.get(credentialId) ?? [];
		const nextHistory = history.filter(previous => previous !== fingerprint);
		nextHistory.push(fingerprint);
		if (nextHistory.length > OAUTH_BEARER_FINGERPRINT_HISTORY_LIMIT) nextHistory.shift();
		byCredentialId.set(credentialId, nextHistory);
		this.#oauthBearerFingerprints.set(provider, byCredentialId);
	}

	#findOAuthCredentialIdForBearer(provider: string, bearer: string): number | undefined {
		const fingerprint = fingerprintOAuthBearer(bearer);
		for (const [credentialId, history] of this.#oauthBearerFingerprints.get(provider) ?? []) {
			if (history.includes(fingerprint)) return credentialId;
		}
		return undefined;
	}

	#resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
		return resolveCredentialIdentityKey(provider, credential);
	}

	#dedupeOAuthCredentials(provider: string, credentials: AuthCredential[]): AuthCredential[] {
		const seen = new Set<string>();
		const deduped: AuthCredential[] = [];
		for (let index = credentials.length - 1; index >= 0; index -= 1) {
			const credential = credentials[index];
			if (credential.type !== "oauth") {
				deduped.push(credential);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				deduped.push(credential);
				continue;
			}
			if (seen.has(identityKey)) {
				continue;
			}
			seen.add(identityKey);
			deduped.push(credential);
		}
		return deduped.reverse();
	}

	#pruneDuplicateStoredCredentials(provider: string, entries: StoredCredential[]): StoredCredential[] {
		const seen = new Set<string>();
		const kept: StoredCredential[] = [];
		const removed: StoredCredential[] = [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			const credential = entry.credential;
			if (credential.type !== "oauth") {
				kept.push(entry);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				kept.push(entry);
				continue;
			}
			if (seen.has(identityKey)) {
				removed.push(entry);
				continue;
			}
			seen.add(identityKey);
			kept.push(entry);
		}
		if (removed.length > 0) {
			for (const entry of removed) {
				this.#store.deleteAuthCredential(entry.id, "deduplicated duplicate credential");
			}
			this.#resetProviderAssignments(provider);
		}
		return kept.reverse();
	}

	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	#getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	#toScopedBackoffKey(providerKey: string, blockScope: string | undefined): string {
		return blockScope ? `${providerKey}\0${blockScope}` : providerKey;
	}

	#getCredentialBlockedUntilForKey(backoffKey: string, credentialIndex: number, nowMs: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(backoffKey);
		if (!backoffMap) return undefined;
		const blockedUntil = backoffMap.get(credentialIndex);
		if (!blockedUntil) return undefined;
		if (blockedUntil <= nowMs) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(backoffKey);
			}
			const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey);
			probeAfterMap?.delete(credentialIndex);
			if (probeAfterMap?.size === 0) this.#credentialBackoffProbeAfter.delete(backoffKey);
			return undefined;
		}
		return blockedUntil;
	}

	#readPersistedCredentialBlock(
		credentialId: number,
		providerKey: string,
		blockScope: string | undefined,
	): number | undefined {
		if (this.#persistedBlockStoreDamaged) return undefined;
		const getCredentialBlock = this.#store.getCredentialBlock?.bind(this.#store);
		if (!getCredentialBlock) return undefined;
		try {
			return getCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return undefined;
			logger.debug("Failed to read credential block from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return undefined;
		}
	}

	#readPersistedCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number {
		if (this.#persistedBlockStoreDamaged) return 0;
		const getCredentialBlockReconcileAfter = this.#store.getCredentialBlockReconcileAfter?.bind(this.#store);
		if (!getCredentialBlockReconcileAfter) return 0;
		try {
			return getCredentialBlockReconcileAfter(credentialId, providerKey, blockScope) ?? 0;
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return 0;

			logger.debug("Failed to read credential block reconcile-after time from persistent store", {
				err,
				credentialId,
				providerKey,
				blockScope,
			});
			return 0;
		}
	}

	#getCredentialBlockedUntil(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScopeOrScopes: string | readonly string[] | undefined = undefined,
	): number | undefined {
		const nowMs = Date.now();

		const scopes = (
			typeof blockScopeOrScopes === "string" ? [blockScopeOrScopes] : (blockScopeOrScopes ?? [])
		).filter(scope => scope.length > 0);
		let blockedUntil = this.#getCredentialBlockedUntilForKey(providerKey, credentialIndex, nowMs);
		for (const blockScope of scopes) {
			const scopedBlockedUntil = this.#getCredentialBlockedUntilForKey(
				this.#toScopedBackoffKey(providerKey, blockScope),
				credentialIndex,
				nowMs,
			);
			if (scopedBlockedUntil !== undefined && (blockedUntil === undefined || scopedBlockedUntil > blockedUntil)) {
				blockedUntil = scopedBlockedUntil;
			}
		}

		const credentialId = this.#getStoredCredentials(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return blockedUntil;
		const persistedGlobalBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, "");
		if (
			persistedGlobalBlockedUntil !== undefined &&
			(blockedUntil === undefined || persistedGlobalBlockedUntil > blockedUntil)
		) {
			blockedUntil = persistedGlobalBlockedUntil;
		}
		for (const blockScope of scopes) {
			const persistedScopedBlockedUntil = this.#readPersistedCredentialBlock(credentialId, providerKey, blockScope);
			if (
				persistedScopedBlockedUntil !== undefined &&
				(blockedUntil === undefined || persistedScopedBlockedUntil > blockedUntil)
			) {
				blockedUntil = persistedScopedBlockedUntil;
			}
		}
		return blockedUntil;
	}

	#isCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockScope: string | readonly string[] | undefined = undefined,
	): boolean {
		return this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope) !== undefined;
	}

	#markCredentialBlocked(
		provider: string,
		providerKey: string,
		credentialIndex: number,
		blockedUntilMs: number,
		blockScope: string | undefined = undefined,
	): void {
		const backoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const backoffMap = this.#credentialBackoff.get(backoffKey) ?? new Map<number, number>();
		const existing = backoffMap.get(credentialIndex) ?? 0;
		const nextBlockedUntil = Math.max(existing, blockedUntilMs);
		backoffMap.set(credentialIndex, nextBlockedUntil);
		this.#credentialBackoff.set(backoffKey, backoffMap);
		const probeAfterMap = this.#credentialBackoffProbeAfter.get(backoffKey) ?? new Map<number, number>();
		probeAfterMap.set(credentialIndex, Math.min(nextBlockedUntil, Date.now() + USAGE_REPORT_TTL_MS));
		this.#credentialBackoffProbeAfter.set(backoffKey, probeAfterMap);
		this.#invalidateUsageReportCache(provider);

		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock || this.#persistedBlockStoreDamaged) return;
		const credentialId = this.#getStoredCredentials(provider)[credentialIndex]?.id;
		if (credentialId === undefined) return;
		try {
			upsertCredentialBlock({
				credentialId,
				providerKey,
				blockScope: blockScope ?? "",
				blockedUntilMs: nextBlockedUntil,
			});
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return;
			logger.debug("Failed to persist credential block", {
				err,
				credentialId,
				provider,
				providerKey,
				blockScope,
				blockedUntilMs: nextBlockedUntil,
			});
		}
	}

	#handlePersistedBlockStoreError(err: unknown): boolean {
		if (!isSqliteCorruptionError(err)) return false;
		this.#reportDamagedBlockStore(err);
		return true;
	}

	#assertPersistedBlockStoreWritable(): void {
		if (!this.#persistedBlockStoreDamaged) return;
		const store = this.#sourceLabel ?? `local ${getAgentDbPath()}`;
		throw new Error(`Persistent credential block store ${store} is unavailable after SQLite corruption`);
	}

	#reportDamagedBlockStore(err: unknown): void {
		if (this.#persistedBlockStoreDamaged) return;
		this.#persistedBlockStoreDamaged = true;
		const store = this.#sourceLabel ?? `local ${getAgentDbPath()}`;
		logger.error(
			"Persistent credential store is corrupt; cross-process rate-limit persistence is disabled for this process. In-memory backoff still applies. Repair the store with `sqlite3 <path> '.recover'` or delete it to recreate on next login.",
			{ err, store },
		);
	}

	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		lastUsedAtMs?: number,
	): void {
		if (!sessionId) return;
		const nowMs = lastUsedAtMs ?? Date.now();
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index, lastUsedAtMs: nowMs });
		this.#sessionLastCredential.set(provider, sessionMap);

		try {
			const credentialId = this.#getStoredCredentials(provider)[index]?.id;
			if (credentialId !== undefined) {
				const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
				const cacheValue = JSON.stringify({ type, index, credentialId, lastUsedAtMs: nowMs });

				const expiresAtSec = Math.floor(nowMs / 1000) + 30 * 24 * 60 * 60;
				this.#store.setCache(cacheKey, cacheValue, expiresAtSec);
			}
		} catch (err) {
			logger.debug("Failed to write session sticky credential to persistent store cache", { err });
		}
	}

	#getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number; lastUsedAtMs?: number } | undefined {
		if (!sessionId) return undefined;
		let sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap?.has(sessionId)) {
			return sessionMap.get(sessionId);
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as {
					type: AuthCredential["type"];
					index: number;
					credentialId?: number;
					lastUsedAtMs?: number;
				};

				if (val.credentialId !== undefined) {
					const stored = this.#getStoredCredentials(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				if (!sessionMap) {
					sessionMap = new Map();
					this.#sessionLastCredential.set(provider, sessionMap);
				}
				const sessionVal = { type: val.type, index: val.index, lastUsedAtMs: val.lastUsedAtMs };
				sessionMap.set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	#clearSessionCredential(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(provider);
			}
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	#selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
		filter?: (credential: AuthCredential) => boolean,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } => {
				if (entry.credential.type !== type) return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.#isCredentialBlocked(provider, providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	async #rankApiKeySelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: ApiKeySelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;

		blockScopes?: readonly string[];
	}): Promise<ApiKeyCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedApiKeyCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				if (blockedUntil !== undefined) {
					return { selection, usage: null, usageChecked: false, blockedUntil };
				}
				const usage = await this.#getUsageReport(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				return { selection, usage, usageChecked: true, blockedUntil: undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			if (result) return result;
			return args.order.map(idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? this.#getScopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && this.#isUsageLimitReached(scopedLimits)) {
				const resetAtMs = this.#getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				planPriority: 0,
				secondaryUsed: this.#normalizeUsageFraction(secondary),
				secondaryRequiredDrain: this.#computeWindowRequiredDrain(
					secondary,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryRequiredDrain: this.#computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderUsageRankedCandidates(ranked, "none");
	}

	async #selectApiKeyCredential(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter?: (credential: ApiKeyCredential) => boolean,
	): Promise<ApiKeySelection | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is ApiKeySelection => {
				if (entry.credential.type !== "api_key") return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, "api_key");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];
		const strategy = this.#rankingStrategyResolver?.(provider);
		if (!strategy) {
			for (const idx of order) {
				const candidate = credentials[idx];
				if (!this.#isCredentialBlocked(provider, providerKey, candidate.index)) {
					return candidate;
				}
			}
			return fallback;
		}

		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const candidates = await this.#rankApiKeySelections({
			providerKey,
			provider,
			order,
			credentials,
			options,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
		});
		return candidates[0]?.selection ?? fallback;
	}

	#clearProviderSessionCredentialCache(provider: string): void {
		try {
			this.#store.deleteCachePrefix?.(`${SESSION_STICKY_CACHE_PREFIX}${provider}:`);
		} catch (err) {
			logger.debug("Failed to clear provider session sticky credentials from persistent store cache", { err });
		}
	}

	#resetProviderAssignments(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
		this.#sessionLastCredential.delete(provider);
		this.#clearProviderSessionCredentialCache(provider);
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
	}

	#replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		const target = entries[index];
		this.#store.updateAuthCredential(target.id, credential);
		const updated = [...entries];
		updated[index] = { id: target.id, credential };
		this.#setStoredCredentials(provider, updated);
	}

	#tryDisableCredentialAtIfMatches(
		provider: string,
		index: number,
		expectedCredential: AuthCredential,
		disabledCause: string,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return false;
		const target = entries[index];
		const serialized = serializeCredential(provider, expectedCredential);
		if (!serialized) return false;
		const disabled = this.#store.tryDisableAuthCredentialIfMatches(target.id, serialized.data, disabledCause);
		if (!disabled) return false;
		const updated = entries.filter((_value, idx) => idx !== index);
		this.#setStoredCredentials(provider, updated);
		this.#resetProviderAssignments(provider);
		this.#emitCredentialDisabled({ provider, disabledCause });
		return true;
	}

	#replaceCredentialById(provider: string, id: number, credential: AuthCredential): number {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return -1;
		const expected = serializeCredential(provider, entries[index]!.credential);
		if (
			expected &&
			this.#store.tryUpdateAuthCredentialIfMatches &&
			!this.#store.tryUpdateAuthCredentialIfMatches(id, expected.data, credential)
		) {
			const latest = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latest.map(row => ({ id: row.id, credential: row.credential })),
			);
			return latest.findIndex(row => row.id === id);
		}
		if (!expected || !this.#store.tryUpdateAuthCredentialIfMatches) {
			this.#store.updateAuthCredential(id, credential);
		}
		const updated = [...entries];
		updated[index] = { id, credential };
		this.#setStoredCredentials(provider, updated);
		return index;
	}

	#disableCredentialByIdIfMatches(
		provider: string,
		id: number,
		expected: AuthCredential,
		disabledCause: string,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === id);
		if (index === -1) return false;
		return this.#tryDisableCredentialAtIfMatches(provider, index, expected, disabledCause);
	}

	#emitCredentialDisabled(event: CredentialDisabledEvent): void {
		if (this.#credentialDisabledListeners.size === 0) {
			if (this.#pendingDisabledEvents.length >= MAX_PENDING_DISABLED_EVENTS) {
				this.#pendingDisabledEvents.shift();
			}
			this.#pendingDisabledEvents.push(event);
			return;
		}

		const listeners = [...this.#credentialDisabledListeners];
		for (const listener of listeners) {
			this.#invokeListener(listener, event);
		}
	}

	#invokeListener(
		listener: (event: CredentialDisabledEvent) => void | Promise<void>,
		event: CredentialDisabledEvent,
	): void {
		const logListenerError = (error: unknown): void => {
			logger.warn("onCredentialDisabled listener threw", { provider: event.provider, error: String(error) });
		};
		try {
			const result = listener(event);
			if (result && typeof (result as PromiseLike<void>).then === "function") {
				(result as Promise<void>).catch(logListenerError);
			}
		} catch (error) {
			logListenerError(error);
		}
	}

	get(provider: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(provider)[0];
	}

	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = this.#dedupeOAuthCredentials(provider, normalized);
		const stored = this.#store.replaceAuthCredentialsRemote
			? await this.#store.replaceAuthCredentialsRemote(provider, deduped)
			: this.#store.replaceAuthCredentialsForProvider(provider, deduped);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	listStoredCredentials(provider?: string): StoredAuthCredential[] {
		if (provider !== undefined) {
			return this.#getStoredCredentials(provider).map(entry => ({
				id: entry.id,
				provider,
				credential: entry.credential,
				disabledCause: null,
			}));
		}
		const rows: StoredAuthCredential[] = [];
		for (const [storedProvider, entries] of this.#data) {
			for (const entry of entries) {
				rows.push({
					id: entry.id,
					provider: storedProvider,
					credential: entry.credential,
					disabledCause: null,
				});
			}
		}
		return rows;
	}

	async refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		const refreshSkewMs = options.refreshSkewMs ?? OAUTH_REFRESH_SKEW_MS;
		const hasDurableLease =
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease;
		const owner = crypto.randomUUID();
		let leasedCredentialId: number | undefined;

		while (hasDurableLease) {
			if (options.signal?.aborted) throw new AIError.AbortError("OAuth refresh ownership aborted by caller");
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(
				entry =>
					entry.credential.type === "oauth" &&
					(options.credentialId === undefined || entry.id === options.credentialId),
			);
			if (row?.credential.type !== "oauth") {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const currentIsFresh = Date.now() + refreshSkewMs < current.expires;

			if (
				options.observedCredential &&
				!authCredentialEquals(current, options.observedCredential) &&
				currentIsFresh
			) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && currentIsFresh) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (this.#store.tryAcquireCredentialRefreshLease?.(row.id, owner, Date.now() + OAUTH_REFRESH_LEASE_TTL_MS)) {
				leasedCredentialId = row.id;
				break;
			}
			const leaseExpiresAt = this.#store.getCredentialRefreshLeaseExpiresAt?.(row.id);
			const waitMs =
				leaseExpiresAt === undefined
					? OAUTH_REFRESH_LEASE_POLL_MS
					: Math.min(Math.max(leaseExpiresAt - Date.now(), OAUTH_REFRESH_LEASE_POLL_MS), 250);
			await raceCredentialRefreshWithSignal(
				Bun.sleep(waitMs),
				options.signal,
				"OAuth refresh ownership wait aborted by caller",
			);
		}

		try {
			const rows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				rows.map(row => ({ id: row.id, credential: row.credential })),
			);
			const row = rows.find(
				entry =>
					entry.credential.type === "oauth" &&
					(options.credentialId === undefined || entry.id === options.credentialId),
			);
			if (row?.credential.type !== "oauth") {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const current = options.credentialFromRow(row.credential);
			if (!current) {
				return { credential: undefined, refreshed: false, removed: false };
			}
			const currentIsFresh = Date.now() + refreshSkewMs < current.expires;

			if (
				options.observedCredential &&
				!authCredentialEquals(current, options.observedCredential) &&
				currentIsFresh
			) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (!options.forceRefresh && currentIsFresh) {
				return { credential: current, refreshed: false, removed: false };
			}
			if (options.canRefresh && !options.canRefresh(current)) {
				return { credential: current, refreshed: false, removed: false };
			}
			const serialized = serializeCredential(provider, current);
			if (!serialized) return { credential: current, refreshed: false, removed: false };

			let stopLeaseRenewal = false;
			let leaseRenewalError: unknown;
			const leaseRenewalStopped = Promise.withResolvers<void>();
			const leaseRenewal =
				leasedCredentialId !== undefined
					? (async () => {
							while (!stopLeaseRenewal) {
								await Promise.race([Bun.sleep(OAUTH_REFRESH_LEASE_RENEW_MS), leaseRenewalStopped.promise]);
								if (stopLeaseRenewal) return;
								const renewed = this.#store.renewCredentialRefreshLease?.(
									leasedCredentialId,
									owner,
									Date.now() + OAUTH_REFRESH_LEASE_TTL_MS,
								);
								if (!renewed) {
									throw new AIError.ConfigurationError("OAuth refresh ownership was lost before persistence");
								}
							}
						})().catch(error => {
							leaseRenewalError = error;
						})
					: undefined;
			const refreshAbort = new AbortController();
			const refreshTimeout = setTimeout(() => {
				refreshAbort.abort(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				);
			}, options.refreshTimeoutMs ?? OAUTH_REFRESH_OPERATION_TIMEOUT_MS);

			let refreshed: OAuthCredentials;
			try {
				try {
					refreshed = await options.refresh(current, refreshAbort.signal);
				} catch (error) {
					if (options.isDefinitiveFailure?.(error)) {
						const disabledCause = options.disabledCause?.(error) ?? `oauth refresh failed: ${String(error)}`;
						const disabled = this.#store.tryDisableAuthCredentialIfMatches(
							row.id,
							serialized.data,
							disabledCause,
							leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
						);
						if (disabled) {
							this.#setStoredCredentials(
								provider,
								rows
									.filter(entry => entry.id !== row.id)
									.map(entry => ({ id: entry.id, credential: entry.credential })),
							);
							this.#resetProviderAssignments(provider);
							this.#emitCredentialDisabled({ provider, disabledCause });
							return { credential: undefined, refreshed: false, removed: true };
						}
						await this.reload();
						const latest = this.#getStoredCredentials(provider).find(entry => entry.id === row.id)?.credential;
						return {
							credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
							refreshed: false,
							removed: false,
						};
					}
					options.onRefreshFailure?.(error);
					const keepCredential =
						typeof options.keepCredentialOnRefreshFailure === "function"
							? options.keepCredentialOnRefreshFailure(error)
							: options.keepCredentialOnRefreshFailure === true;
					if (keepCredential) {
						return { credential: current, refreshed: false, removed: false };
					}
					throw error;
				}
			} finally {
				stopLeaseRenewal = true;
				leaseRenewalStopped.resolve();
				await leaseRenewal;
				clearTimeout(refreshTimeout);
			}
			if (leaseRenewalError) throw leaseRenewalError;

			const merged: T = options.mergeRefreshedCredential
				? options.mergeRefreshedCredential(current, refreshed)
				: {
						...current,
						access: refreshed.access,
						refresh: refreshed.refresh,
						expires: refreshed.expires,
						accountId: refreshed.accountId ?? current.accountId,
						email: refreshed.email ?? current.email,
						projectId: refreshed.projectId ?? current.projectId,
						enterpriseUrl: refreshed.enterpriseUrl ?? current.enterpriseUrl,
						apiEndpoint: refreshed.apiEndpoint ?? current.apiEndpoint,
						orgId: refreshed.orgId ?? current.orgId,
						orgName: refreshed.orgName ?? current.orgName,
					};
			if (this.#store.tryUpdateAuthCredentialIfMatches) {
				if (
					!this.#store.tryUpdateAuthCredentialIfMatches(
						row.id,
						serialized.data,
						merged,
						leasedCredentialId !== undefined ? { owner, nowMs: Date.now() } : undefined,
					)
				) {
					await this.reload();
					const latest = this.#getStoredCredentials(provider).find(entry => entry.id === row.id)?.credential;
					return {
						credential: latest?.type === "oauth" ? options.credentialFromRow(latest) : undefined,
						refreshed: false,
						removed: false,
					};
				}
			} else {
				this.#store.updateAuthCredential(row.id, merged);
			}
			this.#setStoredCredentials(
				provider,
				rows.map(entry => ({ id: entry.id, credential: entry.id === row.id ? merged : entry.credential })),
			);
			return { credential: merged, refreshed: true, removed: false };
		} finally {
			if (leasedCredentialId !== undefined) {
				this.#store.releaseCredentialRefreshLease?.(leasedCredentialId, owner);
			}
		}
	}

	async #upsertOAuthCredential(provider: string, credential: OAuthCredential): Promise<void> {
		const stored = this.#store.upsertAuthCredentialRemote
			? await this.#store.upsertAuthCredentialRemote(provider, credential)
			: this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	async remove(provider: string): Promise<void> {
		if (this.#store.deleteAuthCredentialsRemote) {
			await this.#store.deleteAuthCredentialsRemote(provider, "deleted by user");
		} else {
			this.#store.deleteAuthCredentialsForProvider(provider, "deleted by user");
		}
		this.#setStoredCredentials(provider, []);
		this.#resetProviderAssignments(provider);
	}

	async removeCredential(provider: string, credentialId: number): Promise<boolean> {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === credentialId);
		if (index === -1) return false;

		if (this.#store.deleteAuthCredentialRemote) {
			const deleted = await this.#store.deleteAuthCredentialRemote(credentialId, "deleted by user");
			if (!deleted) return false;
		} else {
			this.#store.deleteAuthCredential(credentialId, "deleted by user");
		}
		this.#setStoredCredentials(
			provider,
			entries.filter((_entry, entryIndex) => entryIndex !== index),
		);
		this.#resetProviderAssignments(provider);
		return true;
	}

	list(): string[] {
		return [...this.#data.keys()];
	}

	has(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).length > 0;
	}

	hasAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (this.#hasDedicatedEnvAuth(provider)) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	hasResolvableAuth(provider: string): boolean {
		if (this.hasAuth(provider)) return true;
		return Boolean(getEnvApiKey(provider));
	}

	hasNonEnvCredential(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#configOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (this.#fallbackResolver?.(provider)) return true;
		return false;
	}

	#hasDedicatedEnvAuth(provider: string): boolean {
		if (provider === "xai-oauth") {
			return Boolean($env.XAI_OAUTH_TOKEN?.trim());
		}
		return Boolean(getEnvApiKey(provider));
	}

	getCredentialOrigin(provider: string): CredentialOrigin | undefined {
		if (this.#runtimeOverrides.has(provider)) return { kind: "runtime" };
		if (this.#configOverrides.has(provider)) return { kind: "config" };
		const stored = this.#getCredentialsForProvider(provider);
		if (stored.some(credential => credential.type === "oauth")) return { kind: "oauth" };
		if (stored.some(credential => credential.type === "api_key" && credential.source === "login")) {
			return { kind: "api_key" };
		}
		if (this.#hasDedicatedEnvAuth(provider)) return { kind: "env", envVar: getEnvApiKeyName(provider) };
		if (stored.some(credential => credential.type === "api_key")) return { kind: "api_key" };
		if (this.#fallbackResolver?.(provider)) return { kind: "fallback" };
		return undefined;
	}

	hasOAuth(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth");
	}

	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.#getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	#resolveActiveOAuthCredential(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#getCredentialsForProvider(provider);
		const oauthCredentials = allCredentials.filter((c): c is OAuthCredential => c.type === "oauth");
		if (oauthCredentials.length === 0) return undefined;

		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) return undefined;

		const sessionPref = this.#getSessionCredential(provider, sessionId);

		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		if (!sessionPref && (getEnvApiKey(provider) || this.#fallbackResolver?.(provider))) return undefined;

		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	getOAuthAccountId(provider: string, sessionId?: string): string | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		const accountId = preferred?.accountId;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	}

	getOAuthAccountIdentity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		const preferred = this.#resolveActiveOAuthCredential(provider, sessionId);
		if (!preferred) return undefined;
		const identity: OAuthAccountIdentity = {};
		if (typeof preferred.accountId === "string" && preferred.accountId.length > 0) {
			identity.accountId = preferred.accountId;
		}
		if (typeof preferred.email === "string" && preferred.email.length > 0) {
			identity.email = preferred.email;
		}
		if (typeof preferred.projectId === "string" && preferred.projectId.length > 0) {
			identity.projectId = preferred.projectId;
		}
		if (typeof preferred.orgId === "string" && preferred.orgId.length > 0) {
			identity.orgId = preferred.orgId;
		}
		if (typeof preferred.orgName === "string" && preferred.orgName.length > 0) {
			identity.orgName = preferred.orgName;
		}
		if (!identity.accountId && !identity.email && !identity.projectId && !identity.orgId) return undefined;
		return identity;
	}

	getAll(): AuthStorageData {
		const result: AuthStorageData = {};
		for (const [provider, entries] of this.#data.entries()) {
			const credentials = entries.map(entry => entry.credential);
			if (credentials.length === 1) {
				result[provider] = credentials[0];
			} else if (credentials.length > 1) {
				result[provider] = credentials;
			}
		}
		return result;
	}

	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			onAuth: (info: OAuthAuthInfo) => void;

			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
		},
	): Promise<OAuthLoginIdentity | undefined> {
		const manualCodeInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider)
			? () => ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):" })
			: undefined;

		const def = getProviderDefinition(provider) ?? getOAuthProvider(provider);
		if (!def?.login) {
			throw new AIError.ConfigurationError(`Unknown OAuth provider: ${provider}`);
		}
		const result = await def.login({
			onAuth: ctrl.onAuth,
			onProgress: ctrl.onProgress,
			onPrompt: ctrl.onPrompt,
			onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
			signal: ctrl.signal,
			fetch: ctrl.fetch,
		});
		if (typeof result === "string") {
			if (!result) {
				return undefined;
			}
			const newCredential: ApiKeyCredential = { type: "api_key", key: result, source: "login" };
			const stored = this.#store.upsertAuthCredentialRemote
				? await this.#store.upsertAuthCredentialRemote(provider, newCredential)
				: this.#store.upsertAuthCredentialForProvider(provider, newCredential);
			this.#setStoredCredentials(
				provider,
				stored.map(entry => ({ id: entry.id, credential: entry.credential })),
			);
			this.#resetProviderAssignments(provider);
			return { type: "api_key" };
		}

		const newCredential: OAuthCredential = { type: "oauth", ...result, authorizedAt: Date.now() };

		await this.#upsertOAuthCredential(def.storeCredentialsAs ?? provider, newCredential);
		return {
			type: "oauth",
			email: newCredential.email,
			accountId: newCredential.accountId,
			orgId: newCredential.orgId,
			orgName: newCredential.orgName,
		};
	}

	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	#buildUsageCredential(credential: AuthCredential): UsageCredential {
		if (credential.type === "api_key") {
			return {
				type: "api_key",
				apiKey: credential.key,
			};
		}
		return {
			type: "oauth",
			accessToken: credential.access,
			refreshToken: credential.refresh,
			expiresAt: credential.expires,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			orgId: credential.orgId,
			orgName: credential.orgName,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	#buildUsageCacheIdentity(credential: UsageCredential): string {
		const parts: string[] = [credential.type];
		const accountId = credential.accountId?.trim();
		if (accountId) parts.push(`account:${accountId}`);
		const email = credential.email?.trim().toLowerCase();
		if (email) parts.push(`email:${email}`);
		const orgId = credential.orgId?.trim();
		if (orgId) parts.push(`org:${orgId}`);
		const projectId = credential.projectId?.trim();
		if (projectId) parts.push(`project:${projectId}`);
		const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
		if (enterpriseUrl) parts.push(`enterprise:${enterpriseUrl}`);

		const hasStableIdentifier = Boolean(accountId || email || orgId);
		if (!hasStableIdentifier) {
			const secret = credential.apiKey?.trim() || credential.refreshToken?.trim() || credential.accessToken?.trim();
			if (secret) {
				parts.push(`secret:${Bun.hash(secret).toString(16)}`);
			} else {
				parts.push("anonymous");
			}
		}
		return parts.join("|");
	}

	#normalizeUsageBaseUrl(baseUrl?: string): string {
		return baseUrl?.trim().replace(/\/+$/, "") ?? "";
	}

	#usageCacheProviderKey(provider: Provider): string {
		const versionOverride = USAGE_REPORT_CACHE_KEY_VERSION_OVERRIDES[provider];
		return versionOverride === undefined ? provider : `${versionOverride}:${provider}`;
	}

	#usageForceRefreshCacheKey(provider?: Provider): string {
		return provider
			? `${USAGE_FORCE_REFRESH_CACHE_PREFIX}provider:${provider}`
			: `${USAGE_FORCE_REFRESH_CACHE_PREFIX}all`;
	}

	#markUsageForceRefresh(provider?: Provider): void {
		this.#usageCache.set(this.#usageForceRefreshCacheKey(provider), {
			value: true,
			expiresAt: Date.now() + USAGE_FORCE_REFRESH_TTL_MS,
		});
	}

	#hasUsageForceRefresh(provider?: Provider): boolean {
		const key = this.#usageForceRefreshCacheKey(provider);
		const entry = this.#usageCache.get<boolean>(key);
		if (entry?.value !== true) return false;
		if (entry.expiresAt > Date.now()) return true;
		this.#usageCache.set(key, { value: null, expiresAt: 0 });
		return false;
	}

	#usageForceRefresh(requests: readonly UsageRequestDescriptor[]): ForcedUsageRefresh {
		const all = this.#hasUsageForceRefresh();
		const providers = new Set<Provider>();
		for (const request of requests) providers.add(request.provider);
		if (!all) {
			for (const provider of providers) {
				if (!this.#hasUsageForceRefresh(provider)) providers.delete(provider);
			}
		}
		return { all, providers };
	}

	#clearUsageForceRefresh(refresh: ForcedUsageRefresh): void {
		if (refresh.all) this.#usageCache.set(this.#usageForceRefreshCacheKey(), { value: null, expiresAt: 0 });
		for (const provider of refresh.providers) {
			this.#usageCache.set(this.#usageForceRefreshCacheKey(provider), { value: null, expiresAt: 0 });
		}
	}
	#buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = this.#buildUsageCacheIdentity(request.credential);
		const providerKey = this.#usageCacheProviderKey(request.provider);
		const cacheKey = `report:${providerKey}:${baseUrl}:${identity}`;
		const cacheKeys = this.#usageReportCacheKeysByProvider.get(request.provider) ?? new Set<string>();
		cacheKeys.add(cacheKey);
		this.#usageReportCacheKeysByProvider.set(request.provider, cacheKeys);
		return cacheKey;
	}
	#buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
		const snapshot = requests
			.map(request => {
				const providerKey = this.#usageCacheProviderKey(request.provider);
				return `${providerKey}:${this.#normalizeUsageBaseUrl(request.baseUrl) || "default"}:${this.#buildUsageCacheIdentity(request.credential)}`;
			})
			.sort()
			.join("\n");
		return `reports:${Bun.hash(snapshot).toString(16)}`;
	}

	#buildUsageRequest(provider: Provider, credential: UsageCredential, baseUrl?: string): UsageRequestDescriptor {
		return { provider, credential, baseUrl };
	}

	#buildUsageRequestForOauth(
		provider: Provider,
		credential: OAuthCredential,
		baseUrl?: string,
	): UsageRequestDescriptor {
		return this.#buildUsageRequest(provider, this.#buildUsageCredential(credential), baseUrl);
	}

	#buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
		if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
			return null;
		}
		return {
			type: "oauth",
			access: credential.accessToken,
			refresh: credential.refreshToken,
			expires: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			orgId: credential.orgId,
			orgName: credential.orgName,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	#buildCompletionProbeCredential(credential: UsageCredential): CompletionProbeCredential | null {
		if (credential.type === "api_key") {
			return credential.apiKey ? { type: "api_key", apiKey: credential.apiKey } : null;
		}
		if (!credential.accessToken) return null;
		return {
			type: "oauth",
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
		};
	}

	#mergeRefreshedUsageCredential(credential: UsageCredential, refreshed: OAuthCredentials): UsageCredential {
		return {
			...credential,
			accessToken: refreshed.access,
			refreshToken: refreshed.refresh,
			expiresAt: refreshed.expires,
			accountId: refreshed.accountId ?? credential.accountId,
			projectId: refreshed.projectId ?? credential.projectId,
			email: refreshed.email ?? credential.email,
			enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
			apiEndpoint: refreshed.apiEndpoint ?? credential.apiEndpoint,
			orgId: refreshed.orgId ?? credential.orgId,
			orgName: refreshed.orgName ?? credential.orgName,
		};
	}

	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		const entries = this.#getStoredCredentials(provider);

		const previousRefresh =
			previous.refreshToken && previous.refreshToken !== REMOTE_REFRESH_SENTINEL ? previous.refreshToken : undefined;
		const match = entries.find(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previousRefresh && entry.credential.refresh === previousRefresh) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId &&
				entry.credential.orgId === previous.orgId
			);
		});
		return match?.id;
	}

	#persistRefreshedUsageCredential(
		provider: Provider,
		previous: UsageCredential,
		next: UsageCredential,
		credentialId = this.#findStoredCredentialIdForUsageCredential(provider, previous),
	): void {
		if (credentialId === undefined) return;
		const entry = this.#getStoredCredentials(provider).find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth") return;
		this.#replaceCredentialById(provider, credentialId, {
			type: "oauth",
			access: next.accessToken ?? entry.credential.access,
			refresh: next.refreshToken ?? entry.credential.refresh,
			expires: next.expiresAt ?? entry.credential.expires,
			accountId: next.accountId,
			projectId: next.projectId,
			email: next.email,
			enterpriseUrl: next.enterpriseUrl,
			apiEndpoint: next.apiEndpoint,
			orgId: next.orgId ?? entry.credential.orgId,
			orgName: next.orgName ?? entry.credential.orgName,

			authorizedAt: entry.credential.authorizedAt,
		});
	}

	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const providerImpl = this.#resolveUsageProvider(request.provider);
		if (!providerImpl) return null;

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageFetchParams = {
			...request,
			accountKey: this.#buildUsageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = this.#buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#findStoredCredentialIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#refreshOAuthCredential(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = this.#mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#persistRefreshedUsageCredential(
						request.provider,
						request.credential,
						refreshedCredential,
						refreshableCredentialId,
					);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					if (request.credential.expiresAt <= Date.now() && AIError.isDefinitiveOAuthFailure(errorMsg)) {
						this.#usageCache.set(this.#buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
					}

					this.#usageLogger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			const report = await providerImpl.fetchUsage(params, {
				fetch: this.#usageFetch,
				logger: this.#usageLogger,
			});

			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return report;
		} catch (error) {
			if (error instanceof AIError.ProviderHttpError && (error.status === 401 || error.status === 403)) {
				this.#usageCache.set(this.#buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
			}
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}
	async #fetchUsageCached(
		request: UsageRequestDescriptor,
		options: { timeoutMs?: number; forceRefresh?: boolean } = {},
	): Promise<UsageReport | null> {
		const timeoutMs = options.timeoutMs;
		const forceRefresh = options.forceRefresh ?? false;
		const cacheKey = this.#buildUsageReportCacheKey(request);

		const now = Date.now();
		const cached = forceRefresh ? undefined : this.#usageCache.get<UsageReport | null>(cacheKey);

		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const usageCacheEpoch = this.#usageCacheEpoch;
		const inFlightKey = `${cacheKey}\0${usageCacheEpoch}`;
		const inFlight = this.#usageRequestInFlight.get(inFlightKey);
		if (inFlight) return inFlight;
		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs);
			if (usageCacheEpoch !== this.#usageCacheEpoch) return report;
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				this.#recordUsageHistory(request, report);
				this.#reconcileCodexUsageBlock(request, report);
				return report;
			}

			const retainLastGood =
				!forceRefresh && this.#resolveUsageProvider(request.provider)?.retainLastGoodOnFailure !== false;
			const lastGood = retainLastGood
				? (this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value ?? null)
				: null;
			const backoffJitter = USAGE_FAILURE_BACKOFF_MS * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + USAGE_FAILURE_BACKOFF_MS + backoffJitter;
			this.#usageCache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(inFlightKey);
		});

		this.#usageRequestInFlight.set(inFlightKey, promise);
		return promise;
	}

	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = this.#buildUsageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#store, entries);
		} catch (error) {
			this.#usageLogger?.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#store.listUsageHistory?.(query) ?? [];
	}

	recordObservedUsage(entry: {
		provider: Provider;
		model: string;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
		costUsd?: number;
		at?: number;
	}): void {
		const record = this.#store.recordObservedUsage;
		if (!record) return;
		try {
			record.call(this.#store, [
				{
					at: entry.at ?? Date.now(),
					provider: entry.provider,
					model: entry.model,
					requests: 1,
					inputTokens: entry.usage.input,
					outputTokens: entry.usage.output,
					cacheReadTokens: entry.usage.cacheRead,
					cacheWriteTokens: entry.usage.cacheWrite,
					costUsd: Number.isFinite(entry.costUsd) ? (entry.costUsd ?? 0) : 0,
				},
			]);
		} catch (error) {
			this.#usageLogger?.debug("observed usage record failed", {
				provider: entry.provider,
				error: String(error),
			});
		}
	}

	recordClientUsage(report: ClientUsageReport): boolean {
		const record = this.#store.recordClientUsage;
		if (!record) return false;
		record.call(this.#store, report);
		return true;
	}

	getClientUsageSummary(sinceMs: number): ClientUsageSummary {
		return this.#store.getClientUsageSummary?.(sinceMs) ?? { clients: [] };
	}

	ingestUsageHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string },
	): boolean {
		if (this.#fetchUsageReportsOverride) return false;
		const parseHeaders = this.#resolveUsageProvider(provider)?.parseRateLimitHeaders;
		if (!parseHeaders) return false;

		const credential = this.#resolveActiveOAuthCredential(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#buildUsageReportCacheKey(
			this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
		);
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now);
		if (!parsedReport) return false;

		const exhausted = parsedReport.limits.some(limit => this.#isUsageLimitExhausted(limit));
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...(parsedReport.metadata ?? {}) };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#store.ingestUsageReport?.bind(this.#store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#usageHeaderIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#fetchUsageReportsOverride || this.#store.fetchUsageReports) return false;
		const priorEntry = this.#usageCache.getStale<UsageReport | null>(cacheKey);
		const prior = priorEntry?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...(report.metadata ?? {}),
					...(prior.metadata ?? {}),
					source: prior.metadata?.source,
					headersUpdatedAt: now,
				},
			};
		}

		const expiresAt = Math.max(priorEntry?.expiresAt ?? now - 1, now - 1);
		this.#usageCache.set(cacheKey, { value: merged, expiresAt });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	async #collectUsageRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): Promise<UsageRequestDescriptor[]> {
		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#data.keys(),
			...this.#runtimeUsageProviderOverrides.keys(),
			...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = this.#resolveUsageProvider(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#getStoredCredentials(providerId);
			if (entries.length > 0) {
				const dedupedEntries = this.#pruneDuplicateStoredCredentials(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#setStoredCredentials(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			if (providerId === "xai-oauth") {
				let hasUsableStoredOAuthCredential = false;
				for (const entry of entries) {
					if (entry.credential.type !== "oauth") continue;
					const request = this.#buildUsageRequestForOauth(provider, entry.credential, baseUrl);
					if (providerImpl.supports && !providerImpl.supports(request)) continue;
					requests.push(request);
					hasUsableStoredOAuthCredential = true;
				}
				const oauthToken = $env.XAI_OAUTH_TOKEN?.trim();
				if (!hasUsableStoredOAuthCredential && oauthToken) {
					const request = this.#buildUsageRequest(provider, { type: "oauth", accessToken: oauthToken }, baseUrl);
					if (!providerImpl.supports || providerImpl.supports(request)) requests.push(request);
				}
				continue;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#runtimeOverrides.get(providerId);
				const extensionUsageKeyConfig = this.#runtimeUsageProviderOverrides.get(provider)?.apiKey,
					extensionUsageKey = extensionUsageKeyConfig
						? await this.#configValueResolver(extensionUsageKeyConfig)
						: undefined,
					envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? extensionUsageKey ?? envKey;
				if (!apiKey) continue;
				const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				let request: UsageRequestDescriptor;
				if (credential.type === "api_key") {
					const apiKey = await this.#configValueResolver(credential.key);
					if (!apiKey) continue;
					request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				} else {
					request = this.#buildUsageRequestForOauth(provider, credential, baseUrl);
				}
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
		const metadata = report.metadata;
		if (!metadata || typeof metadata !== "object") return undefined;
		const value = metadata[key];
		return typeof value === "string" ? value.trim() : undefined;
	}

	#getUsageReportScopeAccountId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const accountId = limit.scope.accountId?.trim();
			if (accountId) ids.add(accountId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportScopeProjectId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const projectId = limit.scope.projectId?.trim();
			if (projectId) ids.add(projectId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportIdentifiers(report: UsageReport): string[] {
		const identifiers: string[] = [];
		const email = this.#getUsageReportMetadataValue(report, "email");
		if (email) identifiers.push(`email:${email.toLowerCase()}`);
		if (report.provider === "anthropic" || report.provider === "openai-codex") {
			if (identifiers.length === 0) {
				const accountId =
					this.#getUsageReportMetadataValue(report, "accountId") ?? this.#getUsageReportScopeAccountId(report);
				if (accountId) identifiers.push(`account:${accountId}`);
			}
			const orgId = this.#getUsageReportMetadataValue(report, "orgId");
			if (orgId) {
				if (identifiers.length === 0) return [`${report.provider}:org:${orgId.toLowerCase()}`];
				return identifiers.map(
					identifier => `${report.provider}:org:${orgId.toLowerCase()}|${identifier.toLowerCase()}`,
				);
			}
			return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
		}
		const projectId =
			this.#getUsageReportMetadataValue(report, "projectId") ?? this.#getUsageReportScopeProjectId(report);

		if (projectId && !email) identifiers.push(`project:${projectId}`);
		const accountId = this.#getUsageReportMetadataValue(report, "accountId");
		if (accountId) identifiers.push(`account:${accountId}`);
		const account = this.#getUsageReportMetadataValue(report, "account");
		if (account) identifiers.push(`account:${account}`);
		const user = this.#getUsageReportMetadataValue(report, "user");
		if (user) identifiers.push(`account:${user}`);
		const username = this.#getUsageReportMetadataValue(report, "username");
		if (username) identifiers.push(`account:${username}`);
		const scopeAccountId = this.#getUsageReportScopeAccountId(report);
		if (scopeAccountId) identifiers.push(`account:${scopeAccountId}`);
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}

	#mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
		if (reports.length === 1) return reports[0];
		const sorted = [...reports].sort((a, b) => {
			const limitDiff = b.limits.length - a.limits.length;
			if (limitDiff !== 0) return limitDiff;
			return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
		});
		const base = sorted[0];
		const mergedLimits = [...base.limits];
		const limitIds = new Set(mergedLimits.map(limit => limit.id));
		const mergedMetadata: Record<string, unknown> = { ...(base.metadata ?? {}) };
		let fetchedAt = base.fetchedAt;

		for (const report of sorted.slice(1)) {
			fetchedAt = Math.max(fetchedAt, report.fetchedAt);
			for (const limit of report.limits) {
				if (!limitIds.has(limit.id)) {
					limitIds.add(limit.id);
					mergedLimits.push(limit);
				}
			}
			if (report.metadata) {
				for (const [key, value] of Object.entries(report.metadata)) {
					if (mergedMetadata[key] === undefined) {
						mergedMetadata[key] = value;
					}
				}
			}
		}

		return {
			...base,
			fetchedAt,
			limits: mergedLimits,
			metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
		};
	}

	#dedupeUsageReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = this.#getUsageReportIdentifiers(report);
			let groupIndex: number | undefined;
			for (const identifier of identifiers) {
				const existing = idToGroup.get(identifier);
				if (existing !== undefined) {
					groupIndex = existing;
					break;
				}
			}
			if (groupIndex === undefined) {
				groupIndex = groups.length;
				groups.push([]);
			}
			groups[groupIndex].push(report);
			for (const identifier of identifiers) {
				idToGroup.set(identifier, groupIndex);
			}
		}

		const deduped = groups.map(group => this.#mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#usageLogger?.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	#isUsageLimitExhausted(limit: UsageLimit): boolean {
		if (limit.status !== undefined && limit.status !== "unknown") return limit.status === "exhausted";
		const amount = limit.amount;
		if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
		if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
		if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
		if (amount.remaining !== undefined && amount.remaining <= 0) return true;
		if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
		return false;
	}

	#getScopedUsageLimits(
		strategy: CredentialRankingStrategy,
		report: UsageReport,
		context: CredentialRankingContext,
	): UsageLimit[] {
		return strategy.scopeLimits?.(report, context) ?? report.limits;
	}

	#isUsageLimitReached(limits: UsageLimit[]): boolean {
		return limits.some(limit => this.#isUsageLimitExhausted(limit));
	}

	/** Extracts when every currently exhausted window has reset (in ms). */
	#getUsageResetAtMs(limits: UsageLimit[], nowMs: number): number | undefined {
		const candidates: number[] = [];
		for (const limit of limits) {
			if (!this.#isUsageLimitExhausted(limit)) continue;
			const window = limit.window;
			if (window?.resetsAt && window.resetsAt > nowMs) {
				candidates.push(window.resetsAt);
			}
		}
		if (candidates.length === 0) return undefined;
		return Math.max(...candidates);
	}

	async #getUsageReport(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		if (credential.type === "oauth") {
			const storeHook = this.#store.getUsageReport?.bind(this.#store);
			if (storeHook) {
				const report = await storeHook(provider, credential, options?.signal);
				if (report) {
					this.#reconcileCodexUsageBlock(
						this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
						report,
					);
				}
				return report;
			}
		}
		const usageCredential = this.#buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#configValueResolver(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(this.#buildUsageRequest(provider, usageCredential, options?.baseUrl), {
			timeoutMs: options?.timeoutMs ?? this.#usageRequestTimeoutMs,
		});
	}

	usageProviderFor(provider: Provider): UsageProvider | undefined {
		return this.#resolveUsageProvider(provider);
	}

	getUsageReportingModelIds(
		provider: Provider,
		modelIds: readonly string[],
		reports: readonly UsageReport[],
	): string[] {
		const strategy = this.#rankingStrategyResolver?.(provider);
		const providerReports = reports.filter(report => report.provider === provider);
		if (providerReports.length === 0) return [];
		const seen = new Set<string>();
		const reporting: string[] = [];
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			const context: CredentialRankingContext = { modelId };
			const hasUsage = providerReports.some(report => {
				const limits = strategy
					? this.#getScopedUsageLimits(strategy, report, context)
					: report.limits.filter(limit => limit.scope.shared === true || limit.scope.modelId === modelId);
				return limits.some(limit => this.#isUsageLimitExhausted(limit) || resolveUsedFraction(limit) !== undefined);
			});
			if (hasUsage) reporting.push(modelId);
		}
		return reporting;
	}

	async getModelUsageHealth(provider: Provider, options: ModelUsageHealthOptions): Promise<ModelUsageHealth> {
		options.signal?.throwIfAborted();
		const origin = this.getCredentialOrigin(provider);
		const strategy = this.#rankingStrategyResolver?.(provider);
		if (!origin || !strategy || (origin.kind !== "oauth" && origin.kind !== "api_key")) {
			return { state: "unknown", accounts: [] };
		}

		const stored = this.#getStoredCredentials(provider).map((entry, index) => ({ entry, index }));
		const oauthPool = stored.filter(({ entry }) => entry.credential.type === "oauth");
		const apiKeyPool = stored.filter(({ entry }) => entry.credential.type === "api_key");
		const loginApiKeyPool = apiKeyPool.filter(
			({ entry }) => entry.credential.type === "api_key" && entry.credential.source === "login",
		);
		const pool = origin.kind === "oauth" ? oauthPool : loginApiKeyPool;
		if (pool.length === 0) return { state: "unknown", accounts: [] };
		const sessionCredential = this.#getSessionCredential(provider, options.sessionId);
		const selectedCredentialId =
			sessionCredential?.type === origin.kind
				? this.#getStoredCredentials(provider)[sessionCredential.index]?.id
				: undefined;

		const rankingContext: CredentialRankingContext = { modelId: options.modelId };
		const planRequirement = resolveOpenAICodexPlanRequirement(provider, options.modelId);
		const planEligibilityByCredential = new Map<number, boolean | undefined>();
		const blockScope = strategy.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const reserveFraction = Number.isFinite(options.reserveFraction)
			? Math.max(0, Math.min(1, options.reserveFraction))
			: 0;
		const nowMs = Date.now();
		let accounts = await Promise.all(
			pool.map(async ({ entry, index }): Promise<ModelUsageAccountHealth> => {
				const credentialType = entry.credential.type;
				const providerKey = this.#getProviderTypeKey(provider, credentialType);
				let blockedUntil = this.#getCredentialBlockedUntil(provider, providerKey, index, blockScopes);
				if (blockedUntil !== undefined && provider !== "openai-codex") {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}

				let report: UsageReport | null;
				try {
					report = await raceUsageWithSignal(
						this.#getUsageReport(provider, entry.credential, {
							baseUrl: options.baseUrl,
							timeoutMs: this.#usageRequestTimeoutMs,
							signal: options.signal,
						}),
						options.signal,
					);
				} catch (error) {
					if (options.signal?.aborted) throw error;
					report = null;
				}
				if (planRequirement !== "none") {
					planEligibilityByCredential.set(entry.id, getOpenAICodexPlanEligibility(report, planRequirement));
				}

				if (provider === "openai-codex") {
					blockedUntil = this.#getCredentialBlockedUntil(provider, providerKey, index, blockScopes);
				}
				if (blockedUntil !== undefined) {
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: blockedUntil,
					};
				}
				if (!report) return { credentialId: entry.id, credentialType, state: "unknown" };

				const limits =
					strategy.scopeLimitsForReserve?.(report, rankingContext) ??
					this.#getScopedUsageLimits(strategy, report, rankingContext);
				if (limits.length === 0) return { credentialId: entry.id, credentialType, state: "unknown" };

				const currentLimits = limits.filter(limit => {
					const resetsAt = limit.window?.resetsAt;
					return resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
				});
				if (currentLimits.length === 0) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				const activeExhausted = currentLimits.filter(limit => this.#isUsageLimitExhausted(limit));
				if (activeExhausted.length > 0) {
					const futureResets = activeExhausted
						.map(limit => limit.window?.resetsAt)
						.filter((resetsAt): resetsAt is number => resetsAt !== undefined && resetsAt > nowMs);
					return {
						credentialId: entry.id,
						credentialType,
						state: "depleted",
						resetsAt: futureResets.length > 0 ? Math.min(...futureResets) : undefined,
					};
				}

				const usedFractions = currentLimits
					.map(resolveUsedFraction)
					.filter((fraction): fraction is number => fraction !== undefined);
				if (usedFractions.length === 0) {
					return { credentialId: entry.id, credentialType, state: "unknown" };
				}
				const remainingFraction = Math.max(0, 1 - Math.max(...usedFractions));
				return {
					credentialId: entry.id,
					credentialType,
					state: remainingFraction <= reserveFraction ? "reserve" : "healthy",
					remainingFraction,
				};
			}),
		);
		if (planRequirement !== "none") {
			accounts = accounts.filter(account => planEligibilityByCredential.get(account.credentialId) !== false);
		}
		if (selectedCredentialId !== undefined) {
			const selectedAccount = accounts.find(account => account.credentialId === selectedCredentialId);
			if (selectedAccount) selectedAccount.selected = true;
		}

		if (accounts.some(account => account.state === "healthy")) return { state: "healthy", accounts };
		if (accounts.some(account => account.state === "unknown")) return { state: "unknown", accounts };
		if (accounts.some(account => account.state === "reserve")) return { state: "reserve", accounts };
		return { state: "depleted", accounts };
	}

	releaseSessionCredentialForReselection(provider: string, sessionId: string): boolean {
		if (!this.#getSessionCredential(provider, sessionId)) return false;
		this.#clearSessionCredential(provider, sessionId);
		return true;
	}

	#fetchUsageRequests(
		requests: readonly UsageRequestDescriptor[],
		serializedProviders: ReadonlySet<Provider>,
	): Promise<Array<UsageReport | null>> {
		const tails = new Map<Provider, Promise<void>>();
		return Promise.all(
			requests.map(request => {
				const forceRefresh = serializedProviders.has(request.provider);
				if (!forceRefresh) {
					return this.#fetchUsageCached(request, { timeoutMs: this.#usageRequestTimeoutMs });
				}
				const tail = tails.get(request.provider) ?? Promise.resolve();
				const current = tail.then(() =>
					this.#fetchUsageCached(request, { timeoutMs: this.#usageRequestTimeoutMs, forceRefresh: true }),
				);
				tails.set(
					request.provider,
					current.then(
						() => undefined,
						() => undefined,
					),
				);
				return current;
			}),
		);
	}

	async fetchUsageReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;

		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		const storeOverride = this.#store.fetchUsageReports?.bind(this.#store);
		const override = this.#fetchUsageReportsOverride ?? storeOverride;
		const shouldReconcileStoreHookReports =
			this.#fetchUsageReportsOverride === undefined && storeOverride !== undefined;
		if (override) {
			const overrideKey = `__override__\0${this.#usageCacheEpoch}`;
			let shared = this.#usageReportsInFlight.get(overrideKey);
			if (!shared) {
				shared = override().finally(() => {
					this.#usageReportsInFlight.delete(overrideKey);
				});
				this.#usageReportsInFlight.set(overrideKey, shared);
			}
			const reports = await raceUsageWithSignal(shared, options?.signal);
			if (shouldReconcileStoreHookReports && reports) this.#reconcileCodexUsageBlocksFromReports(reports);
			return reports;
		}
		if (!this.#usageProviderResolver && this.#runtimeUsageProviderOverrides.size === 0) return null;

		const requests = await this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.#usageLogger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		const forcedRefresh = this.#usageForceRefresh(requests);
		const cacheKey = `${this.#buildUsageReportsCacheKey(requests)}\0${this.#usageCacheEpoch}`;

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			for (const request of requests) {
				this.#usageLogger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await this.#fetchUsageRequests(requests, forcedRefresh.providers);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = this.#dedupeUsageReports(reports);

			const resolved = deduped;
			this.#usageLogger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						this.#getUsageReportMetadataValue(report, "email") ??
						this.#getUsageReportMetadataValue(report, "accountId") ??
						this.#getUsageReportMetadataValue(report, "account") ??
						this.#getUsageReportMetadataValue(report, "user") ??
						this.#getUsageReportMetadataValue(report, "username") ??
						this.#getUsageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			this.#clearUsageForceRefresh(forcedRefresh);
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return promise;
	}

	async checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const stored = this.#store.listAuthCredentials();

		const timeoutMs = options?.timeoutMs ?? this.#usageRequestTimeoutMs;
		const completionProbe = options?.completionProbe;
		const completionTimeoutMs = options?.completionTimeoutMs ?? timeoutMs;
		const ctx: UsageFetchContext = {
			fetch: this.#usageFetch,
			logger: this.#usageLogger,
		};

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.orgId) base.orgId = row.credential.orgId;
				if (row.credential.orgName) base.orgName = row.credential.orgName;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			let initialRequest: UsageRequestDescriptor;
			if (cred.type === "api_key") {
				const apiKey = await this.#configValueResolver(cred.key);
				if (!apiKey) {
					base.reason = "api key reference could not be resolved";
					results.push(base);
					continue;
				}
				initialRequest = this.#buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey }, baseUrl);
			} else {
				initialRequest = this.#buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const probeSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			let params: UsageFetchParams & { signal: AbortSignal } = {
				...initialRequest,
				accountKey: this.#buildUsageCacheIdentity(initialRequest.credential),
				signal: probeSignal,
			};
			let refreshError: string | undefined;

			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = this.#buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#refreshOAuthCredential(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = this.#mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#persistRefreshedUsageCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
							row.id,
						);
						params = {
							...params,
							credential: refreshedCredential,
							accountKey: this.#buildUsageCacheIdentity(refreshedCredential),
						};
					} catch (error) {
						refreshError = `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}

			if (refreshError) {
				base.ok = false;
				base.reason = refreshError;

				results.push(base);
				continue;
			}

			const providerImpl = this.#resolveUsageProvider(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
			} else if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
			} else if (providerImpl.validatesCredentials === false) {
				base.reason = `usage probe for ${row.provider} does not validate credentials`;
			} else {
				try {
					const report = await providerImpl.fetchUsage(params, ctx);
					if (report === null) {
						base.reason = "usage probe returned no data for this credential";
					} else {
						base.ok = true;
						const accountId = this.#getUsageReportMetadataValue(report, "accountId");
						const email = this.#getUsageReportMetadataValue(report, "email");
						if (accountId) base.accountId = accountId;
						if (email) base.email = email;
						const { raw: _raw, ...trimmed } = report;
						base.report = trimmed;
					}
				} catch (error) {
					base.ok = false;
					base.reason = error instanceof Error ? error.message : String(error);
				}
			}

			if (completionProbe) {
				const probeCred = this.#buildCompletionProbeCredential(params.credential);
				if (!probeCred) {
					base.completion = {
						ok: null,
						reason: `no bearer bytes available for ${row.credential.type} credential`,
					};
				} else {
					const completionTimeoutSignal = AbortSignal.timeout(completionTimeoutMs);
					const completionSignal = options?.signal
						? AbortSignal.any([options.signal, completionTimeoutSignal])
						: completionTimeoutSignal;
					try {
						base.completion = await completionProbe({
							provider: row.provider as Provider,
							credentialId: row.id,
							credential: probeCred,
							signal: completionSignal,
						});
					} catch (error) {
						base.completion = {
							ok: false,
							reason: error instanceof Error ? error.message : String(error),
						};
					}
				}
			}

			results.push(base);
		}

		return results;
	}

	async #resolveCredentialTarget(
		provider: string,
		sessionId: string | undefined,
		options?: { credentialId?: number; apiKey?: string },
	): Promise<{ type: AuthCredential["type"]; index: number; explicit: boolean } | undefined> {
		const explicit = options?.credentialId !== undefined || options?.apiKey !== undefined;
		if (explicit) {
			const latestRows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}
		if (options?.credentialId !== undefined) {
			const stored = this.#getStoredCredentials(provider);
			const index = stored.findIndex(entry => entry.id === options.credentialId);
			const entry = index === -1 ? undefined : stored[index];
			if (entry) return { type: entry.credential.type, index, explicit: true };
		}
		if (options?.apiKey !== undefined) {
			const stored = this.#getStoredCredentials(provider);
			for (let index = 0; index < stored.length; index++) {
				const entry = stored[index];
				if (entry && (await this.#credentialMatchesApiKey(entry.credential, options.apiKey))) {
					return { type: entry.credential.type, index, explicit: true };
				}
			}
		}
		if (explicit) return undefined;
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		return sessionCredential ? { ...sessionCredential, explicit: false } : undefined;
	}

	#credentialBlockRouting(
		provider: string,
		credentialType: AuthCredential["type"],
		modelId: string | undefined,
		blockScopeOverride?: string,
	): CredentialBlockRouting {
		const providerKey = this.#getProviderTypeKey(provider, credentialType);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId };
		const defaultBlockScope = strategy?.blockScope?.(rankingContext);
		const blockScope = blockScopeOverride ?? defaultBlockScope;
		const requestBlockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, defaultBlockScope);
		const siblingBlockScopes =
			blockScopeOverride && !requestBlockScopes.includes(blockScopeOverride)
				? [...requestBlockScopes, blockScopeOverride]
				: requestBlockScopes;
		return {
			providerKey,
			strategy,
			rankingContext,
			blockScope,
			siblingBlockScopes,
		};
	}

	#blockCredentialForRotation(
		provider: string,
		credentialType: AuthCredential["type"],
		targetIndex: number,
		blockedUntil: number,
		routing: CredentialBlockRouting,
	): UsageLimitMarkResult {
		if (targetIndex >= 0) {
			this.#markCredentialBlocked(provider, routing.providerKey, targetIndex, blockedUntil, routing.blockScope);
		}

		const remainingCredentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === credentialType && entry.index !== targetIndex,
			);

		let retryAtMs: number | undefined;
		for (const candidate of remainingCredentials) {
			const candidateBlockedUntil = this.#getCredentialBlockedUntil(
				provider,
				routing.providerKey,
				candidate.index,
				routing.siblingBlockScopes,
			);
			if (candidateBlockedUntil === undefined) return { switched: true };
			if (retryAtMs === undefined || candidateBlockedUntil < retryAtMs) retryAtMs = candidateBlockedUntil;
		}
		return { switched: false, retryAtMs };
	}

	async markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: {
			retryAfterMs?: number;
			baseUrl?: string;
			modelId?: string;
			apiKey?: string;
			credentialId?: number;
			signal?: AbortSignal;
		},
	): Promise<UsageLimitMarkResult> {
		let sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
		});
		if (!sessionCredential && options?.credentialId === undefined && options?.apiKey !== undefined) {
			const credentialId = this.#findOAuthCredentialIdForBearer(provider, options.apiKey);
			const index =
				credentialId === undefined
					? -1
					: this.#getStoredCredentials(provider).findIndex(
							entry => entry.id === credentialId && entry.credential.type === "oauth",
						);
			if (index >= 0) sessionCredential = { type: "oauth", index, explicit: true };
		}
		if (!sessionCredential) return { switched: false };
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		if (!target || target.credential.type !== sessionCredential.type) return { switched: false };
		const credentialType = sessionCredential.type;
		const targetCredentialId = target.id;

		const routing = this.#credentialBlockRouting(provider, credentialType, options?.modelId);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.#defaultBackoffMs);

		if (credentialType === "oauth" && target.credential.type === "oauth" && routing.strategy) {
			const report = await raceUsageWithSignal(
				this.#getUsageReport(provider, target.credential, options),
				options?.signal,
			);
			if (report) {
				const scopedLimits = this.#getScopedUsageLimits(routing.strategy, report, routing.rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}
		options?.signal?.throwIfAborted();

		const targetIndex = this.#getStoredCredentials(provider).findIndex(
			entry => entry.id === targetCredentialId && entry.credential.type === credentialType,
		);
		return this.#blockCredentialForRotation(provider, credentialType, targetIndex, blockedUntil, routing);
	}

	#resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
		if (!window) return undefined;
		if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
			return window.resetsAt;
		}
		return undefined;
	}

	#normalizeUsageFraction(limit: UsageLimit | undefined): number {
		const usedFraction = limit?.amount.usedFraction;
		if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
			return 0.5;
		}
		return Math.min(Math.max(usedFraction, 0), 1);
	}

	#computeWindowRequiredDrain(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
		const headroom = 1 - this.#normalizeUsageFraction(limit);
		if (headroom <= 0) return 0;
		const resetAt = this.#resolveWindowResetAt(limit?.window);
		const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
		let remainingMs = resetAt === undefined ? durationMs : resetAt - nowMs;
		if (Number.isFinite(durationMs) && durationMs > 0) {
			remainingMs = Math.min(remainingMs, durationMs);
		}

		const remainingHours = Math.max(remainingMs, 60_000) / (60 * 60 * 1000);
		return headroom / remainingHours;
	}

	#compareUsageRankedCandidatePriority(
		left: UsageRankedCandidate<AuthCredential>,
		right: UsageRankedCandidate<AuthCredential>,
		planRequirement: OpenAICodexPlanRequirement,
	): number {
		if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
		if (left.blocked && right.blocked) {
			const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
			const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
			if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
			return 0;
		}
		if (planRequirement !== "none" && left.planPriority !== right.planPriority) {
			return left.planPriority - right.planPriority;
		}
		if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;

		const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
		if (leftHot !== rightHot) return leftHot ? 1 : -1;

		const leftMeasured = left.usage !== null;
		const rightMeasured = right.usage !== null;
		if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;

		let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
		if (metric !== 0) return metric;
		metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
		if (metric !== 0) return metric;
		return 0;
	}

	#compareUsageRankedCandidates(
		left: UsageRankedCandidate<AuthCredential>,
		right: UsageRankedCandidate<AuthCredential>,
		planRequirement: OpenAICodexPlanRequirement,
	): number {
		const priority = this.#compareUsageRankedCandidatePriority(left, right, planRequirement);
		return priority !== 0 ? priority : left.orderPos - right.orderPos;
	}

	#orderUsageRankedCandidates<T extends AuthCredential>(
		candidates: UsageRankedCandidate<T>[],
		planRequirement: OpenAICodexPlanRequirement,
	): UsageCandidate<T>[] {
		candidates.sort((left, right) => this.#compareUsageRankedCandidates(left, right, planRequirement));
		return candidates.map(candidate => ({
			selection: candidate.selection,
			usage: candidate.usage,
			usageChecked: candidate.usageChecked,
		}));
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		planRequirement: OpenAICodexPlanRequirement;
		credentials: OAuthSelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;

		blockScopes?: readonly string[];
	}): Promise<OAuthCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedOAuthCandidate[] = [];

		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				let blockedUntil = this.#getCredentialBlockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				let usage: UsageReport | null = null;
				let usageChecked = false;
				if (blockedUntil !== undefined && args.provider === "openai-codex") {
					usage = await this.#getUsageReport(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
					blockedUntil = this.#getCredentialBlockedUntil(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					);
				}
				if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
				if (!usageChecked) {
					usage = await this.#getUsageReport(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				return { selection, usage, usageChecked, blockedUntil: undefined as number | undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();

		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			return (
				result ??
				args.order.map(idx => {
					const selection = args.credentials[idx];
					return selection ? { selection, usage: null, usageChecked: false, blockedUntil: undefined } : null;
				})
			);
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? this.#getScopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && this.#isUsageLimitReached(scopedLimits)) {
				const resetAtMs = this.#getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				planPriority: getOpenAICodexPlanPriority(usage, args.planRequirement),
				secondaryUsed: this.#normalizeUsageFraction(secondary),
				secondaryRequiredDrain: this.#computeWindowRequiredDrain(
					secondary,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryRequiredDrain: this.#computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return this.#orderUsageRankedCandidates(ranked, args.planRequirement);
	}

	async #resolveOAuthSelection(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");

		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);

		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const planRequirement = resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const checkUsage = strategy !== undefined && (credentials.length > 1 || hasPlanRequirement);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);

		const sessionPreferredLastUsedAtMs =
			sessionCredential?.type === "oauth" ? sessionCredential.lastUsedAtMs : undefined;
		const sessionPreferredIsWarm =
			provider !== "anthropic" ||
			sessionPreferredLastUsedAtMs === undefined ||
			Date.now() - sessionPreferredLastUsedAtMs < ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS;
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#isCredentialBlocked(provider, providerKey, sessionPreferredIndex, blockScopes);
		const shouldRank = checkUsage && (!sessionPreferredIsAvailable || !sessionPreferredIsWarm || hasPlanRequirement);

		const baseRankingOrder = credentials.map((_credential, index) => index);
		let rankingOrder = shouldRank && sessionId ? baseRankingOrder : order;
		const sessionPreferredRankingPos =
			shouldRank && sessionId && sessionPreferredIndex !== undefined && !hasPlanRequirement
				? credentials.findIndex(entry => entry.index === sessionPreferredIndex)
				: -1;
		if (sessionPreferredRankingPos > 0) {
			rankingOrder = [
				sessionPreferredRankingPos,
				...baseRankingOrder.filter(index => index !== sessionPreferredRankingPos),
			];
		}
		const candidates = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					planRequirement,
					order: rankingOrder,
					credentials,
					options,
					strategy: strategy!,
					rankingContext,
					blockScope,
					blockScopes,
				})
			: order
					.map(idx => credentials[idx])
					.filter((selection): selection is { credential: OAuthCredential; index: number } => Boolean(selection))
					.map(selection => ({ selection, usage: null, usageChecked: false }));
		const preflightFailures = new Set<OAuthCandidate>();

		if (!shouldRank && sessionPreferredIndex !== undefined && !hasPlanRequirement) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
					candidate.selection.index === sessionPreferredIndex,
			);
			if (sessionPreferredCandidate > 0) {
				const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
			}
		}

		const forceRefreshIndex = options?.forceRefresh
			? (sessionPreferredIndex ?? candidates[0]?.selection.index)
			: undefined;
		await Promise.all(
			candidates.map(async candidate => {
				const force = forceRefreshIndex !== undefined && candidate.selection.index === forceRefreshIndex;
				const initialCredentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
				let syncedPeerCredential = false;
				if (initialCredentialId !== undefined) {
					const beforeSync = candidate.selection.credential;
					if (!this.#syncOAuthSelectionFromStore(provider, candidate.selection, initialCredentialId)) return;
					syncedPeerCredential = !authCredentialEquals(beforeSync, candidate.selection.credential);
				}
				const hasFreshAccess = Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires;
				if ((!force || syncedPeerCredential) && hasFreshAccess) return;
				const latestCredential = this.#getCredentialsForProvider(provider)[candidate.selection.index];
				if (
					!force &&
					latestCredential?.type === "oauth" &&
					Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires
				) {
					candidate.selection.credential = latestCredential;
					return;
				}
				const credentialId = this.#getStoredCredentials(provider)[candidate.selection.index]?.id;
				try {
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#refreshOAuthCredential(
						provider,
						refreshTarget,
						credentialId,
						options?.signal,
					);
					const updated: OAuthCredential = {
						...candidate.selection.credential,
						...refreshedCredentials,
						type: "oauth",
					};
					candidate.selection.credential = updated;
					if (credentialId !== undefined) {
						const idx = this.#replaceCredentialById(provider, credentialId, updated);
						if (idx !== -1) candidate.selection.index = idx;
					} else {
						this.#replaceCredentialAt(provider, candidate.selection.index, updated);
					}
				} catch (error) {
					const errorMsg = String(error);
					const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: errorMsg,
						isDefinitiveFailure,
					});
					if (isDefinitiveFailure) {
						const outcome = await this.#disableDefinitiveOAuthFailure(
							provider,
							credentialId,
							candidate.selection.credential,
							candidate.selection.index,
							errorMsg,
						);
						if (
							outcome !== "disabled" &&
							credentialId !== undefined &&
							this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)
						) {
							return;
						}
					} else if (credentialId !== undefined) {
						const latestIndex = this.#getStoredCredentials(provider).findIndex(
							entry => entry.id === credentialId,
						);
						if (latestIndex !== -1) {
							this.#markCredentialBlocked(
								provider,
								providerKey,
								latestIndex,
								Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
								blockScope,
							);
						}
					}
					preflightFailures.add(candidate);
				}
			}),
		);

		const enforcePlanRequirement =
			hasPlanRequirement &&
			candidates.some(candidate => getOpenAICodexPlanEligibility(candidate.usage, planRequirement) === true);

		if (hasPlanRequirement && sessionPreferredIndex !== undefined) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
					candidate.selection.index === sessionPreferredIndex,
			);
			if (sessionPreferredCandidate > 0) {
				const preferred = candidates[sessionPreferredCandidate]!;
				const planEligibility = getOpenAICodexPlanEligibility(preferred.usage, planRequirement);
				if (planEligibility === true || (!enforcePlanRequirement && planEligibility !== false)) {
					candidates.splice(sessionPreferredCandidate, 1);
					candidates.unshift(preferred);
				}
			}
		}

		const passes: Array<{ allowBlocked: boolean; enforcePlanRequirement: boolean }> = [
			{ allowBlocked: false, enforcePlanRequirement },
			{ allowBlocked: true, enforcePlanRequirement },
		];
		if (enforcePlanRequirement) passes.push({ allowBlocked: true, enforcePlanRequirement: false });

		for (const pass of passes) {
			for (const candidate of candidates) {
				if (preflightFailures.has(candidate)) continue;
				const resolved = await this.#tryOAuthCredential(
					provider,
					candidate.selection,
					providerKey,
					sessionId,
					options,
					{
						checkUsage,
						allowBlocked: pass.allowBlocked,
						prefetchedUsage: candidate.usage,
						usagePrechecked: candidate.usageChecked,
						planRequirement,
						enforcePlanRequirement: pass.enforcePlanRequirement,
						strategy,
						rankingContext,
						blockScope,
						blockScopes,
					},
				);
				if (resolved) return resolved;
			}
		}

		return undefined;
	}

	async #disableDefinitiveOAuthFailure(
		provider: string,
		credentialId: number | undefined,
		attemptedCredential: OAuthCredential,
		index: number,
		errorMsg: string,
	): Promise<"disabled" | "peer-rotated" | "cas-lost"> {
		if (credentialId !== undefined) {
			const latestRow = this.#store.listAuthCredentials(provider).find(row => row.id === credentialId);
			const latestCredential = latestRow?.credential;
			if (latestCredential?.type === "oauth" && latestCredential.refresh !== attemptedCredential.refresh) {
				logger.debug("OAuth refresh race detected; another process rotated token first", {
					provider,
					index,
					credentialId,
				});
				await this.reload();
				return "peer-rotated";
			}
		}

		const disabled =
			credentialId !== undefined
				? this.#disableCredentialByIdIfMatches(
						provider,
						credentialId,
						attemptedCredential,
						`oauth refresh failed: ${errorMsg}`,
					)
				: this.#tryDisableCredentialAtIfMatches(
						provider,
						index,
						attemptedCredential,
						`oauth refresh failed: ${errorMsg}`,
					);
		if (!disabled) {
			logger.debug("OAuth refresh disable lost CAS; reloading after peer rotation", { provider, index });
			await this.reload();
			return "cas-lost";
		}
		return "disabled";
	}

	async #refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return raceCredentialRefreshWithSignal(existing, signal);
		}
		if (Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal);
		}
		const promise = this.#refreshOAuthCredentialUnshared(provider, credential, credentialId).finally(() => {
			this.#oauthCredentialRefreshInFlight.delete(credentialId);
		});
		this.#oauthCredentialRefreshInFlight.set(credentialId, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		const hasDurableLease =
			!!this.#store.tryAcquireCredentialRefreshLease &&
			!!this.#store.getCredentialRefreshLeaseExpiresAt &&
			!!this.#store.releaseCredentialRefreshLease &&
			!!this.#store.renewCredentialRefreshLease;
		if (credentialId !== undefined && hasDurableLease) {
			const forceRefresh = credential.expires === 0;
			const result = await this.refreshStoredOAuthCredential(provider, {
				credentialId,
				observedCredential: forceRefresh ? undefined : credential,
				credentialFromRow: row => row,
				forceRefresh,
				signal,
				refresh: (current, refreshSignal) =>
					this.#requestOAuthCredentialRefresh(
						provider,
						current,
						credentialId,
						signal && refreshSignal ? AbortSignal.any([signal, refreshSignal]) : (signal ?? refreshSignal),
					),
				isDefinitiveFailure: error => AIError.isDefinitiveOAuthFailure(String(error)),
				disabledCause: error => `oauth refresh failed: ${String(error)}`,
			});
			if (result.credential) {
				if (result.refreshed) {
					if (Date.now() < result.credential.expires) return result.credential;
				} else if (Date.now() + OAUTH_REFRESH_SKEW_MS < result.credential.expires) {
					return result.credential;
				}
				throw new AIError.OAuthError(
					`OAuth refresh did not produce a usable credential for provider: ${provider}`,
					{
						kind: "token-refresh",
						provider,
					},
				);
			}
			throw new AIError.OAuthError(`OAuth credential no longer exists for provider: ${provider}`, {
				kind: "token-refresh",
				provider,
			});
		}
		return this.#requestOAuthCredentialRefresh(provider, credential, credentialId, signal);
	}

	async #requestOAuthCredentialRefresh(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		let refreshPromise: Promise<OAuthCredentials>;

		const storeRefresh = this.#store.refreshOAuthCredential?.bind(this.#store);
		const overrideRefresh = this.#refreshOAuthCredentialOverride ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			refreshPromise = overrideRefresh(provider, credentialId, credential, signal);
		} else {
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				if (!customProvider.refreshToken) {
					throw new AIError.OAuthError(`OAuth provider "${provider}" does not support token refresh`, {
						kind: "configuration",
						provider,
					});
				}
				refreshPromise = customProvider.refreshToken(credential, signal);
			} else {
				refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential, signal);
			}
		}

		const cancellation = Promise.withResolvers<never>();
		let onAbort: (() => void) | undefined;
		const timeout = setTimeout(
			() =>
				cancellation.reject(
					new AIError.OAuthError(`OAuth token refresh timed out for provider: ${provider}`, {
						kind: "timeout",
						provider,
					}),
				),
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
		if (signal) {
			if (signal.aborted) {
				cancellation.reject(new AIError.AbortError("OAuth token refresh aborted by caller"));
			} else {
				onAbort = () => cancellation.reject(new AIError.AbortError("OAuth token refresh aborted by caller"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		try {
			return await Promise.race([refreshPromise, cancellation.promise]);
		} finally {
			clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	#syncOAuthSelectionFromStore(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		const latestIndex = latestRows.findIndex(row => row.id === credentialId);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		const stored = this.#getStoredCredentials(provider);
		const selected = stored[selection.index];
		if (selected?.credential.type !== "oauth") return false;

		const prepare = this.#store.prepareForRequest?.bind(this.#store);
		if (prepare) {
			await prepare(selected.id, { signal: options?.signal });
		}
		return this.#syncOAuthSelectionFromStore(provider, selection, selected.id);
	}

	async #tryOAuthCredential(
		provider: Provider,
		selection: { credential: OAuthCredential; index: number },
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: {
			checkUsage: boolean;
			allowBlocked: boolean;
			prefetchedUsage?: UsageReport | null;
			usagePrechecked?: boolean;
			planRequirement?: OpenAICodexPlanRequirement;
			enforcePlanRequirement?: boolean;
			strategy?: CredentialRankingStrategy;
			rankingContext?: CredentialRankingContext;
			blockScope?: string;
			blockScopes?: readonly string[];

			allowFallback?: boolean;
		},
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			planRequirement: providedPlanRequirement,
			enforcePlanRequirement,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
			allowFallback = true,
		} = usageOptions;
		if (
			!allowBlocked &&
			this.#isCredentialBlocked(provider, providerKey, selection.index, blockScopes ?? blockScope)
		) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}

		const credentialId = this.#getStoredCredentials(provider)[selection.index]?.id;

		const planRequirement = providedPlanRequirement ?? resolveOpenAICodexPlanRequirement(provider, options?.modelId);
		const hasPlanRequirement = planRequirement !== "none";
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#getUsageReport(provider, selection.credential, {
					...options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
				if (this.#isUsageLimitReached(scopedLimits)) {
					const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
					this.#markCredentialBlocked(
						provider,
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
						blockScope,
					);
					return undefined;
				}
			}
		}

		try {
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated: OAuthCredential = {
				type: "oauth",
				access: result.newCredentials.access,
				refresh: result.newCredentials.refresh,
				expires: result.newCredentials.expires,
				accountId: result.newCredentials.accountId ?? selection.credential.accountId,
				email: result.newCredentials.email ?? selection.credential.email,
				projectId: result.newCredentials.projectId ?? selection.credential.projectId,
				enterpriseUrl: result.newCredentials.enterpriseUrl ?? selection.credential.enterpriseUrl,
				apiEndpoint: result.newCredentials.apiEndpoint ?? selection.credential.apiEndpoint,
				orgId: result.newCredentials.orgId ?? selection.credential.orgId,
				orgName: result.newCredentials.orgName ?? selection.credential.orgName,
				authorizedAt: result.newCredentials.authorizedAt ?? selection.credential.authorizedAt,
			};
			if (credentialId !== undefined) {
				const idx = this.#replaceCredentialById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				this.#replaceCredentialAt(provider, selection.index, updated);
			}
			if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#getUsageReport(provider, updated, {
						...options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyPlanFilter && getOpenAICodexPlanEligibility(usage, planRequirement) !== true) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
					const scopedLimits = this.#getScopedUsageLimits(strategy, usage, rankingContext);
					if (this.#isUsageLimitReached(scopedLimits)) {
						const resetAtMs = this.#getUsageResetAtMs(scopedLimits, Date.now());
						this.#markCredentialBlocked(
							provider,
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
							blockScope,
						);
						return undefined;
					}
				}
			}
			this.#recordOAuthBearerCredentialId(provider, result.apiKey, credentialId);
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return { apiKey: result.apiKey, credential: updated, credentialId };
		} catch (error) {
			const errorMsg = String(error);

			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				const outcome = await this.#disableDefinitiveOAuthFailure(
					provider,
					credentialId,
					selection.credential,
					selection.index,
					errorMsg,
				);
				if (outcome === "peer-rotated") {
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
					return undefined;
				}
				if (outcome === "cas-lost") return undefined;
				if (this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.#resolveOAuthSelection(provider, sessionId, options);
				}
			} else {
				this.#markCredentialBlocked(
					provider,
					providerKey,
					selection.index,
					Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
				);
			}
		}

		return undefined;
	}

	async peekApiKey(provider: string): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		const oauthSelection = this.#selectCredentialByType(provider, "oauth");
		if (oauthSelection) {
			const expiresAt = oauthSelection.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				if (provider === "github-copilot") {
					return JSON.stringify({
						token: oauthSelection.credential.access,
						enterpriseUrl: oauthSelection.credential.enterpriseUrl,
						apiEndpoint: oauthSelection.credential.apiEndpoint,
					});
				}
				return oauthSelection.credential.access;
			}
		}

		const loginApiKeySelection = this.#selectCredentialByType(
			provider,
			"api_key",
			undefined,
			credential => credential.type === "api_key" && credential.source === "login",
		);
		if (loginApiKeySelection) {
			return this.#configValueResolver(loginApiKeySelection.credential.key);
		}

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	async getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) {
			return runtimeKey;
		}

		const configKey = this.#configOverrides.get(provider);
		if (configKey) {
			return configKey;
		}

		const oauthResolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (oauthResolved) {
			return oauthResolved.apiKey;
		}
		const loginApiKeySelection = await this.#selectApiKeyCredential(
			provider,
			sessionId,
			options,
			credential => credential.source === "login",
		);
		if (loginApiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", loginApiKeySelection.index);
			return this.#configValueResolver(loginApiKeySelection.credential.key);
		}

		if (sessionId) this.#sessionLastCredential.get(provider)?.delete(sessionId);

		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;
		const apiKeySelection = await this.#selectApiKeyCredential(
			provider,
			sessionId,
			options,
			credential => credential.source !== "login",
		);
		if (apiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	async getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccess | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const resolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (!resolved) return undefined;
		const { credential, credentialId } = resolved;
		return {
			accessToken: credential.access,
			credentialId,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
			orgId: credential.orgId,
			orgName: credential.orgName,
		};
	}

	#getStoredOAuthSelections(provider: string): StoredOAuthSelection[] {
		return this.#getStoredCredentials(provider)
			.map((entry, index) => ({ credentialId: entry.id, credential: entry.credential, index }))
			.filter((entry): entry is StoredOAuthSelection => entry.credential.type === "oauth");
	}

	async #resolveStoredOAuthAccess(
		provider: string,
		selection: StoredOAuthSelection,
		providerKey: string,
		options: AuthApiKeyOptions | undefined,
	): Promise<OAuthAccessResolution> {
		try {
			const resolved = await this.#tryOAuthCredential(
				provider,
				{ credential: selection.credential, index: selection.index },
				providerKey,
				undefined,
				options,
				{ checkUsage: false, allowBlocked: true, allowFallback: false },
			);
			if (!resolved) {
				return {
					ok: false,
					credentialId: selection.credentialId,
					accountId: selection.credential.accountId,
					email: selection.credential.email,
					projectId: selection.credential.projectId,
					enterpriseUrl: selection.credential.enterpriseUrl,
					orgId: selection.credential.orgId,
					orgName: selection.credential.orgName,
					error: "OAuth access unavailable",
				};
			}
			const { credential } = resolved;
			return {
				ok: true,
				credentialId: selection.credentialId,
				accessToken: credential.access,
				accountId: credential.accountId,
				email: credential.email,
				projectId: credential.projectId,
				enterpriseUrl: credential.enterpriseUrl,
				orgId: credential.orgId,
				orgName: credential.orgName,
			};
		} catch (error) {
			return {
				ok: false,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				orgId: selection.credential.orgId,
				orgName: selection.credential.orgName,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	listOAuthAccounts(provider: string, sessionId?: string): OAuthAccountSummary[] {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const activeCredentialId =
			sessionCredential?.type === "oauth"
				? this.#getStoredCredentials(provider)[sessionCredential.index]?.id
				: undefined;
		return this.#getStoredOAuthSelections(provider).map((selection, position) => ({
			position,
			credentialId: selection.credentialId,
			accountId: selection.credential.accountId,
			email: selection.credential.email,
			projectId: selection.credential.projectId,
			enterpriseUrl: selection.credential.enterpriseUrl,
			orgId: selection.credential.orgId,
			orgName: selection.credential.orgName,
			active: selection.credentialId === activeCredentialId,
		}));
	}

	pinSessionOAuthAccount(
		provider: string,
		sessionId: string,
		credentialId: number,
		options?: { lastUsedAtMs?: number },
	): boolean {
		if (!sessionId || this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return false;
		}
		const stored = this.#getStoredCredentials(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		const target = stored[index];
		if (target?.credential.type !== "oauth") return false;
		this.#recordSessionCredential(provider, sessionId, "oauth", index, options?.lastUsedAtMs);
		return true;
	}

	async getOAuthAccesses(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return [];
		}
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return Promise.all(
			this.#getStoredOAuthSelections(provider).map(selection =>
				this.#resolveStoredOAuthAccess(provider, selection, providerKey, options),
			),
		);
	}

	async getOAuthAccessAt(
		provider: string,
		position: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider)[position];
		if (!selection) return undefined;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	async getOAuthAccessByCredentialId(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (this.#runtimeOverrides.has(provider) || this.#configOverrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider).find(
			candidate => candidate.credentialId === credentialId,
		);
		if (!selection) return undefined;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	async listResetCredits(options?: {
		provider?: string;
		sessionId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditAccountStatus[]> {
		const provider = options?.provider ?? "openai-codex";
		const accesses = await this.getOAuthAccesses(provider);
		if (accesses.length === 0) return [];
		const baseUrl = options?.baseUrlResolver?.(provider);
		const activeId = this.getOAuthAccountIdentity(provider, options?.sessionId);
		return Promise.all(
			accesses.map(async (access): Promise<ResetCreditAccountStatus> => {
				const active =
					!!activeId &&
					((!!activeId.accountId && activeId.accountId === access.accountId) ||
						(!!activeId.email && activeId.email === access.email));
				const base = {
					credentialId: access.credentialId,
					accountId: access.accountId,
					email: access.email,
					active,
				};
				if (!access.ok) return { ...base, availableCount: 0, credits: [], error: access.error };
				const list = await listCodexResetCredits({
					accessToken: access.accessToken,
					accountId: access.accountId,
					baseUrl,
					fetch: this.#usageFetch,
					signal: options?.signal,
				});
				if (!list) return { ...base, availableCount: 0, credits: [], error: "Failed to load saved resets" };
				return { ...base, availableCount: list.availableCount, credits: list.credits };
			}),
		);
	}

	async redeemResetCredit(options: {
		target: ResetCreditTarget;
		provider?: string;
		creditId?: string;
		baseUrlResolver?: (provider: string) => string | undefined;
		signal?: AbortSignal;
	}): Promise<ResetCreditRedeemOutcome> {
		const provider = options.provider ?? "openai-codex";
		const baseUrl = options.baseUrlResolver?.(provider);
		const { target } = options;
		const accesses = await this.getOAuthAccesses(provider);
		const match = accesses.find(
			access =>
				(target.credentialId !== undefined && access.credentialId === target.credentialId) ||
				(!!target.accountId && access.accountId === target.accountId) ||
				(!!target.email && access.email === target.email),
		);
		if (!match) return { ok: false, code: "no_account", accountId: target.accountId, email: target.email };
		if (!match.ok) {
			return { ok: false, code: "account_unavailable", accountId: match.accountId, email: match.email };
		}

		let creditId = options.creditId;
		if (!creditId) {
			const list = await listCodexResetCredits({
				accessToken: match.accessToken,
				accountId: match.accountId,
				baseUrl,
				fetch: this.#usageFetch,
				signal: options.signal,
			});

			if (!list) {
				return { ok: false, code: "credit_list_failed", accountId: match.accountId, email: match.email };
			}
			const credit = pickSoonestExpiringCredit(list.credits);
			if (!credit) return { ok: false, code: "no_credit", accountId: match.accountId, email: match.email };
			creditId = credit.id;
		}

		const result = await consumeCodexResetCredit({
			creditId,
			accessToken: match.accessToken,
			accountId: match.accountId,
			baseUrl,
			fetch: this.#usageFetch,
			signal: options.signal,
		});
		if (result.ok) {
			this.#invalidateUsageReportCache(provider, baseUrl);
			if (this.#store.invalidateUsageCache) {
				await this.#store.invalidateUsageCache(options.signal).catch(err => {
					logger.debug("Failed to notify store of stale usage", { err });
				});
			}

			if (match.credentialId !== undefined) this.#clearCredentialBlocks(provider, match.credentialId);
		}
		return { ok: result.ok, code: result.code, accountId: match.accountId, email: match.email, creditId };
	}

	#invalidateUsageReportCache(provider: string, baseUrl?: string): void {
		this.#usageCacheEpoch += 1;
		const expired = Date.now() - 1;
		for (const entry of this.#getStoredCredentials(provider)) {
			if (entry.credential.type !== "oauth") continue;
			const cacheKey = this.#buildUsageReportCacheKey(
				this.#buildUsageRequestForOauth(provider, entry.credential, baseUrl),
			);
			const existing = this.#usageCache.getStale<UsageReport | null>(cacheKey);
			this.#usageCache.set(cacheKey, { value: existing?.value ?? null, expiresAt: expired });
		}
	}

	#invalidateUsageReportCacheForProvider(provider: Provider): void {
		this.#usageCacheEpoch += 1;
		const expired = Date.now() - 1;
		const prefix = `report:${this.#usageCacheProviderKey(provider)}:`;
		if (this.#usageCache.deletePrefix(prefix)) return;
		const cacheKeys = new Set(this.#usageReportCacheKeysByProvider.get(provider));
		for (const entry of this.#getStoredCredentials(provider)) {
			cacheKeys.add(
				this.#buildUsageReportCacheKey({
					provider,
					credential: this.#buildUsageCredential(entry.credential),
				}),
			);
		}
		for (const cacheKey of cacheKeys) {
			this.#usageCache.set(cacheKey, { value: null, expiresAt: expired });
		}
	}

	async #clearUsageReportCache(provider?: string): Promise<void> {
		this.#usageCacheEpoch += 1;
		const prefix = provider ? `report:${this.#usageCacheProviderKey(provider)}:` : "report:";
		if (!this.#usageCache.deletePrefix(prefix)) {
			const requests = await this.#collectUsageRequests();
			for (const request of requests) {
				if (provider && request.provider !== provider) continue;
				this.#usageCache.set(this.#buildUsageReportCacheKey(request), { value: null, expiresAt: 0 });
			}
		}
		if (!this.#fetchUsageReportsOverride && !this.#store.fetchUsageReports) this.#markUsageForceRefresh(provider);
	}

	async invalidateUsageCache(provider?: string, signal?: AbortSignal): Promise<void> {
		await this.#clearUsageReportCache(provider);

		if (this.#store.invalidateUsageCache) {
			await this.#store.invalidateUsageCache(signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}

	#invalidateUsageReportCacheForProviderKey(providerKey: string): void {
		const oauthSuffix = ":oauth";
		if (!providerKey.endsWith(oauthSuffix)) return;
		this.#invalidateUsageReportCache(providerKey.slice(0, -oauthSuffix.length));
	}

	#clearCredentialBlocks(provider: string, credentialId: number): void {
		try {
			this.deleteCredentialBlocks(credentialId);
		} catch (err) {
			logger.debug("Failed to clear persisted credential blocks", { err, provider, credentialId });
		}

		const index = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (index < 0) return;
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const scopedPrefix = `${providerKey}\0`;
		for (const [key, backoffMap] of this.#credentialBackoff) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			backoffMap.delete(index);
			if (backoffMap.size === 0) this.#credentialBackoff.delete(key);
		}
		for (const [key, probeAfterMap] of this.#credentialBackoffProbeAfter) {
			if (key !== providerKey && !key.startsWith(scopedPrefix)) continue;
			probeAfterMap.delete(index);
			if (probeAfterMap.size === 0) this.#credentialBackoffProbeAfter.delete(key);
		}
	}

	#scopeUsageReportToBlockScope(
		report: UsageReport,
		blockScope: string | undefined,
		strategy: CredentialRankingStrategy | undefined,
	): UsageReport {
		if (!blockScope || !strategy?.scopeLimits || !strategy.blockScopes) return report;

		const modelId = blockScope === "spark" ? "gpt-5.3-codex-spark" : "gpt-5.3-codex";
		if (strategy.blockScopes({ modelId })[0] !== blockScope) return report;
		const scopedLimits = strategy.scopeLimits(report, { modelId });
		const meterStates = report.metadata?.meterStates;
		const meterState =
			meterStates !== null && typeof meterStates === "object"
				? (meterStates as Record<string, { allowed?: boolean; limitReached?: boolean }>)[blockScope]
				: undefined;
		return {
			...report,
			limits: scopedLimits,
			metadata:
				meterState || blockScope === "spark"
					? {
							...report.metadata,
							allowed: meterState?.allowed,
							limitReached: meterState?.limitReached,
						}
					: report.metadata,
		};
	}

	#clearCredentialBlockScope(
		provider: string,
		credentialId: number,
		credentialIndex: number,
		providerKey: string,
		blockScope: string | undefined,
	): void {
		const key = this.#toScopedBackoffKey(providerKey, blockScope);
		const backoffMap = this.#credentialBackoff.get(key);
		backoffMap?.delete(credentialIndex);
		if (backoffMap?.size === 0) this.#credentialBackoff.delete(key);
		const probeAfterMap = this.#credentialBackoffProbeAfter.get(key);
		probeAfterMap?.delete(credentialIndex);
		if (probeAfterMap?.size === 0) this.#credentialBackoffProbeAfter.delete(key);
		try {
			this.deleteCredentialBlock(credentialId, providerKey, blockScope ?? "");
		} catch (err) {
			logger.debug("Failed to clear persisted credential block", { err, provider, credentialId, blockScope });
		}
	}

	#isHealthyCodexUsageReport(report: UsageReport): boolean {
		if (report.provider !== "openai-codex") return false;
		const metadata = report.metadata;
		if (metadata?.allowed !== true || metadata.limitReached !== false) return false;
		return !this.#isUsageLimitReached(report.limits);
	}

	#reconcileCodexUsageBlockForCredential(provider: Provider, credentialId: number, report: UsageReport): void {
		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const credentialIndex = this.#getStoredCredentials(provider).findIndex(entry => entry.id === credentialId);
		if (credentialIndex < 0) return;

		const strategy = this.#rankingStrategyResolver?.(provider);
		const blockScopes =
			strategy?.blockScopes?.() ?? [strategy?.blockScope?.({})].filter(scope => scope !== undefined);
		const scopesToHeal = blockScopes.length > 0 ? blockScopes : [undefined];
		for (const blockScope of scopesToHeal) {
			this.#healCodexUsageBlockScope(
				provider,
				providerKey,
				credentialId,
				credentialIndex,
				blockScope,
				report,
				strategy,
			);
		}
	}

	#healCodexUsageBlockScope(
		provider: Provider,
		providerKey: string,
		credentialId: number,
		credentialIndex: number,
		blockScope: string | undefined,
		report: UsageReport,
		strategy: CredentialRankingStrategy | undefined,
	): void {
		const scopedReport = this.#scopeUsageReportToBlockScope(report, blockScope, strategy);
		if (!this.#isHealthyCodexUsageReport(scopedReport)) return;
		const blockedUntilMs = this.#getCredentialBlockedUntil(provider, providerKey, credentialIndex, blockScope);
		if (blockedUntilMs === undefined) return;

		const nowMs = Date.now();
		const scopedBackoffKey = this.#toScopedBackoffKey(providerKey, blockScope);
		const globalProbeAfterMs = this.#credentialBackoffProbeAfter.get(providerKey)?.get(credentialIndex) ?? 0;
		const scopedProbeAfterMs = this.#credentialBackoffProbeAfter.get(scopedBackoffKey)?.get(credentialIndex) ?? 0;
		const storeGlobalProbeAfterMs = this.#readPersistedCredentialBlockReconcileAfter(credentialId, providerKey, "");
		const storeScopedProbeAfterMs = this.#readPersistedCredentialBlockReconcileAfter(
			credentialId,
			providerKey,
			blockScope ?? "",
		);
		if (Math.max(globalProbeAfterMs, scopedProbeAfterMs, storeGlobalProbeAfterMs, storeScopedProbeAfterMs) > nowMs) {
			return;
		}
		this.#clearCredentialBlockScope(provider, credentialId, credentialIndex, providerKey, blockScope);
		logger.info("Cleared stale Codex usage-limit block after healthy live usage report", {
			credentialId,
			provider,
			blockScope,
			clearedBlockedUntilMs: blockedUntilMs,
		});
	}

	#reconcileCodexUsageBlock(request: UsageRequestDescriptor, report: UsageReport): void {
		if (request.provider !== "openai-codex") return;
		const credentialId = this.#findStoredCredentialIdForUsageCredential(request.provider, request.credential);
		if (credentialId === undefined) return;
		this.#reconcileCodexUsageBlockForCredential(request.provider, credentialId, report);
	}

	#findStoredCredentialIdsForUsageReport(report: UsageReport): number[] {
		if (report.provider !== "openai-codex") return [];
		const email = this.#getUsageReportMetadataValue(report, "email")?.toLowerCase();
		const accountId = (
			this.#getUsageReportMetadataValue(report, "accountId") ?? this.#getUsageReportScopeAccountId(report)
		)?.toLowerCase();
		if (!email && !accountId) return [];
		const matches: number[] = [];
		for (const entry of this.#getStoredCredentials(report.provider)) {
			const credential = entry.credential;
			if (credential.type !== "oauth") continue;
			const credentialEmail = credential.email?.trim().toLowerCase();
			const credentialAccountId = credential.accountId?.trim().toLowerCase();

			const emailComparable = Boolean(email && credentialEmail);
			const accountComparable = Boolean(accountId && credentialAccountId);
			if (!emailComparable && !accountComparable) continue;
			if (emailComparable && credentialEmail !== email) continue;
			if (accountComparable && credentialAccountId !== accountId) continue;
			matches.push(entry.id);
		}
		return matches;
	}

	#reconcileCodexUsageBlocksFromReports(reports: UsageReport[]): void {
		const reconciled = new Set<number>();
		for (const report of reports) {
			for (const credentialId of this.#findStoredCredentialIdsForUsageReport(report)) {
				if (reconciled.has(credentialId)) continue;
				reconciled.add(credentialId);
				this.#reconcileCodexUsageBlockForCredential(report.provider, credentialId, report);
			}
		}
	}

	#extractStructuredApiKeyToken(apiKey: string): string | undefined {
		if (!apiKey.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(apiKey) as { token?: unknown };
			return typeof parsed.token === "string" ? parsed.token : undefined;
		} catch {
			return undefined;
		}
	}

	async #credentialMatchesApiKey(credential: AuthCredential, apiKey: string): Promise<boolean> {
		if (credential.type === "api_key") {
			return (await this.#configValueResolver(credential.key)) === apiKey;
		}
		if (credential.access === apiKey) return true;
		return this.#extractStructuredApiKeyToken(apiKey) === credential.access;
	}

	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean>;
	async invalidateCredentialMatching(provider: string, apiKey: string, signal?: AbortSignal): Promise<boolean>;
	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		optionsOrSignal?: InvalidateCredentialMatchingOptions | AbortSignal,
	): Promise<boolean> {
		const signal = isAbortSignalOption(optionsOrSignal) ? optionsOrSignal : optionsOrSignal?.signal;
		const sessionId = isAbortSignalOption(optionsOrSignal) ? undefined : optionsOrSignal?.sessionId;
		const stored = this.#getStoredCredentials(provider);
		let matched: { id: number; type: AuthCredential["type"]; index: number } | undefined;
		for (let index = 0; index < stored.length; index++) {
			const entry = stored[index];
			if (entry && (await this.#credentialMatchesApiKey(entry.credential, apiKey))) {
				matched = { id: entry.id, type: entry.credential.type, index };
				break;
			}
		}

		if (!matched) {
			await this.reload();
			return false;
		}

		this.#clearSessionCredential(provider, sessionId);
		this.#markCredentialBlocked(
			provider,
			this.#getProviderTypeKey(provider, matched.type),
			matched.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
		if (markSuspect) {
			await markSuspect(matched.id, { signal });
		} else {
			await this.reload();
		}

		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return true;
	}

	async rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; modelId?: string; apiKey?: string; credentialId?: number; signal?: AbortSignal },
	): Promise<boolean> {
		const error = options?.error;
		const status = AIError.status(error);
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
			const retryAfterMs = extractRetryHint(undefined, message);
			return (
				await this.markUsageLimitReached(provider, sessionId, {
					retryAfterMs,
					modelId: options?.modelId,
					apiKey: options?.apiKey,
					credentialId: options?.credentialId,
					signal: options?.signal,
				})
			).switched;
		}

		const sessionCredential = await this.#resolveCredentialTarget(provider, sessionId, {
			credentialId: options?.credentialId,
			apiKey: options?.apiKey,
		});
		if (!sessionCredential) return false;

		const deniedModel = AIError.codexChatGPTAccountPolicyModel(error);
		const exactCodexModelPolicy =
			deniedModel !== undefined && AIError.isCodexChatGPTAccountPolicyError(error, provider, options?.modelId);

		if (deniedModel !== undefined && !exactCodexModelPolicy) return false;
		if (exactCodexModelPolicy || AIError.isAccountPolicyError(error)) {
			const modelPolicyScope = exactCodexModelPolicy
				? modelAccountPolicyBlockScope(provider, options?.modelId)
				: undefined;
			if (exactCodexModelPolicy && modelPolicyScope === undefined) return false;
			const routing = this.#credentialBlockRouting(
				provider,
				sessionCredential.type,
				options?.modelId,
				modelPolicyScope,
			);
			return this.#blockCredentialForRotation(
				provider,
				sessionCredential.type,
				sessionCredential.index,
				Date.now() + AuthStorage.#defaultBackoffMs,
				routing,
			).switched;
		}

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);

		const hasSibling = this.#getCredentialsForProvider(provider).some(
			(credential, index) =>
				credential.type === sessionCredential.type &&
				index !== sessionCredential.index &&
				!this.#isCredentialBlocked(provider, providerKey, index),
		);
		const target = this.#getStoredCredentials(provider)[sessionCredential.index];
		const sticky = this.#getSessionCredential(provider, sessionId);
		if (
			!sessionCredential.explicit ||
			(sticky?.type === sessionCredential.type && sticky.index === sessionCredential.index)
		) {
			this.#clearSessionCredential(provider, sessionId);
		}
		this.#markCredentialBlocked(
			provider,
			providerKey,
			sessionCredential.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		if (target && AIError.isInvalidatedOAuthTokenError(error)) {
			const disabledCause = message ?? "upstream reported invalidated OAuth token";
			const deleted = this.#store.deleteAuthCredentialRemote
				? await this.#store.deleteAuthCredentialRemote(target.id, disabledCause)
				: this.disableCredentialById(target.id, disabledCause);
			if (deleted) {
				const latestRows = this.#store.listAuthCredentials(provider);
				this.#setStoredCredentials(
					provider,
					latestRows.map(row => ({ id: row.id, credential: row.credential })),
				);
			}
			return deleted && hasSibling;
		}

		if (target) {
			const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
			if (markSuspect) {
				await markSuspect(target.id, { signal: options?.signal });
			} else {
				await this.reload();
			}
			const latestRows = this.#store.listAuthCredentials(provider);
			this.#setStoredCredentials(
				provider,
				latestRows.map(row => ({ id: row.id, credential: row.credential })),
			);
		}

		return hasSibling;
	}

	resolver(provider: string, options?: { sessionId?: string; baseUrl?: string; modelId?: string }): ApiKeyResolver {
		const { sessionId, baseUrl, modelId } = options ?? {};
		return async ({ lastChance, error, signal, previousKey }) => {
			if (error === undefined) {
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			if (lastChance) {
				const switched = await this.rotateSessionCredential(provider, sessionId, {
					error,
					modelId,
					signal,
					apiKey: previousKey,
				});
				if (!switched) {
					const status = AIError.status(error);
					const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

					if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) return undefined;
				}
				return this.getApiKey(provider, sessionId, { baseUrl, modelId, signal });
			}
			return this.getApiKey(provider, sessionId, { baseUrl, modelId, forceRefresh: true, signal });
		};
	}

	exportSnapshot(): AuthCredentialSnapshot {
		const entries: AuthCredentialSnapshotEntry[] = [];
		for (const [provider, stored] of this.#data) {
			for (const entry of stored) {
				const credential = entry.credential;
				const redacted: SnapshotCredential =
					credential.type === "api_key" ? credential : { ...credential, refresh: REMOTE_REFRESH_SENTINEL };
				entries.push({
					id: entry.id,
					provider,
					credential: redacted,
					identityKey: resolveCredentialIdentityKey(provider, credential),
				});
			}
		}
		return { generation: this.#generation, generatedAt: Date.now(), credentials: entries };
	}

	async listDisabledCredentials(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]> {
		if (!this.#store.listDisabledCredentials) return [];
		return this.#store.listDisabledCredentials(provider, signal);
	}

	async revalidateCredentials(): Promise<void> {
		if (this.#store.refreshSnapshot) await this.#store.refreshSnapshot();
		await this.reload();
	}

	async refreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) return raceCredentialRefreshWithSignal(existing, signal);

		const promise = (async () => {
			this.#bumpGeneration("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal);
			} catch (error) {
				this.#bumpGeneration("credential-refresh-failure");
				throw error;
			} finally {
				this.#oauthRefreshInFlight.delete(id);
			}
		})();
		this.#oauthRefreshInFlight.set(id, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	async forceRefreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.refreshCredentialById(id, signal);
	}

	async #forceRefreshCredentialByIdUnshared(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			const target = entries[index];
			if (target.credential.type !== "oauth") {
				throw new AIError.ValidationError(
					`Credential ${id} is not OAuth (provider=${provider}, type=${target.credential.type})`,
				);
			}

			const attempted = target.credential;

			const stale: OAuthCredential = { ...attempted, expires: 0 };
			let refreshed: OAuthCredentials;
			try {
				refreshed = await this.#refreshOAuthCredential(provider as Provider, stale, id, signal);
			} catch (error) {
				if (AIError.isDefinitiveOAuthFailure(String(error))) {
					if (
						!this.#disableCredentialByIdIfMatches(
							provider,
							id,
							attempted,
							`oauth refresh failed: ${String(error)}`,
						)
					) {
						await this.reload();
					}
				}
				throw error;
			}
			const updated: OAuthCredential = {
				type: "oauth",
				access: refreshed.access,
				refresh: refreshed.refresh,
				expires: refreshed.expires,
				accountId: refreshed.accountId ?? attempted.accountId,
				email: refreshed.email ?? attempted.email,
				projectId: refreshed.projectId ?? attempted.projectId,
				enterpriseUrl: refreshed.enterpriseUrl ?? attempted.enterpriseUrl,
				apiEndpoint: refreshed.apiEndpoint ?? attempted.apiEndpoint,
				orgId: refreshed.orgId ?? attempted.orgId,
				orgName: refreshed.orgName ?? attempted.orgName,
				authorizedAt: refreshed.authorizedAt ?? attempted.authorizedAt,
			};

			if (this.#replaceCredentialById(provider, id, updated) === -1) {
				throw new AIError.ValidationError(`No credential with id=${id}`);
			}
			return {
				id,
				provider,
				credential: { ...updated, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: resolveCredentialIdentityKey(provider, updated),
			};
		}
		throw new AIError.ValidationError(`No credential with id=${id}`);
	}

	disableCredentialById(id: number, disabledCause: string): boolean {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			this.#store.deleteAuthCredential(id, disabledCause);
			const next = entries.filter((_value, idx) => idx !== index);
			this.#setStoredCredentials(provider, next);
			this.#resetProviderAssignments(provider);
			this.#emitCredentialDisabled({ provider, disabledCause });
			return true;
		}
		return false;
	}

	upsertCredential(provider: string, credential: AuthCredential): AuthCredentialSnapshotEntry[] {
		const stored = this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential })),
		);
		this.#resetProviderAssignments(provider);
		return stored.map(entry => {
			const persisted = entry.credential;
			const redacted: SnapshotCredential =
				persisted.type === "api_key" ? persisted : { ...persisted, refresh: REMOTE_REFRESH_SENTINEL };
			return {
				id: entry.id,
				provider: entry.provider,
				credential: redacted,
				identityKey: resolveCredentialIdentityKey(provider, persisted),
			};
		});
	}

	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
		if (this.#persistedBlockStoreDamaged) return [];
		const listCredentialBlocks = this.#store.listCredentialBlocks?.bind(this.#store);
		if (!listCredentialBlocks) return [];
		try {
			return listCredentialBlocks(credentialIds);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) return [];
			throw err;
		}
	}

	upsertCredentialBlock(block: StoredCredentialBlock): void {
		this.#assertPersistedBlockStoreWritable();
		const upsertCredentialBlock = this.#store.upsertCredentialBlock?.bind(this.#store);
		if (!upsertCredentialBlock) return;
		try {
			upsertCredentialBlock(block);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) this.#assertPersistedBlockStoreWritable();
			throw err;
		}
		this.#invalidateUsageReportCacheForProviderKey(block.providerKey);
		this.#bumpGeneration("credential-block");
	}

	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
		this.#assertPersistedBlockStoreWritable();
		const deleteCredentialBlock = this.#store.deleteCredentialBlock?.bind(this.#store);
		if (!deleteCredentialBlock) return;
		try {
			deleteCredentialBlock(credentialId, providerKey, blockScope);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) this.#assertPersistedBlockStoreWritable();
			throw err;
		}
		this.#invalidateUsageReportCacheForProviderKey(providerKey);
		this.#bumpGeneration("credential-block");
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.#assertPersistedBlockStoreWritable();
		const deleteCredentialBlocks = this.#store.deleteCredentialBlocks?.bind(this.#store);
		if (!deleteCredentialBlocks) return;
		try {
			deleteCredentialBlocks(credentialId);
		} catch (err) {
			if (this.#handlePersistedBlockStoreError(err)) this.#assertPersistedBlockStoreWritable();
			throw err;
		}
		this.#bumpGeneration("credential-block");
	}

	describeCredentialSource(provider: string, sessionId?: string): string | undefined {
		if (this.#runtimeOverrides.has(provider)) {
			return "runtime override (--api-key)";
		}
		if (this.#configOverrides.has(provider)) {
			return "config override (models.yml)";
		}

		const baseLabel = this.#sourceLabel ?? "local store";
		const stored = this.#getStoredCredentials(provider);
		const session = sessionId ? this.#sessionLastCredential.get(provider)?.get(sessionId) : undefined;
		const describeStored = (
			type: AuthCredential["type"],
			filter?: (credential: AuthCredential) => boolean,
		): string | undefined => {
			const typed = stored
				.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.credential.type === type && (filter?.(entry.credential) ?? true));
			if (typed.length === 0) return undefined;
			const sticky = session?.type === type ? typed.find(entry => entry.index === session.index) : undefined;
			const chosen = sticky?.entry ?? typed[0].entry;
			const credential = chosen.credential;
			const identity =
				credential.type === "oauth"
					? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
					: `cred ${chosen.id}`;
			return `${baseLabel} · ${type} #${chosen.id} (${identity})`;
		};

		const oauthSource = describeStored("oauth");
		if (oauthSource) return oauthSource;
		const loginApiKeySource = describeStored(
			"api_key",
			credential => credential.type === "api_key" && credential.source === "login",
		);
		if (loginApiKeySource) return loginApiKeySource;
		if (getEnvApiKey(provider)) return `env (over ${baseLabel})`;
		const apiKeySource = describeStored(
			"api_key",
			credential => credential.type !== "api_key" || credential.source !== "login",
		);
		if (apiKeySource) return apiKeySource;
		if (this.#fallbackResolver?.(provider) !== undefined) return "fallback resolver";
		return undefined;
	}
}
