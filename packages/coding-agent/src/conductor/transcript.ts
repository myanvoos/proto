/**
 * The conductor's transcript stem. Deliberately distinct from the advisor's so that
 * `isAdvisorTranscriptName` / `loadAdvisorTranscriptCosts` never sweep conductor turns into advisor totals,
 * while the reserved stem still keeps a worker id from colliding with it.
 */
export const CONDUCTOR_TRANSCRIPT_STEM = "__conductor";

export const CONDUCTOR_TRANSCRIPT_FILENAME = `${CONDUCTOR_TRANSCRIPT_STEM}.jsonl`;

export function isConductorTranscriptName(name: string): boolean {
	return name === CONDUCTOR_TRANSCRIPT_FILENAME;
}
