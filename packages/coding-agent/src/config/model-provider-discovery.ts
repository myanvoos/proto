import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { ModelResolutionSource } from "@oh-my-pi/pi-catalog/model-manager";
import {
	MODELS_DEV_CATALOG_PROVIDER_IDS,
	type OpenAICodexAccount,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";

const SPECIAL_MODEL_MANAGER_PROVIDER_IDS: readonly string[] = [
	"google-antigravity",
	"google-gemini-cli",
	"openai-codex",
];

// Shared-catalog providers persist additive models.dev rows, so their caches load at startup too.
export const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = [
	...new Set([
		...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
		...SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
		...MODELS_DEV_CATALOG_PROVIDER_IDS,
	]),
];

const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(["llama-cpp-local", "lm-studio-local", "vllm-local"]);

export const RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 15_000;

export const BUILT_IN_DISCOVERY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;
export const kNoAuth = "N/A";

export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

export function isDiscoveryBearerApiKey(apiKey: string | undefined | null): apiKey is string {
	return isAuthenticated(apiKey) && !LOCAL_PROVIDER_PLACEHOLDERS.has(apiKey);
}

/** Bounds a model-discovery operation; the inner operation gets no signal because not every discovery contract accepts one. */
export async function withModelDiscoveryTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		timeoutReject(new Error(`model discovery timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	try {
		return await Promise.race([run(), timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

export interface BuiltInDiscoveryResult {
	models: Model<Api>[];
	authoritativeProviders: Set<string>;
	/** Providers whose successful endpoint refresh replaces their prior discovered slice. */
	replaceRuntimeProviders: Set<string>;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	source?: ModelResolutionSource;
	models: string[];
	error?: string;
}
export function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {}
	return value;
}

export function extractGoogleOAuthProjectId(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { projectId?: unknown; project_id?: unknown };
		const rawProjectId = typeof parsed.projectId === "string" ? parsed.projectId : parsed.project_id;
		if (typeof rawProjectId === "string") {
			const projectId = rawProjectId.trim();
			return projectId.length > 0 ? projectId : undefined;
		}
	} catch {}
	return undefined;
}

export function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

export async function resolveCodexDiscoveryAccounts(
	authStorage: AuthStorage,
	resolvedAccessToken: string,
): Promise<OpenAICodexAccount[] | null> {
	const accesses = await authStorage.getOAuthAccesses("openai-codex");
	const accounts: OpenAICodexAccount[] = [];
	for (const access of accesses) {
		if (!access.ok) return null;
		accounts.push({ accessToken: access.accessToken, accountId: access.accountId });
	}
	if (!accounts.some(account => account.accessToken === resolvedAccessToken)) {
		const matchingCredential = getOAuthCredentialsForProvider(authStorage, "openai-codex").find(
			credential => credential.access === resolvedAccessToken,
		);
		accounts.push({ accessToken: resolvedAccessToken, accountId: matchingCredential?.accountId });
	}
	return accounts;
}
