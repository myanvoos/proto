export const SINGULARITYAPI_DEV_API_BASE_URL = "https://api.singularityapi.dev/v1";
export const SINGULARITYAPI_TECH_API_BASE_URL = "https://api.singularityapi.tech/v1";

/**
 * Resolve a configured SingularityAPI base URL onto its gateway's `/v1` surface.
 *
 * Discovery and the model-cache namespace both key off the result, and the registry passes the raw configured
 * value while discovery passes a `/v1`-suffixed one, so both must normalize here. A blank value means "not
 * configured" and resolves to `canonical` — the product's own host, never the other gateway's.
 */
export function normalizeSingularityApiBaseUrl(baseUrl: string | undefined, canonical: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) return canonical;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
