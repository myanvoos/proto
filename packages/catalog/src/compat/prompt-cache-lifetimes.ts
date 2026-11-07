import type { Model } from "../types";
import { isOfficialCodexApiUrl } from "../wire/codex";

/** Prompt-cache retention tiers a request can write. */
export type PromptCacheTier = "short" | "long";

/**
 * Lifetime of a prompt-cache entry the provider keeps, per retention tier, in
 * seconds.
 *
 * Derived from the provider contract rather than per-model catalog rules: the
 * Anthropic Messages protocol (first-party and gateways) keeps 5m entries and
 * 1h ones on its long tier, Bedrock Converse exposes the same two tiers where
 * the model declares long-retention support, and Antigravity's Cloud Code
 * Assist only declares a 5m entry. Providers that publish no lifetime are not
 * warmed and get no cache chip.
 */
export function promptCacheLifetimeSeconds(model: Model, tier: PromptCacheTier): number | undefined {
	if (model.api === "anthropic-messages") return tier === "long" ? 3600 : 300;
	if (model.provider === "google-antigravity") return tier === "long" ? undefined : 300;
	if (model.api === "bedrock-converse-stream") {
		const compat = model.compat;
		if (compat === undefined || !("promptCacheMode" in compat) || compat.promptCacheMode !== "explicit") {
			return undefined;
		}
		if (tier === "short") return 300;
		return "supportsLongPromptCacheRetention" in compat && compat.supportsLongPromptCacheRetention === true
			? 3600
			: undefined;
	}
	return undefined;
}

/**
 * Whether {@link model}'s prompt-cache entries never expire. Only the
 * provider's own endpoint qualifies: a gateway or proxy reusing the provider
 * id makes no such promise.
 */
export function isPromptCachePersistent(model: Model): boolean {
	return model.api === "openai-codex-responses" && isOfficialCodexApiUrl(model.baseUrl);
}
