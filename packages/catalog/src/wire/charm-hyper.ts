export const CHARM_HYPER_API_BASE_URL = "https://hyper.charm.land/v1";

/**
 * Resolve a configured Charm Hyper base URL onto the gateway's `/v1` surface.
 *
 * Inference, discovery, the `/credits` usage probe and the model-cache namespace
 * all key off this result, so they must agree: a blank value means "not
 * configured" and resolves to the canonical host; anything else keeps its host
 * and gains `/v1` if it omits one.
 */
export function normalizeCharmHyperBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return CHARM_HYPER_API_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
