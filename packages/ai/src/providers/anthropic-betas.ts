/**
 * Normalizes an `anthropic-beta` value (header string or array) into trimmed,
 * non-empty entries. Shared by the Messages transport and its message-thread
 * fingerprinting so both read the beta set identically.
 */
export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}
