import { fileURLToPath } from "node:url";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	addKeyAliases,
	canonicalKeyId,
	EDITOR_LIMITS,
	Editor,
	type EditorTextDecorationContext,
	type EditorTheme,
	getKeybindings,
	type KeyId,
	parseKey,
	parseKittySequence,
	TUI,
} from "@oh-my-pi/pi-tui";
import { BracketedPasteHandler } from "@oh-my-pi/pi-tui/bracketed-paste";
import { materializeString } from "@oh-my-pi/pi-utils/materialize-string";
import type { AppKeybinding } from "../../config/keybindings";
import {
	attachmentSgr,
	COMPOSER_TOKEN_REGEX,
	chipLabel,
	collapseImageMarkers,
	renderPlaceholders,
} from "../composer-attachments";
import { MacOSSpellingProvider, type SpellingFeatures } from "../macos-spelling";
import { hasMagicKeyword, highlightMagicKeywords } from "../magic-keywords";
import { isQueuedMessageList, parseQueueShorthand, QUEUE_LIST_MARKER_RE } from "../queue-input";
import { fgOrPlain, theme } from "../theme/theme";

type ConfigurableEditorAction = Extract<
	AppKeybinding,
	| "app.interrupt"
	| "app.clear"
	| "app.exit"
	| "app.suspend"
	| "app.display.reset"
	| "app.thinking.cycle"
	| "app.model.cycleForward"
	| "app.model.cycleBackward"
	| "app.model.select"
	| "app.model.selectTemporary"
	| "app.tools.toggleVisibility"
	| "app.thinking.toggle"
	| "app.editor.external"
	| "app.history.search"
	| "app.message.dequeue"
	| "app.retry"
	| "app.clipboard.pasteImage"
	| "app.clipboard.pasteTextRaw"
	| "app.clipboard.copyPrompt"
>;

const DEFAULT_ACTION_KEYS: Record<ConfigurableEditorAction, KeyId[]> = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.suspend": ["ctrl+z"],
	"app.display.reset": ["alt+l"],
	"app.thinking.cycle": ["shift+tab"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["shift+ctrl+p"],
	"app.model.select": ["alt+m"],
	"app.model.selectTemporary": ["alt+p"],
	"app.tools.toggleVisibility": ["ctrl+shift+o"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.editor.external": ["ctrl+g"],
	"app.history.search": ["ctrl+r"],
	"app.message.dequeue": ["alt+up"],
	"app.retry": ["alt+r"],
	"app.clipboard.pasteImage": ["ctrl+v"],
	"app.clipboard.pasteTextRaw": ["ctrl+shift+v", "alt+shift+v"],
	"app.clipboard.copyPrompt": ["alt+shift+c"],
};

function buildMatchKeys(keys: readonly KeyId[]): Set<string> {
	const matchKeys = new Set<string>();
	for (const key of keys) {
		addKeyAliases(matchKeys, key);
	}
	return matchKeys;
}

function unionOfMatchKeys(matchKeys: ReadonlyMap<ConfigurableEditorAction, ReadonlySet<string>>): Set<string> {
	const union = new Set<string>();
	for (const keys of matchKeys.values()) {
		for (const key of keys) union.add(key);
	}
	return union;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;
const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;
const URI_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;
const FILE_URI_REGEX = /^file:\/\//i;

const ABSOLUTE_PATH_PREFIX_SOURCE = String.raw`(?:\/|~\/|file:\/\/|\\\\|[A-Za-z]:[\\/])`;

const ABSOLUTE_PATH_PREFIX_REGEX = new RegExp(`^${ABSOLUTE_PATH_PREFIX_SOURCE}`);

const INTERIOR_PATH_ANCHOR_REGEX = new RegExp(String.raw`(?<!\\)\s(?:${ABSOLUTE_PATH_PREFIX_SOURCE}|\.\.?[\\/])`);

function isPastedPathSeparator(char: string | undefined): boolean {
	return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

function normalizePastedPath(path: string): string {
	const trimmed = path.trim();
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const unquoted =
		trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;

	if (FILE_URI_REGEX.test(unquoted)) {
		try {
			return fileURLToPath(unquoted);
		} catch {}
	}
	return unquoted.replace(SHELL_ESCAPED_PATH_CHAR_REGEX, "$1");
}

function isExplicitPastedPath(path: string): boolean {
	if (FILE_URI_REGEX.test(path)) return true;
	if (URI_SCHEME_REGEX.test(path)) return false;
	return path.includes("/") || path.includes("\\");
}

function isImagePath(path: string): boolean {
	return BRACKETED_IMAGE_PATH_REGEX.test(path);
}

function splitPastedPathSegments(payload: string): string[] | undefined {
	const segments: string[] = [];
	let segment = "";
	let quote: string | undefined;
	let escaped = false;

	for (let i = 0; i < payload.length; i++) {
		const char = payload[i];
		if (escaped) {
			segment += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			segment += char;
			escaped = true;
			continue;
		}
		if (quote) {
			segment += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			segment += char;
			quote = char;
			continue;
		}
		if (isPastedPathSeparator(char)) {
			if (segment) {
				segments.push(segment);
				segment = "";
			}
			continue;
		}
		segment += char;
	}

	if (escaped || quote) return undefined;
	if (segment) segments.push(segment);
	return segments.length > 0 ? segments : undefined;
}

function extractExplicitPathSegments(payload: string): string[] | undefined {
	const pasted = payload.trim();
	if (!pasted) return undefined;

	const segments = splitPastedPathSegments(pasted);
	if (!segments) return undefined;

	const paths: string[] = [];
	for (const segment of segments) {
		const path = normalizePastedPath(segment);
		if (!path || !isExplicitPastedPath(path)) return undefined;
		paths.push(path);
	}
	return paths;
}

export function extractPastePathsFromText(text: string): string[] | undefined {
	return extractExplicitPathSegments(text);
}

function extractWholeTextImagePath(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed || /[\r\n]/.test(trimmed) || !ABSOLUTE_PATH_PREFIX_REGEX.test(trimmed)) return undefined;
	if (INTERIOR_PATH_ANCHOR_REGEX.test(trimmed)) return undefined;
	const wholePath = normalizePastedPath(trimmed);
	return wholePath && isExplicitPastedPath(wholePath) && isImagePath(wholePath) ? wholePath : undefined;
}

export function extractImagePastePathsFromText(text: string): string[] | undefined {
	const paths = extractPastePathsFromText(text);
	if (paths !== undefined) return paths.every(isImagePath) ? paths : undefined;
	const wholePath = extractWholeTextImagePath(text);
	return wholePath ? [wholePath] : undefined;
}

function bracketedPastePayload(data: string): string | undefined {
	if (!data.startsWith(BRACKETED_PASTE_START)) return undefined;
	const endIndex = data.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
	if (endIndex === -1 || endIndex + BRACKETED_PASTE_END.length !== data.length) return undefined;
	return data.slice(BRACKETED_PASTE_START.length, endIndex);
}

export function extractBracketedPastePaths(data: string): string[] | undefined {
	const payload = bracketedPastePayload(data);
	return payload === undefined ? undefined : extractExplicitPathSegments(payload);
}

export function extractBracketedImagePastePaths(data: string): string[] | undefined {
	const payload = bracketedPastePayload(data);
	return payload === undefined ? undefined : extractImagePastePathsFromText(payload);
}

export function extractImagePathFromText(text: string): string | undefined {
	const paths = extractPastePathsFromText(text);
	if (paths?.length === 1 && isImagePath(paths[0])) return paths[0];
	if (paths !== undefined) return undefined;
	return extractWholeTextImagePath(text);
}

function pickEditorTheme(args: readonly unknown[]): EditorTheme {
	for (const arg of args) {
		if (isEditorTheme(arg)) return arg;
	}

	return args[0] as EditorTheme;
}

function isEditorTheme(value: unknown): value is EditorTheme {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<EditorTheme>;
	return (
		typeof candidate.borderColor === "function" && typeof candidate.symbols === "object" && candidate.symbols !== null
	);
}

export interface TextAttachment {
	n: number;
	label: string;
	content: string;
	lineCount: number;
	charCount: number;
}

export type ComposerChipDescriptor =
	| { kind: "image"; n: number; image: ImageContent; link: string | undefined }
	| { kind: "paste"; n: number; text: TextAttachment };

export const COMPOSER_IMAGE_LIMITS = { count: 32, bytes: 32 * 1024 * 1024 } as const;
const MAX_QUEUED_INPUT_BYTES = 256 * 1024;
const MAX_QUEUED_INPUT_CHUNKS = 128;

export class CustomEditor extends Editor {
	#spelling = new MacOSSpellingProvider();
	imageLinks?: readonly (string | undefined)[];

	#pendingImages: ImageContent[] = [];
	#disposed = false;
	#materializingDraftLinks = false;

	get pendingImages(): readonly ImageContent[] {
		return this.#pendingImages;
	}

	set pendingImages(images: readonly ImageContent[]) {
		this.assertDraftImages(images);
		this.#pendingImages = images.map(image => ({ ...image, data: materializeString(image.data) }));
	}

	assertDraftImages(images: readonly ImageContent[]): void {
		let bytes = 0;
		for (const image of images) bytes += Buffer.byteLength(image.data);
		if (images.length > COMPOSER_IMAGE_LIMITS.count || bytes > COMPOSER_IMAGE_LIMITS.bytes) {
			throw new RangeError("Draft image limit reached (32 images / 32 MiB base64); submit or clear images first");
		}
	}

	pendingImageLinks: (string | undefined)[] = [];

	pendingTexts: TextAttachment[] = [];
	#textAttachmentCounter = 0;

	draftImageLinkMaterializer?: (images: readonly ImageContent[]) => Promise<(string | undefined)[] | undefined>;

	tui?: TUI;

	constructor(...args: readonly unknown[]) {
		super(pickEditorTheme(args));
		const requestTextAssistRepaint = (): void => {
			this.invalidate();
			this.#requestShimmerRepaint?.();
		};
		this.#spelling.onUpdate = requestTextAssistRepaint;
		this.onTextAssistApplied = requestTextAssistRepaint;
		this.setTextAssistProvider(this.#spelling);
		if (args[0] instanceof TUI) this.tui = args[0];
	}

	setSpellingFeatures(features: SpellingFeatures): void {
		this.#spelling.setFeatures(features);
	}

	clearDraft(historyText?: string): void {
		if (historyText !== undefined) this.addToHistory(historyText);
		this.setText("");
		this.clearAtoms();
		this.imageLinks = undefined;
		this.pendingImages = [];
		this.pendingImageLinks = [];
		this.pendingTexts = [];
		this.#textAttachmentCounter = 0;
	}

	setDraft(text: string, images?: readonly ImageContent[]): void {
		if (Buffer.byteLength(text) > EDITOR_LIMITS.draftBytes) {
			this.onInputRejected?.("Draft exceeds the 4 MiB UTF-8 limit; existing draft was preserved");
			return;
		}
		try {
			this.assertDraftImages(images ?? []);
		} catch (error) {
			this.onInputRejected?.(String(error));
			return;
		}
		this.clearAtoms();
		this.pendingTexts = [];
		this.#textAttachmentCounter = 0;
		this.imageLinks = undefined;
		this.pendingImages = images ? [...images] : [];
		this.pendingImageLinks = images ? images.map(() => undefined) : [];
		this.setCollapsedText(text);
		void this.#materializeDraftLinks().catch(error => this.onInputRejected?.(String(error)));
	}

	setCollapsedText(text: string): void {
		this.setText(
			collapseImageMarkers(text, this.pendingImages.length, (label, expansion) =>
				this.registerAtom(label, expansion),
			),
		);
	}

	insertTextAttachment(content: string, expansion: string = content): void {
		const n = this.#textAttachmentCounter + 1;
		const label = chipLabel("paste", n);
		let bytes = Buffer.byteLength(content);
		for (const entry of this.pendingTexts) bytes += Buffer.byteLength(entry.content);
		if (bytes > EDITOR_LIMITS.attachmentBytes || this.pendingTexts.length >= EDITOR_LIMITS.attachmentCount) {
			this.onInputRejected?.("Text attachment limit reached (16 MiB / 256 attachments)");
			return;
		}
		if (!this.insertAtom(label, expansion)) return;
		this.#textAttachmentCounter = n;
		this.pendingTexts.push({
			n,
			label,
			content: materializeString(content),
			lineCount: content.split("\n").length,
			charCount: content.length,
		});
	}

	composerChips(): ComposerChipDescriptor[] {
		const text = this.getText();
		const chips: ComposerChipDescriptor[] = [];
		for (let i = 0; i < this.pendingImages.length; i++) {
			const n = i + 1;
			const visible =
				text.includes(chipLabel("image", n)) || text.includes(`[Image #${n}]`) || text.includes(`[Image #${n},`);
			if (!visible) continue;
			chips.push({ kind: "image", n, image: this.pendingImages[i], link: this.pendingImageLinks[i] });
		}
		for (const entry of this.pendingTexts) {
			if (!text.includes(entry.label)) continue;
			chips.push({ kind: "paste", n: entry.n, text: entry });
		}
		return chips;
	}

	async #materializeDraftLinks(): Promise<void> {
		if (this.#materializingDraftLinks || this.#disposed) return;
		this.#materializingDraftLinks = true;
		try {
			while (!this.#disposed) {
				const materialize = this.draftImageLinkMaterializer;
				const images = this.pendingImages;
				if (!materialize || images.length === 0) return;
				const links = await materialize(images);
				if (this.#disposed) return;
				if (this.pendingImages !== images) continue;
				if (links) {
					this.pendingImageLinks = links;
					this.imageLinks = links;
					this.#requestShimmerRepaint?.();
				}
				return;
			}
		} finally {
			this.#materializingDraftLinks = false;
		}
	}

	override atomicTokenPattern = COMPOSER_TOKEN_REGEX;

	static readonly SHIMMER_FRAME_MS = 70;

	static readonly SHIMMER_PERIOD_MS = 1800;

	#shimmerTimer: Timer | undefined;

	#requestShimmerRepaint: (() => void) | undefined;
	#queueDecorationText: string | undefined;
	#decorationLines: readonly string[] = [""];
	#queueShorthandActive = false;
	#queueListActive = false;

	override decorateText = (text: string, context: EditorTextDecorationContext): string => {
		const editorText = this.getText();
		const animated = this.focused && this.#shimmerEnabled() && hasMagicKeyword(editorText);
		const phase = animated ? (Date.now() % CustomEditor.SHIMMER_PERIOD_MS) / CustomEditor.SHIMMER_PERIOD_MS : 0;
		if (animated) this.#scheduleShimmerFrame();
		if (this.#queueDecorationText !== editorText) {
			this.#queueDecorationText = editorText;
			this.#decorationLines = this.getLines();
			const queueBody = parseQueueShorthand(editorText);
			this.#queueShorthandActive = queueBody !== undefined;
			this.#queueListActive = queueBody !== undefined && isQueuedMessageList(queueBody);
		}
		let sourceSearchOffset = 0;
		const locateSource = (value: string): number => {
			const offset = text.indexOf(value, sourceSearchOffset);
			if (offset === -1) return sourceSearchOffset;
			sourceSearchOffset = offset + value.length;
			return offset;
		};
		return renderPlaceholders(text, {
			renderText: value => {
				const sourceOffset = locateSource(value);
				const highlighted = this.#spelling.decorateTypos(
					value,
					{
						editorText,
						lines: this.#decorationLines,
						line: context.line,
						startCol: context.startCol + sourceOffset,
					},
					span => highlightMagicKeywords(span, undefined, phase),
				);
				if (this.#queueShorthandActive && (value.startsWith("->") || value.startsWith("=>"))) {
					const icon = typeof theme === "undefined" ? "➤" : theme.nav.selected;
					return `${fgOrPlain("dim", `Queueing ${icon}`)}${highlighted.slice(2)}`;
				}
				if (this.#queueListActive) {
					const markerMatch = QUEUE_LIST_MARKER_RE.exec(value);
					if (markerMatch) {
						const indent = markerMatch[1] ?? "";
						const markerEnd = markerMatch[0].length;
						return `${indent}${fgOrPlain("accent", value.slice(indent.length, markerEnd))}${highlighted.slice(markerEnd)}`;
					}
				}
				return highlighted;
			},
			renderReference: (value, kind, index, form) => {
				locateSource(value);
				if (form === "chip") {
					const styled = `${attachmentSgr(kind, index)}\x1b[1m${value}\x1b[22m\x1b[39m`;
					return kind === "image"
						? this.imageReferenceHyperlink(value, index, this.imageLinks, () => styled)
						: styled;
				}
				return kind === "image"
					? this.imageReferenceHyperlink(value, index, this.imageLinks, label =>
							fgOrPlain("accent", label, `\x1b[1m\x1b[4m${label}\x1b[24m\x1b[22m`),
						)
					: fgOrPlain("accent", value, `\x1b[1m${value}\x1b[22m`);
			},
		});
	};

	magicKeywordsEnabledOverride: boolean | undefined;

	magicKeywordsEnabled: () => boolean = () => true;

	imageReferenceHyperlink: (
		label: string,
		index: number,
		imageLinks: readonly (string | undefined)[] | undefined,
		renderLabel: (text: string) => string,
	) => string = (label, _index, _imageLinks, renderLabel) => renderLabel(label);

	#shimmerEnabled(): boolean {
		return this.magicKeywordsEnabledOverride ?? this.magicKeywordsEnabled();
	}

	setShimmerRepaintHandler(handler: (() => void) | undefined): void {
		this.#requestShimmerRepaint = handler;
		if (!handler && this.#shimmerTimer) {
			clearTimeout(this.#shimmerTimer);
			this.#shimmerTimer = undefined;
		}
	}

	override dispose(): void {
		this.#disposed = true;
		this.#pendingInput = [];
		this.#pendingInputBytes = 0;
		this.#pasteHandler.clear();
		this.#queuedPasteHandler.clear();
		this.#queueDecorationText = undefined;
		this.#decorationLines = [""];
		this.setShimmerRepaintHandler(undefined);
		this.#spelling.onUpdate = undefined;
		this.pendingImages = [];
		this.pendingImageLinks = [];
		this.pendingTexts = [];
		this.imageLinks = undefined;
		this.draftImageLinkMaterializer = undefined;
		super.dispose();
	}

	#scheduleShimmerFrame(): void {
		if (this.#shimmerTimer || !this.#requestShimmerRepaint) return;
		this.#shimmerTimer = setTimeout(() => {
			this.#shimmerTimer = undefined;
			this.#requestShimmerRepaint?.();
		}, CustomEditor.SHIMMER_FRAME_MS);
		this.#shimmerTimer.unref?.();
	}
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModel?: () => void;
	onToggleToolActivity?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onHistorySearch?: () => void;
	onSuspend?: () => void;
	onSelectModelTemporary?: () => void;

	onCopyPrompt?: () => void;

	onPasteImage?: () => Promise<boolean>;

	onPasteImagePath?: (path: string) => void | Promise<void>;

	onPasteTextRaw?: () => void | Promise<void>;

	onDequeue?: () => void;

	onRetry?: () => void;

	onCapsLock?: () => void;

	onLeftAtStart?: () => void;

	#customKeyHandlers = new Map<KeyId, () => void>();
	#customMatchKeys = new Map<string, () => void>();

	#pasteHandler = new BracketedPasteHandler();

	#pasteInFlight = 0;

	#pendingInput: string[] = [];
	#pendingInputBytes = 0;
	#queuedPasteHandler = new BracketedPasteHandler({ byteLimit: MAX_QUEUED_INPUT_BYTES });
	#actionKeys = new Map<ConfigurableEditorAction, KeyId[]>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [action as ConfigurableEditorAction, [...keys]]),
	);
	#actionMatchKeys = new Map<ConfigurableEditorAction, Set<string>>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [
			action as ConfigurableEditorAction,
			buildMatchKeys(keys),
		]),
	);

	#actionMatchKeyUnion = unionOfMatchKeys(this.#actionMatchKeys);

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionKeys.set(action, [...keys]);
		this.#actionMatchKeys.set(action, buildMatchKeys(keys));
		this.#actionMatchKeyUnion = unionOfMatchKeys(this.#actionMatchKeys);
	}

	#rebuildCustomMatchKeys(): void {
		this.#customMatchKeys.clear();
		for (const [keyId, handler] of this.#customKeyHandlers) {
			for (const alias of buildMatchKeys([keyId])) {
				if (!this.#customMatchKeys.has(alias)) this.#customMatchKeys.set(alias, handler);
			}
		}
	}

	#matchesAction(canonical: string | undefined, action: ConfigurableEditorAction): boolean {
		return canonical !== undefined && (this.#actionMatchKeys.get(action)?.has(canonical) ?? false);
	}

	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
		this.#rebuildCustomMatchKeys();
	}

	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
		this.#rebuildCustomMatchKeys();
	}

	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
		this.#rebuildCustomMatchKeys();
	}

	#onPasteSettled = (): void => {
		this.#pasteInFlight--;
		if (this.#pasteInFlight > 0 || this.#disposed || this.#queuedPasteHandler.active) return;
		this.#drainPendingInput();
	};

	#trackAsyncPaste(promise: Promise<unknown>): void {
		this.#pasteInFlight++;
		void promise.catch(error => this.onInputRejected?.(String(error))).then(this.#onPasteSettled);
	}

	#drainPendingInput(): void {
		const drained = this.#pendingInput;
		this.#pendingInput = [];
		this.#pendingInputBytes = 0;
		for (const chunk of drained) this.handleInput(chunk);
	}

	#queueInput(data: string): void {
		const bytes = Buffer.byteLength(data);
		if (
			this.#pendingInput.length >= MAX_QUEUED_INPUT_CHUNKS ||
			this.#pendingInputBytes + bytes > MAX_QUEUED_INPUT_BYTES
		) {
			this.onInputRejected?.("Input queue is full (128 chunks / 256 KiB); incoming input was discarded");
			return;
		}
		this.#pendingInput.push(materializeString(data));
		this.#pendingInputBytes += bytes;
	}

	override handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#pasteInFlight > 0 || this.#queuedPasteHandler.active) {
			const paste = this.#queuedPasteHandler.process(data);
			if (paste.handled) {
				if (paste.rejected) this.onInputRejected?.("Queued paste exceeds 256 KiB and was discarded");
				if (paste.pasteContent !== undefined)
					this.#queueInput(`${BRACKETED_PASTE_START}${paste.pasteContent}${BRACKETED_PASTE_END}`);
			} else this.#queueInput(data);
			if (this.#pasteInFlight === 0 && !this.#queuedPasteHandler.active) this.#drainPendingInput();
			return;
		}

		const hadBareQueuePrefix = this.textEquals("->") || this.textEquals("=>");
		const kittyParsed = data.charCodeAt(0) === 0x1b ? parseKittySequence(data) : null;
		if (kittyParsed && (kittyParsed.modifier & 64) !== 0 && this.onCapsLock) {
			this.onCapsLock();
			return;
		}

		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.rejected) this.onInputRejected?.("Paste exceeds the 4 MiB UTF-8 limit and was discarded");
			if (paste.pasteContent === undefined) return;
			const content = paste.pasteContent;

			if (content.length === 0 && this.onPasteImage) {
				this.#trackAsyncPaste(Promise.resolve(this.onPasteImage()));
				return;
			}
			const imagePaths = extractImagePastePathsFromText(content);
			if (imagePaths && this.onPasteImagePath) {
				if (imagePaths.length > COMPOSER_IMAGE_LIMITS.count) {
					this.onInputRejected?.("At most 32 image paths can be pasted at once");
					return;
				}
				this.#trackAsyncPaste(
					(async () => {
						for (const p of imagePaths) await this.onPasteImagePath?.(p);
					})(),
				);
				return;
			}
			this.pasteText(content);

			this.#drainPendingInput();
			return;
		}

		const parsedKey = parseKey(data);
		const canonical = parsedKey !== undefined ? canonicalKeyId(parsedKey) : undefined;

		if (canonical === "left" && this.onLeftAtStart && this.getText().trim() === "") {
			this.onLeftAtStart();
			return;
		}

		// Ctrl+C copies while a selection is visible and keeps its clear-draft /
		// exit role otherwise; collapsing afterwards lets a second Ctrl+C clear.
		if (this.hasSelection() && (canonical === "ctrl+c" || this.#matchesAction(canonical, "app.clear"))) {
			super.handleInput(data);
			this.clearSelection();
			return;
		}

		if (
			canonical !== undefined &&
			(this.#actionMatchKeyUnion.has(canonical) || this.#customMatchKeys.has(canonical))
		) {
			if (this.#matchesAction(canonical, "app.clipboard.pasteImage") && this.onPasteImage) {
				this.#trackAsyncPaste(Promise.resolve(this.onPasteImage()));
				return;
			}

			if (this.#matchesAction(canonical, "app.clipboard.pasteTextRaw") && this.onPasteTextRaw) {
				this.#trackAsyncPaste(Promise.resolve(this.onPasteTextRaw()));
				return;
			}

			if (this.#matchesAction(canonical, "app.editor.external") && this.onExternalEditor) {
				this.onExternalEditor();
				return;
			}

			if (this.#matchesAction(canonical, "app.model.selectTemporary") && this.onSelectModelTemporary) {
				this.onSelectModelTemporary();
				return;
			}

			if (this.#matchesAction(canonical, "app.display.reset") && this.onDisplayReset) {
				this.onDisplayReset();
				return;
			}

			if (this.#matchesAction(canonical, "app.suspend") && this.onSuspend) {
				this.onSuspend();
				return;
			}

			if (this.#matchesAction(canonical, "app.thinking.toggle") && this.onToggleThinking) {
				this.onToggleThinking();
				return;
			}

			if (this.#matchesAction(canonical, "app.model.select") && this.onSelectModel) {
				this.onSelectModel();
				return;
			}

			if (this.#matchesAction(canonical, "app.history.search") && this.onHistorySearch) {
				this.onHistorySearch();
				return;
			}

			if (this.#matchesAction(canonical, "app.tools.toggleVisibility") && this.onToggleToolActivity) {
				this.onToggleToolActivity();
				return;
			}

			if (this.#matchesAction(canonical, "app.model.cycleBackward") && this.onCycleModelBackward) {
				this.onCycleModelBackward();
				return;
			}

			if (this.#matchesAction(canonical, "app.model.cycleForward") && this.onCycleModelForward) {
				this.onCycleModelForward();
				return;
			}

			if (this.#matchesAction(canonical, "app.thinking.cycle") && this.onCycleThinkingLevel) {
				this.onCycleThinkingLevel();
				return;
			}

			if (this.#matchesAction(canonical, "app.interrupt") && this.onEscape && !this.isShowingAutocomplete()) {
				this.onEscape();
				return;
			}

			if (this.#matchesAction(canonical, "app.clear") && this.onClear) {
				this.onClear();
				return;
			}

			// When the exit key doubles as forward-delete (readline ^D: the default
			// app.exit binding overlaps tui.editor.deleteCharForward) and the buffer
			// is non-empty, delete the character at the cursor instead of quitting.
			// Invoking the operation directly keeps the exit chord's precedence slot:
			// neither a later handler bound to the same chord nor an earlier
			// base-editor action can steal it. Only an empty buffer exits. Draft
			// presence is read off the buffer alone: pending image/text records are
			// retained after their chips are deleted so numbering is not recycled.
			if (this.#matchesAction(canonical, "app.exit")) {
				const doublesAsForwardDelete =
					canonical !== undefined && getKeybindings().matchesCanonical(canonical, "tui.editor.deleteCharForward");
				if (doublesAsForwardDelete && !this.textEquals("")) {
					this.deleteCharForward();
					return;
				}
				this.onExit?.();
				return;
			}

			if (this.#matchesAction(canonical, "app.message.dequeue") && this.onDequeue) {
				this.onDequeue();
				return;
			}

			if (this.#matchesAction(canonical, "app.clipboard.copyPrompt") && this.onCopyPrompt) {
				this.onCopyPrompt();
				return;
			}

			if (this.#matchesAction(canonical, "app.retry") && this.onRetry) {
				const customHandler = this.#customMatchKeys.get(canonical);
				if (customHandler) {
					customHandler();
					return;
				}
				this.onRetry();
				return;
			}

			const handler = this.#customMatchKeys.get(canonical);
			if (handler) {
				handler();
				return;
			}
		}

		super.handleInput(data);
		if (!hadBareQueuePrefix && (this.textEquals("->") || this.textEquals("=>"))) {
			const cursor = this.getCursor();
			if (cursor.line === 0 && cursor.col === 2) {
				this.insertText("\n");
			}
		}
	}

	handleDraftEdit(data: string): void {
		const parsed = parseKey(data);
		const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;
		if (canonical !== undefined && this.#matchesAction(canonical, "app.clear")) {
			if (this.onClear) this.onClear();
			else this.setText("");
			return;
		}
		super.handleInput(data);
	}
}
