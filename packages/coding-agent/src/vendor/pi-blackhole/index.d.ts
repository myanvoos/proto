import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionFactory } from "../../extensibility/extensions/types";

export const MEMORY_THINKING_LEVEL: "low";

export function resolveMemoryModelCandidates(context: {
	model?: Model;
	models: { resolve(spec: string): Model | undefined };
}): Model[];

/** One folded user message: `recallIndex` is the `#N` the recall tool resolves. */
export interface SummaryUserTurn {
	recallIndex: number;
	text: string;
	images?: string[];
}

/**
 * Deterministic structural compaction summary: header sections, every user turn in
 * `[User Messages]` (oversized pastes elided behind a `recall #N:full` pointer), then the brief
 * transcript and the recall note.
 */
export declare function compileSummary(input: {
	messages: Array<Record<string, unknown>>;
	previousSummary?: string;
	/** Session-global `#N` of each converted message; `undefined` entries render no ref. */
	sourceIndices?: Array<number | undefined>;
	userTurns?: SummaryUserTurn[];
}): string;

/** One entry as recall ranks it: `index` is the `#N` the tool resolves. */
export interface RecallRenderedEntry {
	index: number;
	id?: string;
	role: string;
	summary: string;
	files?: string[];
	snippet?: string;
	matchCount?: number;
}

/** BM25 search over rendered entries; every query is split into terms before matching. */
export declare function searchEntries(
	entries: RecallRenderedEntry[],
	messages: Array<Record<string, unknown>>,
	query?: string,
	page?: number,
	mode?: string,
): RecallRenderedEntry[];

/** Read a session JSONL file in chunks; a file that does not exist yet reads as empty history. */
export declare function loadAllMessages(
	sessionFile: string,
	full: boolean,
	allowedEntryIds?: ReadonlySet<string>,
): { rendered: RecallRenderedEntry[]; rawMessages: Array<Record<string, unknown>>; entryIds: string[] };

/** Resolve one `#N:path` / `#N:text` drill-down against a session file. */
export declare function expandEntryFile(
	sessionFile: string,
	entryIndex: number,
	pathPattern: string,
	full?: boolean,
	offset?: number,
	limit?: number,
): string;

/** Bound one recall response: entries drop before the header, and a footer names what was cut. */
export declare function capRecallBlocks(input: {
	header: string;
	entryBlocks: string[];
	tailBlocks?: string[];
	budget: number;
	continuation?: string;
}): { text: string; omittedEntries: number; totalEntries: number; capped: boolean };

declare const piBlackhole: ExtensionFactory;

export default piBlackhole;
