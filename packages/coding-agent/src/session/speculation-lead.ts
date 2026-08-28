const SPECULATION_LEAD_FRACTION = 0.125;

export const SPECULATION_LEAD_MIN_TOKENS = 8_192;
const SPECULATION_LEAD_MAX_TOKENS = 32_000;

export function resolveSpeculationLeadTokens(thresholdTokens: number): number {
	return Math.min(
		SPECULATION_LEAD_MAX_TOKENS,
		Math.max(SPECULATION_LEAD_MIN_TOKENS, Math.floor(thresholdTokens * SPECULATION_LEAD_FRACTION)),
	);
}
