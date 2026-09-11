import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { loadReviewerTranscriptCost } from "../advisor/transcript-recorder";
import { visitEntriesFromFileStream } from "../session/session-loader";

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

export interface ConductorJournalEntry {
	/** 1-based epoch number, in transcript order. */
	epoch: number;
	/** Wall-clock time of the ruling; 0 when the transcript message carries no timestamp. */
	at: number;
	/** Wake reasons live rulings recorded; unrestored entries carry none (digests are not replayed). */
	wakeReasons: string[];
	action: "prompt" | "template" | "deduped";
	context: "continue" | "compact";
	promptHeadline?: string;
	note?: string;
}

/** Collapses a multi-line authored prompt into the journal's one-line headline. */
export function journalHeadline(text: string): string {
	const line = text.split("\n").find(candidate => candidate.trim()) ?? "";
	const collapsed = line.replace(/\s+/g, " ").trim();
	return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

/**
 * Rebuilds the decision journal from the session's `__conductor.jsonl` transcript: every `cue({op:"next"})`
 * ruling the conductor ever recorded, in order. Restored entries carry the ruling's delivery shape but not the
 * wake reasons (digests are not persisted to the primary transcript); live entries carry both. Missing,
 * malformed, or unreadable transcripts yield an empty journal — restore is best-effort by contract.
 */
export async function loadConductorJournal(sessionFile: string | undefined): Promise<ConductorJournalEntry[]> {
	const transcriptFile = conductorTranscriptPath(sessionFile);
	if (!transcriptFile) return [];
	const entries: ConductorJournalEntry[] = [];
	try {
		await visitEntriesFromFileStream(transcriptFile, entry => {
			if (typeof entry !== "object" || entry === null) return;
			const record = entry as {
				type?: unknown;
				message?: { role?: unknown; timestamp?: unknown; content?: unknown };
			};
			if (record.type !== "message") return;
			const message = record.message;
			if (message?.role !== "assistant") return;
			const content = message.content;
			if (!Array.isArray(content)) return;
			for (const block of content) {
				const toolCall = block as { type?: unknown; name?: unknown; arguments?: Record<string, unknown> };
				if (toolCall.type !== "toolCall" || toolCall.name !== "cue") continue;
				const args = toolCall.arguments;
				if (args?.op !== "next") continue;
				const promptText = typeof args.prompt === "string" ? args.prompt.trim() : "";
				entries.push({
					epoch: entries.length + 1,
					at: typeof message.timestamp === "number" ? message.timestamp : 0,
					wakeReasons: [],
					action: promptText ? "prompt" : "template",
					context: args.context === "compact" ? "compact" : "continue",
					promptHeadline: promptText ? journalHeadline(promptText) : undefined,
					note: typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined,
				});
			}
		});
	} catch (err) {
		logger.debug("conductor journal read failed", { file: transcriptFile, err: String(err) });
		return [];
	}
	return entries;
}
