import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	findLeadingSlashCommandStart,
	findTrailingSlashCommandStart,
	midPromptSkillTokenMatches,
	SKILL_NAMESPACE,
} from "../autocomplete";
import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { canonicalKeyId, getKeybindings, type KeybindingsManager } from "../keybindings";
import { extractPrintableText, matchesKey, parseKey } from "../keys";
import { KillRing } from "../kill-ring";
import type { SymbolTheme } from "../symbols";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	getSegmenter,
	getWidthConfigEpoch,
	getWordNavKind,
	graphemeStartAt,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "../utils";
import { type SelectItem, SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list";

const DEFAULT_PROMPT_GUTTER = "❯ ";
const DEFAULT_HINT_STYLE = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const SELECTION_SGR_OPEN = "\x1b[7m";
const SELECTION_SGR_CLOSE = "\x1b[27m";
// Inner decorations may end with a full SGR reset, which would also clear the
// selection's reverse video; re-assert it after every reset.
const SGR_RESET_PATTERN = /\x1b\[0m|\x1b\[m/g;
const EMPTY_DECORATION_CONTEXT: EditorTextDecorationContext = { line: 0, startCol: 0, endCol: 0 };

const AUTOCOMPLETE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	overflowSearch: false,
};

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	wrapDescription: true,
	maxDescriptionRows: 2,
	overflowSearch: false,
};

function sanitizeLoadedText(text: string): string {
	return replaceTabs(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x09\x0b-\x1f\x7f\x80-\x9f]/g, "");
}

const segmenter = getSegmenter();
const printableBindingCache = new WeakMap<KeybindingsManager, { revision: number; hasPrintable: boolean }>();

function isPrintableBindingId(key: string): boolean {
	if (key.length === 1) return true;
	if (key === "space" || key === "shift+space") return true;
	// Modified printables (e.g. "shift+z") still arrive as one raw printable
	// character on legacy terminals.
	return /^shift\+.$/.test(key);
}

function hasPrintableSingleCharBinding(keybindings: KeybindingsManager): boolean {
	const cached = printableBindingCache.get(keybindings);
	if (cached && cached.revision === keybindings.revision) return cached.hasPrintable;

	let hasPrintable = false;
	const resolved = keybindings.getResolvedBindings();
	for (const keys of Object.values(resolved)) {
		const candidates = typeof keys === "string" ? [keys] : (keys ?? []);
		if (candidates.some(isPrintableBindingId)) {
			hasPrintable = true;
			break;
		}
	}
	printableBindingCache.set(keybindings, { revision: keybindings.revision, hasPrintable });
	return hasPrintable;
}

interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
	width: number;
}

function wordWrapLine(line: string, maxWidth: number, knownLineWidth?: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0, width: 0 }];
	}

	const lineWidth = knownLineWidth ?? visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length, width: lineWidth }];
	}

	const gStart: number[] = [];
	const gWidth: number[] = [];
	interface Token {
		startG: number;
		endG: number;
		startIndex: number;
		endIndex: number;
		isWhitespace: boolean;
	}
	const tokens: Token[] = [];
	let inWhitespace = false;
	let tokenStartG = 0;
	let tokenStartIndex = 0;
	let gCount = 0;
	for (const seg of segmenter.segment(line)) {
		const graphemeIsWhitespace = getWordNavKind(seg.segment) === "whitespace";
		if (gCount === 0) {
			inWhitespace = graphemeIsWhitespace;
		} else if (graphemeIsWhitespace !== inWhitespace) {
			tokens.push({
				startG: tokenStartG,
				endG: gCount,
				startIndex: tokenStartIndex,
				endIndex: seg.index,
				isWhitespace: inWhitespace,
			});
			tokenStartG = gCount;
			tokenStartIndex = seg.index;
			inWhitespace = graphemeIsWhitespace;
		}
		gStart.push(seg.index);
		gWidth.push(-1);
		gCount++;
	}
	gStart.push(line.length);
	if (gCount > tokenStartG) {
		tokens.push({
			startG: tokenStartG,
			endG: gCount,
			startIndex: tokenStartIndex,
			endIndex: line.length,
			isWhitespace: inWhitespace,
		});
	}

	const graphemeWidth = (g: number): number => {
		let w = gWidth[g] ?? -1;
		if (w < 0) {
			w = visibleWidth(line.slice(gStart[g] ?? 0, gStart[g + 1] ?? line.length));
			gWidth[g] = w;
		}
		return w;
	};

	const chunks: TextChunk[] = [];
	const pushChunk = (text: string, startIndex: number, endIndex: number): void => {
		chunks.push({ text, startIndex, endIndex, width: visibleWidth(text) });
	};

	const consumePrefixToWidth = (
		startG: number,
		endG: number,
		availableWidth: number,
	): { endG: number; len: number } => {
		let prefixWidth = 0;
		let g = startG;
		while (g < endG) {
			const w = graphemeWidth(g);
			if (prefixWidth + w > availableWidth) break;
			prefixWidth += w;
			g++;
			if (prefixWidth === availableWidth) break;
		}
		return { endG: g, len: (gStart[g] ?? 0) - (gStart[startG] ?? 0) };
	};
	const hasWideGrapheme = (startG: number, endG: number): boolean => {
		for (let g = startG; g < endG; g++) {
			if (graphemeWidth(g) > 1) return true;
		}
		return false;
	};

	let chunkStart = 0;
	let chunkEnd = 0;
	let currentWidth = 0;
	let atLineStart = true;
	const indentationEnd = tokens[0]?.isWhitespace ? tokens[0].endIndex : 0;

	for (const token of tokens) {
		const tokenWidth = visibleWidth(line.slice(token.startIndex, token.endIndex));

		if (atLineStart && token.isWhitespace && chunks.length > 0) {
			const prev = chunks[chunks.length - 1];
			if (prev) prev.endIndex = token.endIndex;
			chunkStart = token.endIndex;
			chunkEnd = token.endIndex;
			continue;
		}
		atLineStart = false;

		if (tokenWidth > maxWidth) {
			let consumedPrefixLen = 0;
			let consumedPrefixEndG = token.startG;
			if (chunkEnd > chunkStart && currentWidth < maxWidth) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.startG, token.endG, remainingWidth);
				consumedPrefixEndG = consumed.endG;
				consumedPrefixLen = consumed.len;
			}

			if (chunkEnd > chunkStart) {
				if (consumedPrefixLen > 0) {
					const endIndex = token.startIndex + consumedPrefixLen;
					pushChunk(line.slice(chunkStart, endIndex), chunkStart, endIndex);
					chunkStart = endIndex;
					chunkEnd = endIndex;
				} else {
					pushChunk(line.slice(chunkStart, chunkEnd), chunkStart, token.startIndex);
					chunkStart = token.startIndex;
					chunkEnd = token.startIndex;
				}
				currentWidth = 0;
			}

			let tcStart = token.startIndex + consumedPrefixLen;
			let tcEnd = tcStart;
			let tcWidth = 0;
			for (let g = consumedPrefixEndG; g < token.endG; g++) {
				const w = graphemeWidth(g);
				const gEnd = gStart[g + 1] ?? line.length;
				if (tcWidth + w > maxWidth && tcEnd > tcStart) {
					pushChunk(line.slice(tcStart, tcEnd), tcStart, tcEnd);
					tcStart = tcEnd;
					tcWidth = w;
				} else {
					tcWidth += w;
				}
				tcEnd = gEnd;
			}

			if (tcEnd > tcStart) {
				chunkStart = tcStart;
				chunkEnd = tcEnd;
				currentWidth = tcWidth;
			}
			continue;
		}

		if (currentWidth + tokenWidth > maxWidth) {
			if (
				chunkEnd > chunkStart &&
				!token.isWhitespace &&
				currentWidth < maxWidth &&
				hasWideGrapheme(token.startG, token.endG)
			) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.startG, token.endG, remainingWidth);
				if (consumed.len > 0) {
					const endIndex = token.startIndex + consumed.len;
					pushChunk(line.slice(chunkStart, endIndex), chunkStart, endIndex);
					const remainder = line.slice(endIndex, token.endIndex);
					chunkStart = endIndex;
					chunkEnd = token.endIndex;
					currentWidth = visibleWidth(remainder);
					atLineStart = false;
					continue;
				}
			}

			const chunkText = line.slice(chunkStart, chunkEnd);
			const trimmedChunk = chunkEnd <= indentationEnd ? chunkText : chunkText.trimEnd();
			if (trimmedChunk || chunks.length === 0) {
				pushChunk(trimmedChunk, chunkStart, chunkEnd);
			} else {
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = chunkEnd;
			}

			atLineStart = true;
			if (token.isWhitespace) {
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = token.endIndex;
				chunkStart = token.endIndex;
				chunkEnd = token.endIndex;
				currentWidth = 0;
			} else {
				chunkStart = token.startIndex;
				chunkEnd = token.endIndex;
				currentWidth = tokenWidth;
				atLineStart = false;
			}
		} else {
			if (chunkEnd === chunkStart) chunkStart = token.startIndex;
			chunkEnd = token.endIndex;
			currentWidth += tokenWidth;
		}
	}

	if (chunkEnd > chunkStart) {
		pushChunk(line.slice(chunkStart, chunkEnd), chunkStart, line.length);
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0, width: 0 }];
}

function visualColAtOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	let col = 0;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= offset) break;
		col += visibleWidth(seg.segment);
	}
	return col;
}

function offsetAtVisualCol(text: string, col: number): number {
	if (col <= 0) return 0;
	let current = 0;
	for (const seg of segmenter.segment(text)) {
		const width = visibleWidth(seg.segment);
		if (current + width > col) return seg.index;
		current += width;
	}
	return text.length;
}

function maxSegmentVisualCol(text: string, isLastSegment: boolean): number {
	let total = 0;
	let lastWidth = 0;
	for (const seg of segmenter.segment(text)) {
		lastWidth = visibleWidth(seg.segment);
		total += lastWidth;
	}
	return isLastSegment ? total : Math.max(0, total - lastWidth);
}

function isPlainTextRun(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
	}
	return true;
}

const DEFAULT_PAGE_SCROLL_LINES = 10;

const MAX_UNDO_STACK = 100;

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface SelectionRange {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
}

interface LayoutLine {
	text: string;

	width: number;
	sourceLine: number;
	sourceStartCol: number;
	hasCursor: boolean;
	cursorPos?: number;
}

interface WrapEntry {
	width: number;
	chunks: TextChunk[] | null;
}

interface LayoutCacheEntry {
	line: string;
	width: number;
	epoch: number;
	wrapped: boolean;
	layouts: LayoutLine[];
}

interface PlainRenderCacheEntry {
	width: number;
	gutter: string;
	output: string;
}

interface PromptGutter {
	firstLine: string;
	continuation: string;
	width: number;
}

interface PromptGutterCacheEntry {
	width: number;
	gutter: string;
	continuation: string | undefined;
	value: PromptGutter | undefined;
}

export interface EditorTopBorder {
	content: string;

	width: number;

	revision?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;

	accentColor?: (str: string) => string;

	surfaceColor?: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
	editorPaddingX?: number;

	hintStyle?: (text: string) => string;
}

interface HistoryEntry {
	prompt: string;
}

interface HistoryStorage {
	add(prompt: string, cwd?: string): Promise<void>;
	getRecent(limit: number): HistoryEntry[];
}

export interface EditorInlineReplacement {
	replaceLen: number;

	insert: string;
}

export interface EditorWordReplacements {
	line: number;
	startCol: number;
	endCol: number;
	items: readonly string[];
}

export interface EditorTextDecorationContext {
	line: number;
	startCol: number;
	endCol: number;
}

export interface EditorTextAssistProvider {
	getWordCompletion?(lines: string[], cursorLine: number, cursorCol: number): string | null;

	tryAutocorrect?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): EditorInlineReplacement | null | Promise<EditorInlineReplacement | null>;

	getWordReplacements?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): EditorWordReplacements | null | Promise<EditorWordReplacements | null>;
}

type HistoryCursorAnchor = "start" | "end";
type AutocompleteRequest = { kind: "regular"; explicitTab: boolean } | { kind: "force" };

export class Editor implements Component, Focusable {
	#state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};
	#linesRevision = 0;
	#joinedTextRevision = -1;
	#joinedText = "";

	#focused = false;

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		if (this.#focused === value) return;
		this.#focused = value;
		// Losing focus must not leave an in-flight provider request running or
		// a stale suggestion menu open over the newly focused component.
		if (!value) this.#cancelAutocomplete();
	}

	#theme: EditorTheme;
	#useTerminalCursor = false;

	cursorOverride: string | undefined;

	cursorOverrideWidth: number | undefined;

	decorateText: ((text: string, context: EditorTextDecorationContext) => string) | undefined;
	#promptGutter: string | undefined;
	#promptGutterContinuation: string | undefined;
	#promptGutterCache: PromptGutterCacheEntry | undefined;
	#placeholder: string | undefined;

	#lastLayoutWidth: number = 80;

	#wrapCache = new Map<string, WrapEntry>();
	#wrapCacheWidth = -1;
	#wrapCacheEpoch = -1;
	#layoutCache: Array<LayoutCacheEntry | undefined> = [];
	#layoutScratch: LayoutLine[] = [];
	#plainRenderCache = new WeakMap<LayoutLine, PlainRenderCacheEntry>();
	#maxHeight?: number;
	#viewportHeight?: number;
	#scrollOffset: number = 0;

	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	#jumpMode: "forward" | "backward" | null = null;

	#preferredVisualCol: number | null = null;

	#selectionAnchor: { line: number; col: number } | null = null;

	/** Selection range resolved for the render in progress; only valid inside render(). */
	#renderSelection: SelectionRange | null = null;

	borderColor: (str: string) => string;

	#autocompleteProvider?: AutocompleteProvider;
	#textAssistProvider?: EditorTextAssistProvider;
	#textAssistProviderRevision = 0;
	#autocompleteList?: SelectList;
	#autocompleteState: "regular" | "force" | "assist" | null = null;
	#textAssistReplacement:
		| { line: number; startCol: number; endCol: number; original: string; cursorOffset: number }
		| undefined;
	#autocompletePrefix: string = "";
	// True once the user moved the highlight (Up/Down/PageUp/PageDown) in the
	// current suggestion list; a description-only ("weak") match may only be
	// accepted by Enter after such an explicit choice.
	#autocompleteNavigated = false;
	#autocompleteRequestId: number = 0;
	#autocompletePendingRequest: AutocompleteRequest | undefined;
	#autocompleteRequestRunning = false;
	#autocompleteAbortController: AbortController | undefined;
	#autocompleteWaiters: Array<() => void> = [];
	#autocompleteMaxVisible: number = 10;
	onAutocompleteUpdate?: () => void;

	onTextAssistApplied?: () => void;

	viewportRowsProvider?: () => number;

	#pastes: Map<number, string> = new Map();
	#pasteCounter: number = 0;

	#atoms: Map<string, string> = new Map();

	atomicTokenPattern: RegExp | undefined;
	#atomicTokenSource: string | undefined;
	#atomicTokenRe: RegExp | undefined;

	#pasteHandler = new BracketedPasteHandler();

	#history: string[] = [];
	#historyIndex: number = -1;
	#historyStorage?: HistoryStorage;

	#undoStack: EditorState[] = [];
	#suspendUndo = false;

	#autocompleteTimeout?: NodeJS.Timeout;

	onSubmit?: (text: string) => void | Promise<void>;
	onAltEnter?: (text: string) => void;
	onChange?: (text: string) => void;

	/** Invoked when the copy key is pressed with an active selection. */
	onCopySelection?: (text: string) => void;

	onLargePaste?: (text: string, lineCount: number) => boolean;
	onAutocompleteCancel?: () => void;
	disableSubmit: boolean = false;

	constructor(theme: EditorTheme) {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
	}

	dispose(): void {
		this.#cancelAutocomplete();
		this.#autocompleteAbortController = undefined;
		this.#autocompleteProvider = undefined;
		this.#textAssistProviderRevision++;
		this.#textAssistProvider = undefined;
		this.#autocompleteList = undefined;
		this.#historyStorage = undefined;
		this.#pasteHandler.clear();
		this.#pastes.clear();
		this.#atoms.clear();
		this.#history = [];
		this.#undoStack.length = 0;
		this.#wrapCache.clear();
		this.#layoutCache = [];
		this.#layoutScratch = [];
		this.#plainRenderCache = new WeakMap();
		this.#state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.#selectionAnchor = null;
		this.#renderSelection = null;
		this.#linesRevision = 0;
		this.#joinedTextRevision = -1;
		this.#joinedText = "";
		this.#promptGutterCache = undefined;
		this.onAutocompleteUpdate = undefined;
		this.onAutocompleteCancel = undefined;
		this.onTextAssistApplied = undefined;
		this.onSubmit = undefined;
		this.onAltEnter = undefined;
		this.onChange = undefined;
		this.onLargePaste = undefined;
		this.viewportRowsProvider = undefined;
	}

	setTheme(theme: EditorTheme): void {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		if (this.#autocompleteProvider === provider) return;
		this.#autocompleteProvider = provider;
		// A published list belongs to the old provider just as much as an
		// in-flight request does. Clear both synchronously before the next Tab.
		this.#cancelAutocomplete();
	}

	setTextAssistProvider(provider: EditorTextAssistProvider | undefined): void {
		this.#textAssistProviderRevision++;
		this.#textAssistProvider = provider;
		// Assist suggestions are produced by this provider; never leave them
		// selectable after swapping to a different one.
		if (this.#autocompleteState === "assist") {
			this.#cancelAutocomplete();
		}
	}

	setBorderVisible(_borderVisible: boolean): void {}

	setPromptGutter(promptGutter: string | undefined): void {
		this.#promptGutter = promptGutter;
	}

	setPromptGutterContinuation(text: string | undefined): void {
		this.#promptGutterContinuation = text;
	}

	setPlaceholder(placeholder: string | undefined): void {
		this.#placeholder = placeholder;
	}

	isAutocompleteActive(): boolean {
		return this.#autocompleteState !== null;
	}

	getTopBorderAvailableWidth(terminalWidth: number): number {
		return Math.max(0, terminalWidth);
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		if (this.#useTerminalCursor === useTerminalCursor) return;
		this.#useTerminalCursor = useTerminalCursor;
	}

	setImeSafeCursorLayout(_enabled: boolean): void {}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	setMaxHeight(maxHeight: number | undefined): void {
		if (this.#maxHeight === maxHeight) return;
		this.#maxHeight = maxHeight;
	}

	/** Total rows allocated by the host, including completion suggestions. */
	setViewportHeight(height: number | undefined): void {
		this.#viewportHeight = height === undefined ? undefined : Math.max(1, Math.floor(height));
	}

	setScrollbarVisible(_visible: boolean): void {}

	getAutocompleteMaxVisible(): number {
		return this.#autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 10;
		if (this.#autocompleteMaxVisible !== newMaxVisible) {
			this.#autocompleteMaxVisible = newMaxVisible;
			if (this.#autocompleteState !== null) {
				this.#autocompleteList?.setMaxVisible(newMaxVisible);
			}
		}
	}

	setHistoryStorage(storage: HistoryStorage): void {
		this.#historyStorage = storage;
		const recent = storage.getRecent(100);
		this.#history = recent.map(entry => entry.prompt);
		this.#historyIndex = -1;
	}

	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;

		const stor = this.#historyStorage;
		if (stor) {
			stor.add(trimmed, getProjectDir()).catch(error => {
				logger.error("HistoryStorage add failed", { error: String(error) });
			});
		}

		if (this.#history.length > 0 && this.#history[0] === trimmed) return;
		this.#history.unshift(trimmed);

		if (this.#history.length > 100) {
			this.#history.pop();
		}
	}

	#setLines(lines: string[]): void {
		this.#state.lines = lines.slice();
		this.#linesRevision++;
	}

	#setLine(index: number, line: string): void {
		if (this.#state.lines[index] === line) return;
		this.#state.lines[index] = line;
		this.#linesRevision++;
	}

	#spliceLines(start: number, deleteCount: number, ...items: string[]): void {
		if (deleteCount === 0 && items.length === 0) return;
		this.#state.lines.splice(start, deleteCount, ...items);
		this.#linesRevision++;
	}

	#isEditorEmpty(): boolean {
		return this.#state.lines.length === 1 && this.#state.lines[0] === "";
	}

	#isOnFirstVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	#isOnLastVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	#navigateHistory(direction: 1 | -1): void {
		this.#resetKillSequence();
		if (this.#history.length === 0) return;
		const newIndex = this.#historyIndex - direction;
		if (newIndex < -1 || newIndex >= this.#history.length) return;
		this.#historyIndex = newIndex;
		if (this.#historyIndex === -1) {
			this.#setTextInternal("", "end");
		} else {
			const cursorAnchor: HistoryCursorAnchor = direction === -1 ? "start" : "end";
			this.#setTextInternal(this.#history[this.#historyIndex] || "", cursorAnchor);
		}
	}

	#setTextInternal(text: string, cursorAnchor: HistoryCursorAnchor = "end"): void {
		this.#selectionAnchor = null;
		this.#undoStack.length = 0;
		this.#volatileTextLen = 0;
		const lines = sanitizeLoadedText(text).split("\n");
		this.#setLines(lines.length === 0 ? [""] : lines);
		if (cursorAnchor === "start") {
			this.#state.cursorLine = 0;
			this.#setCursorCol(0);
		} else {
			this.#state.cursorLine = this.#state.lines.length - 1;
			this.#setCursorCol(this.#state.lines[this.#state.cursorLine]?.length || 0);
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {}

	#getPromptGutterWidth(width: number): number {
		const gutter = this.#promptGutter ?? DEFAULT_PROMPT_GUTTER;
		if (!gutter) return 0;
		return Math.min(visibleWidth(gutter), width);
	}

	#getPromptGutter(width: number): PromptGutter | undefined {
		const gutter = this.#promptGutter ?? DEFAULT_PROMPT_GUTTER;
		const continuation = this.#promptGutterContinuation;
		const cached = this.#promptGutterCache;
		if (cached && cached.width === width && cached.gutter === gutter && cached.continuation === continuation) {
			return cached.value;
		}

		let value: PromptGutter | undefined;
		if (gutter) {
			const gutterWidth = this.#getPromptGutterWidth(width);
			if (gutterWidth > 0) {
				value = {
					firstLine: sliceByColumn(gutter, 0, gutterWidth, true),
					continuation: this.#getContinuationGutter(gutterWidth),
					width: gutterWidth,
				};
			}
		}
		this.#promptGutterCache = { width, gutter, continuation, value };
		return value;
	}

	#getContinuationGutter(gutterWidth: number): string {
		if (this.#promptGutterContinuation === undefined) return padding(gutterWidth);
		const sliced = sliceByColumn(this.#promptGutterContinuation, 0, gutterWidth, true);
		return sliced + padding(Math.max(0, gutterWidth - visibleWidth(sliced)));
	}

	#getVisibleContentHeight(contentLines: number): number {
		const preferred = Math.max(1, this.#maxHeight ?? contentLines);
		if (this.#viewportHeight === undefined) return preferred;
		const suggestionRows = this.#autocompleteState && this.#autocompleteList && this.#viewportHeight > 1 ? 1 : 0;
		return Math.min(preferred, this.#viewportHeight - suggestionRows);
	}

	#decorate(text: string, context: EditorTextDecorationContext): string {
		const decorate = this.decorateText;
		if ((decorate === undefined && this.#renderSelection === null) || text.length === 0) return text;
		const idx = text.indexOf(CURSOR_MARKER);
		const sourceLength = Math.max(0, context.endCol - context.startCol);
		if (idx === -1) {
			const decoratedLength = Math.min(text.length, sourceLength);
			return (
				this.#decorateSlice(text.slice(0, decoratedLength), context.startCol, context) + text.slice(decoratedLength)
			);
		}
		const before = text.slice(0, idx);
		const after = text.slice(idx + CURSOR_MARKER.length);
		const beforeLength = Math.min(before.length, sourceLength);
		const afterLength = Math.min(after.length, sourceLength - beforeLength);
		const cursorCol = context.startCol + beforeLength;
		return (
			(beforeLength > 0 ? this.#decorateSlice(before.slice(0, beforeLength), context.startCol, context) : "") +
			before.slice(beforeLength) +
			CURSOR_MARKER +
			(afterLength > 0 ? this.#decorateSlice(after.slice(0, afterLength), cursorCol, context) : "") +
			after.slice(afterLength)
		);
	}

	#decorateSlice(slice: string, sliceStartCol: number, context: EditorTextDecorationContext): string {
		const selection = this.#renderSelection;
		if (selection === null) return this.#decoratePlain(slice, sliceStartCol, context);

		const sliceEndCol = sliceStartCol + slice.length;
		const line = context.line;
		let selStart = sliceEndCol;
		let selEnd = sliceStartCol;
		if (line >= selection.startLine && line <= selection.endLine) {
			selStart = line === selection.startLine ? Math.max(selection.startCol, sliceStartCol) : sliceStartCol;
			selEnd = line === selection.endLine ? Math.min(selection.endCol, sliceEndCol) : sliceEndCol;
		}
		if (selEnd <= selStart) {
			return this.#decoratePlain(slice, sliceStartCol, context);
		}

		const before = slice.slice(0, selStart - sliceStartCol);
		const middle = slice.slice(selStart - sliceStartCol, selEnd - sliceStartCol);
		const after = slice.slice(selEnd - sliceStartCol);
		const styled =
			SELECTION_SGR_OPEN +
			this.#decoratePlain(middle, selStart, context).replace(
				SGR_RESET_PATTERN,
				match => `${match}${SELECTION_SGR_OPEN}`,
			) +
			SELECTION_SGR_CLOSE;
		return this.#decoratePlain(before, sliceStartCol, context) + styled + this.#decoratePlain(after, selEnd, context);
	}

	#decoratePlain(part: string, partStartCol: number, context: EditorTextDecorationContext): string {
		const decorate = this.decorateText;
		if (part.length === 0) return "";
		if (decorate === undefined) return part;
		return decorate(part, {
			...context,
			startCol: partStartCol,
			endCol: partStartCol + part.length,
		});
	}

	#selectionSpanForLayout(
		layoutLine: LayoutLine,
		selection: SelectionRange,
	): { start: number; end: number; coversEOL: boolean } | null {
		const { sourceLine, sourceStartCol } = layoutLine;
		if (sourceLine < selection.startLine || sourceLine > selection.endLine) return null;
		const textEndCol = sourceStartCol + layoutLine.text.length;
		const selStartCol = sourceLine === selection.startLine ? selection.startCol : sourceStartCol;
		const selEndCol = sourceLine === selection.endLine ? selection.endCol : textEndCol;
		const start = Math.max(sourceStartCol, selStartCol) - sourceStartCol;
		const end = Math.min(textEndCol, selEndCol) - sourceStartCol;
		const lineLength = this.#state.lines[sourceLine]?.length ?? 0;
		// The line's trailing pad is highlighted when the selection spans past
		// its last column, i.e. the newline after it is part of the selection.
		const coversEOL =
			(sourceLine > selection.startLine && sourceLine < selection.endLine) ||
			(sourceLine === selection.startLine && sourceLine !== selection.endLine && selection.startCol >= lineLength);
		if (end <= start && !coversEOL) return null;
		return { start, end, coversEOL };
	}

	#getStyledInputCursor(): { text: string; width: number } {
		const cursorChar = this.#theme.symbols.inputCursor;

		return { text: cursorChar, width: visibleWidth(cursorChar) };
	}

	#renderEndOfLineCursorAtWidthLimit(
		before: string,
		marker: string,
		maxWidth: number,
		replacement?: { text: string; width: number },
	): { text: string; width: number } {
		const beforeGraphemes = [...segmenter.segment(before)];
		const lastGrapheme = beforeGraphemes[beforeGraphemes.length - 1]?.segment;
		const lastGraphemeWidth = lastGrapheme ? visibleWidth(lastGrapheme) : 0;
		const builtInCursor = this.#getStyledInputCursor();
		const fallbackReplacement = lastGrapheme
			? { text: `\x1b[7m${lastGrapheme}\x1b[0m`, width: lastGraphemeWidth }
			: builtInCursor;
		const clampReplacement = (candidate: { text: string; width: number }): { text: string; width: number } => {
			let text = sliceByColumn(candidate.text, 0, maxWidth, true);
			let width = visibleWidth(text);
			if (width > maxWidth) {
				text = "";
				width = 0;
			}
			return { text, width };
		};

		let clampedReplacement = clampReplacement(replacement ?? fallbackReplacement);
		if (replacement && clampedReplacement.width === 0) {
			clampedReplacement = clampReplacement(fallbackReplacement);
		}
		if (lastGrapheme && clampedReplacement.width === 0) {
			clampedReplacement = clampReplacement(builtInCursor);
		}

		const replacedSpanWidth = Math.min(maxWidth, Math.max(lastGraphemeWidth, clampedReplacement.width));
		const prefixWidth = Math.max(0, maxWidth - replacedSpanWidth);
		const beforePrefix = sliceByColumn(before, 0, prefixWidth, true);
		const replacementPad = padding(Math.max(0, replacedSpanWidth - clampedReplacement.width));
		return {
			text: `${beforePrefix}${replacementPad}${clampedReplacement.text}${marker}`,
			width: visibleWidth(beforePrefix) + replacedSpanWidth,
		};
	}

	#renderTerminalCursorMarker(text: string, marker: string, maxWidth: number): string {
		if (!marker) return text;
		if (visibleWidth(text) < maxWidth) {
			return text + marker;
		}

		let insertAt = text.length;
		let offset = 0;
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 0) {
				insertAt = offset;
			}
			offset += seg.segment.length;
		}

		return `${text.slice(0, insertAt)}${marker}${text.slice(insertAt)}`;
	}

	#getPageScrollStep(totalVisualLines: number): number {
		const visibleHeight =
			this.#maxHeight === undefined && this.#viewportHeight === undefined
				? DEFAULT_PAGE_SCROLL_LINES
				: this.#getVisibleContentHeight(totalVisualLines);
		return Math.max(1, visibleHeight - 1);
	}

	#renderPlainLayoutLine(layoutLine: LayoutLine, lineContentWidth: number, gutterText: string): string {
		if (lineContentWidth === 0) return gutterText;

		let displayText = layoutLine.text;
		let displayWidth = layoutLine.width;
		if (displayWidth > lineContentWidth) {
			displayText = sliceByColumn(displayText, 0, lineContentWidth, true);
			displayWidth = visibleWidth(displayText);
		}
		return gutterText + displayText + padding(Math.max(0, lineContentWidth - displayWidth));
	}

	#findCurrentLayoutLine(layoutLines: LayoutLine[]): number {
		for (let i = 0; i < layoutLines.length; i++) {
			const layoutLine = layoutLines[i];
			if (!layoutLine || layoutLine.sourceLine !== this.#state.cursorLine) continue;

			const colInSegment = this.#state.cursorCol - layoutLine.sourceStartCol;
			const isLastSegmentOfLine =
				i === layoutLines.length - 1 || layoutLines[i + 1]?.sourceLine !== layoutLine.sourceLine;
			const isFirstSegmentOfLine = i === 0 || layoutLines[i - 1]?.sourceLine !== layoutLine.sourceLine;
			if (
				(colInSegment >= 0 || isFirstSegmentOfLine) &&
				(colInSegment < layoutLine.text.length || (isLastSegmentOfLine && colInSegment <= layoutLine.text.length))
			) {
				return i;
			}
		}

		return layoutLines.length - 1;
	}

	#updateScrollOffset(layoutLines: LayoutLine[], visibleHeight: number): void {
		if (layoutLines.length <= visibleHeight) {
			this.#scrollOffset = 0;
			return;
		}

		const cursorLine = this.#findCurrentLayoutLine(layoutLines);
		if (cursorLine < this.#scrollOffset) {
			this.#scrollOffset = cursorLine;
		} else if (cursorLine >= this.#scrollOffset + visibleHeight) {
			this.#scrollOffset = cursorLine - visibleHeight + 1;
		}

		const maxOffset = Math.max(0, layoutLines.length - visibleHeight);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
	}

	render(width: number): readonly string[] {
		const activeSelection = this.#getSelectionRange();
		this.#renderSelection = activeSelection;
		const promptGutter = this.#getPromptGutter(width);
		const contentAreaWidth = Math.max(0, width - (promptGutter?.width ?? 0));

		const layoutWidth = Math.max(1, contentAreaWidth);
		this.#lastLayoutWidth = layoutWidth;

		const layoutLines = this.#layoutText(layoutWidth);
		const visibleContentHeight = this.#getVisibleContentHeight(layoutLines.length);
		this.#updateScrollOffset(layoutLines, visibleContentHeight);
		const visibleStart = this.#scrollOffset;
		const visibleEnd = Math.min(layoutLines.length, visibleStart + visibleContentHeight);

		const result: string[] = [];

		const emitCursorMarker = this.focused;
		const lineContentWidth = contentAreaWidth;

		const inlineHint = this.#getInlineHint();
		const hintStyle = this.#theme.hintStyle ?? DEFAULT_HINT_STYLE;
		const placeholderActive =
			inlineHint !== null &&
			this.#placeholder !== undefined &&
			inlineHint === this.#placeholder &&
			this.#state.lines.length === 1 &&
			this.#state.lines[0] === "";
		for (let visibleIndex = 0, layoutIndex = visibleStart; layoutIndex < visibleEnd; visibleIndex++, layoutIndex++) {
			const layoutLine = layoutLines[layoutIndex]!;
			let displayText = layoutLine.text;
			let displayWidth = layoutLine.width;
			const decorationContext =
				this.decorateText === undefined && activeSelection === null
					? EMPTY_DECORATION_CONTEXT
					: {
							line: layoutLine.sourceLine,
							startCol: layoutLine.sourceStartCol,
							endCol: layoutLine.sourceStartCol + layoutLine.text.length,
						};
			let decorated = false;
			const showPromptGutter = promptGutter !== undefined && visibleIndex === 0;
			const gutterText =
				promptGutter === undefined ? "" : showPromptGutter ? promptGutter.firstLine : promptGutter.continuation;

			const hasCursor = layoutLine.hasCursor && layoutLine.cursorPos !== undefined;
			const marker = emitCursorMarker ? CURSOR_MARKER : "";
			const selectionSpan =
				activeSelection === null ? null : this.#selectionSpanForLayout(layoutLine, activeSelection);

			if (!hasCursor && this.decorateText === undefined && selectionSpan === null) {
				const cached = this.#plainRenderCache.get(layoutLine);
				if (cached?.width === lineContentWidth && cached.gutter === gutterText) {
					result.push(cached.output);
					continue;
				}
				const output = this.#renderPlainLayoutLine(layoutLine, lineContentWidth, gutterText);
				this.#plainRenderCache.set(layoutLine, { width: lineContentWidth, gutter: gutterText, output });
				result.push(output);
				continue;
			}

			if (displayWidth > lineContentWidth) {
				displayText = sliceByColumn(displayText, 0, lineContentWidth, true);
				displayWidth = visibleWidth(displayText);
			}

			if (lineContentWidth === 0) {
				if (hasCursor && !this.#useTerminalCursor) {
					const zeroWidthCursorBudget = visibleWidth(gutterText);
					const zeroWidthCursorReplacement = this.cursorOverride
						? { text: this.cursorOverride, width: this.cursorOverrideWidth ?? 1 }
						: this.#getStyledInputCursor();
					if (showPromptGutter && zeroWidthCursorBudget > 0) {
						const promptGlyph = [...segmenter.segment(gutterText)][0]?.segment ?? "";
						const promptGlyphWidth = visibleWidth(promptGlyph);
						const remainingCursorWidth = Math.max(0, zeroWidthCursorBudget - promptGlyphWidth);
						if (remainingCursorWidth === 0) {
							result.push(`\x1b[7m${promptGlyph}\x1b[0m${marker}`);
						} else {
							const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
								"",
								marker,
								remainingCursorWidth,
								zeroWidthCursorReplacement,
							);
							result.push(`${promptGlyph}${widthLimitedCursor.text}`);
						}
					} else {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
							gutterText,
							marker,
							zeroWidthCursorBudget,
							zeroWidthCursorReplacement,
						);
						result.push(widthLimitedCursor.text);
					}
				} else if (hasCursor && this.#useTerminalCursor) {
					result.push(this.#renderTerminalCursorMarker(gutterText, marker, visibleWidth(gutterText)));
				} else {
					result.push(gutterText + (hasCursor ? marker : ""));
				}
				continue;
			}

			if (hasCursor && this.#useTerminalCursor) {
				if (marker) {
					const before = displayText.slice(0, layoutLine.cursorPos);
					const after = displayText.slice(layoutLine.cursorPos);
					if (after.length === 0 && inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - 1);
						const truncated = truncateToWidth(inlineHint, availWidth);
						const hintText =
							truncated.length > 0 ? ` ${placeholderActive ? truncated : hintStyle(truncated)}` : "";
						displayText = before + marker + hintText;
						displayWidth += truncated.length > 0 ? 1 + Math.min(visibleWidth(inlineHint), availWidth) : 0;
					} else if (after.length === 0 && displayWidth >= lineContentWidth) {
						displayText = this.#renderTerminalCursorMarker(before, marker, lineContentWidth);
					} else {
						displayText = before + marker + after;
					}
				}
			} else if (hasCursor && !this.#useTerminalCursor) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					const afterGraphemes = [...segmenter.segment(after)];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;

					displayText =
						this.#decorate(before, { ...decorationContext, endCol: decorationContext.startCol + before.length }) +
						marker +
						cursor +
						this.#decorate(restAfter, {
							...decorationContext,
							startCol: decorationContext.startCol + before.length + firstGrapheme.length,
						});
					decorated = true;
				} else if (this.cursorOverride) {
					const overrideWidth = this.cursorOverrideWidth ?? 1;
					if (displayWidth + overrideWidth > lineContentWidth) {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth, {
							text: this.cursorOverride,
							width: overrideWidth,
						});
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - overrideWidth - 1);
						const truncated = truncateToWidth(inlineHint, availWidth);
						const hintText =
							truncated.length > 0 ? ` ${placeholderActive ? truncated : hintStyle(truncated)}` : "";
						displayText = before + marker + this.cursorOverride + hintText;
						displayWidth +=
							overrideWidth + (truncated.length > 0 ? 1 + Math.min(visibleWidth(inlineHint), availWidth) : 0);
					} else {
						displayText = before + marker + this.cursorOverride;
						displayWidth += overrideWidth;
					}
				} else {
					const { text: cursor, width: cursorWidth } = this.#getStyledInputCursor();
					if (displayWidth + cursorWidth > lineContentWidth) {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth);
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - cursorWidth - 1);
						const truncated = truncateToWidth(inlineHint, availWidth);
						const hintText =
							truncated.length > 0 ? ` ${placeholderActive ? truncated : hintStyle(truncated)}` : "";
						displayText = before + marker + cursor + hintText;
						displayWidth +=
							cursorWidth + (truncated.length > 0 ? 1 + Math.min(visibleWidth(inlineHint), availWidth) : 0);
					} else {
						displayText = before + marker + cursor;
						displayWidth += cursorWidth;
					}
				}
			}

			if (!decorated) {
				displayText = this.#decorate(displayText, decorationContext);
			}
			if (!hasCursor) {
				displayWidth = displayText === layoutLine.text ? layoutLine.width : visibleWidth(displayText);
				if (displayWidth > lineContentWidth) {
					displayText = truncateToWidth(displayText, lineContentWidth);
					displayWidth = visibleWidth(displayText);
				}
			}

			const padWidth = Math.max(0, lineContentWidth - displayWidth);
			const linePad =
				selectionSpan?.coversEOL && padWidth > 0
					? `${SELECTION_SGR_OPEN}${padding(padWidth)}${SELECTION_SGR_CLOSE}`
					: padding(padWidth);

			result.push(gutterText + displayText + linePad);
		}

		if (this.#autocompleteState && this.#autocompleteList) {
			const viewportRows = this.viewportRowsProvider?.() || process.stdout.rows || Number(Bun.env.LINES) || 24;
			const available =
				this.#viewportHeight === undefined
					? Math.max(1, viewportRows - result.length - 2)
					: this.#viewportHeight - result.length;
			if (available > 0) {
				this.#autocompleteList.setMaxVisible(Math.min(this.#autocompleteMaxVisible, available));
				this.#autocompleteList.setMaxHeight(available);
				result.push(...this.#autocompleteList.render(width));
			}
		}

		return result;
	}

	handleInput(data: string): void {
		let next: string | undefined = data;
		while (next !== undefined && next.length > 0) {
			next = this.#handleInputChunk(next);
		}
	}

	#handleInputChunk(data: string): string | undefined {
		if (this.#autocompleteRequestRunning && this.#autocompleteState === null) {
			this.#invalidateAutocompleteRequests();
		}

		if (this.#jumpMode !== null) {
			const kb = getKeybindings();
			const parsedKey = parseKey(data);
			const canonical = parsedKey === undefined ? undefined : canonicalKeyId(parsedKey);
			if (
				kb.matchesCanonical(canonical, "tui.editor.jumpForward") ||
				kb.matchesCanonical(canonical, "tui.editor.jumpBackward")
			) {
				this.#jumpMode = null;
				return;
			}

			const printableText = extractPrintableText(data);
			if (printableText) {
				const direction = this.#jumpMode;
				this.#jumpMode = null;
				this.#jumpToChar(printableText, direction);
				return;
			}

			this.#jumpMode = null;
		}

		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					return paste.remaining;
				}
			}
			return;
		}

		if (
			this.#autocompleteState === null &&
			data.length === 1 &&
			isPlainTextRun(data) &&
			!hasPrintableSingleCharBinding(getKeybindings())
		) {
			this.#insertCharacter(data);
			return;
		}

		const kb = getKeybindings();
		const parsedKey = parseKey(data);
		const canonical = parsedKey === undefined ? undefined : canonicalKeyId(parsedKey);

		if (canonical === undefined && data.length > 1 && isPlainTextRun(data)) {
			this.#insertCharacter(data);
			return;
		}

		if (matchesKey(data, "ctrl+c") || kb.matchesCanonical(canonical, "tui.input.copy")) {
			if (this.#getSelectionRange() !== null) {
				this.#copySelection();
			}
			return;
		}

		if (kb.matchesCanonical(canonical, "tui.editor.undo")) {
			this.#applyUndo();
			return;
		}

		if (kb.matchesCanonical(canonical, "tui.editor.spellingSuggestions")) {
			void this.#showSpellingSuggestions();
			return;
		}

		if (this.#autocompleteState && this.#autocompleteList) {
			if (kb.matchesCanonical(canonical, "tui.select.cancel")) {
				this.#cancelAutocomplete(true);
				return;
			}
			if (
				this.#autocompleteState === "assist" &&
				(kb.matchesCanonical(canonical, "tui.input.submit") ||
					data === "\n" ||
					kb.matchesCanonical(canonical, "tui.input.tab"))
			) {
				this.#applySpellingSuggestion();
				return;
			} else if (
				kb.matchesCanonical(canonical, "tui.select.up") ||
				kb.matchesCanonical(canonical, "tui.select.down") ||
				kb.matchesCanonical(canonical, "tui.select.pageUp") ||
				kb.matchesCanonical(canonical, "tui.select.pageDown") ||
				kb.matchesCanonical(canonical, "tui.input.submit") ||
				data === "\n" ||
				kb.matchesCanonical(canonical, "tui.input.tab")
			) {
				if (
					kb.matchesCanonical(canonical, "tui.select.up") ||
					kb.matchesCanonical(canonical, "tui.select.down") ||
					kb.matchesCanonical(canonical, "tui.select.pageUp") ||
					kb.matchesCanonical(canonical, "tui.select.pageDown")
				) {
					this.#autocompleteList.handleInput(data);
					this.#autocompleteNavigated = true;
					this.onAutocompleteUpdate?.();
					return;
				}

				if (kb.matchesCanonical(canonical, "tui.input.tab")) {
					const selected = this.#autocompleteList.getSelectedItem();

					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
						this.#cancelAutocomplete();
						return;
					}
					if (selected && this.#autocompleteProvider) {
						const shouldChainSlashCommandAutocomplete = this.#isSlashCommandNameAutocompleteSelection();
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines.slice(),
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							this.#autocompletePrefix,
						);

						this.#recordUndoState();
						// The completion is its own undo unit: reset typing
						// coalescing so the next char snapshots separately.
						this.#lastAction = null;
						this.#setLines(result.lines);
						this.#selectionAnchor = null;
						this.#state.cursorLine = result.cursorLine;
						this.#setCursorCol(result.cursorCol);

						this.#cancelAutocomplete();
						this.onAutocompleteUpdate?.();

						if (this.onChange) {
							this.onChange(this.getText());
						}

						result.onApplied?.();

						if (shouldChainSlashCommandAutocomplete && this.#isCompletedSlashCommandAtCursor()) {
							void this.#tryTriggerAutocomplete();
						}
					}
					return;
				}

				if (
					(kb.matchesCanonical(canonical, "tui.input.submit") || data === "\n") &&
					findLeadingSlashCommandStart(this.#autocompletePrefix) !== null &&
					this.#isInSubmittedSlashCommandContext() &&
					!this.#selectedCompletionIsPath() &&
					!this.#selectedCompletionIsSkillNamespace()
				) {
					const selected = this.#autocompleteList.getSelectedItem();

					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (
						!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected) ||
						this.#selectedCompletionNeedsExplicitAcceptance(currentTextBeforeCursor)
					) {
						// Enter on a highlight the user never chose must not swap the
						// typed command for a description-only match: drop the list
						// and let the literal text submit below.
						this.#cancelAutocomplete();
					} else {
						if (selected && this.#autocompleteProvider) {
							const result = this.#autocompleteProvider.applyCompletion(
								this.#state.lines.slice(),
								this.#state.cursorLine,
								this.#state.cursorCol,
								selected,
								this.#autocompletePrefix,
							);

							this.#recordUndoState();
							// The completion is its own undo unit: reset typing
							// coalescing so the next char snapshots separately.
							this.#lastAction = null;
							this.#setLines(result.lines);
							this.#selectionAnchor = null;
							this.#state.cursorLine = result.cursorLine;
							this.#setCursorCol(result.cursorCol);
							result.onApplied?.();
						}
						this.#cancelAutocomplete();
					}
				} else if (kb.matchesCanonical(canonical, "tui.input.submit") || data === "\n") {
					const selected = this.#autocompleteList.getSelectedItem();

					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (
						!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected) ||
						this.#selectedCompletionNeedsExplicitAcceptance(currentTextBeforeCursor)
					) {
						this.#cancelAutocomplete();
					} else {
						if (selected && this.#autocompleteProvider) {
							const shouldChainSlashCommandAutocomplete = this.#isSlashCommandNameAutocompleteSelection();
							const result = this.#autocompleteProvider.applyCompletion(
								this.#state.lines.slice(),
								this.#state.cursorLine,
								this.#state.cursorCol,
								selected,
								this.#autocompletePrefix,
							);

							this.#recordUndoState();
							// The completion is its own undo unit: reset typing
							// coalescing so the next char snapshots separately.
							this.#lastAction = null;
							this.#setLines(result.lines);
							this.#selectionAnchor = null;
							this.#state.cursorLine = result.cursorLine;
							this.#setCursorCol(result.cursorCol);

							this.#cancelAutocomplete();
							this.onAutocompleteUpdate?.();

							if (this.onChange) {
								this.onChange(this.getText());
							}

							result.onApplied?.();
							if (shouldChainSlashCommandAutocomplete && this.#isCompletedSlashCommandAtCursor()) {
								void this.#tryTriggerAutocomplete();
							}
						}
						return;
					}
				}
			}
		}

		if (this.#autocompleteState === "assist") {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}

		if (kb.matchesCanonical(canonical, "tui.input.tab") && !this.#autocompleteState) {
			void this.#handleTabCompletion();
			return;
		}

		if (kb.matchesCanonical(canonical, "tui.editor.deleteToLineEnd")) {
			this.#deleteToEndOfLine();
		} else if (kb.matchesCanonical(canonical, "tui.editor.deleteToLineStart")) {
			this.#deleteToStartOfLine();
		} else if (kb.matchesCanonical(canonical, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
		} else if (kb.matchesCanonical(canonical, "tui.editor.deleteWordForward")) {
			this.#deleteWordForwards();
		} else if (kb.matchesCanonical(canonical, "tui.editor.yank")) {
			this.#yankFromKillRing();
		} else if (kb.matchesCanonical(canonical, "tui.editor.yankPop")) {
			this.#yankPop();
		} else if (matchesKey(data, "alt+enter")) {
			if (this.onAltEnter) {
				this.onAltEnter(this.getText());
			} else {
				this.#addNewLine();
			}
		} else if (
			(!kb.matchesCanonical(canonical, "tui.input.submit") &&
				((data.charCodeAt(0) === 10 && data.length > 1) ||
					matchesKey(data, "ctrl+enter") ||
					data === "\x1b\r" ||
					data === "\x1b[13;2~" ||
					kb.matchesCanonical(canonical, "tui.input.newLine") ||
					(data.length > 1 && data.includes("\x1b") && data.includes("\r")))) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.#shouldSubmitOnBackslashEnter(data, kb)) {
				this.#handleBackspace();
				this.#submitValue();
				return;
			}
			this.#addNewLine();
		} else if (kb.matchesCanonical(canonical, "tui.input.submit") || data === "\n") {
			if (this.disableSubmit) {
				return;
			}

			if (!this.#autocompleteState) {
				const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				if (
					findLeadingSlashCommandStart(textBeforeCursor) !== null &&
					this.#isInSubmittedSlashCommandContext() &&
					this.#autocompleteProvider?.trySyncSlashCompletion
				) {
					const syncResult = this.#autocompleteProvider.trySyncSlashCompletion(textBeforeCursor);
					// No active selection to accept: a description-only top match
					// must not replace the typed command on submit.
					if (syncResult && syncResult.items.length > 0 && !syncResult.items[0]!.weakMatch) {
						this.#autocompleteRequestId += 1;

						const selected = syncResult.items[0]!;
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines.slice(),
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							syncResult.prefix,
						);
						this.#recordUndoState();
						// The completion is its own undo unit: reset typing
						// coalescing so the next char snapshots separately.
						this.#lastAction = null;
						this.#setLines(result.lines);
						this.#selectionAnchor = null;
						this.#state.cursorLine = result.cursorLine;
						this.#setCursorCol(result.cursorCol);
						result.onApplied?.();
					}
				}
			}

			this.#submitValue();
		} else if (
			kb.matchesCanonical(canonical, "tui.editor.deleteCharBackward") ||
			matchesKey(data, "shift+backspace")
		) {
			this.#handleBackspace();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorLineStart")) {
			this.#moveToLineStart();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorLineEnd")) {
			this.#moveToLineEnd();
		} else if (kb.matchesCanonical(canonical, "tui.editor.pageUp")) {
			this.#pageScroll(-1);
		} else if (kb.matchesCanonical(canonical, "tui.editor.pageDown")) {
			this.#pageScroll(1);
		} else if (kb.matchesCanonical(canonical, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.#handleForwardDelete();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorWordLeft")) {
			this.#resetKillSequence();
			this.#moveWordBackwards();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorWordRight")) {
			this.#resetKillSequence();
			this.#moveWordForwards();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectUp")) {
			this.#beginSelection();
			if (this.#isOnFirstVisualLine()) {
				this.#moveToMessageStart(true);
			} else {
				this.#moveCursor(-1, 0, true);
			}
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectDown")) {
			this.#beginSelection();
			if (this.#isOnLastVisualLine()) {
				this.#moveToMessageEnd(true);
			} else {
				this.#moveCursor(1, 0, true);
			}
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectRight")) {
			this.#beginSelection();
			this.#moveCursor(0, 1, true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectLeft")) {
			this.#beginSelection();
			this.#moveCursor(0, -1, true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectWordLeft")) {
			this.#beginSelection();
			this.#moveWordBackwards(true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectWordRight")) {
			this.#beginSelection();
			this.#moveWordForwards(true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectLineStart")) {
			this.#beginSelection();
			this.#moveToLineStart(true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectLineEnd")) {
			this.#beginSelection();
			this.#moveToLineEnd(true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectPageUp")) {
			this.#beginSelection();
			this.#pageScroll(-1, true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorSelectPageDown")) {
			this.#beginSelection();
			this.#pageScroll(1, true);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorUp")) {
			if (this.#isEditorEmpty()) {
				this.#navigateHistory(-1);
			} else if (this.#historyIndex > -1 && this.#isOnFirstVisualLine()) {
				this.#navigateHistory(-1);
			} else if (this.#isOnFirstVisualLine()) {
				this.#moveToLineStart();
			} else {
				this.#moveCursor(-1, 0);
			}
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorDown")) {
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1);
			} else if (this.#isOnLastVisualLine()) {
				this.#moveToLineEnd();
			} else {
				this.#moveCursor(1, 0);
			}
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorRight")) {
			this.#moveCursor(0, 1);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorLeft")) {
			this.#moveCursor(0, -1);
		} else if (matchesKey(data, "shift+space")) {
			this.#insertCharacter(" ");
		} else if (kb.matchesCanonical(canonical, "tui.editor.jumpForward")) {
			this.#jumpMode = "forward";
		} else if (kb.matchesCanonical(canonical, "tui.editor.jumpBackward")) {
			this.#jumpMode = "backward";
		} else {
			const printableText = extractPrintableText(data);
			if (printableText) {
				this.#insertCharacter(printableText);
			}
		}
	}

	#lineEntry(line: string, width: number): WrapEntry {
		const epoch = getWidthConfigEpoch();
		if (width !== this.#wrapCacheWidth || epoch !== this.#wrapCacheEpoch) {
			this.#wrapCache.clear();
			this.#wrapCacheWidth = width;
			this.#wrapCacheEpoch = epoch;
		}
		let entry = this.#wrapCache.get(line);
		if (entry === undefined) {
			if (this.#wrapCache.size >= 256) {
				this.#wrapCache.clear();
			}
			entry = { width: visibleWidth(line), chunks: null };
			this.#wrapCache.set(line, entry);
		}
		return entry;
	}

	#wrapLine(line: string, width: number): TextChunk[] {
		const entry = this.#lineEntry(line, width);
		entry.chunks ??= wordWrapLine(line, width, entry.width);
		return entry.chunks;
	}

	#layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines = this.#layoutScratch;
		layoutLines.length = 0;
		const lineCount = this.#state.lines.length;
		this.#layoutCache.length = Math.max(1, lineCount);
		const epoch = getWidthConfigEpoch();

		if (lineCount === 0 || (lineCount === 1 && this.#state.lines[0] === "")) {
			let entry = this.#layoutCache[0];
			if (entry?.line !== "" || entry.width !== contentWidth || entry.epoch !== epoch) {
				entry = {
					line: "",
					width: contentWidth,
					epoch,
					wrapped: false,
					layouts: [
						{
							text: "",
							width: 0,
							sourceLine: 0,
							sourceStartCol: 0,
							hasCursor: false,
						},
					],
				};
				this.#layoutCache[0] = entry;
			}
			const layoutLine = entry.layouts[0]!;
			layoutLine.sourceLine = 0;
			layoutLine.hasCursor = true;
			layoutLine.cursorPos = 0;
			layoutLines.push(layoutLine);
			return layoutLines;
		}

		for (let i = 0; i < lineCount; i++) {
			const line = this.#state.lines[i] || "";
			let entry = this.#layoutCache[i];
			if (!entry || entry.line !== line || entry.width !== contentWidth || entry.epoch !== epoch) {
				const lineEntry = this.#lineEntry(line, contentWidth);
				const wrapped = lineEntry.width > contentWidth;
				if (!entry) {
					entry = { line, width: contentWidth, epoch, wrapped, layouts: [] };
					this.#layoutCache[i] = entry;
				} else {
					entry.line = line;
					entry.width = contentWidth;
					entry.epoch = epoch;
					entry.wrapped = wrapped;
				}

				const cachedLayouts = entry.layouts;
				if (!wrapped) {
					let layoutLine = cachedLayouts[0];
					if (!layoutLine) {
						layoutLine = {
							text: line,
							width: lineEntry.width,
							sourceLine: i,
							sourceStartCol: 0,
							hasCursor: false,
						};
						cachedLayouts[0] = layoutLine;
					} else {
						this.#plainRenderCache.delete(layoutLine);
						layoutLine.text = line;
						layoutLine.width = lineEntry.width;
						layoutLine.sourceStartCol = 0;
					}
					cachedLayouts.length = 1;
				} else {
					const chunks = this.#wrapLine(line, contentWidth);
					for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
						const chunk = chunks[chunkIndex]!;
						let layoutLine = cachedLayouts[chunkIndex];
						if (!layoutLine) {
							layoutLine = {
								text: chunk.text,
								width: chunk.width,
								sourceLine: i,
								sourceStartCol: chunk.startIndex,
								hasCursor: false,
							};
							cachedLayouts[chunkIndex] = layoutLine;
						} else {
							this.#plainRenderCache.delete(layoutLine);
							layoutLine.text = chunk.text;
							layoutLine.width = chunk.width;
							layoutLine.sourceStartCol = chunk.startIndex;
						}
					}
					cachedLayouts.length = chunks.length;
				}
			}

			const isCurrentLine = i === this.#state.cursorLine;
			const cursorPos = this.#state.cursorCol;
			const cachedLayouts = entry.layouts;
			for (let layoutIndex = 0; layoutIndex < cachedLayouts.length; layoutIndex++) {
				const layoutLine = cachedLayouts[layoutIndex]!;
				layoutLine.sourceLine = i;
				layoutLine.hasCursor = false;

				if (!isCurrentLine) {
					layoutLines.push(layoutLine);
					continue;
				}

				if (!entry.wrapped) {
					layoutLine.hasCursor = true;
					layoutLine.cursorPos = cursorPos;
				} else {
					const chunkStart = layoutLine.sourceStartCol;
					const isLastChunk = layoutIndex === cachedLayouts.length - 1;
					const hasCursorInChunk = isLastChunk
						? cursorPos >= chunkStart
						: cursorPos >= chunkStart && cursorPos < chunkStart + layoutLine.text.length;
					if (hasCursorInChunk) {
						layoutLine.hasCursor = true;
						layoutLine.cursorPos = Math.max(0, Math.min(cursorPos - chunkStart, layoutLine.text.length));
					}
				}
				layoutLines.push(layoutLine);
			}
		}

		return layoutLines;
	}

	getText(): string {
		if (this.#joinedTextRevision !== this.#linesRevision) {
			this.#joinedText = this.#state.lines.join("\n");
			this.#joinedTextRevision = this.#linesRevision;
		}
		return this.#joinedText;
	}

	textEquals(value: string): boolean {
		const lines = this.#state.lines;
		if (lines.length === 1) return lines[0] === value;
		if (value.indexOf("\n") === -1) return false;
		return this.getText() === value;
	}

	#expandPasteMarkers(text: string): string {
		const sources: string[] = [];
		for (const pasteId of this.#pastes.keys()) {
			sources.push(`\\[Paste #${pasteId}(?:, (?:\\+\\d+ lines|\\d+ chars))?\\]`);
		}
		const labels = [...this.#atoms.keys()].sort((a, b) => b.length - a.length);
		for (const label of labels) sources.push(RegExp.escape(label));
		if (sources.length === 0) return text;
		const markerRegex = new RegExp(sources.join("|"), "g");
		return text.replace(markerRegex, match => {
			const paste = /^\[Paste #(\d+)/.exec(match);
			if (paste) return this.#pastes.get(Number(paste[1])) ?? match;
			return this.#atoms.get(match) ?? match;
		});
	}

	registerAtom(label: string, expansion: string): void {
		this.#atoms.set(label, expansion);
	}

	insertAtom(label: string, expansion: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();
		this.registerAtom(label, expansion);
		this.#withUndoSuspended(() => {
			this.#insertTextAtCursor(`${label} `);
		});
	}

	clearAtoms(): void {
		this.#atoms.clear();
	}

	getExpandedText(): string {
		return this.#expandPasteMarkers(this.getText());
	}

	getLines(): string[] {
		return [...this.#state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.#state.cursorLine, col: this.#state.cursorCol };
	}

	hasSelection(): boolean {
		return this.#getSelectionRange() !== null;
	}

	getSelectedText(): string {
		const selection = this.#getSelectionRange();
		return selection === null ? "" : this.#extractRangeText(selection);
	}

	clearSelection(): void {
		this.#selectionAnchor = null;
	}

	#clampCursor(line: number, col: number): { line: number; col: number } {
		const clampedLine = Math.max(0, Math.min(line, this.#state.lines.length - 1));
		const lineText = this.#state.lines[clampedLine] ?? "";
		return { line: clampedLine, col: Math.max(0, Math.min(col, lineText.length)) };
	}

	#getSelectionRange(): SelectionRange | null {
		const anchor = this.#selectionAnchor;
		if (anchor === null) return null;
		const head = this.#clampCursor(this.#state.cursorLine, this.#state.cursorCol);
		const tail = this.#clampCursor(anchor.line, anchor.col);
		const headFirst = head.line < tail.line || (head.line === tail.line && head.col <= tail.col);
		const start = headFirst ? head : tail;
		const end = headFirst ? tail : head;
		if (start.line === end.line && start.col === end.col) return null;
		return { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
	}

	#extractRangeText(range: SelectionRange): string {
		const lines = this.#state.lines;
		if (range.startLine === range.endLine) {
			return (lines[range.startLine] ?? "").slice(range.startCol, range.endCol);
		}
		const parts: string[] = [(lines[range.startLine] ?? "").slice(range.startCol)];
		for (let i = range.startLine + 1; i < range.endLine; i++) {
			parts.push(lines[i] ?? "");
		}
		parts.push((lines[range.endLine] ?? "").slice(0, range.endCol));
		return parts.join("\n");
	}

	#beginSelection(): void {
		this.#selectionAnchor ??= { line: this.#state.cursorLine, col: this.#state.cursorCol };
	}

	/**
	 * Removes the selected range and returns the removed text. Clearing the
	 * selection is unconditional so any edit collapses even an empty (anchor ==
	 * cursor) selection.
	 */
	#deleteSelection(): string | null {
		if (this.#selectionAnchor === null) return null;
		const selection = this.#getSelectionRange();
		this.#selectionAnchor = null;
		if (selection === null) return null;
		const removed = this.#extractRangeText(selection);
		this.#recordUndoState();

		const firstLine = this.#state.lines[selection.startLine] ?? "";
		const lastLine = this.#state.lines[selection.endLine] ?? "";
		if (selection.startLine === selection.endLine) {
			this.#setLine(selection.startLine, firstLine.slice(0, selection.startCol) + firstLine.slice(selection.endCol));
		} else {
			const merged = firstLine.slice(0, selection.startCol) + lastLine.slice(selection.endCol);
			this.#spliceLines(selection.startLine, selection.endLine - selection.startLine + 1, merged);
		}
		this.#state.cursorLine = selection.startLine;
		this.#setCursorCol(selection.startCol);
		return removed;
	}

	#copySelection(): void {
		const selection = this.#getSelectionRange();
		if (selection === null) return;
		this.onCopySelection?.(this.#expandPasteMarkers(this.#extractRangeText(selection)));
	}

	moveToLineStart(): void {
		this.#moveToLineStart();
	}

	moveToLineEnd(): void {
		this.#moveToLineEnd();
	}

	moveToMessageStart(): void {
		this.#moveToMessageStart();
	}

	moveToMessageEnd(): void {
		this.#moveToMessageEnd();
	}

	undoPastTransientText(transientText: string): void {
		if (transientText.length === 0) {
			this.#applyUndo();
			return;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const transientStartCol = this.#state.cursorCol - transientText.length;
		if (transientStartCol < 0 || currentLine.slice(transientStartCol, this.#state.cursorCol) !== transientText) {
			this.#applyUndo();
			return;
		}

		const beforeTransient = currentLine.slice(0, transientStartCol);
		const afterTransient = currentLine.slice(this.#state.cursorCol);
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		this.#selectionAnchor = null;
		this.#setLine(this.#state.cursorLine, beforeTransient + afterTransient);
		this.#setCursorCol(transientStartCol);

		while (true) {
			const snapshot = this.#undoStack.at(-1);
			if (
				!snapshot ||
				!this.#matchesTransientUndoSnapshot(
					snapshot,
					transientText,
					transientStartCol,
					beforeTransient,
					afterTransient,
				)
			) {
				break;
			}
			this.#undoStack.pop();
		}

		if (this.#undoStack.length === 0) {
			if (this.onChange) {
				this.onChange(this.getText());
			}
			return;
		}

		this.#applyUndo();
	}

	setText(text: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#pasteHandler.clear();
		this.#cancelAutocomplete();
		this.#setTextInternal(text);
	}
	submit(): void {
		if (this.disableSubmit) return;
		this.#submitValue();
	}

	#exitHistoryForEditing(): void {
		if (this.#historyIndex === -1) return;
		if (this.#state.cursorLine === 0 && this.#state.cursorCol === 0) {
			this.#state.cursorLine = this.#state.lines.length - 1;
			const line = this.#state.lines[this.#state.cursorLine] || "";
			this.#setCursorCol(line.length);
		}
		this.#historyIndex = -1;
	}

	insertText(text: string): void {
		this.#exitHistoryForEditing();
		this.#insertTextAtCursor(text);
	}

	deleteBeforeCursor(count: number): void {
		const removable = Math.min(count, this.#state.cursorCol);
		if (removable <= 0) return;
		this.#exitHistoryForEditing();
		this.#selectionAnchor = null;
		this.#recordUndoState();
		const line = this.#state.lines[this.#state.cursorLine] ?? "";
		this.#setLine(
			this.#state.cursorLine,
			line.slice(0, this.#state.cursorCol - removable) + line.slice(this.#state.cursorCol),
		);
		this.#setCursorCol(this.#state.cursorCol - removable);
		this.#lastAction = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#volatileTextLen = 0;

	setVolatileText(text: string): void {
		this.#exitHistoryForEditing();
		this.#withUndoSuspended(() => {
			this.#deleteCharsBeforeCursor(this.#volatileTextLen);
			if (text) this.#insertTextAtCursor(text);
		});
		this.#volatileTextLen = text.length;
		if (!text && this.onChange) this.onChange(this.getText());
	}

	clearVolatileText(): void {
		if (this.#volatileTextLen === 0) return;
		this.#withUndoSuspended(() => this.#deleteCharsBeforeCursor(this.#volatileTextLen));
		this.#volatileTextLen = 0;
		if (this.onChange) this.onChange(this.getText());
	}

	commitVolatileText(text: string): void {
		this.#exitHistoryForEditing();
		this.#withUndoSuspended(() => this.#deleteCharsBeforeCursor(this.#volatileTextLen));
		this.#volatileTextLen = 0;
		if (text) this.#insertTextAtCursor(text);
		else if (this.onChange) this.onChange(this.getText());
	}

	#deleteCharsBeforeCursor(count: number): void {
		let remaining = count;
		while (remaining > 0) {
			if (this.#state.cursorCol > 0) {
				const removable = Math.min(remaining, this.#state.cursorCol);
				const line = this.#state.lines[this.#state.cursorLine] ?? "";
				this.#setLine(
					this.#state.cursorLine,
					line.slice(0, this.#state.cursorCol - removable) + line.slice(this.#state.cursorCol),
				);
				this.#setCursorCol(this.#state.cursorCol - removable);
				remaining -= removable;
			} else if (this.#state.cursorLine > 0) {
				const prev = this.#state.lines[this.#state.cursorLine - 1] ?? "";
				const cur = this.#state.lines[this.#state.cursorLine] ?? "";
				this.#setLine(this.#state.cursorLine - 1, prev + cur);
				this.#spliceLines(this.#state.cursorLine, 1);
				this.#state.cursorLine -= 1;
				this.#setCursorCol(prev.length);
				remaining -= 1;
			} else {
				break;
			}
		}
	}

	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	insertPaste(content: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();
		this.#withUndoSuspended(() => {
			this.#storePasteMarker(content, content.split("\n").length);
		});
	}

	#applyInlineReplacement(replacement: EditorInlineReplacement): boolean {
		this.#selectionAnchor = null;
		if (
			!Number.isInteger(replacement.replaceLen) ||
			replacement.replaceLen < 0 ||
			replacement.replaceLen > this.#state.cursorCol
		) {
			return false;
		}
		const line = this.#state.lines[this.#state.cursorLine] || "";
		const before = line.slice(0, this.#state.cursorCol - replacement.replaceLen);
		const after = line.slice(this.#state.cursorCol);
		this.#setLine(this.#state.cursorLine, before + replacement.insert + after);
		this.#setCursorCol(before.length + replacement.insert.length);
		this.#lastAction = null;
		this.onChange?.(this.getText());
		if (this.#autocompleteState) {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
		return true;
	}

	#insertCharacter(char: string): void {
		this.#exitHistoryForEditing();
		// Replacing a selection already snapshotted the pre-selection text, so the
		// inserted text joins that entry: one undo restores what the user replaced.
		const replacedSelection = this.#deleteSelection() !== null;

		const isWordChunk =
			char.length === 1
				? getWordNavKind(char) !== "whitespace"
				: [...segmenter.segment(char)].every(seg => getWordNavKind(seg.segment) !== "whitespace");
		if (!replacedSelection && (!isWordChunk || this.#lastAction !== "type-word")) {
			this.#recordUndoState();
		}

		const line = this.#state.lines[this.#state.cursorLine] || "";
		const cursorCol = this.#state.cursorCol;
		this.#setLine(
			this.#state.cursorLine,
			cursorCol === line.length
				? line + char
				: cursorCol === 0
					? char + line
					: line.slice(0, cursorCol) + char + line.slice(cursorCol),
		);
		this.#setCursorCol(cursorCol + char.length);
		this.#lastAction = isWordChunk ? "type-word" : null;

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (char.length === 1) {
			const replaceLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = replaceLine.slice(0, this.#state.cursorCol);
			const inlineReplacement = this.#autocompleteProvider?.trySyncInlineReplace?.(textBeforeCursor);
			if (inlineReplacement && this.#applyInlineReplacement(inlineReplacement)) return;
			const cursorLine = this.#state.cursorLine;
			const cursorCol = this.#state.cursorCol;
			const currentLine = this.#state.lines[cursorLine] ?? "";
			const textAssistProvider = this.#textAssistProvider;
			const textAssistProviderRevision = this.#textAssistProviderRevision;
			const autocorrection = textAssistProvider?.tryAutocorrect?.(this.#state.lines.slice(), cursorLine, cursorCol);
			if (autocorrection instanceof Promise) {
				autocorrection
					.then(replacement => {
						if (
							textAssistProvider === this.#textAssistProvider &&
							textAssistProviderRevision === this.#textAssistProviderRevision &&
							replacement &&
							this.#state.cursorLine === cursorLine &&
							this.#state.cursorCol === cursorCol &&
							this.#state.lines[cursorLine] === currentLine &&
							this.#applyInlineReplacement(replacement)
						) {
							this.onTextAssistApplied?.();
						}
					})
					.catch(() => {});
			} else if (autocorrection && this.#applyInlineReplacement(autocorrection)) {
				return;
			}
		}

		if (!this.#autocompleteProvider) return;

		if (!this.#autocompleteState) {
			if (char === "/" && (this.#isAtStartOfSubmittedMessage() || this.#isInMidPromptSkillSlashContext())) {
				this.#tryTriggerAutocomplete();
			} else if (char === "@") {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);

				const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
					this.#tryTriggerAutocomplete();
				}
			} else if (char === "#") {
				this.#tryTriggerAutocomplete();
			} else if (/[a-zA-Z0-9.\-_/]/.test(char)) {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);

				if (this.#isInSlashAutocompleteContext()) {
					this.#tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
					this.#tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
					this.#tryTriggerAutocomplete();
				} else if (textBeforeCursor.match(/(?:^|[\s([{>]):[a-zA-Z0-9_+-]*$/)) {
					this.#tryTriggerAutocomplete();
				} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
					this.#tryTriggerAutocomplete();
				}
			}
		} else {
			this.#debouncedUpdateAutocomplete();
		}
	}

	#handlePaste(pastedText: string): void {
		let filteredText = this.#sanitizePastedText(pastedText);

		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const charBeforeCursor = this.#state.cursorCol > 0 ? currentLine[this.#state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		const pastedLines = filteredText.split("\n");
		const totalChars = filteredText.length;

		const isMarkerSized = pastedLines.length > 10 || totalChars > 1000;

		if (isMarkerSized && this.onLargePaste?.(filteredText, pastedLines.length)) {
			return;
		}

		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();

		this.#withUndoSuspended(() => {
			if (isMarkerSized) {
				this.#storePasteMarker(filteredText, pastedLines.length);
				return;
			}

			if (pastedLines.length === 1) {
				if (filteredText) {
					this.#insertTextAtCursor(filteredText);
				}
				return;
			}

			this.#insertTextAtCursor(filteredText);
		});
	}

	#sanitizePastedText(pastedText: string): string {
		const decodedText = decodeReencodedPasteControls(pastedText);

		const cleanText = decodedText.replace(/\r\n?/g, "\n").normalize("NFC");

		const tabExpandedText = cleanText.replace(/\t/g, "   ");

		return tabExpandedText.replace(/[\x00-\x09\x0B-\x1F\x7F\x80-\x9F]/g, "");
	}

	#storePasteMarker(content: string, lineCount: number): void {
		this.#pasteCounter++;
		const pasteId = this.#pasteCounter;
		this.#pastes.set(pasteId, content);

		const marker =
			lineCount > 10 ? `[Paste #${pasteId}, +${lineCount} lines]` : `[Paste #${pasteId}, ${content.length} chars]`;
		this.#insertTextAtCursor(marker);
	}

	#retriggerAutocompleteAtCursor(): void {
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
			return;
		}
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
		if (this.#isInSlashAutocompleteContext()) {
			this.#tryTriggerAutocomplete();
		} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
			this.#tryTriggerAutocomplete();
		} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
			this.#tryTriggerAutocomplete();
		} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
			this.#tryTriggerAutocomplete();
		}
	}

	#addNewLine(): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		if (this.#deleteSelection() === null) {
			this.#recordUndoState();
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		const before = currentLine.slice(0, this.#state.cursorCol);
		const after = currentLine.slice(this.#state.cursorCol);

		this.#setLine(this.#state.cursorLine, before);
		this.#spliceLines(this.#state.cursorLine + 1, 0, after);

		this.#state.cursorLine++;
		this.#setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#shouldSubmitOnBackslashEnter(data: string, kb: KeybindingsManager): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		return this.#state.cursorCol > 0 && currentLine[this.#state.cursorCol - 1] === "\\";
	}

	#submitValue(): void {
		// A submit during a split bracketed paste ends the paste transaction.
		this.#pasteHandler.clear();
		this.#resetKillSequence();

		const result = this.#expandPasteMarkers(this.getText()).trim();

		this.#setLines([""]);
		this.#state.cursorLine = 0;
		this.#state.cursorCol = 0;
		this.#selectionAnchor = null;
		this.#pastes.clear();
		this.#pasteCounter = 0;
		this.#atoms.clear();
		this.#historyIndex = -1;
		this.#scrollOffset = 0;
		this.#undoStack.length = 0;
		this.#volatileTextLen = 0;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	#getAtomicTokenRe(): RegExp | undefined {
		const pattern = this.atomicTokenPattern;
		if (pattern === undefined) {
			this.#atomicTokenSource = undefined;
			this.#atomicTokenRe = undefined;
			return undefined;
		}
		if (pattern.source !== this.#atomicTokenSource) {
			this.#atomicTokenSource = pattern.source;
			this.#atomicTokenRe = new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
			);
		}
		return this.#atomicTokenRe;
	}

	#atomicTokenAt(line: string, col: number): { start: number; end: number } | undefined {
		const re = this.#getAtomicTokenRe();
		if (re === undefined) return undefined;
		re.lastIndex = 0;
		for (;;) {
			const match = re.exec(line);
			if (match === null) break;
			if (match[0].length === 0) {
				re.lastIndex = match.index + 1;
				continue;
			}
			const start = match.index;
			const end = start + match[0].length;
			if (col < start) break;
			if (col < end) return { start, end };
		}
		return undefined;
	}

	#expandRangeOverAtomicTokens(line: string, start: number, end: number): { start: number; end: number } {
		const startToken = this.#atomicTokenAt(line, start);
		if (startToken !== undefined && startToken.start < start) {
			start = startToken.start;
		}
		if (end > start) {
			const endToken = this.#atomicTokenAt(line, end - 1);
			if (endToken !== undefined && endToken.end > end) {
				end = endToken.end;
			}
		}
		return { start, end };
	}

	#handleBackspace(): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		if (this.#deleteSelection() !== null) {
			if (this.onChange) {
				this.onChange(this.getText());
			}
			this.#retriggerAutocompleteAtCursor();
			return;
		}
		if (this.#state.cursorCol === 0 && this.#state.cursorLine === 0) return;
		this.#recordUndoState();

		let removedSlashTrigger = false;

		if (this.#state.cursorCol > 0) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = line.slice(0, this.#state.cursorCol);
			const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
			removedSlashTrigger = trailingSlashStart === this.#state.cursorCol - 1;

			const token = this.#atomicTokenAt(line, this.#state.cursorCol - 1);
			if (token !== undefined) {
				this.#setLine(this.#state.cursorLine, line.slice(0, token.start) + line.slice(token.end));
				this.#setCursorCol(token.start);
			} else {
				const beforeCursor = line.slice(0, this.#state.cursorCol);

				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

				const before = line.slice(0, this.#state.cursorCol - graphemeLength);
				const after = line.slice(this.#state.cursorCol);

				this.#setLine(this.#state.cursorLine, before + after);
				this.#setCursorCol(this.#state.cursorCol - graphemeLength);
			}
		} else if (this.#state.cursorLine > 0) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";

			this.#setLine(this.#state.cursorLine - 1, previousLine + currentLine);
			this.#spliceLines(this.#state.cursorLine, 1);

			this.#state.cursorLine--;
			this.#setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			if (removedSlashTrigger) {
				this.#cancelAutocomplete();
				this.onAutocompleteUpdate?.();
			} else {
				this.#debouncedUpdateAutocomplete();
			}
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);

			if (this.#isInSlashAutocompleteContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#setCursorCol(col: number): void {
		this.#state.cursorCol = col;
		this.#preferredVisualCol = null;
	}

	#moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];

		if (currentVL && targetVL) {
			const sourceLine = this.#state.lines[currentVL.logicalLine] || "";
			const sourceText = sourceLine.slice(currentVL.startCol, currentVL.startCol + currentVL.length);
			const currentVisualCol = visualColAtOffset(sourceText, this.#state.cursorCol - currentVL.startCol);

			const isLastSourceSegment =
				currentVisualLine === visualLines.length - 1 ||
				visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
			const sourceMaxVisualCol = maxSegmentVisualCol(sourceText, isLastSourceSegment);

			const isLastTargetSegment =
				targetVisualLine === visualLines.length - 1 ||
				visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
			const targetLine = this.#state.lines[targetVL.logicalLine] || "";
			const targetText = targetLine.slice(targetVL.startCol, targetVL.startCol + targetVL.length);
			const targetMaxVisualCol = maxSegmentVisualCol(targetText, isLastTargetSegment);

			const moveToVisualCol = this.#computeVerticalMoveColumn(
				currentVisualCol,
				sourceMaxVisualCol,
				targetMaxVisualCol,
			);

			this.#state.cursorLine = targetVL.logicalLine;
			const targetCol = targetVL.startCol + offsetAtVisualCol(targetText, moveToVisualCol);
			this.#state.cursorCol = Math.min(targetCol, targetLine.length);
		}
	}

	#computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.#preferredVisualCol !== null;
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol;
		const targetTooShort = targetMaxVisualCol < currentVisualCol;

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				this.#preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}
			this.#preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.#preferredVisualCol!;
		if (targetTooShort || targetCantFitPreferred) {
			return targetMaxVisualCol;
		}

		const result = this.#preferredVisualCol!;
		this.#preferredVisualCol = null;
		return result;
	}

	#moveToLineStart(select = false): void {
		this.#resetKillSequence();
		if (!select) this.#selectionAnchor = null;
		this.#setCursorCol(0);
	}

	#moveToLineEnd(select = false): void {
		this.#resetKillSequence();
		if (!select) this.#selectionAnchor = null;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#moveToMessageStart(select = false): void {
		this.#resetKillSequence();
		if (!select) this.#selectionAnchor = null;
		this.#state.cursorLine = 0;
		this.#setCursorCol(0);
	}

	#moveToMessageEnd(select = false): void {
		this.#resetKillSequence();
		if (!select) this.#selectionAnchor = null;
		this.#state.cursorLine = this.#state.lines.length - 1;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#resetKillSequence(): void {
		this.#lastAction = null;
	}

	#withUndoSuspended<T>(fn: () => T): T {
		const wasSuspended = this.#suspendUndo;
		this.#suspendUndo = true;
		try {
			return fn();
		} finally {
			this.#suspendUndo = wasSuspended;
		}
	}

	#recordUndoState(): void {
		if (this.#suspendUndo) return;
		this.#undoStack.push({
			lines: this.#state.lines.slice(),
			cursorLine: this.#state.cursorLine,
			cursorCol: this.#state.cursorCol,
		});
		if (this.#undoStack.length > MAX_UNDO_STACK) {
			this.#undoStack.shift();
		}
	}

	#applyUndo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) return;

		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		this.#volatileTextLen = 0;
		this.#selectionAnchor = null;
		this.#setLines(snapshot.lines);
		this.#state.cursorLine = snapshot.cursorLine;
		this.#state.cursorCol = snapshot.cursorCol;

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			if (this.#isInSlashAutocompleteContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#matchesTransientUndoSnapshot(
		snapshot: EditorState,
		transientText: string,
		transientStartCol: number,
		beforeTransient: string,
		afterTransient: string,
	): boolean {
		if (snapshot.cursorLine !== this.#state.cursorLine) return false;
		if (snapshot.lines.length !== this.#state.lines.length) return false;

		const transientLength = snapshot.cursorCol - transientStartCol;
		if (transientLength < 0 || transientLength >= transientText.length) return false;

		for (let i = 0; i < snapshot.lines.length; i++) {
			if (i === this.#state.cursorLine) continue;
			if (snapshot.lines[i] !== this.#state.lines[i]) return false;
		}

		return (
			snapshot.lines[snapshot.cursorLine] ===
			beforeTransient + transientText.slice(0, transientLength) + afterTransient
		);
	}

	#recordKill(text: string, direction: "forward" | "backward", accumulate = this.#lastAction === "kill"): void {
		if (!text) return;
		this.#killRing.push(text, { prepend: direction === "backward", accumulate });
		this.#lastAction = "kill";
	}

	#insertTextAtCursor(text: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		if (this.#deleteSelection() === null) {
			this.#recordUndoState();
		}

		const normalized = text.replace(/\r\n?/g, "\n");
		const lines = normalized.split("\n");

		if (lines.length === 1) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const before = line.slice(0, this.#state.cursorCol);
			const after = line.slice(this.#state.cursorCol);
			this.#setLine(this.#state.cursorLine, before + normalized + after);
			this.#setCursorCol(this.#state.cursorCol + normalized.length);
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
			const afterCursor = currentLine.slice(this.#state.cursorCol);

			const newLines: string[] = [];
			for (let i = 0; i < this.#state.cursorLine; i++) {
				newLines.push(this.#state.lines[i] || "");
			}

			newLines.push(beforeCursor + (lines[0] || ""));
			for (let i = 1; i < lines.length - 1; i++) {
				newLines.push(lines[i] || "");
			}
			newLines.push((lines[lines.length - 1] || "") + afterCursor);

			for (let i = this.#state.cursorLine + 1; i < this.#state.lines.length; i++) {
				newLines.push(this.#state.lines[i] || "");
			}

			this.#setLines(newLines);
			this.#state.cursorLine += lines.length - 1;
			this.#setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#yankFromKillRing(): void {
		const text = this.#killRing.peek();
		if (!text) return;
		this.#insertTextAtCursor(text);
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank") return;
		if (this.#killRing.length <= 1) return;

		this.#historyIndex = -1;
		this.#recordUndoState();

		this.#withUndoSuspended(() => {
			if (!this.#deleteYankedText()) return;
			this.#killRing.rotate();
			const text = this.#killRing.peek();
			if (text) {
				this.#insertTextAtCursor(text);
			}
		});

		this.#lastAction = "yank";
	}

	#deleteYankedText(): boolean {
		const yankedText = this.#killRing.peek();
		if (!yankedText) return false;

		const yankLines = yankedText.split("\n");
		const endLine = this.#state.cursorLine;
		const endCol = this.#state.cursorCol;
		const startLine = endLine - (yankLines.length - 1);
		if (startLine < 0) return false;

		if (yankLines.length === 1) {
			const line = this.#state.lines[endLine] ?? "";
			const startCol = endCol - yankedText.length;
			if (startCol < 0) return false;
			if (line.slice(startCol, endCol) !== yankedText) return false;

			this.#setLine(endLine, line.slice(0, startCol) + line.slice(endCol));
			this.#state.cursorLine = endLine;
			this.#setCursorCol(startCol);
			return true;
		}

		const firstInserted = yankLines[0] ?? "";
		const lastInserted = yankLines[yankLines.length - 1] ?? "";
		const firstLineText = this.#state.lines[startLine] ?? "";
		const lastLineText = this.#state.lines[endLine] ?? "";

		if (!firstLineText.endsWith(firstInserted)) return false;
		if (endCol !== lastInserted.length) return false;
		if (lastLineText.slice(0, endCol) !== lastInserted) return false;

		const startCol = firstLineText.length - firstInserted.length;
		if (startCol < 0) return false;

		const suffix = lastLineText.slice(endCol);
		const newLine = firstLineText.slice(0, startCol) + suffix;

		this.#spliceLines(startLine, yankLines.length, newLine);
		this.#state.cursorLine = startLine;
		this.#setCursorCol(startCol);
		return true;
	}

	#deleteToStartOfLine(): void {
		this.#historyIndex = -1;
		const selected = this.#deleteSelection();
		if (selected !== null) {
			this.#recordKill(selected, "backward");
			if (this.onChange) {
				this.onChange(this.getText());
			}
			this.#retriggerAutocompleteAtCursor();
			return;
		}
		if (this.#state.cursorCol === 0 && this.#state.cursorLine === 0) return;
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		let deletedText = "";

		if (this.#state.cursorCol > 0) {
			const { end } = this.#expandRangeOverAtomicTokens(currentLine, 0, this.#state.cursorCol);
			deletedText = currentLine.slice(0, end);
			this.#setLine(this.#state.cursorLine, currentLine.slice(end));
			this.#setCursorCol(0);
		} else if (this.#state.cursorLine > 0) {
			deletedText = "\n";
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
			this.#setLine(this.#state.cursorLine - 1, previousLine + currentLine);
			this.#spliceLines(this.#state.cursorLine, 1);
			this.#state.cursorLine--;
			this.#setCursorCol(previousLine.length);
		}

		this.#recordKill(deletedText, "backward");

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#deleteToEndOfLine(): void {
		this.#historyIndex = -1;
		const selected = this.#deleteSelection();
		if (selected !== null) {
			this.#recordKill(selected, "forward");
			if (this.onChange) {
				this.onChange(this.getText());
			}
			this.#retriggerAutocompleteAtCursor();
			return;
		}
		const lineToEnd = this.#state.lines[this.#state.cursorLine] ?? "";
		if (this.#state.cursorCol >= lineToEnd.length && this.#state.cursorLine >= this.#state.lines.length - 1) {
			return;
		}
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		let deletedText = "";

		if (this.#state.cursorCol < currentLine.length) {
			const { start } = this.#expandRangeOverAtomicTokens(currentLine, this.#state.cursorCol, currentLine.length);
			deletedText = currentLine.slice(start);
			this.#setLine(this.#state.cursorLine, currentLine.slice(0, start));
			if (start < this.#state.cursorCol) {
				this.#setCursorCol(start);
			}
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
			deletedText = "\n";
			this.#setLine(this.#state.cursorLine, currentLine + nextLine);
			this.#spliceLines(this.#state.cursorLine + 1, 1);
		}

		this.#recordKill(deletedText, "forward");

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#deleteWordBackwards(): void {
		this.#historyIndex = -1;
		const selected = this.#deleteSelection();
		if (selected !== null) {
			this.#recordKill(selected, "backward");
			if (this.onChange) {
				this.onChange(this.getText());
			}
			this.#retriggerAutocompleteAtCursor();
			return;
		}
		if (this.#state.cursorCol === 0 && this.#state.cursorLine === 0) return;
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#recordKill("\n", "backward");
				const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
				this.#setLine(this.#state.cursorLine - 1, previousLine + currentLine);
				this.#spliceLines(this.#state.cursorLine, 1);
				this.#state.cursorLine--;
				this.#setCursorCol(previousLine.length);
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordBackwards();

			const range = this.#expandRangeOverAtomicTokens(currentLine, this.#state.cursorCol, oldCursorCol);

			const deletedText = currentLine.slice(range.start, range.end);
			this.#setLine(this.#state.cursorLine, currentLine.slice(0, range.start) + currentLine.slice(range.end));
			this.#setCursorCol(range.start);
			this.#recordKill(deletedText, "backward");
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#deleteWordForwards(): void {
		this.#historyIndex = -1;
		const selected = this.#deleteSelection();
		if (selected !== null) {
			this.#recordKill(selected, "forward");
			if (this.onChange) {
				this.onChange(this.getText());
			}
			this.#retriggerAutocompleteAtCursor();
			return;
		}
		const lineForGuard = this.#state.lines[this.#state.cursorLine] ?? "";
		if (this.#state.cursorCol >= lineForGuard.length && this.#state.cursorLine >= this.#state.lines.length - 1) {
			return;
		}
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#recordKill("\n", "forward");
				const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
				this.#setLine(this.#state.cursorLine, currentLine + nextLine);
				this.#spliceLines(this.#state.cursorLine + 1, 1);
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordForwards();

			const range = this.#expandRangeOverAtomicTokens(currentLine, oldCursorCol, this.#state.cursorCol);

			const deletedText = currentLine.slice(range.start, range.end);
			this.#setLine(this.#state.cursorLine, currentLine.slice(0, range.start) + currentLine.slice(range.end));
			this.#setCursorCol(range.start);
			this.#recordKill(deletedText, "forward");
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#retriggerAutocompleteAtCursor();
	}

	#handleForwardDelete(): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		if (this.#deleteSelection() !== null) {
			if (this.onChange) {
				this.onChange(this.getText());
			}
			this.#retriggerAutocompleteAtCursor();
			return;
		}
		const currentLineForGuard = this.#state.lines[this.#state.cursorLine] ?? "";
		if (
			this.#state.cursorCol >= currentLineForGuard.length &&
			this.#state.cursorLine >= this.#state.lines.length - 1
		) {
			return;
		}
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol < currentLine.length) {
			const token = this.#atomicTokenAt(currentLine, this.#state.cursorCol);
			if (token !== undefined) {
				this.#setLine(this.#state.cursorLine, currentLine.slice(0, token.start) + currentLine.slice(token.end));
				this.#setCursorCol(token.start);
			} else {
				const afterCursor = currentLine.slice(this.#state.cursorCol);

				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

				const before = currentLine.slice(0, this.#state.cursorCol);
				const after = currentLine.slice(this.#state.cursorCol + graphemeLength);
				this.#setLine(this.#state.cursorLine, before + after);
			}
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
			this.#setLine(this.#state.cursorLine, currentLine + nextLine);
			this.#spliceLines(this.#state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);

			if (this.#isInSlashAutocompleteContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const lineVisWidth = this.#lineEntry(line, width).width;
			if (line.length === 0) {
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				const chunks = this.#wrapLine(line, width);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	#findCurrentVisualLine(visualLines: Array<{ logicalLine: number; startCol: number; length: number }>): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl) continue;
			if (vl.logicalLine === this.#state.cursorLine) {
				const colInSegment = this.#state.cursorCol - vl.startCol;

				const isLastSegmentOfLine =
					i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
				const isFirstSegmentOfLine = i === 0 || visualLines[i - 1]?.logicalLine !== vl.logicalLine;
				if (
					(colInSegment >= 0 || isFirstSegmentOfLine) &&
					(colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))
				) {
					return i;
				}
			}
		}

		return visualLines.length - 1;
	}

	#moveCursor(deltaLine: number, deltaCol: number, select = false): void {
		this.#resetKillSequence();
		if (!select) this.#selectionAnchor = null;
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";

			if (deltaCol > 0) {
				if (this.#state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.#state.cursorCol);
					const graphemes = [...segmenter.segment(afterCursor)];
					const firstGrapheme = graphemes[0];
					this.#setCursorCol(this.#state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
					this.#state.cursorLine++;
					this.#setCursorCol(0);
				} else {
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						const segmentText = currentLine.slice(currentVL.startCol, currentVL.startCol + currentVL.length);
						this.#preferredVisualCol = visualColAtOffset(segmentText, this.#state.cursorCol - currentVL.startCol);
					}
				}
			} else {
				if (this.#state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
					const graphemes = [...segmenter.segment(beforeCursor)];
					const lastGrapheme = graphemes[graphemes.length - 1];
					this.#setCursorCol(this.#state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
				} else if (this.#state.cursorLine > 0) {
					this.#state.cursorLine--;
					const prevLine = this.#state.lines[this.#state.cursorLine] || "";
					this.#setCursorCol(prevLine.length);
				}
			}
		}
	}

	#pageScroll(direction: -1 | 1, select = false): void {
		this.#resetKillSequence();
		if (!select) this.#selectionAnchor = null;
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		const step = this.#getPageScrollStep(visualLines.length);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * step));
		if (targetVisualLine === currentVisualLine) return;
		this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	#moveWordBackwards(select = false): void {
		if (!select) this.#selectionAnchor = null;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#state.cursorLine--;
				const prevLine = this.#state.lines[this.#state.cursorLine] || "";
				this.#setCursorCol(prevLine.length);
			}
			return;
		}

		this.#setCursorCol(moveWordLeft(currentLine, this.#state.cursorCol));
	}

	#jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.#resetKillSequence();
		this.#selectionAnchor = null;
		const isForward = direction === "forward";
		const lines = this.#state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.#state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.#state.cursorLine;

			const searchFrom = isCurrentLine
				? isForward
					? this.#state.cursorCol + 1
					: this.#state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.#state.cursorLine = lineIdx;
				// The match may sit inside a grapheme cluster (e.g. a combining
				// mark): jump to the START of the cluster containing it so the
				// cursor never lands mid-grapheme.
				this.#setCursorCol(graphemeStartAt(line, idx));
				return;
			}
		}
	}

	#moveWordForwards(select = false): void {
		if (!select) this.#selectionAnchor = null;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#state.cursorLine++;
				this.#setCursorCol(0);
			}
			return;
		}

		this.#setCursorCol(moveWordRight(currentLine, this.#state.cursorCol));
	}

	#hasOnlyWhitespaceBeforeCursorLine(): boolean {
		for (let i = 0; i < this.#state.cursorLine; i++) {
			if ((this.#state.lines[i] || "").trim() !== "") {
				return false;
			}
		}
		return true;
	}

	#isAtStartOfSubmittedMessage(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		return this.#hasOnlyWhitespaceBeforeCursorLine() && (beforeCursor.trim() === "" || beforeCursor.trim() === "/");
	}

	#isInSubmittedSlashCommandContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		return this.#hasOnlyWhitespaceBeforeCursorLine() && beforeCursor.trimStart().startsWith("/");
	}

	#isInMidPromptSkillSlashContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		const slashStart = findTrailingSlashCommandStart(beforeCursor);
		if (slashStart === null) return false;
		if (this.#hasOnlyWhitespaceBeforeCursorLine() && findLeadingSlashCommandStart(beforeCursor) !== null)
			return false;
		return !this.#hasOnlyWhitespaceBeforeCursorLine() || beforeCursor.slice(0, slashStart).trim() !== "";
	}

	#isInSlashAutocompleteContext(): boolean {
		return this.#isInSubmittedSlashCommandContext() || this.#isInMidPromptSkillSlashContext();
	}

	#autocompletePrefixMatchesCursorText(currentTextBeforeCursor: string, item?: SelectItem | null): boolean {
		if (currentTextBeforeCursor === this.#autocompletePrefix) return true;

		if (item?.value.startsWith("skill:") && findTrailingSlashCommandStart(this.#autocompletePrefix) !== null) {
			const currentTrailingStart = findTrailingSlashCommandStart(currentTextBeforeCursor);
			if (currentTrailingStart !== null) {
				const token = currentTextBeforeCursor.slice(currentTrailingStart);
				if (!token.includes(" ") && !token.slice(1).includes("/")) {
					const lowerToken = token.slice(1).toLowerCase();
					if (midPromptSkillTokenMatches(lowerToken, item.value, item.description)) return true;
				}
			}
			return false;
		}

		if (findLeadingSlashCommandStart(this.#autocompletePrefix) !== null && !this.#selectedCompletionIsPath()) {
			const currentLeadingStart = findLeadingSlashCommandStart(currentTextBeforeCursor);
			if (currentLeadingStart !== null) {
				const token = currentTextBeforeCursor.slice(currentLeadingStart);
				if (!token.includes(" ") && !token.slice(1).includes("/")) return true;
			}
			return false;
		}

		if (this.#autocompletePrefix.startsWith("@")) {
			return /(?:^|\s)@[^\s]*$/.test(currentTextBeforeCursor);
		}

		return currentTextBeforeCursor.endsWith(this.#autocompletePrefix);
	}

	#selectedCompletionIsPath(): boolean {
		const selected = this.#autocompleteList?.getSelectedItem();
		if (!selected) return false;
		return selected.value.startsWith("/") || selected.value.startsWith('"');
	}

	#selectedCompletionIsSkillNamespace(): boolean {
		return this.#autocompleteList?.getSelectedItem()?.value === SKILL_NAMESPACE;
	}

	#selectedCompletionNeedsExplicitAcceptance(textBeforeCursor: string): boolean {
		if (this.#autocompleteNavigated) return false;
		// SelectList preserves the provider's AutocompleteItem objects.
		const selected: AutocompleteItem | null | undefined = this.#autocompleteList?.getSelectedItem();
		return (
			selected?.weakMatch === true ||
			// A debounced refresh may leave a strong row for an older slash query.
			// Drop that implicit selection too; the sync submit path resolves the
			// current query instead of executing an unrelated stale command.
			(this.#isSlashCommandNameAutocompleteSelection() &&
				!this.#selectedCompletionIsPath() &&
				textBeforeCursor !== this.#autocompletePrefix)
		);
	}

	#isSlashCommandNameAutocompleteSelection(): boolean {
		if (this.#autocompleteState !== "regular") {
			return false;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return (
			this.#isInSubmittedSlashCommandContext() && textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")
		);
	}

	#isCompletedSlashCommandAtCursor(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		if (this.#state.cursorCol !== currentLine.length) {
			return false;
		}

		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return (
			this.#isInSubmittedSlashCommandContext() &&
			(/^\/\S+ $/.test(textBeforeCursor) || textBeforeCursor === `/${SKILL_NAMESPACE}`)
		);
	}

	#textTriggersUrlAutocomplete(textBeforeCursor: string): boolean {
		return /(?:^|[\s"'`(<=])[a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*$/i.test(textBeforeCursor);
	}

	async #tryTriggerAutocomplete(explicitTab: boolean = false): Promise<void> {
		if (!this.#autocompleteProvider) return;
		if (
			explicitTab &&
			this.#autocompleteProvider.shouldTriggerFileCompletion &&
			!this.#autocompleteProvider.shouldTriggerFileCompletion(
				this.#state.lines.slice(),
				this.#state.cursorLine,
				this.#state.cursorCol,
			)
		) {
			return;
		}
		await this.#queueAutocompleteRequest({ kind: "regular", explicitTab });
	}
	#createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : AUTOCOMPLETE_SELECT_LIST_LAYOUT;
		// A fresh list starts on row 0 by construction, not by user choice.
		this.#autocompleteNavigated = false;
		return new SelectList(items, this.#autocompleteMaxVisible, this.#theme.selectList, layout);
	}

	async #handleTabCompletion(): Promise<void> {
		const wordCompletion = this.#getWordCompletion();
		if (wordCompletion) {
			const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
			const after = currentLine.slice(this.#state.cursorCol);
			this.#insertTextAtCursor(wordCompletion + (/^[\s.,;:!?"\])}]/.test(after) ? "" : " "));
			return;
		}
		if (!this.#autocompleteProvider) return;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		if (this.#isInSubmittedSlashCommandContext() && !beforeCursor.trimStart().includes(" ")) {
			await this.#handleSlashCommandCompletion();
		} else if (this.#isInMidPromptSkillSlashContext()) {
			await this.#handleSlashCommandCompletion();
			if (!this.#autocompleteState) {
				await this.#forceFileAutocomplete();
			}
		} else {
			await this.#forceFileAutocomplete();
		}
	}
	async #showSpellingSuggestions(): Promise<void> {
		const cursorLine = this.#state.cursorLine;
		const cursorCol = this.#state.cursorCol;
		const lines = [...this.#state.lines];
		const textAssistProvider = this.#textAssistProvider;
		const textAssistProviderRevision = this.#textAssistProviderRevision;
		const result = textAssistProvider?.getWordReplacements?.(lines, cursorLine, cursorCol);
		const replacements = result instanceof Promise ? await result.catch(() => null) : result;
		if (
			textAssistProvider !== this.#textAssistProvider ||
			textAssistProviderRevision !== this.#textAssistProviderRevision ||
			!replacements ||
			this.#state.cursorLine !== cursorLine ||
			this.#state.cursorCol !== cursorCol ||
			this.#state.lines[replacements.line] !== lines[replacements.line] ||
			replacements.line < 0 ||
			replacements.line >= this.#state.lines.length ||
			replacements.startCol < 0 ||
			replacements.endCol <= replacements.startCol ||
			replacements.items.length === 0
		) {
			return;
		}
		const line = this.#state.lines[replacements.line] ?? "";
		if (replacements.endCol > line.length) return;
		const original = line.slice(replacements.startCol, replacements.endCol);
		this.#autocompletePrefix = original;
		this.#autocompleteList = this.#createAutocompleteList(
			original,
			replacements.items.map(value => ({ value, label: value })),
		);
		this.#autocompleteState = "assist";
		// An in-flight regular request would republish the suggestion list
		// over the assist list once it resolves: invalidate it.
		this.#invalidateAutocompleteRequests();
		this.#textAssistReplacement = {
			line: replacements.line,
			startCol: replacements.startCol,
			endCol: replacements.endCol,
			original,
			cursorOffset:
				replacements.line === this.#state.cursorLine ? Math.max(0, this.#state.cursorCol - replacements.endCol) : 0,
		};
		this.onAutocompleteUpdate?.();
	}

	#applySpellingSuggestion(): void {
		const replacement = this.#textAssistReplacement;
		const selected = this.#autocompleteList?.getSelectedItem();
		if (!replacement || !selected) {
			this.#cancelAutocomplete();
			return;
		}
		const line = this.#state.lines[replacement.line] ?? "";
		if (line.slice(replacement.startCol, replacement.endCol) !== replacement.original) {
			this.#cancelAutocomplete();
			return;
		}
		this.#recordUndoState();
		this.#setLine(
			replacement.line,
			line.slice(0, replacement.startCol) + selected.value + line.slice(replacement.endCol),
		);
		this.#state.cursorLine = replacement.line;
		this.#setCursorCol(replacement.startCol + selected.value.length + replacement.cursorOffset);
		this.#lastAction = null;
		this.#cancelAutocomplete();
		this.onAutocompleteUpdate?.();
		this.onChange?.(this.getText());
	}
	async #handleSlashCommandCompletion(): Promise<void> {
		await this.#tryTriggerAutocomplete();
	}

	async #forceFileAutocomplete(): Promise<void> {
		if (!this.#autocompleteProvider) return;
		if (typeof this.#autocompleteProvider.getForceFileSuggestions !== "function") {
			await this.#tryTriggerAutocomplete(true);
			return;
		}
		await this.#queueAutocompleteRequest({ kind: "force" });
	}

	#cancelAutocomplete(notifyCancel: boolean = false): void {
		const wasAutocompleting = this.#autocompleteState !== null;
		this.#clearAutocompleteTimeout();
		this.#invalidateAutocompleteRequests();
		this.#autocompleteState = null;
		this.#autocompleteList = undefined;
		this.#autocompleteNavigated = false;
		this.#textAssistReplacement = undefined;
		this.#autocompletePrefix = "";
		if (notifyCancel && wasAutocompleting) {
			this.onAutocompleteCancel?.();
		}
	}

	isShowingAutocomplete(): boolean {
		return this.#autocompleteState !== null;
	}

	async #updateAutocomplete(): Promise<void> {
		if (!this.#autocompleteState || !this.#autocompleteProvider || this.#autocompleteState === "assist") return;
		if (this.#autocompleteState === "force") {
			await this.#forceFileAutocomplete();
			return;
		}
		await this.#queueAutocompleteRequest({ kind: "regular", explicitTab: false });
	}

	#queueAutocompleteRequest(request: AutocompleteRequest): Promise<void> {
		const waiter = Promise.withResolvers<void>();
		this.#autocompleteWaiters.push(waiter.resolve);
		this.#autocompletePendingRequest = request;
		this.#autocompleteRequestId++;
		this.#autocompleteAbortController?.abort();
		if (!this.#autocompleteRequestRunning) void this.#drainAutocompleteRequests();
		return waiter.promise;
	}

	async #drainAutocompleteRequests(): Promise<void> {
		if (this.#autocompleteRequestRunning) return;
		this.#autocompleteRequestRunning = true;
		try {
			while (this.#autocompletePendingRequest) {
				const request = this.#autocompletePendingRequest;
				this.#autocompletePendingRequest = undefined;
				const requestId = this.#autocompleteRequestId;
				const controller = new AbortController();
				this.#autocompleteAbortController = controller;
				await this.#runAutocompleteRequest(request, requestId, controller.signal);
				if (this.#autocompleteAbortController === controller) {
					this.#autocompleteAbortController = undefined;
				}
			}
		} finally {
			this.#autocompleteRequestRunning = false;
			const waiters = this.#autocompleteWaiters.splice(0);
			for (const resolve of waiters) resolve();
		}
	}

	async #runAutocompleteRequest(request: AutocompleteRequest, requestId: number, signal: AbortSignal): Promise<void> {
		const provider = this.#autocompleteProvider;
		if (!provider) return;
		const lines = [...this.#state.lines];
		const cursorLine = this.#state.cursorLine;
		const cursorCol = this.#state.cursorCol;
		let suggestions: { items: AutocompleteItem[]; prefix: string } | null;
		try {
			if (request.kind === "force") {
				const getForceFileSuggestions = provider.getForceFileSuggestions;
				if (!getForceFileSuggestions) return;
				suggestions = await getForceFileSuggestions.call(provider, lines, cursorLine, cursorCol, signal);
			} else {
				suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, signal);
			}
		} catch (error) {
			if (!signal.aborted && requestId === this.#autocompleteRequestId) {
				logger.debug("Autocomplete provider failed", { error: String(error) });
				this.#cancelAutocomplete();
				this.onAutocompleteUpdate?.();
			}
			return;
		}
		if (
			signal.aborted ||
			requestId !== this.#autocompleteRequestId ||
			cursorLine !== this.#state.cursorLine ||
			cursorCol !== this.#state.cursorCol ||
			lines.length !== this.#state.lines.length ||
			lines.some((line, index) => line !== this.#state.lines[index])
		) {
			return;
		}

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = request.kind === "force" ? "force" : "regular";
			this.onAutocompleteUpdate?.();
			return;
		}
		this.#cancelAutocomplete();
		this.onAutocompleteUpdate?.();
	}

	#invalidateAutocompleteRequests(): void {
		this.#autocompletePendingRequest = undefined;
		this.#autocompleteRequestId++;
		this.#autocompleteAbortController?.abort();
		const waiters = this.#autocompleteWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	#debouncedUpdateAutocomplete(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
		}
		// A mutation makes any in-flight provider I/O stale right now, not in
		// 100 ms: abort it so the debounced refresh is not serialized behind
		// uncancelled filesystem work for text the user already replaced.
		this.#autocompleteAbortController?.abort();
		this.#autocompleteAbortController = undefined;
		this.#autocompleteTimeout = setTimeout(() => {
			void this.#updateAutocomplete();
			this.#autocompleteTimeout = undefined;
		}, 100);
	}

	#clearAutocompleteTimeout(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
			this.#autocompleteTimeout = undefined;
		}
	}

	#getInlineHint(): string | null {
		if (this.#autocompleteState && this.#autocompleteList) {
			const selected = this.#autocompleteList.getSelectedItem();
			return selected?.hint ?? null;
		}

		if (this.#placeholder && this.#state.lines.length === 1 && this.#state.lines[0] === "") {
			return this.#placeholder;
		}

		if (this.#autocompleteProvider?.getInlineHint) {
			const hint = this.#autocompleteProvider.getInlineHint(
				this.#state.lines.slice(),
				this.#state.cursorLine,
				this.#state.cursorCol,
			);
			if (hint) return hint;
		}

		return this.#getWordCompletion();
	}
	#getWordCompletion(): string | null {
		return (
			this.#textAssistProvider?.getWordCompletion?.(
				this.#state.lines.slice(),
				this.#state.cursorLine,
				this.#state.cursorCol,
			) ?? null
		);
	}
}
