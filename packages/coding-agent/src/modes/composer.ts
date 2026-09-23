import {
	type Component,
	Container,
	Editor,
	type HistoryBatch,
	ProcessTerminal,
	Spacer,
	type Terminal,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TUIOptions,
	type ViewportSize,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../config/keybindings";
import { CustomEditor } from "./components/custom-editor";
import { isRowPrefix, TranscriptContainer } from "./components/transcript-container";
import { type RecentSession, WelcomeComponent } from "./components/welcome";
import { getEditorTheme, initThemeSync, theme } from "./theme/theme";

export const COMPOSER_PLACEHOLDER = "ask anything · / for commands";

const DOUBLE_INTERRUPT_MS = 500;

export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: boolean;
	readonly spellingAutocorrect: boolean;
}

export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	showHardwareCursor: true,
	maxInlineImages: 8,
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: true,
	spellingAutocorrect: false,
};

export interface ComposerWelcomeUpdate {
	readonly version?: string;
	readonly modelName?: string;
	readonly providerName?: string;
	readonly recentSessions?: readonly RecentSession[];
}

interface ComposerOptions {
	readonly terminal?: Terminal;

	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

interface ComposerStartOptions {
	readonly clearScrollback?: boolean;

	readonly deferInput?: boolean;
}

class StatusHost implements Component {
	#component: Component | undefined;

	setComponent(component: Component): void {
		this.#component = component;
	}

	render(width: number): readonly string[] {
		return this.#component?.render(width) ?? [];
	}
}

class ComposerHairline implements Component {
	suppressed = false;

	render(width: number): string[] {
		if (this.suppressed) return [];
		return [theme.fg("borderMuted", theme.boxSharp.horizontal.repeat(Math.max(1, width)))];
	}

	invalidate(): void {}
}

function isBlankRow(row: string): boolean {
	return !/\S/.test(Bun.stripANSI(row));
}

/**
 * Fit `rows` into `budget`, shedding leading blank padding before content. A
 * compressed block keeps its heading (`Steering · 2`) instead of spending its
 * single surviving row on the spacer that separates it from the block above.
 */
function compressRows(rows: readonly string[], budget: number): string[] {
	if (rows.length <= budget) return [...rows];
	let start = 0;
	while (start < rows.length - budget && !/\S/.test(rows[start]!)) start++;
	return rows.slice(start, start + budget);
}

class CardPadRow implements Component {
	render(): string[] {
		return [""];
	}

	invalidate(): void {}
}

export class Composer implements TerminalFrameProvider {
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	readonly #editorSlot = new Container();
	readonly #statusHost = new StatusHost();
	readonly #bottomMargin = new Spacer(1);
	readonly #composerHairline = new ComposerHairline();
	readonly #padAboveEditor = new CardPadRow();
	readonly #padBelowEditor = new CardPadRow();
	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#preferences: ComposerPreferences;
	#welcome: WelcomeComponent | undefined;
	#version = "";
	#modelName = "";
	#providerName = "";
	#recentSessions: RecentSession[] = [];
	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#belowChildren: readonly Component[] = [];
	#runtimeMounted = false;
	#nextHistoryId = 1;
	#headerRetired = false;
	#historyReplay = false;
	#historyFlush = false;
	// Whether the last row written to native history is blank.
	#historyEndsBlank = false;
	#offeredHistory:
		| {
				batch: HistoryBatch;
				width: number;
				transcript: TranscriptContainer;
				transcriptId?: number;
				header: boolean;
		  }
		| undefined;
	#lastInterruptAt = 0;
	// Where the live transcript sat in the last painted viewport.
	#lastLiveFrame:
		| { transcript: TranscriptContainer; viewportLength: number; liveStart: number; liveRows: number }
		| undefined;
	#started = false;
	#stopped = false;
	#transferred = false;

	constructor(options: ComposerOptions = {}) {
		if (typeof theme === "undefined") initThemeSync();
		this.#exit = options.exit ?? (code => process.exit(code));
		this.#now = options.now ?? Date.now;
		this.#preferences = { ...COMPOSER_DEFAULTS, ...options.preferences };
		this.#applyWelcomeUpdate(options.welcome ?? {});

		this.ui = new TUI(
			options.terminal ?? new ProcessTerminal(),
			this.#preferences.showHardwareCursor,
			options.tuiOptions,
		);
		this.ui.setFrameProvider(this);
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);

		this.#editor = new CustomEditor(getEditorTheme());
		this.#editorSlot.addChild(this.editor);
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setPlaceholder(COMPOSER_PLACEHOLDER);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});

		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#composerHairline);
		this.ui.addChild(this.#padAboveEditor);
		this.ui.addChild(this.#editorSlot);
		this.ui.addChild(this.#padBelowEditor);
		this.ui.addChild(this.#statusHost);
		this.ui.addChild(this.#bottomMargin);
		this.ui.setFocus(this.editor);
	}

	/** Plan immutable history independently of the complete mutable viewport. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		if (!this.#started || this.#stopped) return { viewport: [] };
		const width = Math.max(1, viewport.columns);
		const height = Math.max(0, viewport.rows);
		const roots = this.ui.children;
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) {
			// Nothing to replay, and this frame already carries the reset that asked
			// for one. Holding the request would replay it once a transcript attaches
			// and reset the display a second time — at startup, erasing what the user
			// had on screen before launch after the first reset deliberately kept it.
			this.#historyReplay = false;
			this.#lastLiveFrame = undefined;
			return {
				viewport: height > 0 ? this.#renderComposerRoots(roots, width, height).slice(-height) : [],
				viewportAnchor: "bottom",
			};
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const before = this.#renderRoots(
			roots.slice(0, transcriptIndex).filter(root => root !== this.#header),
			width,
		);
		const after = this.#renderComposerRoots(roots.slice(transcriptIndex + 1), width, height);
		// Height is billed as-is, unlike chrome: a shrunken terminal has already
		// pushed the live rows it can no longer show into the host's scrollback,
		// so holding them live would write them a second time when they finally
		// retire. Shrinking therefore empties the transcript viewport for good —
		// growing back cannot retract a host push, and only an explicit display
		// replacement (`beginHistoryReplay`) may repaint the ledger. Pinned by
		// "a shrink retires the transcript overflow once and only a replay can
		// bring it back" in composer.test.ts.
		// Chrome is billed as rendered, not against the smallest chrome ever seen:
		// a frame may only call rows live when it can actually paint them. Rows
		// counted as live beyond the paintable space are clipped off the top of
		// the plan, and the live region is repainted in place rather than
		// scrolled, so an un-retired block clipped here would never reach native
		// history — it would simply be overwritten. Expanded drafts and dialogs
		// therefore retire the transcript they cover instead of hiding it.
		const capacity = Math.max(0, height - before.length - after.length);
		const history = this.#offerHistory(transcript, width, capacity);
		const header = this.#headerRetired || this.#offeredHistory?.header ? [] : this.#historyHeader(width);
		const now = performance.now();
		const live = transcript.renderViewport(width, Math.max(0, capacity - header.length), {
			now,
			tick: Math.floor(now / 80),
		});
		// A retired block leaves the blank that separates it from the next one at
		// the end of history. With nothing live below it, the chrome's own gap
		// row would double that blank.
		const historyEndsBlank = history?.rows.length ? isBlankRow(history.rows.at(-1)!) : this.#historyEndsBlank;
		const chrome =
			historyEndsBlank &&
			header.length + before.length + live.length === 0 &&
			after.length > 0 &&
			isBlankRow(after[0]!)
				? after.slice(1)
				: after;
		const rows = [...header, ...before, ...live, ...chrome];
		const painted = height > 0 ? rows.slice(-height) : [];
		this.#lastLiveFrame = {
			transcript,
			viewportLength: painted.length,
			liveStart: header.length + before.length - (rows.length - painted.length),
			liveRows: live.length,
		};
		return { history, viewport: painted, viewportAnchor: "bottom" };
	}

	/**
	 * Retire the live transcript rows a resize pushed off the top of the last
	 * painted viewport. Only a viewport that opens on the live transcript can
	 * do so in order: the welcome header above it would have to reach history
	 * first, and an in-flight history offer owns the rows it covers.
	 */
	retireArchivedRows(rows: number, viewportLength: number): number {
		const frame = this.#lastLiveFrame;
		this.#lastLiveFrame = undefined;
		if (!frame || frame.viewportLength !== viewportLength || frame.liveStart !== 0 || this.#offeredHistory) return 0;
		return frame.transcript.retireArchivedRows(Math.min(rows, frame.liveRows));
	}

	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (!offered || offered.batch.id !== id) return;
		if (offered.transcriptId !== undefined) offered.transcript.acknowledgeFinalizedBatch(offered.transcriptId);
		if (offered.header) this.#headerRetired = true;
		const last = offered.batch.rows.at(-1);
		if (last !== undefined || offered.batch.kind === "replay")
			this.#historyEndsBlank = last !== undefined && isBlankRow(last);
		this.#offeredHistory = undefined;
	}

	/** The alternate resize preview is semantic only: it cannot retire history. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		const width = Math.max(1, viewport.columns);
		const height = Math.max(0, viewport.rows);
		if (height === 0) return [];
		const roots = this.ui.children;
		const index = roots.findIndex(root => root instanceof TranscriptContainer);
		let rows: string[];
		if (index < 0) {
			rows = this.#renderComposerRoots(roots, width, height).slice(-height);
		} else {
			const after = this.#renderComposerRoots(roots.slice(index + 1), width, height);
			const transcript = roots[index] as TranscriptContainer;
			const tail = transcript.renderTail(width, Math.max(0, height - after.length));
			const prefix = tail.length + after.length < height ? this.#renderRoots(roots.slice(0, index), width) : [];
			rows = [...prefix, ...tail, ...after].slice(-height);
		}
		// The borrowed resize buffer paints from row zero. Pad only this preview,
		// not the normal history plan, to retain the composer's bottom anchor.
		return [...Array<string>(height - rows.length).fill(""), ...rows];
	}

	/** Called only for an explicit display/session replacement, never a resize. */
	beginHistoryReplay(): void {
		this.#offeredHistory = undefined;
		this.#historyReplay = true;
		this.#historyFlush = false;
		const transcript = this.ui.children.find(root => root instanceof TranscriptContainer);
		if (transcript instanceof TranscriptContainer) transcript.beginReplay();
	}

	beginHistoryFlush(): void {
		this.#historyFlush = true;
		if (!this.#offeredHistory) this.#historyReplay = false;
		for (const root of this.ui.children) {
			if (root instanceof TranscriptContainer) root.cancelReplay();
		}
	}

	#offerHistory(transcript: TranscriptContainer, width: number, capacity: number): HistoryBatch | undefined {
		const offered = this.#offeredHistory;
		if (offered) {
			// An unwritten old-width offer is withdrawn, never mutated under the
			// same identity. Reflow its semantic content before the writer clips rows.
			const batch = offered.transcriptId === undefined ? undefined : offered.transcript.rerenderOfferedBatch(width);
			const header = offered.header ? this.#historyHeader(width) : [];
			const rows = [...header, ...(batch?.rows ?? [])];
			offered.transcriptId = batch?.id;
			if (
				offered.width === width &&
				rows.length === offered.batch.rows.length &&
				isRowPrefix(rows, offered.batch.rows)
			) {
				return offered.batch;
			}
			offered.width = width;
			offered.batch = { id: this.#nextHistoryId++, kind: offered.batch.kind, rows };
			return offered.batch;
		}
		if (this.#historyReplay) {
			this.#historyReplay = false;
			const replay = transcript.peekReplayBatch(width);
			const batch: HistoryBatch = {
				id: this.#nextHistoryId++,
				kind: "replay",
				rows: [...this.#historyHeader(width), ...(replay?.rows ?? [])],
			};
			this.#offeredHistory = { batch, width, transcript, transcriptId: replay?.id, header: true };
			return batch;
		}
		let header = false;
		if (!this.#headerRetired) {
			const headerRows = this.#historyHeader(width);
			if (!this.#historyFlush && headerRows.length + transcript.liveRowCount(width) <= capacity) return undefined;
			header = true;
		}
		const retired = this.#historyFlush
			? transcript.peekFlushBatch(width)
			: transcript.peekFinalizedBatch(width, capacity);
		if (!header && !retired) return undefined;
		const batch: HistoryBatch = {
			id: this.#nextHistoryId++,
			rows: [...(header ? this.#historyHeader(width) : []), ...(retired?.rows ?? [])],
			kind: "append",
		};
		this.#offeredHistory = { batch, width, transcript, transcriptId: retired?.id, header };
		return batch;
	}

	/**
	 * Header rows ending in exactly one blank separator row, identical live and
	 * retired: the welcome already closes with a spacer, and adding another at
	 * retirement doubled the gap above the first prompt in scrollback.
	 */
	#historyHeader(width: number): readonly string[] {
		const rows = this.#header.render(width);
		if (rows.length === 0) return rows;
		return /\S/.test(rows.at(-1)!) ? [...rows, ""] : rows;
	}

	/** Allocate before rendering: clipping an already-rendered editor can hide its cursor. */
	#renderComposerRoots(roots: readonly Component[], width: number, height: number): string[] {
		if (!roots.includes(this.#editorSlot)) {
			return this.#renderRoots(roots, width);
		}
		// Responsive chrome renders once, after its budget is known. Rendering an
		// image preview just to measure it would acquire graphics that a compact
		// second pass immediately releases again.
		const responsiveRoots = roots.filter(root => root !== this.#editorSlot && root.setMaxHeight !== undefined);
		// Responsive blocks are measured in their compact one-row form: that is the
		// shape they fall back to anyway, and it never transmits a full preview
		// image the outer budget would then discard.
		const rendered = roots.map(root => {
			if (root === this.#editorSlot) return [];
			if (root.setMaxHeight === undefined) return Array.from(root.render(width));
			root.setMaxHeight(1);
			return Array.from(root.render(width));
		});
		let chromeRows = rendered.reduce((sum, rows) => sum + rows.length, 0);
		// Decoration is expendable before input. Keep the usual card on roomy
		// terminals, but recover its padding/hairline on short panes.
		for (const decoration of [
			this.#bottomMargin,
			this.#padAboveEditor,
			this.#padBelowEditor,
			this.#composerHairline,
		]) {
			if (chromeRows + responsiveRoots.length + Math.min(3, height) <= height) break;
			const index = roots.indexOf(decoration);
			if (index < 0) continue;
			chromeRows -= rendered[index]!.length;
			rendered[index] = [];
		}
		// A replacement dialog is modal: reserve enough rows for its identity and
		// choices before transcript and status chrome keep theirs.
		const slotChildren = this.#editorSlot.children;
		const replacement = !slotChildren.includes(this.editor);
		const minimumEditorRows = Math.min(
			height,
			replacement ? 3 : slotChildren.includes(this.editor) && this.editor.isAutocompleteActive() ? 2 : 1,
		);
		// Rows are budgeted in two passes. The first walks upwards from the
		// editor so the newest affordances — the interrupt hint, the status
		// footer, the busy row — each keep one row before any older block above
		// them (a queued steering list, a transcript tail) takes a second row.
		// The second pass then tops blocks up in reading order.
		const budgeted = roots.map(() => 0);
		let remaining = Math.max(0, height - minimumEditorRows);
		const allocatable = roots
			.map((root, index) => ({ root, index }))
			.filter(entry => entry.root !== this.#editorSlot);
		for (const { index } of [...allocatable].reverse()) {
			if (remaining === 0) break;
			// Blank padding and blocks with nothing to say never outrank content.
			if (!rendered[index]!.some(row => /\S/.test(row))) continue;
			budgeted[index] = 1;
			remaining--;
		}
		for (const { root, index } of allocatable) {
			if (remaining === 0) break;
			// A responsive block reports no natural height until it renders, so it
			// receives the rest of the budget at its own position and clamps itself.
			const desired =
				root.setMaxHeight === undefined
					? rendered[index]!.length
					: rendered[index]!.length === 0
						? 0
						: budgeted[index] + remaining;
			const extra = Math.min(remaining, Math.max(0, desired - budgeted[index]));
			budgeted[index] += extra;
			remaining -= extra;
		}
		for (const { root, index } of allocatable) {
			if (root.setMaxHeight === undefined) {
				rendered[index] = compressRows(rendered[index]!, budgeted[index]!);
			} else if (budgeted[index] !== 1) {
				root.setMaxHeight(budgeted[index]!);
				rendered[index] = budgeted[index]! > 0 ? Array.from(root.render(width)) : [];
			}
		}
		chromeRows = rendered.reduce((sum, rows) => sum + rows.length, 0);
		let slotRows = Math.max(1, height - chromeRows);
		const children = this.#editorSlot.children;
		// A guarded ask mounts the editable draft last; allocate it first so
		// clearing the draft remains possible even when only one row survives.
		const slotLines: string[][] = children.map(() => []);
		for (let index = children.length - 1; index >= 0 && slotRows > 0; index--) {
			const child = children[index]!;
			if (child instanceof Editor) child.setViewportHeight(slotRows);
			else child.setMaxHeight?.(slotRows);
			slotLines[index] = Array.from(child.render(width));
			slotRows = Math.max(0, slotRows - slotLines[index]!.length);
		}
		rendered[roots.indexOf(this.#editorSlot)] = slotLines.flat();
		return rendered.flat();
	}

	#renderRoots(roots: readonly Component[], width: number): string[] {
		const rows: string[] = [];
		for (const root of roots) for (const row of root.render(width)) rows.push(row);
		return rows;
	}
	get editor(): CustomEditor {
		return this.#editor;
	}

	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
	}

	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		this.#preferences = { ...this.#preferences, ...update };
		this.editor.setTheme(getEditorTheme());
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		if (this.#preferences.quiet) {
			this.#welcome = undefined;
		} else {
			this.#ensureWelcome();
			this.#welcome?.invalidate();
		}
		if (wasQuiet !== this.#preferences.quiet) this.#rebuildHeader();
		this.ui.requestRender();
	}

	updateWelcome(update: ComposerWelcomeUpdate): void {
		if (this.#stopped) return;
		this.#applyWelcomeUpdate(update);
		if (this.#preferences.quiet) return;
		this.#ensureWelcome();
		const welcome = this.#welcome;
		if (!welcome) return;
		if (update.version !== undefined) welcome.setVersion(this.#version);
		if (update.modelName !== undefined || update.providerName !== undefined) {
			welcome.setModel(this.#modelName, this.#providerName);
		}
		if (update.recentSessions !== undefined) welcome.setRecentSessions(this.#recentSessions);
		this.ui.requestRender();
	}

	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	setEditor(editor: CustomEditor): void {
		const previous = this.#editor;
		this.#editor = editor;
		if (previous !== editor) this.#editorSlot.disposeChildren();
		this.#editorSlot.clear();
		this.#editorSlot.addChild(editor);
	}

	get editorSlot(): Container {
		return this.#editorSlot;
	}

	setHairlineSuppressed(suppressed: boolean): void {
		this.#composerHairline.suppressed = suppressed;
	}

	setStatusComponent(component: Component): void {
		this.#statusHost.setComponent(component);
	}

	setRuntimeChildren(children: readonly Component[], below: readonly Component[] = []): void {
		if (this.#stopped) return;
		const chrome = [this.#composerHairline, this.#padAboveEditor, this.#editorSlot, this.#padBelowEditor];
		if (this.#runtimeMounted) {
			for (const child of this.#runtimeChildren) this.ui.removeChild(child);
			for (const child of chrome) this.ui.removeChild(child);
			for (const child of this.#belowChildren) this.ui.removeChild(child);
			this.ui.removeChild(this.#statusHost);
			this.ui.removeChild(this.#bottomMargin);
		} else {
			for (const child of chrome) this.ui.removeChild(child);
			this.ui.removeChild(this.#statusHost);
			this.ui.removeChild(this.#bottomMargin);
			this.#runtimeMounted = true;
		}
		this.#belowChildren = below;
		this.#runtimeChildren = children;
		for (const child of children) this.ui.addChild(child);
		for (const child of chrome) this.ui.addChild(child);
		this.ui.addChild(this.#statusHost);
		for (const child of below) this.ui.addChild(child);
		this.ui.addChild(this.#bottomMargin);
		this.ui.requestRender();
	}

	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.ui.stop();
		this.#stopped = true;
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
		if (update.modelName !== undefined) this.#modelName = update.modelName;
		if (update.providerName !== undefined) this.#providerName = update.providerName;
		if (update.recentSessions !== undefined) this.#recentSessions = [...update.recentSessions];
	}

	#ensureWelcome(): void {
		this.#welcome ??= new WelcomeComponent(this.#version, this.#modelName, this.#providerName, this.#recentSessions);
	}

	#rebuildHeader(): void {
		this.#header.clear();
		for (const component of this.#headerBefore) this.#header.addChild(component);
		if (this.#welcome) {
			this.#header.addChild(new Spacer(1));
			this.#header.addChild(this.#welcome);
			this.#header.addChild(new Spacer(1));
		}
		for (const component of this.#headerAfter) this.#header.addChild(component);
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		if (this.#stopped) return;
		if (this.#started) this.ui.stop();
		this.#stopped = true;
		this.#exit(code);
	}
}

interface ComposerShortcutContext {
	busy: boolean;
	focused: boolean;
}

interface ComposerShortcutChip {
	id: "interrupt";
	label: string;
}

export function buildComposerShortcuts(
	keybindings: KeybindingsManager,
	ctx: ComposerShortcutContext,
): readonly ComposerShortcutChip[] {
	const chips: ComposerShortcutChip[] = [];
	const key = (action: AppKeybinding): string =>
		keybindings
			.getDisplayString(action)
			.replace(/Ctrl\+/g, "^")
			.replace(/Alt\+/g, "M+");
	if (ctx.busy && !ctx.focused) chips.push({ id: "interrupt", label: `${key("app.interrupt")} interrupt` });
	return chips;
}

export class ComposerShortcutsBar implements Component {
	#provider: (() => readonly ComposerShortcutChip[]) | undefined;

	setShortcutsProvider(provider: () => readonly ComposerShortcutChip[]): void {
		this.#provider = provider;
	}

	render(width: number): string[] {
		const chips = this.#provider?.() ?? [];
		const inset = "  ";
		if (chips.length === 0) return [""];
		const budget = Math.max(0, width - inset.length);
		const parts: string[] = [];
		let col = 0;
		for (const chip of chips) {
			const sep = parts.length > 0 ? theme.fg("dim", " · ") : "";
			const sepWidth = parts.length > 0 ? visibleWidth(sep) : 0;
			const match = chip.label.match(/^(\S+)\s(.*)$/);
			const styled = `${theme.fg("dim", match?.[1] ?? chip.label)}${match ? theme.fg("muted", ` ${match[2]}`) : ""}`;
			const labelWidth = visibleWidth(chip.label);
			if (col + sepWidth + labelWidth > budget) continue;
			parts.push(sep + styled);
			col += sepWidth + labelWidth;
		}
		if (parts.length === 0) return [""];
		return [inset + parts.join("")];
	}

	invalidate(): void {}
}
