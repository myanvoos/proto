import { type Component, Container, type HistoryBatch, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { estimateTranscriptBytes, TRANSCRIPT_WINDOW_BYTES } from "../utils/transcript-window";
import { isToolActivityComponent } from "./tool-activity";
import { isUsageRowBlock } from "./usage-row";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Presentation declaration captured permanently when a block is added. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/**
 * Explicit semantic-row contract for a block whose stable head may enter native
 * history before finalization. Every later array must extend the prior keys
 * exactly; each row renderer is deterministic for its width.
 * A publication that breaks these invariants (e.g. a mid-stream theme change
 * re-coloring already-emitted bytes) freezes further stable-row emission for
 * that block instead of failing the render — see {@link TranscriptContainer}.
 */
export interface AppendOnlyTranscriptBlock {
	readonly transcriptBlockMode: "appendOnly";
	getTranscriptStableRows(): readonly TranscriptStableRow[];
	/**
	 * Render the first `count` semantic rows at the requested current width.
	 * Counts are monotonic identities, not physical row counts; this output must
	 * prefix the block's full render at the same width.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[];
	/**
	 * Discard every published stable row so the block re-renders its head from
	 * scratch. Called only alongside a destructive display reset (e.g. a
	 * thinking-visibility toggle) that clears the native scrollback those rows
	 * occupied — the sole context in which the append-only "published bytes never
	 * change" contract may be retracted. Optional: blocks whose stable-row
	 * presentation never changes may omit it.
	 */
	resetTranscriptStableRows?(): void;
	/**
	 * Called when the block's unpublished tail is taller than the live viewport:
	 * change the tail so more of it can be published (e.g. break a streaming
	 * paragraph at a settled point) and return true, or return false when it
	 * cannot. Without it the tail's top is clipped off the screen instead.
	 */
	splitStableTail?(width: number): boolean;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport until pressure.
 * - `committed`: logically retired; replay never rewinds this state.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	sourceBytes: number;
	rowBytes: number;
	state: BlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, readonly string[]>;
	/**
	 * Rendered row counts per `(width, snapshot count)`: lets the projected
	 * length skip the re-render when the same prefix was already rendered.
	 * Keyed on both dimensions because one snapshot commonly renders to
	 * multiple physical rows (Markdown wrap).
	 */
	stableRowCountByWidth: Map<number, Map<number, number>>;
	emitted: number;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state to recognize still-matching emitted rows, but never emits another
	 * mid-stream row. An unrelated replacement remains visible in full.
	 */
	stableFrozen: boolean;
	/**
	 * Rows `[start, start + rows.length)` of this block's render at `width` that
	 * a resize pushed into native scrollback while they were still live. They
	 * are skipped wherever emitted rows are — display, retirement, stable
	 * emission — for as long as the render at that width still reproduces them
	 * exactly; the first mismatch drops the record and they are written again.
	 */
	archived: { width: number; start: number; rows: readonly string[] } | undefined;
}

type RetirementPolicy = "pressure" | "flush";
interface LiveLayoutBlock {
	index: number;
	rows: readonly string[];
	emitted: number;
	stable: number;
}
interface LiveRenderCache {
	width: number;
	frame: AnimationFrame;
	generation: number;
	blocks: Map<Component, readonly string[]>;
}
type Offered = { width: number } & (
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay"; end: number; emittedEnd: number }
);

const MAX_LIVE_BLOCKS = 256;
/** Recent committed replay; durable session history, not this window, is authoritative. */
export const RETAINED_COMMITTED_BLOCKS = 2000;
export const RETAINED_COMMITTED_BYTES = TRANSCRIPT_WINDOW_BYTES;
const REPLAY_WINDOW_NOTICE = `Older transcript blocks left the replay window (${RETAINED_COMMITTED_BLOCKS} blocks / ${RETAINED_COMMITTED_BYTES / (1024 * 1024)} MiB). Full history: Alt+PgUp or /history; saved session data is unchanged.`;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
const EMPTY_ROWS: readonly string[] = [];

/** Keep outer spacer rows from hiding the newest content in a short viewport. */
function contentRows(rows: readonly string[]): readonly string[] {
	let end = rows.length;
	while (end > 0 && Bun.stripANSI(rows[end - 1]!).trim().length === 0) end--;
	let start = 0;
	while (start < end && Bun.stripANSI(rows[start]!).trim().length === 0) start++;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];
// Accounting follows a component when a staged rebuild moves it to the visible root.
const sourceBytesByComponent = new WeakMap<Component, number>();

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function createEntry(component: Component): TranscriptEntry {
	return {
		component,
		sourceBytes: sourceBytesByComponent.get(component) ?? 0,
		rowBytes: 0,
		state: "active",
		mode: blockMode(component),
		stableRows: EMPTY_STABLE_ROWS,
		renderedStableByWidth: new Map(),
		stableRowCountByWidth: new Map(),
		emitted: 0,
		stableFrozen: false,
		archived: undefined,
	};
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
}

function isStablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

/** Strip leading/trailing all-blank rows from a transcript block. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#releaseFailures = new WeakSet<Component>();
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	#liveGeneration = 0;
	#liveRenderCache: LiveRenderCache | undefined;
	// Row layout of the last unclipped live viewport: the shown blocks in order,
	// separated by one blank row, each with the rows it painted and the emitted
	// stable count it was sliced by. Lets a resize map rows the host pushed into
	// scrollback back onto whole blocks. Clipped layouts are not recorded.
	#lastLiveLayout: { width: number; blocks: LiveLayoutBlock[] } | undefined;
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new WeakMap<Component, number>();
	#historyEvicted = false;
	// An unfinalized frontier can pin retirement and leave older live output
	// above the viewport. Log once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	#renderRevision = 0;
	#renderedRows: readonly string[] = [];
	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push(createEntry(component));
		this.#liveGeneration++;
	}

	/** Insert into the live tail while retaining the component/entry mirror and immutable history order. */
	insertChildAt(component: Component, index: number): void {
		this.#syncEntries();
		const target = Math.max(this.#frontier, Math.min(this.children.length, Math.trunc(index)));
		this.addChild(component);
		const child = this.children.pop()!;
		const entry = this.#entries.pop()!;
		this.children.splice(target, 0, child);
		this.#entries.splice(target, 0, entry);
		this.#clearDerived();
	}

	override removeChild(component: Component): void {
		const index = this.#removableIndex(component);
		if (index < 0) return;
		this.#removeAt(index);
	}

	#removeAt(index: number): void {
		this.children.splice(index, 1);
		this.#entries.splice(index, 1);
		this.#clearDerived();
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
	}

	override disposeAndRemoveChild(component: Component): void {
		const index = this.#removableIndex(component);
		if (index < 0) return;
		this.#removeAt(index);
		component.dispose?.();
	}

	/** Account hidden source payloads as well as rendered rows, without retaining the source. */
	accountSource(component: Component, value: unknown): void {
		const sourceBytes = Math.min(
			RETAINED_COMMITTED_BYTES + 1,
			(sourceBytesByComponent.get(component) ?? 0) + estimateTranscriptBytes(value, RETAINED_COMMITTED_BYTES),
		);
		sourceBytesByComponent.set(component, sourceBytes);
		const entry = this.#entries.find(candidate => candidate.component === component);
		if (entry) entry.sourceBytes = sourceBytes;
	}

	/** Split extensible live groups before their settled history can pin an unbounded source. */
	hasSourceCapacity(component: Component): boolean {
		return (sourceBytesByComponent.get(component) ?? 0) < RETAINED_COMMITTED_BYTES;
	}

	#clearDerived(): void {
		this.#liveGeneration++;
		this.#liveRenderCache = undefined;
		this.#lastLiveLayout = undefined;
		this.#childStartRows = new WeakMap<Component, number>();
		if (this.#renderedRows.length > 0) this.#renderRevision++;
		this.#renderedRows = EMPTY_ROWS;
		this.#pinnedFrontier = undefined;
	}

	override clear(): void {
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#replayPending = false;
		this.#historyEvicted = false;
		this.#clearDerived();
	}

	override dispose(): void {
		super.dispose();
		this.clear();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.#liveGeneration++;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/**
	 * Forget the append-only emission ledger — emitted counts, published stable
	 * rows, per-width render cache, and freeze state — for every block, and ask
	 * each append-only block to drop its own published rows. The next replay then
	 * re-renders each block from its current {@link Component.render}, applying a
	 * changed presentation (e.g. a thinking-visibility toggle) to rows that were
	 * already emitted as stable heads while streaming (#10177).
	 *
	 * Callers MUST pair this with a scrollback-clearing {@link resetDisplay}: the
	 * emitted rows it forgets still sit in native history until that clear
	 * rewrites them, so unpaired use would duplicate them on the next retirement.
	 */
	resetStableEmission(): void {
		this.#syncEntries();
		this.#offered = undefined;
		this.#clearDerived();
		for (const entry of this.#entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableRowCountByWidth = new Map();
			entry.stableFrozen = false;
			entry.archived = undefined;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		return this.#removableIndex(component) >= 0;
	}

	#removableIndex(component: Component): number {
		this.#syncEntries();
		const index = this.#entries.findLastIndex(entry => entry.component === component);
		if (index < 0) return -1;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0) return -1;
		if ((this.#offered?.kind === "commit" || this.#offered?.kind === "replay") && index < this.#offered.end)
			return -1;
		if (
			(this.#offered?.kind === "append" && index === this.#offered.entry) ||
			(this.#offered?.kind === "replay" && index === this.#offered.end && this.#offered.emittedEnd > 0)
		)
			return -1;
		return index;
	}

	/** Whether a superseded snapshot (a repeated poll) may be replaced; one directly above its turn's usage row stays. */
	canDisplaceBlock(component: Component): boolean {
		if (!this.canRemoveBlock(component)) return false;
		const next = this.children[this.children.indexOf(component) + 1];
		return next === undefined || !isUsageRowBlock(next);
	}

	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Permanently captured presentation mode per block (diagnostics and tests). */
	blockModes(): readonly TranscriptBlockMode[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.mode);
	}

	/** Emitted stable semantic-row counts in transcript order. */
	emittedStableRows(): readonly number[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.emitted);
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(): void {
		this.#syncEntries();
		this.#offered = undefined;
		this.resetStableEmission();
		this.#replayPending = true;
	}

	/**
	 * Drop a not-yet-offered replay so a shutdown flush emits only un-retired
	 * rows. The terminal already holds the committed ledger; re-streaming it at
	 * quit is pure write volume. An already offered replay batch stays valid.
	 */
	cancelReplay(): void {
		this.#replayPending = false;
	}

	/** Total rows the live, un-emitted tail occupies at `width`. */
	liveRowCount(width: number, frame: AnimationFrame = this.#lastFrame): number {
		this.#syncEntries();
		this.#settleFinalized();
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			const rendered = this.#renderLiveEntry(entry, width, frame);
			const block = rendered.slice(this.#projectedEmittedRowCount(entry, index, width, rendered));
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** Render the live tail, constrained to the supplied transcript height. */
	/** Render normal block layouts, showing only the tail that fits on screen. */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#lastLiveLayout = undefined;
		this.#syncEntries();
		this.#settleFinalized();
		this.#trimReplayWindow();
		const capacity = Math.max(0, Math.trunc(rows));
		if (capacity === 0) return EMPTY_ROWS;

		const output: string[] = [];
		const layout: LiveLayoutBlock[] = [];
		for (const { entry, index } of this.#liveEntries()) {
			const rendered = this.#renderLiveEntry(entry, width, frame);
			const emitted = this.#projectedEmitted(entry, index);
			const block = rendered.slice(this.#emittedRowCount(entry, emitted, width, rendered));
			if (block.length === 0) continue;
			if (output.length > 0) output.push("");
			for (const line of block) output.push(line);
			layout.push({ index, rows: block, emitted, stable: entry.stableRows.length });
		}
		if (output.length <= capacity) {
			this.#lastLiveLayout = { width, blocks: layout };
			return output;
		}

		// Preserve each card's layout and chronological order. Overflow is off
		// screen, not a reason to replace tool output with a one-line summary.
		return contentRows(output).slice(-capacity);
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		return this.#peekReplayBatch(width);
	}

	#peekReplayBatch(width: number): HistoryBatch | undefined {
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.rerenderOfferedBatch(width) : undefined;
		}
		if (!this.#replayPending) return undefined;
		this.#replayPending = false;
		let end = this.#frontier;
		while (this.#entries[end]?.state === "settled") end++;
		const head = this.#entries[end];
		let emittedEnd = 0;
		if (head?.mode === "appendOnly") {
			this.#renderEntry(head, width);
			if (!head.stableFrozen) emittedEnd = head.stableRows.length;
		}
		const rows = this.#renderReplay(width, end, emittedEnd);
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, width, kind: "replay", end, emittedEnd };
		return batch;
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	/** Replace an unacknowledged old-width offer; published batch objects remain immutable. */
	rerenderOfferedBatch(width: number): HistoryBatch | undefined {
		const offered = this.#offered;
		if (offered === undefined) return undefined;
		let rows: readonly string[];
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			const before = this.#renderStablePrefix(entry, entry.emitted, width);
			const after = this.#renderStablePrefix(entry, offered.emittedEnd, width);
			rows = after.slice(Math.max(before.length, this.#archivedEnd(entry, width, this.#renderEntry(entry, width))));
		} else if (offered.kind === "commit") {
			rows = this.#renderRange(this.#frontier, offered.end, width, true);
		} else {
			rows = this.#renderReplay(width, offered.end, offered.emittedEnd);
		}
		// Rendering participates in image admission even when the offer is unchanged.
		// A budget retry can replace an unpainted image with its text fallback.
		if (
			offered.width === width &&
			rows.length === offered.batch.rows.length &&
			isRowPrefix(rows, offered.batch.rows)
		) {
			return offered.batch;
		}
		offered.width = width;
		offered.batch = { id: this.#nextBatchId++, rows, kind: offered.batch.kind };
		return offered.batch;
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#syncEntries();
		this.#settleFinalized();
		if (this.#offered !== undefined) return this.rerenderOfferedBatch(width);
		const replay = this.#peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rendered: (readonly string[])[] = new Array(live.length);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			const renderedEntry = this.#renderEntry(candidate.entry, width);
			const rows = renderedEntry.slice(
				this.#emittedRowCount(candidate.entry, candidate.entry.emitted, width, renderedEntry),
			);
			rendered[index] = rows;
			heights[index] = rows.length;
			if (rows.length > 0) total += rows.length + (visible++ > 0 ? 1 : 0);
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.#entries[this.#frontier];
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted >= head.stableRows.length &&
			(head.component as Component & AppendOnlyTranscriptBlock).splitStableTail?.(width)
		) {
			// Re-render to pick up the rows the split published.
			this.#renderEntry(head, width);
		}
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			// Emit as many finished rows as the overflow needs, in one batch. A
			// fast stream adds finished rows quicker than one per pressure cycle,
			// and the live region has to fall back under `room` to stay readable:
			// rows left behind here are rows dropped from the top of the viewport.
			const overflow = total - room;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			// Rows a resize already archived into scrollback are not written again.
			const skip = Math.max(before.length, this.#archivedEnd(head, width, this.#renderEntry(head, width)));
			let emittedEnd = head.emitted;
			let rows: readonly string[] = EMPTY_ROWS;
			while (emittedEnd < head.stableRows.length && rows.length < overflow) {
				const after = this.#renderStablePrefix(head, emittedEnd + 1, width);
				if (!isRowPrefix(before, after) || after.length === before.length) {
					if (emittedEnd === head.emitted) {
						this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
					}
					break;
				}
				rows = after.slice(skip);
				emittedEnd += 1;
			}
			if (emittedEnd > head.emitted && rows.length === 0) {
				// Every newly stable row is already archived: account for it silently.
				head.emitted = emittedEnd;
			} else if (emittedEnd > head.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows,
					kind: "append",
				};
				this.#offered = { batch, width, kind: "append", entry: this.#frontier, emittedEnd };
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}

		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (
				policy === "pressure" &&
				total - freed <= room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) {
			if (policy === "pressure") this.#notePinnedFrontier();
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: this.#renderRange(this.#frontier, end, width, true),
			kind: "append",
		};
		this.#offered = { batch, width, end, kind: "commit" };
		return batch;
	}

	/**
	 * A resize pushed the first `rows` rows of the last painted live viewport
	 * into native scrollback. Account for them without writing them again: a
	 * settled block whose rows and following blank separator all crossed retires
	 * whole (history keeps one blank row between blocks); an append-only block
	 * advances by the stable rows that had crossed when it was painted; and the
	 * crossed rows of the first block that cannot retire are recorded as
	 * archived, skipped only while its render keeps reproducing them. Returns
	 * how many leading viewport rows are now accounted as history.
	 */
	retireArchivedRows(rows: number): number {
		const layout = this.#lastLiveLayout;
		this.#lastLiveLayout = undefined;
		const budget = Math.max(0, Math.trunc(rows));
		if (layout === undefined || this.#offered !== undefined || budget === 0) return 0;
		let start = 0;
		for (const shown of layout.blocks) {
			const entry = this.#entries[shown.index];
			if (entry === undefined || shown.index !== this.#frontier || entry.emitted !== shown.emitted) return start;
			const end = start + shown.rows.length;
			if (entry.state === "settled" && end < budget) {
				this.#commit(entry);
				this.#frontier++;
				start = end + 1;
				continue;
			}
			const crossedRows = Math.min(shown.rows.length, budget - start);
			if (crossedRows <= 0) return start;
			const full = this.#renderEntry(entry, layout.width);
			const shownStart = this.#emittedRowCount(entry, entry.emitted, layout.width, full);
			const prior = entry.archived;
			let credited = 0;
			if (prior === undefined && entry.mode === "appendOnly" && !entry.stableFrozen) {
				const before = this.#renderStablePrefix(entry, entry.emitted, layout.width);
				const limit = Math.min(shown.stable, entry.stableRows.length);
				for (let count = entry.emitted + 1; count <= limit; count++) {
					const after = this.#renderStablePrefix(entry, count, layout.width);
					if (!isRowPrefix(before, after) || after.length - before.length > crossedRows) break;
					entry.emitted = count;
					credited = after.length - before.length;
				}
			}
			if (credited < crossedRows) {
				const fresh = shown.rows.slice(credited, crossedRows);
				// A later push into the same block extends its contiguous span.
				entry.archived =
					prior !== undefined && prior.width === layout.width && prior.start + prior.rows.length === shownStart
						? { width: layout.width, start: prior.start, rows: [...prior.rows, ...fresh] }
						: { width: layout.width, start: shownStart + credited, rows: fresh };
				// The span counts only while the current render still carries it.
				if (this.#archivedEnd(entry, layout.width, full) === 0) return start + credited;
			}
			return start + crossedRows;
		}
		return start;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			// The offered end must still extend this entry's emitted prefix: a
			// stale offer (already-advanced entry) or a retraction (entry reset to
			// zero with the offer still live) must not move it backwards.
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd <= entry.emitted) return;
			entry.emitted = offered.emittedEnd;
		} else if (offered.kind === "commit" || offered.kind === "replay") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#commit(this.#entries[index]!);
			}
			this.#frontier = offered.end;
			if (offered.kind === "replay" && this.#entries[offered.end]) {
				this.#entries[offered.end]!.emitted = offered.emittedEnd;
			}
		}
		for (let index = 0; index < this.#frontier; index++) {
			this.#releaseRenderCaches(this.#entries[index]!);
		}
		this.#offered = undefined;
		this.#trimReplayWindow();
	}

	/**
	 * Render only the trailing `maxRows` semantic rows, walking blocks bottom-up.
	 * Used by the transient resize-buffer repaint, which needs one viewport of
	 * tail rows per resize event — never the full committed ledger.
	 */
	renderTail(width: number, maxRows: number): readonly string[] {
		this.#syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.unshift("");
			rows.unshift(...block);
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/** Full render of the retained window. Export full history from session storage. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		this.#childStartRows = new WeakMap<Component, number>();
		const rows: string[] = this.#historyEvicted
			? [...wrapTextWithAnsi(REPLAY_WINDOW_NOTICE, Math.max(1, width))]
			: [];
		for (const entry of this.#entries) {
			const block = this.#renderEntry(entry, width);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			this.#childStartRows.set(entry.component, rows.length);
			rows.push(...block);
		}
		if (rows.length !== this.#renderedRows.length || !isRowPrefix(this.#renderedRows, rows)) {
			this.#renderRevision++;
			this.#renderedRows = rows;
		}
		return this.#renderedRows;
	}

	getRenderRevision(): number {
		return this.#renderRevision;
	}

	/** Rendered row where a child's block begins in the last full render() (transcript deep-links). */
	getChildStartRow(child: Component): number | undefined {
		return this.#childStartRows.get(child);
	}

	#renderEntry(entry: TranscriptEntry, width: number): readonly string[] {
		const rendered = trimBlankEdges(entry.component.render(width));
		entry.rowBytes = estimateTranscriptBytes(rendered, RETAINED_COMMITTED_BYTES);
		if (entry.state === "committed" || entry.mode === "mutable" || entry.stableFrozen) return rendered;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		const stable = appendOnly.getTranscriptStableRows();
		if (!isStablePrefix(entry.stableRows, stable)) {
			return this.#freezeStableRows(entry, rendered, "publication retracted the published prefix");
		}
		if (entry.emitted > stable.length) {
			return this.#freezeStableRows(entry, rendered, "publication retracted emitted history");
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = appendOnly.renderTranscriptStableRows(published.length, width);
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		// Slice only when the rendered rows actually changed: same length
		// plus prefix-equality in both directions means byte-identical, so
		// the stored array can be reused (callers only slice/read it).
		const priorRows = entry.renderedStableByWidth.get(width);
		if (
			priorRows === undefined ||
			priorRows.length !== stableRendered.length ||
			!isRowPrefix(priorRows, stableRendered)
		) {
			entry.renderedStableByWidth.set(width, stableRendered.slice());
		}
		let perCount = entry.stableRowCountByWidth.get(width);
		if (perCount === undefined) {
			perCount = new Map();
			entry.stableRowCountByWidth.set(width, perCount);
		}
		perCount.set(published.length, stableRendered.length);
		return rendered;
	}

	/**
	 * Demote a drifting append-only publication: rows already written to native
	 * scrollback cannot be retracted, so keep the last good stable state and
	 * stop mid-stream emission for this block. Only a still-matching emitted
	 * prefix may be sliced off the current render. A replacement renders and
	 * retires whole after the old native history, rather than losing its head.
	 */
	#freezeStableRows(entry: TranscriptEntry, rendered: readonly string[], reason: string): readonly string[] {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted });
		return rendered;
	}

	#renderStablePrefix(entry: TranscriptEntry, count: number, width: number): readonly string[] {
		if (count === 0) return EMPTY_ROWS;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}

	/**
	 * Account for an offered history transaction as well as acknowledged rows.
	 * Valid publications use the cached prefix length; frozen publications
	 * must first prove that the old prefix still belongs to the current render.
	 */
	#projectedEmittedRowCount(
		entry: TranscriptEntry,
		index: number,
		width: number,
		rendered: readonly string[],
	): number {
		return this.#emittedRowCount(entry, this.#projectedEmitted(entry, index), width, rendered);
	}

	/** Emitted stable count once the in-flight offer lands. */
	#projectedEmitted(entry: TranscriptEntry, index: number): number {
		const offered = this.#offered;
		return (offered?.kind === "append" && offered.entry === index) ||
			(offered?.kind === "replay" && offered.end === index)
			? offered.emittedEnd
			: entry.emitted;
	}

	#emittedRowCount(entry: TranscriptEntry, count: number, width: number, rendered: readonly string[]): number {
		return Math.max(
			this.#stableEmittedRowCount(entry, count, width, rendered),
			this.#archivedEnd(entry, width, rendered),
		);
	}

	/** End row of the verified archived span at `width`, or 0; a span the render no longer reproduces is dropped. */
	#archivedEnd(entry: TranscriptEntry, width: number, rendered: readonly string[]): number {
		const archived = entry.archived;
		if (archived === undefined || archived.width !== width) return 0;
		const end = archived.start + archived.rows.length;
		for (let row = 0; row < archived.rows.length; row++) {
			if (rendered[archived.start + row] !== archived.rows[row]) {
				entry.archived = undefined;
				return 0;
			}
		}
		return end;
	}

	#stableEmittedRowCount(entry: TranscriptEntry, count: number, width: number, rendered: readonly string[]): number {
		if (count === 0) return 0;
		const perCount = entry.stableRowCountByWidth.get(width);
		const memo = perCount?.get(Math.min(count, entry.stableRows.length));
		if (!entry.stableFrozen && memo !== undefined) return memo;
		// A provider may replace streamed text on completion. Native history is
		// immutable, but its row count cannot be used as an offset into unrelated
		// final text. Preserve that history and publish the replacement once.
		const cached = entry.renderedStableByWidth.get(width);
		const prefix =
			entry.stableFrozen && cached && memo !== undefined
				? cached.slice(0, memo)
				: this.#renderStablePrefix(entry, count, width);
		return !entry.stableFrozen || isRowPrefix(prefix, rendered) ? prefix.length : 0;
	}
	/**
	 * Record that pressure retirement is blocked behind a not-yet-settled
	 * frontier block, and log its identity once the episode outlives the grace
	 * period. A block that never finalizes (a dropped terminal event) pins the
	 * whole live region here with no visible symptom other than degraded
	 * one-line layout, so the log line is the only forensic trail.
	 */
	#notePinnedFrontier(): void {
		const entry = this.#entries[this.#frontier];
		if (entry === undefined) return;
		const now = Date.now();
		if (this.#pinnedFrontier?.index !== this.#frontier) {
			this.#pinnedFrontier = { index: this.#frontier, since: now, logged: false };
			return;
		}
		if (this.#pinnedFrontier.logged || now - this.#pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.#pinnedFrontier.logged = true;
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
		});
	}

	#renderRange(start: number, end: number, width: number, trailingBlank: boolean): readonly string[] {
		const rows: string[] = [];
		// Set once a block with content precedes the next one — including a head
		// whose rows all reached scrollback earlier, which still needs its blank
		// separator before the next block.
		let separate = false;
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			// Only the range head is sliced by its emitted stable prefix; every other
			// entry renders whole, so the append-only verification pass (a second
			// full render of the block's stable prefix) is skipped for them. This
			// keeps a complete-ledger replay at one render per block.
			const rendered =
				index === start ? this.#renderEntry(entry, width) : trimBlankEdges(entry.component.render(width));
			entry.rowBytes = estimateTranscriptBytes(rendered, RETAINED_COMMITTED_BYTES);
			const emittedRows = index === start ? this.#emittedRowCount(entry, entry.emitted, width, rendered) : 0;
			const block = rendered.slice(emittedRows);
			if (block.length > 0) {
				if (separate) rows.push("");
				rows.push(...block);
			}
			if (rendered.length > 0) separate = true;
		}
		if (trailingBlank && rows.length > 0) rows.push("");
		return rows;
	}

	#renderReplay(width: number, end: number, emittedEnd: number): readonly string[] {
		const rows = this.#historyEvicted ? [...wrapTextWithAnsi(REPLAY_WINDOW_NOTICE, Math.max(1, width)), ""] : [];
		rows.push(...this.#renderRange(0, end, width, true));
		const head = this.#entries[end];
		if (head?.mode === "appendOnly" && emittedEnd > 0) {
			rows.push(...this.#renderStablePrefix(head, emittedEnd, width));
		}
		return rows;
	}

	/** Commit bookkeeping; only the bounded recent replay keeps its component. */
	#commit(entry: TranscriptEntry): void {
		if (entry.state === "committed") return;
		entry.state = "committed";
		entry.stableRows = EMPTY_STABLE_ROWS;
		entry.renderedStableByWidth.clear();
		entry.stableRowCountByWidth.clear();
		entry.emitted = 0;
		entry.stableFrozen = false;
		entry.archived = undefined;
		this.#releaseRenderCaches(entry);
	}

	#releaseRenderCaches(entry: TranscriptEntry): void {
		try {
			entry.component.releaseRenderCaches?.();
		} catch (error) {
			if (this.#releaseFailures.has(entry.component)) return;
			this.#releaseFailures.add(entry.component);
			logger.warn("Transcript block failed to release render caches", {
				component: entry.component.constructor.name,
				error: String(error),
			});
		}
	}

	/** Forget acknowledged history only; an in-flight batch and live output remain intact. */
	#trimReplayWindow(): void {
		if (this.#offered !== undefined || this.#frontier === 0) return;
		let bytes = 0;
		let keepFrom = this.#frontier;
		while (keepFrom > 0 && this.#frontier - keepFrom < RETAINED_COMMITTED_BLOCKS) {
			const entry = this.#entries[keepFrom - 1]!;
			const size = entry.sourceBytes + entry.rowBytes;
			if (bytes + size > RETAINED_COMMITTED_BYTES) break;
			bytes += size;
			keepFrom--;
		}
		if (keepFrom === 0) return;
		const dropped = this.#entries.splice(0, keepFrom);
		this.children.splice(0, keepFrom);
		this.#frontier -= keepFrom;
		this.#historyEvicted = true;
		this.#clearDerived();
		// Action cards and image owners have the same lifetime as their replay
		// blocks. Their normal disposal releases callbacks and terminal payloads.
		for (const entry of dropped) entry.component.dispose?.();
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			const rendered = this.#renderEntry(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#emittedRowCount(entry, entry.emitted, width, rendered) !== rendered.length) return;
			this.#commit(entry);
			this.#frontier++;
		}
	}

	#renderLiveEntry(entry: TranscriptEntry, width: number, frame: AnimationFrame): readonly string[] {
		let cache = this.#liveRenderCache;
		if (
			cache === undefined ||
			cache.width !== width ||
			cache.frame.tick !== frame.tick ||
			cache.frame.now !== frame.now ||
			cache.generation !== this.#liveGeneration
		) {
			cache = { width, frame, generation: this.#liveGeneration, blocks: new Map() };
			this.#liveRenderCache = cache;
		}
		const cached = cache.blocks.get(entry.component);
		if (cached !== undefined) return cached;
		const rows = this.#renderEntry(entry, width);
		cache.blocks.set(entry.component, rows);
		return rows;
	}

	#settleFinalized(): void {
		let changed = false;
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			if (entry.state === "active" && isFinalized(entry.component)) {
				entry.state = "settled";
				changed = true;
			}
		}
		if (changed) this.#liveGeneration++;
	}

	#liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const start =
			this.#offered?.kind === "commit" || this.#offered?.kind === "replay" ? this.#offered.end : this.#frontier;
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = start; index < this.#entries.length; index++) live.push({ entry: this.#entries[index]!, index });
		return live;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(component => existing.get(component) ?? createEntry(component));
		for (let index = 0; index < this.#entries.length; index++) {
			this.children[index] = this.#entries[index]!.component;
		}
		this.#liveGeneration++;
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
		this.#clearDerived();
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
