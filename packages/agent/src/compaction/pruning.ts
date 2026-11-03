import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Tokenizer } from "../tokenizer";
import type { AgentMessage, AgentToolCall } from "../types";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";
import { type ConvertToLlm, defaultConvertToLlm, getMessageFromEntry } from "./messages";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";
import { isAlternateFormReadSelector, splitReadSelector } from "./utils";

/** Bound warm-cache pruning by the provider's prompt-cache lookback window. */
export interface CacheLookbackConfig {
	/**
	 * Prompt-cache lookback of the model the next request goes to, in block
	 * positions (catalog `prompt-cache-lookback`; Anthropic: 20). When set,
	 * warm-cache pruning also leaves a result whose rewrite would put the next
	 * request's cache lookup out of reach, whatever its token suffix (see
	 * `cacheLookbackFloor`). Undefined = no lookback bound.
	 */
	cacheLookbackPositions?: number;
	/**
	 * Projects context messages to what the provider receives, so lookback
	 * positions count app roles (file mentions, command output, custom
	 * messages) as sent. Default {@link defaultConvertToLlm}.
	 */
	convertToLlm?: ConvertToLlm;
}

export interface PruneConfig extends CacheLookbackConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;

	minimumSavings: number;

	protectedTools: ProtectedToolMatcher[];

	supersedeKey?: SupersedeKeyFn;
	supersedeComplete?: SupersedeCompleteFn;

	pruneUseless?: boolean;

	keepBoundaryId?: string;

	cacheWarmSuffixTokens?: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadToolResult],
	pruneUseless: true,
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
	/**
	 * Restore every result this pass blanked. Pruning mutates entries in place,
	 * so a caller whose persistence of the pruned history fails calls this to keep
	 * memory matching what is durable.
	 */
	undo(): void;
}

const NOTHING_PRUNED: PruneResult = { prunedCount: 0, tokensSaved: 0, undo: () => {} };

/** Blank `message` to `notice`, returning the step that restores it. */
function blankToolResult(message: ToolResultMessage, notice: string, prunedAt: number): () => void {
	const { content, prunedAt: previousPrunedAt } = message;
	message.content = [{ type: "text", text: notice }];
	message.prunedAt = prunedAt;
	invalidateMessageCache(message as AgentMessage);
	return () => {
		message.content = content;
		message.prunedAt = previousPrunedAt;
		invalidateMessageCache(message as AgentMessage);
	};
}

/** Combine per-message restore steps into one {@link PruneResult.undo}. */
function undoAll(steps: Array<() => void>): () => void {
	return () => {
		for (const step of steps) step();
	};
}

export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

export const USELESS_NOTICE = "[Uneventful result elided]";

/**
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which a newer successful result supersedes every older one. A key `K` also
 * covers keys with prefix `K + "\u0000"`: they are superseded only when the
 * newest successful result for `K` is complete (see
 * {@link SupersedeCompleteFn}). Return `undefined` to exempt a call from
 * supersede grouping.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

/**
 * Whether a successful keyed result shows its whole target, so a result for a
 * parent key (e.g. a selector-free read) may supersede child-key results (e.g.
 * range reads). A summary, truncated page, or notice is not complete.
 */
export type SupersedeCompleteFn = (message: ToolResultMessage) => boolean;

export interface SupersedePruneConfig extends CacheLookbackConfig {
	/** Supersede key function; a newer successful result with the same key supersedes older ones (see {@link SupersedeKeyFn}). */
	supersedeKey?: SupersedeKeyFn;
	/**
	 * Whether a successful keyed result is complete. Absent, every successful
	 * result is complete. Child-key results are superseded only when the parent
	 * key's newest successful result is complete; same-key results follow
	 * newest-wins, since a same-key re-read that shows a different view means
	 * the target changed. A failed result supersedes only older failed results.
	 *
	 * Trade-off, by design: after `read foo.ts:50-200` → edit → a bare
	 * `read foo.ts` that returns a summary, the pre-edit range stays in context
	 * until a complete bare read or a same-range re-read. Keeping possibly stale
	 * detail is preferred over losing detail the summary does not show.
	 */
	supersedeComplete?: SupersedeCompleteFn;
	/** Also prune results flagged useless by their tool. Default false. */
	pruneUseless?: boolean;
	/**
	 * Prune a candidate now when all messages after it total at most this many
	 * estimated tokens and it sits within
	 * {@link CacheLookbackConfig.cacheLookbackPositions}. Default 8 000.
	 */
	suffixTokenLimit?: number;

	idleFlushMs?: number;

	now?: number;

	keepBoundaryId?: string;

	protectedTools: ProtectedToolMatcher[];
}

const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;
const DEFAULT_IDLE_FLUSH_MS = 30 * 60_000;

/**
 * Positions kept free for the next request's own input (prompt, date/cwd
 * reminder, attachments) and for request projections the count below does not
 * model (orphan-result notes, replayed compaction file metadata, tool-change
 * controls): with Anthropic's 20, stored history gets at most 13.
 */
const RESERVED_LOOKBACK_POSITIONS = 6;

type LookbackBlock = "tool_use" | "tool_result" | undefined;

/**
 * Index of the oldest tool result that can be rewritten while the next request
 * still reaches a cache entry, given the model's prompt-cache `lookback` in
 * block positions (a breakpoint counts itself; a run of consecutive `tool_use`
 * blocks, or of consecutive `tool_result` blocks, is one position). A
 * conservative estimate, not an exact count: a skipped prune costs its tokens,
 * a missed lookup the whole cache.
 *
 * Each request writes its tail cache entry at its last block, so rewriting a
 * result invalidates every entry from its issuing assistant turn on, and once a
 * request has 15 user turns its other breakpoint sits on an older decimation
 * checkpoint. The next request's tail breakpoint then reaches the newest
 * surviving entry, which ends the message before the issuing turn, only when
 * the issuing turn, its tool-result batch, everything after and the next input
 * fit in the lookback window; otherwise the lookup falls back to that
 * checkpoint and the whole conversation since is re-written, not the small
 * suffix the token limits budget for. Each entry is projected through
 * `convertToLlm` and counted the way the Anthropic request converter emits it.
 */
function cacheLookbackFloor(
	entries: readonly SessionEntry[],
	start: number,
	lookback: number | undefined,
	convertToLlm: ConvertToLlm,
): number {
	if (lookback === undefined) return start;
	let positions = RESERVED_LOOKBACK_POSITIONS;
	let later: LookbackBlock;
	let runHoistsImages = false;
	let newerIsAssistant = false;
	const add = (block: LookbackBlock): void => {
		if (block === undefined || block !== later) positions++;
		later = block;
	};
	let floor = entries.length;
	for (let i = entries.length - 1; i >= start; i--) {
		const message = getMessageFromEntry(entries[i]);
		const sent = message === undefined ? [] : convertToLlm([message]);
		for (let m = sent.length - 1; m >= 0; m--) {
			const llm = sent[m];
			if (llm.role === "toolResult") {
				if (later !== "tool_result") runHoistsImages = false;
				add("tool_result");
				// Anthropic rejects images in error results, so the converter moves
				// them after the result run behind one explanatory text block.
				let images = 0;
				if (llm.isError) {
					for (const block of llm.content) if (block.type === "image") images++;
				}
				if (images > 0) {
					positions += runHoistsImages ? images : images + 1;
					runHoistsImages = true;
				}
				newerIsAssistant = false;
			} else if (llm.role === "assistant") {
				// The converter pads consecutive assistant turns with a user turn and
				// drops assistant images, blank text, and turns left empty.
				let pad = newerIsAssistant;
				for (let b = llm.content.length - 1; b >= 0; b--) {
					const block = llm.content[b];
					if (block.type === "image" || (block.type === "text" && block.text.trim().length === 0)) continue;
					if (pad) {
						add(undefined);
						pad = false;
					}
					add(block.type === "toolCall" ? "tool_use" : undefined);
					newerIsAssistant = true;
				}
			} else {
				// The converter drops blank user/developer turns.
				const blocks =
					typeof llm.content === "string" ? (llm.content.trim().length > 0 ? 1 : 0) : llm.content.length;
				if (blocks === 0) continue;
				for (let b = blocks; b > 0; b--) add(undefined);
				newerIsAssistant = false;
			}
		}
		if (positions >= lookback) return floor;
		if (message?.role === "assistant") floor = i;
	}
	return start;
}

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

const MIN_PRUNE_TOKENS = 50;

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

/**
 * True when a read result only carried a structural outline rather than the file's real content.
 * Such a result cannot stand in for an explicit ranged read of the same file.
 */
function elidesContent(message: ToolResultMessage): boolean {
	const summary = (message.details as { summary?: { elidedLines?: number; elidedSpans?: number } } | undefined)
		?.summary;
	if (summary === undefined) return false;
	return (summary.elidedLines ?? 0) > 0 || (summary.elidedSpans ?? 0) > 0;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].id === keepBoundaryId) return i;
	}
	return 0;
}

class SentToolCalls {
	readonly #entries: readonly SessionEntry[];
	readonly #start: number;
	readonly #sent: Map<string, AgentToolCall>;
	#prefix: Map<string, AgentToolCall> | undefined;

	constructor(entries: readonly SessionEntry[], start: number) {
		this.#entries = entries;
		this.#start = start;
		this.#sent = collectToolCallsById(entries, start);
	}

	get(id: string): AgentToolCall | undefined {
		const call = this.#sent.get(id);
		if (call !== undefined || this.#start === 0) return call;
		this.#prefix ??= collectToolCallsById(this.#entries, 0, this.#start);
		return this.#prefix.get(id);
	}
}

interface SupersedeCandidate {
	entry: SessionMessageEntry;
	message: ToolResultMessage;

	index: number;
	tokens: number;

	notice: string;
}

function collectSupersededResults(
	entries: readonly SessionEntry[],
	start: number,
	tokenizer: Tokenizer,
	toolCalls: SentToolCalls,
	supersedeKey: SupersedeKeyFn,
	supersedeComplete: SupersedeCompleteFn | undefined,
	protectedTools: readonly ProtectedToolMatcher[],
): SupersedeCandidate[] {
	// Walk newest → oldest: supersession only depends on NEWER results, so
	// stopping at `start` yields exactly the full scan's candidates at/after it.
	const candidates: SupersedeCandidate[] = [];
	const newerByKey = new Map<string, { success: boolean; complete: boolean }>();
	for (let i = entries.length - 1; i >= start; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCalls.get(message.toolCallId);
		if (!toolCall) continue;
		if (isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const key = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
		if (key === undefined) continue;
		const separator = key.indexOf("\u0000");
		const sameKey = newerByKey.get(key);
		const parent = separator >= 0 ? newerByKey.get(key.slice(0, separator)) : undefined;
		const superseded = message.isError
			? sameKey !== undefined || parent?.success === true
			: sameKey?.success === true || parent?.complete === true;
		const newer = sameKey ?? { success: false, complete: false };
		if (!message.isError && !newer.success) {
			newer.success = true;
			newer.complete = supersedeComplete?.(message) ?? !elidesContent(message);
		}
		newerByKey.set(key, newer);
		if (!superseded) continue;
		candidates.push({
			entry: entry as SessionMessageEntry,
			message,
			index: i,
			tokens: tokenizer.countMessage(message as AgentMessage),
			notice: SUPERSEDED_NOTICE,
		});
	}
	return candidates.reverse();
}

function collectUselessResults(
	entries: readonly SessionEntry[],
	start: number,
	tokenizer: Tokenizer,
	toolCalls: SentToolCalls,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (message?.useless !== true || message.prunedAt !== undefined || message.isError === true) continue;
		if (exclude.has(message)) continue;
		if (isProtectedToolResult(message, toolCalls.get(message.toolCallId), protectedTools)) continue;
		const tokens = tokenizer.countMessage(message as AgentMessage);
		if (estimatePrunedSavings(tokens, USELESS_NOTICE) <= 0) continue;
		candidates.push({ entry: entry as SessionMessageEntry, message, index: i, tokens, notice: USELESS_NOTICE });
	}
	return candidates;
}

export function pruneSupersededToolResults(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	config: SupersedePruneConfig,
): PruneResult {
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const toolCalls = new SentToolCalls(entries, boundaryIndex);
	const candidates = config.supersedeKey
		? collectSupersededResults(
				entries,
				boundaryIndex,
				tokenizer,
				toolCalls,
				config.supersedeKey,
				config.supersedeComplete,
				config.protectedTools,
			)
		: [];
	if (config.pruneUseless) {
		const exclude = new Set(candidates.map(candidate => candidate.message));
		for (const candidate of collectUselessResults(
			entries,
			boundaryIndex,
			tokenizer,
			toolCalls,
			config.protectedTools,
			exclude,
		)) {
			candidates.push(candidate);
		}
		candidates.sort((a, b) => a.index - b.index);
	}
	if (candidates.length === 0) return NOTHING_PRUNED;

	const now = config.now ?? Date.now();
	let lastMessageTimestamp: number | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp === "number") lastMessageTimestamp = timestamp;
		break;
	}
	const idle =
		lastMessageTimestamp !== undefined && now - lastMessageTimestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);

	let toPrune: SupersedeCandidate[];
	if (idle) {
		// Provider cache is cold (idle exceeds the retention TTL), so re-writing
		// the sent region costs nothing. Candidates already start at the
		// compaction boundary (summarized-away entries are never sent).
		toPrune = candidates;
	} else {
		// Mutating a candidate re-writes its suffix (tokens of every message
		// strictly after it) in the warm cache, so prune only when that suffix is
		// small and the next request's cache lookup stays in reach. The suffix
		// only grows walking back, so stop at the first index past either limit
		// instead of measuring the whole branch.
		const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
		const lookbackFloor = cacheLookbackFloor(
			entries,
			boundaryIndex,
			config.cacheLookbackPositions,
			config.convertToLlm ?? defaultConvertToLlm,
		);
		toPrune = [];
		let suffixTokens = 0;
		let next = candidates.length - 1;
		for (let i = entries.length - 1; next >= 0 && suffixTokens <= suffixTokenLimit && i >= lookbackFloor; i--) {
			while (next >= 0 && candidates[next].index === i) toPrune.push(candidates[next--]);
			const entry = entries[i];
			if (entry.type === "message") suffixTokens += tokenizer.countMessage(entry.message as AgentMessage);
		}
		toPrune.reverse();
	}
	if (toPrune.length === 0) return NOTHING_PRUNED;

	let tokensSaved = 0;
	for (const candidate of toPrune) tokensSaved += estimatePrunedSavings(candidate.tokens, candidate.notice);

	const prunedAt = Date.now();
	const steps = toPrune.map(candidate => blankToolResult(candidate.message, candidate.notice, prunedAt));
	return { prunedCount: toPrune.length, tokensSaved, undo: undoAll(steps) };
}

export function pruneToolOutputs(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number; superseded: boolean; useless: boolean }> = [];
	// Entries before the compaction boundary are summarized away (never sent)
	// and are never prune candidates, so no pass below walks them.
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const toolCalls = new SentToolCalls(entries, boundaryIndex);
	const supersededMessages = config.supersedeKey
		? new Set(
				collectSupersededResults(
					entries,
					boundaryIndex,
					tokenizer,
					toolCalls,
					config.supersedeKey,
					config.supersedeComplete,
					config.protectedTools,
				).map(candidate => candidate.message),
			)
		: undefined;
	const uselessMessages =
		config.pruneUseless !== false
			? new Set(
					collectUselessResults(
						entries,
						boundaryIndex,
						tokenizer,
						toolCalls,
						config.protectedTools,
						supersededMessages ?? new Set(),
					).map(candidate => candidate.message),
				)
			: undefined;

	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	const lookbackFloor =
		cacheWarmSuffixTokens === undefined
			? boundaryIndex
			: cacheLookbackFloor(
					entries,
					boundaryIndex,
					config.cacheLookbackPositions,
					config.convertToLlm ?? defaultConvertToLlm,
				);
	// Tokens of every message strictly after entry `i` (cache guard only).
	let messageSuffix = 0;

	for (let i = entries.length - 1; i >= boundaryIndex; i--) {
		const entry = entries[i];
		const suffixAfter = messageSuffix;
		const message = getToolResultMessage(entry);
		if (!message) {
			if (cacheWarmSuffixTokens !== undefined && entry.type === "message") {
				messageSuffix += tokenizer.countMessage(entry.message as AgentMessage);
			}
			continue;
		}

		const tokens = tokenizer.countMessage(message as AgentMessage);
		messageSuffix += tokens;

		// Prompt-cache guard: a result whose all-message suffix exceeds the
		// warm-cache window sits in the already-sent cached prefix — mutating it
		// re-writes the whole suffix (cacheWrite premium), or the whole
		// conversation once the next request's cache lookup is out of reach.
		// Both only worsen walking back, so every older result is in the warm
		// prefix too. Deeper, still-cached superseded/useless copies are left for
		// compaction/shake.
		if (cacheWarmSuffixTokens !== undefined && (suffixAfter > cacheWarmSuffixTokens || i < lookbackFloor)) break;

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		const superseded = supersededMessages?.has(message) ?? false;
		const useless = uselessMessages?.has(message) ?? false;
		const tooSmall = tokens < MIN_PRUNE_TOKENS;
		if (
			!superseded &&
			!useless &&
			(accumulatedTokens < config.protectTokens ||
				tooSmall ||
				isProtectedToolResult(message, toolCalls.get(message.toolCallId), config.protectedTools))
		) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens, superseded, useless });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(
			candidate.tokens,
			candidate.superseded
				? SUPERSEDED_NOTICE
				: candidate.useless
					? USELESS_NOTICE
					: createPrunedNotice(candidate.tokens),
		);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return NOTHING_PRUNED;
	}

	const prunedAt = Date.now();
	const steps = candidates.map(candidate => {
		const notice = candidate.superseded
			? SUPERSEDED_NOTICE
			: candidate.useless
				? USELESS_NOTICE
				: createPrunedNotice(candidate.tokens);
		return blankToolResult(candidate.entry.message as ToolResultMessage, notice, prunedAt);
	});

	return { prunedCount: candidates.length, tokensSaved, undo: undoAll(steps) };
}

export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	if (sel === undefined) return base;
	return `${base}${isAlternateFormReadSelector(sel) ? "\u0001" : "\u0000"}${sel}`;
}
