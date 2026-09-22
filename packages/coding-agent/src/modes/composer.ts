import {
	type Component,
	Container,
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
	#retirementChromeFloor: number | undefined;
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
			return {
				viewport: height > 0 ? this.#renderRoots(roots, width).slice(-height) : [],
				viewportAnchor: "bottom",
			};
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const before = this.#renderRoots(
			roots.slice(0, transcriptIndex).filter(root => root !== this.#header),
			width,
		);
		const after = this.#renderRoots(roots.slice(transcriptIndex + 1), width);
		// Expanded drafts/dialogs may temporarily hide transcript rows, but must
		// not retire them irreversibly. Bill retirement against persistent chrome.
		this.#retirementChromeFloor = Math.min(this.#retirementChromeFloor ?? after.length, after.length);
		const capacity = Math.max(0, height - before.length - this.#retirementChromeFloor);
		const history = this.#offerHistory(transcript, width, capacity);
		const header = this.#headerRetired || this.#offeredHistory?.header ? [] : this.#header.render(width);
		const now = performance.now();
		const live = transcript.renderViewport(width, Math.max(0, capacity - header.length), {
			now,
			tick: Math.floor(now / 80),
		});
		const rows = [...header, ...before, ...live, ...after];
		return { history, viewport: height > 0 ? rows.slice(-height) : [], viewportAnchor: "bottom" };
	}

	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (!offered || offered.batch.id !== id) return;
		if (offered.transcriptId !== undefined) offered.transcript.acknowledgeFinalizedBatch(offered.transcriptId);
		if (offered.header) this.#headerRetired = true;
		this.#offeredHistory = undefined;
	}

	/** The alternate resize preview is semantic only: it cannot retire history. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		const width = Math.max(1, viewport.columns);
		const height = Math.max(0, viewport.rows);
		if (height === 0) return [];
		const roots = this.ui.children;
		const index = roots.findIndex(root => root instanceof TranscriptContainer);
		if (index < 0) return this.#renderRoots(roots, width).slice(-height);
		const after = this.#renderRoots(roots.slice(index + 1), width);
		const transcript = roots[index] as TranscriptContainer;
		const tail = transcript.renderTail(width, Math.max(0, height - after.length));
		const prefix = tail.length + after.length < height ? this.#renderRoots(roots.slice(0, index), width) : [];
		return [...prefix, ...tail, ...after].slice(-height);
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

	#historyHeader(width: number): readonly string[] {
		const rows = this.#header.render(width);
		return rows.length > 0 ? [...rows, ""] : [];
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
