import {
	type Component,
	Container,
	ProcessTerminal,
	type ResizeScrollbackMode,
	Spacer,
	type Terminal,
	TUI,
	type TUIOptions,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../config/keybindings";
import { CustomEditor } from "./components/custom-editor";
import { type LspServerInfo, type RecentSession, WelcomeComponent } from "./components/welcome";
import { getEditorTheme, initThemeSync, theme } from "./theme/theme";

export const COMPOSER_PLACEHOLDER = "ask anything · / for commands";

const DOUBLE_INTERRUPT_MS = 500;

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly scrollbackRebuild: boolean;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: boolean;
	readonly spellingAutocorrect: boolean;
}

/** Settings-schema-compatible defaults used when constructing a dependency-free composer. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	showHardwareCursor: true,
	maxInlineImages: 8,
	scrollbackRebuild: false,
	resizeScrollback: "append",
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: true,
	spellingAutocorrect: false,
};

/** Welcome data that can be supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
	readonly modelName?: string;
	readonly providerName?: string;
	readonly recentSessions?: readonly RecentSession[];
	readonly lspServers?: readonly LspServerInfo[];
}

/** Optional dependencies and initial state for a standalone composer. */
interface ComposerOptions {
	readonly terminal?: Terminal;
	/** Extra TUI construction options (render scheduler injection for tests and `proto render`). */
	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

/** Controls the first terminal paint for a composer that does not already own the terminal. */
interface ComposerStartOptions {
	readonly clearScrollback?: boolean;
	/**
	 * Paint without owning stdin: the tty keeps cooked-mode echo/editing so
	 * typing stays visible while startup module loading blocks the event loop.
	 * {@link Composer.enableInput} later switches to raw input and replays the
	 * kernel-buffered keystrokes into the editor.
	 */
	readonly deferInput?: boolean;
}

/** Mount slot for the session-aware status component below the editor. */
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
/**
 * Canonical interactive composer, usable before session/settings exist and updatable in place.
 * It owns the terminal, welcome header, and editor; InteractiveMode later supplies authoritative
 * data and mounts the session-aware runtime children without replacing the visible header.
 */
export class Composer {
	/** Terminal renderer shared with InteractiveMode after adoption. */
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	readonly #editorSlot = new Container();
	readonly #statusHost = new StatusHost();
	readonly #topFill = new Spacer(0);
	readonly #bottomFill = new Spacer(0);
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
	#lspServers: LspServerInfo[] = [];
	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#belowChildren: readonly Component[] = [];
	#runtimeMounted = false;
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
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setScrollbackRebuild(this.#preferences.scrollbackRebuild);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);

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
		// Emergency controls stay active until InteractiveMode installs configured bindings.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestDirectWrite(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.ui.addChild(this.#topFill);
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#bottomFill);
		this.ui.addChild(this.#composerHairline);
		this.ui.addChild(this.#padAboveEditor);
		this.ui.addChild(this.#editorSlot);
		this.ui.addChild(this.#padBelowEditor);
		this.ui.addChild(this.#statusHost);
		this.ui.addChild(this.#bottomMargin);
		this.ui.setFocus(this.editor);
	}

	/** Live editor whose draft survives startup and session adoption. */
	get editor(): CustomEditor {
		return this.#editor;
	}

	/** The welcome component currently mounted in the header, if quiet mode is off. */
	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	/** Whether this composer already owns the terminal render/input loop. */
	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Start terminal ownership. */
	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
	}
	/** Take raw-input ownership after a deferred-input start. Idempotent. */
	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	/** Apply settings changes without replacing the editor or welcome component. */
	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		this.#preferences = { ...this.#preferences, ...update };
		this.editor.setTheme(getEditorTheme());
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setScrollbackRebuild(this.#preferences.scrollbackRebuild);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);
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

	/** Patch welcome data in place as model, session, and project discovery complete. */
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
		if (update.lspServers !== undefined) welcome.setLspServers(this.#lspServers);
		this.ui.requestRender();
	}

	/** Replace optional header content around the stable welcome scene. */
	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Update the canonical editor reference after InteractiveMode remounts a custom editor. */
	setEditor(editor: CustomEditor): void {
		this.#editor = editor;
		this.#editorSlot.clear();
		this.#editorSlot.addChild(editor);
	}

	get editorSlot(): Container {
		return this.#editorSlot;
	}

	setHairlineSuppressed(suppressed: boolean): void {
		this.#composerHairline.suppressed = suppressed;
	}

	/** Mount the session-aware status component into the slot below the editor. */
	setStatusComponent(component: Component): void {
		this.#statusHost.setComponent(component);
	}

	/** Mount or replace session-aware root children while preserving the header and status hosts. */
	setRuntimeChildren(children: readonly Component[], below: readonly Component[] = []): void {
		if (this.#stopped) return;
		const chrome = [
			this.#bottomFill,
			this.#composerHairline,
			this.#padAboveEditor,
			this.#editorSlot,
			this.#padBelowEditor,
		];
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

	/** Transfer terminal ownership to InteractiveMode without stopping the composer. */
	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	syncHomeAnchor(conversationChildCount: number): void {
		if (this.#stopped) return;
		const width = this.ui.terminal.columns;
		const rows = this.ui.terminal.rows;
		if (!Number.isFinite(rows) || rows <= 0) return;
		const currentTop = this.#topFill.render(width).length;
		const currentBottom = this.#bottomFill.render(width).length;
		let content = 0;
		for (const child of this.ui.children) {
			if (child === this.#topFill || child === this.#bottomFill) continue;
			try {
				content += child.render(width).length;
			} catch {
				content += 1;
			}
		}
		const slack = Math.max(0, rows - content);
		// Conversation content always pins to the bottom edge (all slack goes
		// above the header) so the transcript tail, HUD rows, and working loader
		// sit flush against the composer. The welcome-screen 40/60 split only
		// applies to the empty state; the banner scrolls off naturally once the
		// conversation overflows.
		const top = conversationChildCount > 0 ? slack : this.#welcome !== undefined ? Math.floor((slack * 2) / 5) : 0;
		if (top !== currentTop) this.#topFill.setLines(top);
		if (slack - top !== currentBottom) this.#bottomFill.setLines(slack - top);
	}

	/** Stop a composer that has not transferred terminal ownership. */
	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#stopped = true;
		this.ui.stop();
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
		if (update.modelName !== undefined) this.#modelName = update.modelName;
		if (update.providerName !== undefined) this.#providerName = update.providerName;
		if (update.recentSessions !== undefined) this.#recentSessions = [...update.recentSessions];
		if (update.lspServers !== undefined) this.#lspServers = [...update.lspServers];
	}

	#ensureWelcome(): void {
		this.#welcome ??= new WelcomeComponent(
			this.#version,
			this.#modelName,
			this.#providerName,
			this.#recentSessions,
			this.#lspServers,
		);
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
		// Remains live after transfer until InteractiveMode installs its configured handlers.
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#started) this.ui.stop();
		this.#exit(code);
	}
}

interface ComposerShortcutContext {
	busy: boolean;
	hasQueue: boolean;
	focused: boolean;
}

interface ComposerShortcutChip {
	id: "interrupt" | "dequeue";
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
	if (ctx.hasQueue && !ctx.focused) chips.push({ id: "dequeue", label: `${key("app.message.dequeue")} dequeue` });
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
