import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	COPILOT_CHAT_INTEGRATION_ID,
	getGitHubCopilotBaseUrl,
	normalizeCopilotIntegrationId,
	parseGitHubCopilotApiKey,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { FetchImpl, Message } from "../types";

export type CopilotInitiator = "user" | "agent";
export type CopilotPremiumRequests = number;
export type CopilotDynamicHeaders = {
	headers: Record<string, string>;
	initiator: CopilotInitiator;
	premiumRequests: CopilotPremiumRequests;
};
export function resolveGitHubCopilotBaseUrl(
	baseUrl: string | undefined,
	apiKey: string | undefined,
): string | undefined {
	if (!apiKey) return baseUrl;
	const { enterpriseUrl, apiEndpoint } = parseGitHubCopilotApiKey(apiKey);
	if (apiEndpoint && (!baseUrl || baseUrl.includes("githubcopilot.com"))) return apiEndpoint;
	if (!enterpriseUrl) return baseUrl;
	if (baseUrl && !baseUrl.includes("githubcopilot.com")) return baseUrl;
	return getGitHubCopilotBaseUrl(enterpriseUrl);
}

/** `COPILOT_INTEGRATION_ID` pin for chat and model-policy requests; discovery always keeps the CLI identity. */
export function resolveCopilotIntegrationIdOverride(
	env: Record<string, string | undefined> = $env,
): string | undefined {
	return normalizeCopilotIntegrationId(env.COPILOT_INTEGRATION_ID);
}

// Caller layers only (`extraHeaders` / `options.headers`), never catalog model headers,
// so a catalog default can never masquerade as an explicit choice.
function explicitCopilotIntegrationId(headers: Record<string, string> | undefined): unknown {
	if (!headers) return undefined;
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === "copilot-integration-id") return headers[name];
	}
	return undefined;
}

/** Explicit identity before the defaults: explicit value, then caller headers, then `COPILOT_INTEGRATION_ID`. */
export function resolveCopilotRequestIdentity(
	headers?: Record<string, string>,
	explicit?: unknown,
	env: Record<string, string | undefined> = $env,
): string | undefined {
	return (
		normalizeCopilotIntegrationId(explicit) ??
		normalizeCopilotIntegrationId(explicitCopilotIntegrationId(headers)) ??
		resolveCopilotIntegrationIdOverride(env)
	);
}

// Working `Copilot-Integration-Id` learned per credential+host, so orgs that deny
// the default identity pay the fallback round-trip once instead of every stream.
// Process-local: a stale entry costs at most one reverse retry, which relearns.
const COPILOT_WORKING_INTEGRATION_CACHE_LIMIT = 50;
const copilotWorkingIntegrationCache = new LRUCache<string, string>({ max: COPILOT_WORKING_INTEGRATION_CACHE_LIMIT });

// Custom `model.baseUrl` values survive `resolveGitHubCopilotBaseUrl`; two proxies
// fronting different org policies must not share a learned identity.
function normalizeCopilotCacheBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "") ?? "";
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
	} catch {
		return trimmed.toLowerCase();
	}
}

/** Cache key for a raw Copilot API key envelope on one effective host; the bearer is hashed, never stored. */
export function getCopilotIntegrationCacheKey(apiKeyRaw: string | undefined, baseUrl?: string): string | undefined {
	if (!apiKeyRaw) return undefined;
	const trimmed = apiKeyRaw.trim();
	if (!trimmed) return undefined;
	const parsed = parseGitHubCopilotApiKey(trimmed);
	if (!parsed.accessToken) return undefined;
	const fingerprint = Bun.hash(parsed.accessToken).toString(36);
	return `${parsed.enterpriseUrl ?? ""}\0${parsed.apiEndpoint ?? ""}\0${normalizeCopilotCacheBaseUrl(baseUrl)}\0${fingerprint}`;
}

export function getCachedCopilotIntegrationId(cacheKey: string | undefined): string | undefined {
	if (!cacheKey) return undefined;
	return normalizeCopilotIntegrationId(copilotWorkingIntegrationCache.get(cacheKey));
}

export function rememberCopilotWorkingIntegrationId(cacheKey: string | undefined, integrationId: unknown): void {
	const normalized = normalizeCopilotIntegrationId(integrationId);
	if (!cacheKey || !normalized) return;
	copilotWorkingIntegrationCache.set(cacheKey, normalized);
}

export function clearCopilotIntegrationCache(cacheKey?: string): void {
	if (cacheKey === undefined) copilotWorkingIntegrationCache.clear();
	else copilotWorkingIntegrationCache.delete(cacheKey);
}

// Client-identity denial: HTTP 403, or HTTP 400 `model_not_supported` (Business
// endpoints). Reads a clone so an unrelated 400 reaches the caller intact.
async function isCopilotIdentityDenied(response: Response): Promise<boolean> {
	if (response.status === 403) return true;
	if (response.status !== 400) return false;
	try {
		const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
		return body?.error?.code === "model_not_supported";
	} catch {
		return false;
	}
}

async function drainResponse(response: Response): Promise<void> {
	try {
		await response.arrayBuffer();
	} catch {}
}

/**
 * Reissue a Copilot client-identity denial once with the other surface.
 *
 * Chat (`copilot-chat`) is the default: Business orgs gating premium models per
 * client surface commonly allow chat while blocking the CLI. Other Business and
 * Enterprise orgs do the opposite (403, or 400 `model_not_supported`), so a
 * denied chat request retries once as the CLI. An explicit identity is never
 * second-guessed, and the retry carries the other identity: at most two requests.
 *
 * With `cacheKey`, only a 2xx retry records its identity as working; any other
 * retry outcome clears the entry (401 denies every identity, 408/429/5xx are
 * resent by the transport with the original headers). A cached CLI start that is
 * denied (stale after an org-policy flip) retries once as chat and relearns.
 * `cacheSnapshot` is the cached value the outgoing headers were built from
 * (`null` = empty at build), so a sibling stream learning mid-flight cannot change
 * this request's retry decision; `undefined` snapshots at dispatch.
 */
export function wrapFetchForCopilotFallback(
	base: FetchImpl | undefined,
	enabled: boolean,
	integrationId?: unknown,
	cacheKey?: string,
	cacheSnapshot?: string | null,
): FetchImpl {
	const inner = base ?? fetch;
	if (!enabled) return inner;
	const cliIntegrationId = COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"];
	return async (input, init) => {
		const cachedBeforeRequest =
			cacheSnapshot === undefined
				? getCachedCopilotIntegrationId(cacheKey)
				: normalizeCopilotIntegrationId(cacheSnapshot);
		const response = await inner(input, init);
		if (response.status !== 403 && response.status !== 400) return response;
		// Request inputs carry an already-consumed body; never rebuild them.
		if (input instanceof Request) return response;
		if (normalizeCopilotIntegrationId(integrationId) !== undefined) return response;
		const outgoing = new Headers(init?.headers);
		const outgoingId = outgoing.get("Copilot-Integration-Id");
		if (outgoingId === COPILOT_CHAT_INTEGRATION_ID) {
			if (!(await isCopilotIdentityDenied(response))) return response;
			await drainResponse(response);
			logger.warn(`GitHub Copilot chat identity denied (HTTP ${response.status}); retrying once as the Copilot CLI`);
			const retryHeaders = new Headers(outgoing);
			retryHeaders.set("Copilot-Integration-Id", cliIntegrationId);
			const retry = await inner(input, { ...init, headers: retryHeaders });
			if (cacheKey) {
				if (retry.ok) rememberCopilotWorkingIntegrationId(cacheKey, cliIntegrationId);
				else clearCopilotIntegrationCache(cacheKey);
			}
			return retry;
		}
		if (outgoingId === cliIntegrationId && cacheKey && cachedBeforeRequest === cliIntegrationId) {
			if (!(await isCopilotIdentityDenied(response))) return response;
			await drainResponse(response);
			logger.warn(
				`GitHub Copilot CLI identity denied (HTTP ${response.status}); retrying once as ${COPILOT_CHAT_INTEGRATION_ID}`,
			);
			const retryHeaders = new Headers(outgoing);
			retryHeaders.set("Copilot-Integration-Id", COPILOT_CHAT_INTEGRATION_ID);
			const retry = await inner(input, { ...init, headers: retryHeaders });
			if (retry.ok) rememberCopilotWorkingIntegrationId(cacheKey, COPILOT_CHAT_INTEGRATION_ID);
			else clearCopilotIntegrationCache(cacheKey);
			return retry;
		}
		return response;
	};
}
export function inferCopilotInitiator(messages: unknown[]): CopilotInitiator {
	if (messages.length === 0) return "user";

	const last = messages[messages.length - 1] as Record<string, unknown>;
	const attribution = last.attribution;
	if (typeof attribution === "string") {
		const normalizedAttribution = attribution.trim().toLowerCase();
		if (normalizedAttribution === "user" || normalizedAttribution === "agent") {
			return normalizedAttribution;
		}
	}

	const role = last.role as string | undefined;
	if (!role) return "user";

	if (role !== "user") return "agent";

	const content = last.content;
	if (Array.isArray(content) && content.length > 0) {
		const lastBlock = content[content.length - 1] as Record<string, unknown>;
		if (lastBlock.type === "tool_result") {
			return "agent";
		}
	}

	return "user";
}

export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some(msg => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some(c => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some(c => c.type === "image");
		}
		return false;
	});
}

export function getCopilotInitiatorOverride(headers: Record<string, string> | undefined): CopilotInitiator | undefined {
	if (!headers) return undefined;

	let override: CopilotInitiator | undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "x-initiator") continue;
		const normalized = value.trim().toLowerCase();
		if (normalized === "user" || normalized === "agent") {
			override = normalized;
		}
	}

	return override;
}

export type CopilotPlanTier = "free" | "paid";

function normalizeCopilotPlanTier(planTier: string | undefined): CopilotPlanTier {
	if (planTier === "paid") return "paid";
	return "free";
}
export function getCopilotPremiumMultiplier(premiumMultiplier: number | undefined, planTier?: string): number {
	const normalizedMultiplier = premiumMultiplier ?? 1;
	if (normalizeCopilotPlanTier(planTier) === "free" && normalizedMultiplier === 0) {
		return 1;
	}
	return normalizedMultiplier;
}

export function getCopilotPremiumRequests(params: {
	initiator: CopilotInitiator;
	premiumMultiplier?: number;
	planTier?: string;
}): CopilotPremiumRequests {
	if (params.initiator === "agent") return 0;
	return getCopilotPremiumMultiplier(params.premiumMultiplier, params.planTier);
}

export function buildCopilotDynamicHeaders(params: {
	messages: unknown[];
	hasImages: boolean;
	premiumMultiplier?: number;
	headers?: Record<string, string>;
	initiatorOverride?: CopilotInitiator;
	planTier?: string;
	/** Enterprise login domain; Enterprise keeps the CLI identity its private endpoint accepts. */
	enterpriseUrl?: string;
	/** Raw explicit identity; validated here. */
	integrationId?: unknown;
	/** Learned working identity for this credential; explicit wins, then this, then the defaults. */
	cachedIntegrationId?: unknown;
}): CopilotDynamicHeaders {
	const initiator =
		params.initiatorOverride ?? getCopilotInitiatorOverride(params.headers) ?? inferCopilotInitiator(params.messages);
	const headers: Record<string, string> = {
		...COPILOT_CAPI_IDENTITY_HEADERS,
		"X-Initiator": initiator,
		"X-Interaction-Type": `conversation-${initiator}`,
	};
	headers["Copilot-Integration-Id"] =
		normalizeCopilotIntegrationId(params.integrationId) ??
		normalizeCopilotIntegrationId(params.cachedIntegrationId) ??
		(params.enterpriseUrl ? COPILOT_CAPI_IDENTITY_HEADERS["Copilot-Integration-Id"] : COPILOT_CHAT_INTEGRATION_ID);

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return {
		headers,
		initiator,
		premiumRequests: getCopilotPremiumRequests({
			initiator,
			premiumMultiplier: params.premiumMultiplier,
			planTier: params.planTier,
		}),
	};
}
