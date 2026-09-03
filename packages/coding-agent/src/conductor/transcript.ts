import * as path from "node:path";
import { loadReviewerTranscriptCost } from "../advisor/transcript-recorder";

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

/**
 * Absolute path of the conductor's transcript for a session file. `undefined` when the session is not persisted —
 * an unpersisted session has no transcript directory, so there is nothing to display or tail.
 */
export function conductorTranscriptPath(sessionFile: string | undefined): string | undefined {
	if (!sessionFile?.endsWith(JSONL_SUFFIX)) return undefined;
	return path.join(sessionFile.slice(0, -JSONL_SUFFIX.length), CONDUCTOR_TRANSCRIPT_FILENAME);
}

const JSONL_SUFFIX = ".jsonl";

/**
 * Restores the conductor's accumulated spend from the session's `__conductor.jsonl` transcript, mirroring
 * `loadAdvisorTranscriptCosts` for the single conductor transcript. No transcript → 0.
 */
export async function loadConductorTranscriptCost(sessionFile: string | undefined): Promise<number> {
	const transcriptFile = conductorTranscriptPath(sessionFile);
	if (!transcriptFile) return 0;
	return await loadReviewerTranscriptCost(transcriptFile);
}
