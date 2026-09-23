import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import {
	Container,
	Image,
	type ImageBudget,
	ImageProtocol,
	Markdown,
	replaceTabs,
	Spacer,
	TERMINAL,
	Text,
} from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { expandKeyHint, getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { convertImageToPng } from "../../utils/image-loading";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";
import { isRowPrefix, type TranscriptStableRow, trimBlankEdges } from "./transcript-container";

const MAX_TRANSCRIPT_ERROR_LINES = 8;
const EMPTY_STABLE_RENDER: readonly string[] = [];

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };
type StablePart = { kind: "thinking" | "text"; text: string } | { kind: "spacer" };

interface StableSnapshot {
	readonly partCount: number;
	readonly lastTextLength: number;
}

function isSnapshotExtension(previous: readonly StablePart[], current: readonly StablePart[]): boolean {
	if (previous.length > current.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const before = previous[index]!;
		const after = current[index]!;
		if (before.kind !== after.kind) return false;
		if (before.kind === "spacer" || after.kind === "spacer") continue;
		const isLast = index === previous.length - 1;
		if (isLast ? !after.text.startsWith(before.text) : after.text !== before.text) return false;
	}
	return true;
}

const EMPTY_THINKING_RENDERERS: readonly AssistantThinkingRenderer[] = [];
// Settled spaces tried, from the stream edge back, for one that already wraps.
const SPLIT_WRAP_SEARCH = 48;

function resolveThinkingDisplay(block: ThinkingContentBlock, proseOnly: boolean): { text: string; visible: boolean } {
	const rawThinking = (block as DisplayThinkingContentBlock).rawThinking;

	const formatted = rawThinking !== undefined ? block.thinking : formatThinkingForDisplay(block.thinking, proseOnly);
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(rawThinking ?? block.thinking, formatted),
	};
}

const THINKING_DOTS_FRAMES = ["⠀⠶⠀", "⠰⣿⠆", "⢸⣿⡇", "⢸⣉⡇", "⢾⣉⡷", "⣿⣉⣿", "⣏⠀⣹", "⡇⠀⢸", "⡁⠀⢈"] as const;
const THINKING_MARKDOWN_STYLE = {
	color: (text: string) => theme.fg("thinkingText", text),
	italic: true,
} as const;

const THINKING_DOTS_FRAME_MS_MIN = 70;
const THINKING_DOTS_FRAME_MS_MAX = 230;

const SPEED_WINDOW_MS = 3000;

const SPEED_MAX = 200;

class SpeedTracker {
	#observations: Array<{ time: number; rate: number }> = [];

	#prune(now: number): void {
		const threshold = now - SPEED_WINDOW_MS;
		while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) {
			this.#observations.shift();
		}
	}

	observe(rate: number, now = performance.now()): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
		this.#prune(now);
	}

	getSpeed(now = performance.now()): number {
		this.#prune(now);
		if (this.#observations.length === 0) return 0;
		let sum = 0;
		for (const o of this.#observations) sum += o.rate;
		return sum / this.#observations.length;
	}

	reset(): void {
		this.#observations = [];
	}
}

const sharedSpeedTracker = new SpeedTracker();

export function resetThinkingSpeedTracker(): void {
	sharedSpeedTracker.reset();
}

function lerpHex(from: string, to: string, t: number): string {
	const k = t < 0 ? 0 : t > 1 ? 1 : t;
	const fr = Number.parseInt(from.slice(1, 3), 16);
	const fg = Number.parseInt(from.slice(3, 5), 16);
	const fb = Number.parseInt(from.slice(5, 7), 16);
	const tr = Number.parseInt(to.slice(1, 3), 16);
	const tg = Number.parseInt(to.slice(3, 5), 16);
	const tb = Number.parseInt(to.slice(5, 7), 16);
	const r = Math.round(fr + (tr - fr) * k);
	const g = Math.round(fg + (tg - fg) * k);
	const b = Math.round(fb + (tb - fb) * k);
	return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export class AssistantMessageComponent extends Container {
	readonly transcriptBlockMode = "appendOnly" as const;
	#cacheInvalidationMarker?: CacheInvalidationMarkerComponent;
	#lastMessage?: AssistantMessage;
	#messagePersistenceKey?: string;
	#staticTextBlocks?: readonly string[];
	#convertedKittyImages?: Map<string, ImageContent>;
	#showImages = true;
	#kittyConversionsInFlight?: Set<string>;
	#transcriptBlockFinalized: boolean;

	#errorPinned = false;

	#errorExpanded = false;

	#hasTruncatableError = false;

	#lastUpdateTransient = false;

	#fastPathKey: string | undefined;
	#fastPathItems:
		| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
		| undefined;
	// Source offsets, per content block, of spaces rendered as hard line breaks
	// so a paragraph taller than the live viewport can retire in parts.
	readonly #paragraphCuts = new Map<number, number[]>();

	#thinkingDots: Text | undefined;
	// The constant "Thinking" heading is reproduced by semantic stable snapshots.
	#thinkingLabel: Text | undefined;
	#thinkingDotsTimer: NodeJS.Timeout | undefined;
	#thinkingDotsFrame = 0;

	#lastTokenCount: number | undefined;
	#lastTokenTime = 0;

	#thinkingTokens = 0;

	#thinkingRateLive = false;

	#stableSnapshots: StableSnapshot[] = [];
	#stableParts: readonly StablePart[] = [];
	#nextStableRowId = 0;
	#transcriptStableRows: TranscriptStableRow[] = [];
	#stableRenderCache = new LRUCache<string, readonly string[]>({ max: 64 });

	#textColorTransform?: (text: string) => string;

	setTextColorTransform(transform?: (text: string) => string): void {
		if (this.#textColorTransform === transform) return;
		this.#textColorTransform = transform;
		if (!this.#lastMessage && this.#staticTextBlocks !== undefined) this.#rebuildStaticTextContent();
	}
	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = EMPTY_THINKING_RENDERERS,
		private readonly imageBudget?: ImageBudget,
		private proseOnlyThinking = true,
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;

		if (message) {
			this.#applyContent(message);
		}
	}

	setCacheInvalidation(info: CacheInvalidation | undefined): void {
		this.#cacheInvalidationMarker = info ? new CacheInvalidationMarkerComponent(info) : undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.#cacheInvalidationMarker?.invalidate();

		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	override render(width: number): readonly string[] {
		// Finalized messages render through the memoized Container path: the
		// differential renderer hits per-child render caches, so repeated frames
		// are O(dirty) instead of re-parsing every block. Memory slimming happens
		// once at finalize (#compactFinalMessage), never per render.
		const contentLines = this.#renderStreamingChildren(width);
		const marker = this.#cacheInvalidationMarker;
		const lines = marker ? marker.render(width).concat(contentLines) : contentLines;
		this.#publishStableSnapshot(lines, width);
		if (this.#transcriptBlockFinalized) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			this.#compactFinalMessage();
		}
		return lines;
	}

	/** Width-independent identities for published semantic prefix snapshots. */
	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#transcriptStableRows;
	}

	/** Reset publication only alongside a destructive transcript replay. */
	resetTranscriptStableRows(): void {
		this.#stableSnapshots = [];
		this.#stableParts = [];
		this.#transcriptStableRows = [];
		this.#stableRenderCache.clear();
	}

	/**
	 * Split the paragraph still streaming at the end of the reply with a hard
	 * line break at a settled space, so the rows before it can retire while the
	 * rest streams. The transcript asks only when that paragraph is taller than
	 * the live viewport; otherwise its top would be clipped, and a resize could
	 * push the clipped rows into scrollback ahead of their block. The break
	 * prefers a space where the paragraph already wraps at `width`, so nothing
	 * moves on screen; it stays in the finished message too, so retired rows
	 * keep matching the block they came from.
	 */
	splitStableTail(width: number): boolean {
		const item = this.#fastPathItems?.at(-1);
		if (!item || this.#transcriptBlockFinalized || !this.#lastUpdateTransient) return false;
		// Offsets are into the text as set; source normalization would shift them.
		const original = item.lastText;
		if (item.md.getText() !== original) return false;
		const candidates = item.md.findParagraphCuts().filter(offset => original[offset] === " ");
		if (candidates.length === 0) return false;
		const current = item.md.render(width);
		let chosen = candidates.at(-1)!;
		for (const offset of candidates.slice(-SPLIT_WRAP_SEARCH).reverse()) {
			item.md.setText(`${original.slice(0, offset)}\\\n${original.slice(offset + 1)}`);
			const rows = item.md.render(width);
			if (rows.length === current.length && isRowPrefix(rows, current)) {
				chosen = offset;
				break;
			}
		}
		const cuts = this.#paragraphCuts.get(item.contentIndex) ?? [];
		// Each earlier cut widened the display text by one character.
		const cut = chosen - cuts.filter((offset, index) => offset + index < chosen).length;
		if (cuts.length > 0 && cut <= cuts.at(-1)!) {
			item.md.setText(original);
			return false;
		}
		this.#paragraphCuts.set(item.contentIndex, [...cuts, cut]);
		item.lastText = `${original.slice(0, chosen)}\\\n${original.slice(chosen + 1)}`;
		item.md.setText(item.lastText);
		return true;
	}

	/** Render recorded cuts as hard line breaks, dropping any the text no longer carries. */
	#withParagraphCuts(contentIndex: number, text: string): string {
		const cuts = this.#paragraphCuts.get(contentIndex);
		if (!cuts) return text;
		let output = "";
		let from = 0;
		for (let index = 0; index < cuts.length; index++) {
			const cut = cuts[index]!;
			if (text[cut] !== " " || !/\p{L}/u.test(text[cut + 1] ?? "")) {
				this.#paragraphCuts.set(contentIndex, cuts.slice(0, index));
				break;
			}
			output += `${text.slice(from, cut)}\\\n`;
			from = cut + 1;
		}
		return output + text.slice(from);
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		const requested = Number.isFinite(count) ? Math.trunc(count) : 0;
		const index = Math.max(0, Math.min(requested, this.#stableSnapshots.length));
		if (index === 0) return EMPTY_STABLE_RENDER;
		const key = `${index}:${width}`;
		const cached = this.#stableRenderCache.get(key);
		if (cached) return cached;

		const snapshot = this.#stableSnapshots[index - 1]!;
		const parts = this.#stableParts.slice(0, snapshot.partCount);
		const last = parts.at(-1);
		if (last && last.kind !== "spacer") {
			parts[parts.length - 1] = { kind: last.kind, text: last.text.slice(0, snapshot.lastTextLength) };
		}
		const rows = this.#renderStableSnapshot(parts, width);
		this.#stableRenderCache.set(key, rows);
		return rows;
	}

	#publishStableSnapshot(rendered: readonly string[], width: number): void {
		const parts = this.#currentStableSnapshot();
		if (!parts) return;
		const last = parts.at(-1);
		if (!last || last.kind === "spacer") return;

		const snapshot = { partCount: parts.length, lastTextLength: last.text.length };
		const previous = this.#stableSnapshots.at(-1);
		if (previous && !isSnapshotExtension(this.#stableParts, parts)) return;
		if (previous?.partCount === snapshot.partCount && previous.lastTextLength === snapshot.lastTextLength) return;

		const currentRows = this.#renderStableSnapshot(parts, width);
		if (!isRowPrefix(currentRows, trimBlankEdges(rendered))) return;
		const previousRows = previous
			? this.renderTranscriptStableRows(this.#stableSnapshots.length, width)
			: EMPTY_STABLE_RENDER;
		if (!isRowPrefix(previousRows, currentRows) || currentRows.length === previousRows.length) return;

		this.#stableParts = parts;
		this.#stableSnapshots.push(snapshot);
		this.#transcriptStableRows = [...this.#transcriptStableRows, { key: `assistant:${this.#nextStableRowId++}` }];
		this.#stableRenderCache.set(`${this.#stableSnapshots.length}:${width}`, currentRows);
	}

	#currentStableSnapshot(): readonly StablePart[] | undefined {
		if (this.#transcriptBlockFinalized || !this.#lastUpdateTransient || this.#cacheInvalidationMarker) {
			return undefined;
		}
		const items = this.#fastPathItems;
		if (!items || items.length === 0) return undefined;

		const parts: StablePart[] = [];
		let itemIndex = 0;
		for (const child of this.children) {
			if (child === this.#thinkingLabel) continue;
			const item = items[itemIndex];
			if (item?.md === child) {
				const source = item.md.getText();
				if (itemIndex === items.length - 1) {
					const stableText = item.md.getLastRenderStableText();
					const frozen = stableText.trim();
					if (frozen.length > 0 && /\S/.test(source.slice(stableText.length))) {
						parts.push({ kind: item.blockType, text: frozen });
					}
					break;
				}
				parts.push({ kind: item.blockType, text: source });
				itemIndex++;
				continue;
			}
			if (child instanceof Spacer) {
				parts.push({ kind: "spacer" });
				continue;
			}
			break;
		}
		while (parts.at(-1)?.kind === "spacer") parts.pop();
		return parts.length > 0 ? parts : undefined;
	}

	#renderStableSnapshot(parts: readonly StablePart[], width: number): readonly string[] {
		const rows: string[] = [];
		let renderedThinkingLabel = false;
		for (const [index, part] of parts.entries()) {
			if (part.kind === "spacer") {
				rows.push("");
				continue;
			}
			if (part.kind === "thinking" && !renderedThinkingLabel) {
				rows.push(...new Text(theme.fg("muted", "Thinking"), 2, 0).render(width));
				renderedThinkingLabel = true;
			}
			const markdown =
				part.kind === "text"
					? new Markdown(
							part.text.trim(),
							2,
							0,
							getMarkdownTheme(),
							this.#textColorTransform ? { color: this.#textColorTransform } : undefined,
							2,
						)
					: new Markdown(part.text.trim(), 2, 0, getMarkdownTheme(), THINKING_MARKDOWN_STYLE, 2);
			// The last part is cut mid-stream and may end inside an open code fence.
			if (index === parts.length - 1) markdown.setStreamPrefix(true);
			rows.push(...markdown.render(width));
		}
		return rows;
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.hideThinkingBlock = hide;
		this.#rebuildForDisplayChange();
	}

	setProseOnlyThinking(proseOnly: boolean): void {
		if (this.proseOnlyThinking === proseOnly) return;
		this.proseOnlyThinking = proseOnly;
		this.#rebuildForDisplayChange();
	}

	/**
	 * Children are materialized from the message at updateContent time, so a display toggle that
	 * changes what those children should contain has to rebuild them. Without this a finalized
	 * transcript block keeps rendering the thinking content the user just asked to hide.
	 */
	#rebuildForDisplayChange(): void {
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	override dispose(): void {
		this.#stopThinkingAnimation();
		super.dispose();
	}

	#shouldAnimateThinking(message: AssistantMessage): boolean {
		if (!this.hideThinkingBlock || this.#transcriptBlockFinalized) return false;
		let tail: "text" | "thinking" | undefined;
		for (const content of message.content) {
			if (content.type === "toolCall") return false;
			if (content.type === "text" && canonicalizeMessage(content.text)) tail = "text";
			else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) tail = "thinking";
		}
		return tail === "thinking";
	}

	#thinkingDotsLabel(): string {
		const glyph = THINKING_DOTS_FRAMES[this.#thinkingDotsFrame % THINKING_DOTS_FRAMES.length] ?? "…";
		const coloredGlyph = theme.fg("thinkingText", glyph);
		const thinkingLabel = theme.fg("muted", " Thinking");
		const rate = Math.min(SPEED_MAX, sharedSpeedTracker.getSpeed());

		if (!this.#thinkingRateLive || rate < 0.05) return coloredGlyph + thinkingLabel;

		const totalSpan = this.#thinkingTokens > 0 ? theme.fg("dim", ` · ${formatNumber(this.#thinkingTokens)}`) : "";

		const ratio = Math.sqrt(rate / SPEED_MAX);
		const hex = lerpHex(theme.getColorHex("dim"), theme.getAccentColorHex(), ratio);
		const rateText = ` · ${rate.toFixed(1)} toks/s`;
		const rateSpan = theme.getColorMode() === "truecolor" ? chalk.hex(hex)(rateText) : theme.fg("muted", rateText);
		return coloredGlyph + thinkingLabel + totalSpan + rateSpan;
	}

	#startThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) return;
		this.#scheduleThinkingFrame();
	}

	#thinkingDotsFrameDelay(): number {
		const phase = (1 - Math.cos((2 * Math.PI * this.#thinkingDotsFrame) / THINKING_DOTS_FRAMES.length)) / 2;
		return THINKING_DOTS_FRAME_MS_MIN + (THINKING_DOTS_FRAME_MS_MAX - THINKING_DOTS_FRAME_MS_MIN) * phase;
	}

	#scheduleThinkingFrame(): void {
		this.#thinkingDotsTimer = setTimeout(() => this.#advanceThinkingDots(), this.#thinkingDotsFrameDelay());
		this.#thinkingDotsTimer.unref?.();
	}

	#advanceThinkingDots(): void {
		this.#thinkingDotsTimer = undefined;
		if (!this.#thinkingDots) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % THINKING_DOTS_FRAMES.length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.onImageUpdate?.();
		}
		this.#scheduleThinkingFrame();
	}

	#stopThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) {
			clearTimeout(this.#thinkingDotsTimer);
			this.#thinkingDotsTimer = undefined;
		}
		this.#thinkingDotsFrame = 0;
	}

	setErrorPinned(pinned: boolean): void {
		if (this.#errorPinned === pinned) return;
		this.#errorPinned = pinned;
		if (this.#lastMessage) {
			this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.#errorExpanded === expanded) return;
		this.#errorExpanded = expanded;
		if (this.#hasTruncatableError && this.#lastMessage) {
			this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	markTranscriptBlockFinalized(): void {
		if (this.#transcriptBlockFinalized) return;
		this.#transcriptBlockFinalized = true;
		this.#stopThinkingAnimation();

		if (this.#thinkingDots) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			if (this.#lastMessage) this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	applyRetryRecovery(retryRecovery: AssistantMessage["retryRecovery"]): void {
		if (!this.#lastMessage || !retryRecovery) return;
		this.setErrorPinned(false);
		this.#applyContent({ ...this.#lastMessage, retryRecovery });
	}

	messagePersistenceKey(): string | undefined {
		if (this.#messagePersistenceKey !== undefined) return this.#messagePersistenceKey;
		if (!this.#lastMessage) return undefined;
		return this.#persistenceKeyFor(this.#lastMessage);
	}

	#persistenceKeyFor(message: AssistantMessage): string {
		return [
			"assistant",
			message.timestamp,
			message.provider,
			message.model,
			message.responseId ?? "",
			message.stopReason,
		].join(":");
	}

	#compactFinalMessage(): void {
		const message = this.#lastMessage;
		if (!message || this.#lastUpdateTransient || message.content.some(content => content.type !== "text")) return;
		if (resolveAssistantErrorPresentation(message).kind !== "none") return;
		this.#messagePersistenceKey = this.#persistenceKeyFor(message);
		this.#staticTextBlocks = this.children.flatMap(child => (child instanceof Markdown ? [child.getText()] : []));
		this.#lastMessage = undefined;
	}

	#rebuildStaticTextContent(): void {
		const blocks = this.#staticTextBlocks;
		if (blocks === undefined) return;
		this.#clearContent();
		const mdOptions = this.#textColorTransform ? { color: this.#textColorTransform } : undefined;
		for (const text of blocks) this.addChild(new Markdown(text, 2, 0, getMarkdownTheme(), mdOptions, 2));
		super.invalidate();
	}

	#clearContent(): void {
		this.disposeChildren();
	}

	#renderStreamingChildren(width: number): readonly string[] {
		return super.render(width);
	}

	#appendErrorBlock(message: string): void {
		const safeMessage = replaceTabs(sanitizeText(message));
		if (this.#errorExpanded) {
			const [first = "Unknown error", ...rest] = safeMessage.replace(/\s+$/, "").split("\n");
			this.addChild(new Text(theme.fg("error", `Error: ${first}`), 1, 0));
			for (const line of rest) {
				this.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
			}
			return;
		}
		const total = safeMessage.split("\n").filter(l => l.trim()).length;
		const lines = getPreviewLines(safeMessage, MAX_TRANSCRIPT_ERROR_LINES, TRUNCATE_LENGTHS.LINE);
		if (lines.length === 0) lines.push("Unknown error");

		this.addChild(new Text(theme.fg("error", `Error: ${lines[0]}`), 1, 0));
		for (const line of lines.slice(1)) {
			this.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
		}
		if (total > lines.length) {
			const hidden = total - lines.length;
			this.addChild(
				new Text(
					theme.fg("dim", `  … +${hidden} more line${hidden === 1 ? "" : "s"} (${expandKeyHint()} to expand)`),
					1,
					0,
				),
			);
		}
	}

	setImagesVisible(visible: boolean): void {
		if (this.#showImages === visible) return;
		this.#showImages = visible;
		if (this.#lastMessage) {
			this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		} else if (this.#staticTextBlocks !== undefined) {
			this.#rebuildStaticTextContent();
		}
	}

	#convertImagesForKitty(entries: Array<{ image: ImageContent; key: string }>): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const { image, key } of entries) {
			if (image.mimeType === "image/png") continue;
			if (this.#convertedKittyImages?.has(key) || this.#kittyConversionsInFlight?.has(key)) continue;
			const kittyConversionsInFlight = this.#kittyConversionsInFlight ?? new Set<string>();
			this.#kittyConversionsInFlight = kittyConversionsInFlight;
			kittyConversionsInFlight.add(key);
			convertImageToPng(image)
				.then(converted => {
					this.#kittyConversionsInFlight?.delete(key);
					if (this.#kittyConversionsInFlight?.size === 0) this.#kittyConversionsInFlight = undefined;
					const convertedKittyImages = this.#convertedKittyImages ?? new Map<string, ImageContent>();
					this.#convertedKittyImages = convertedKittyImages;
					convertedKittyImages.set(key, converted);
					if (this.#lastMessage) {
						this.#applyContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
					} else if (this.#staticTextBlocks !== undefined) {
						this.#rebuildStaticTextContent();
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight?.delete(key);
					if (this.#kittyConversionsInFlight?.size === 0) this.#kittyConversionsInFlight = undefined;
				});
		}
	}

	#renderImageEntries(entries: Array<{ image: ImageContent; key: string }>, withLeadingSpacer: boolean): void {
		if (!this.#showImages || entries.length === 0) return;
		this.#convertImagesForKitty(entries);

		if (withLeadingSpacer) this.addChild(new Spacer(1));
		for (const { image, key } of entries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages?.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ ...resolveImageOptions(), budget: this.imageBudget, imageKey: key },
					),
				);
				continue;
			}
			this.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	#appendThinkingExtensions(contentIndex: number, thinkingIndex: number, text: string): void {
		for (const renderer of this.thinkingRenderers) {
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.addChild(component);
				}
			} catch {}
		}
	}

	#computeShapeKey(message: AssistantMessage): string {
		const parts: string[] = [`htb:${this.hideThinkingBlock ? 1 : 0}|pot:${this.proseOnlyThinking ? 1 : 0}`];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(canonicalizeMessage(content.text) ? "T1" : "T0");
			} else if (content.type === "thinking") {
				const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
				if (!display.visible) parts.push("K0");
				else if (this.hideThinkingBlock) parts.push("KH");
				else parts.push("KV");
			} else {
				parts.push(`O:${content.type}`);
			}
		}
		return parts.join("|");
	}

	#canFastPath(message: AssistantMessage): boolean {
		for (const content of message.content) {
			if (content.type === "toolCall" || content.type === "image") return false;
		}
		const errorPresentation = resolveAssistantErrorPresentation(message);
		if (errorPresentation.kind === "compact-recovered" || errorPresentation.kind === "interrupted") return false;
		if (
			errorPresentation.kind === "full" &&
			!(message.stopReason === "error" && this.#errorPinned && !this.#errorExpanded)
		) {
			return false;
		}

		if (this.thinkingRenderers.length > 0 && this.#fastPathItems) {
			for (const item of this.#fastPathItems) {
				if (item.blockType === "thinking") {
					const content = message.content[item.contentIndex];
					if (content?.type === "thinking") {
						const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
						if (this.#withParagraphCuts(item.contentIndex, display.text) !== item.lastText) return false;
					}
				}
			}
		}
		return true;
	}

	#tryFastPathUpdate(message: AssistantMessage, opts?: { transient?: boolean }): boolean {
		if (!this.#fastPathKey || !this.#fastPathItems) return false;
		if (!this.#canFastPath(message)) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		if (this.#computeShapeKey(message) !== this.#fastPathKey) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		const transient = opts?.transient === true;

		this.#applyItemTransience(transient);
		for (let i = 0; i < this.#fastPathItems.length; i++) {
			const item = this.#fastPathItems[i]!;
			const content = message.content[item.contentIndex];
			if (!content) {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			let newText: string;
			if (item.blockType === "text" && content.type === "text") {
				newText = this.#withParagraphCuts(item.contentIndex, content.text.trim());
			} else if (item.blockType === "thinking" && content.type === "thinking") {
				newText = this.#withParagraphCuts(
					item.contentIndex,
					resolveThinkingDisplay(content, this.proseOnlyThinking).text,
				);
			} else {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			if (newText !== item.lastText) {
				if (i < this.#fastPathItems.length - 1) {
					this.#fastPathKey = undefined;
					this.#fastPathItems = undefined;
					return false;
				}
				item.md.setText(newText);
				item.lastText = newText;
			}
		}
		if (this.#thinkingDots) {
			if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
				this.onImageUpdate?.();
			}
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		// Finalized rows may already be immutable native scrollback; rebuilding them appends duplicates.
		if (this.#transcriptBlockFinalized) return;
		this.#applyContent(message, opts);
	}

	#applyContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#lastMessage = message;
		this.#messagePersistenceKey = undefined;
		this.#staticTextBlocks = undefined;
		this.#lastUpdateTransient = opts?.transient === true;

		const isThinkingNow = this.#lastUpdateTransient && this.#shouldAnimateThinking(message);
		if (isThinkingNow) {
			const currentTokens = message.usage.reasoningTokens ?? message.usage.output;
			this.#thinkingTokens = currentTokens;
			const now = performance.now();
			if (this.#lastTokenCount !== undefined) {
				const tokenDelta = currentTokens - this.#lastTokenCount;
				const elapsedMs = now - this.#lastTokenTime;
				if (tokenDelta > 0 && elapsedMs > 0) {
					if (!this.#thinkingRateLive) sharedSpeedTracker.reset();
					sharedSpeedTracker.observe((tokenDelta / elapsedMs) * 1000, now);
					this.#thinkingRateLive = true;
				}
			}
			this.#lastTokenCount = currentTokens;
			this.#lastTokenTime = now;
		} else {
			this.#lastTokenCount = undefined;
			this.#thinkingTokens = 0;
			this.#thinkingRateLive = false;
		}

		if (this.#tryFastPathUpdate(message, opts)) return;

		this.#clearContent();
		this.#thinkingDots = undefined;
		this.#thinkingLabel = undefined;
		this.#hasTruncatableError = false;

		const shouldCapture = this.#canFastPath(message);
		const captureItems:
			| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
			| undefined = shouldCapture ? [] : undefined;

		const hasVisibleContent = message.content.some(
			c =>
				(c.type === "text" && canonicalizeMessage(c.text)) ||
				(c.type === "image" && c.data && c.mimeType) ||
				(!this.hideThinkingBlock &&
					c.type === "thinking" &&
					resolveThinkingDisplay(c, this.proseOnlyThinking).visible),
		);

		let thinkingIndex = 0;
		let hasRenderedContent = false;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				const trimmed = this.#withParagraphCuts(i, content.text.trim());
				const mdOptions = this.#textColorTransform ? { color: this.#textColorTransform } : undefined;
				const md = new Markdown(trimmed, 2, 0, getMarkdownTheme(), mdOptions, 2);
				this.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "text", lastText: trimmed });
				hasRenderedContent = true;
			} else if (content.type === "thinking" && resolveThinkingDisplay(content, this.proseOnlyThinking).visible) {
				const thinkingText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
				if (this.hideThinkingBlock) {
					thinkingIndex += 1;
					continue;
				}

				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						c =>
							(c.type === "text" && canonicalizeMessage(c.text)) ||
							(c.type === "image" && c.data && c.mimeType) ||
							(c.type === "thinking" && resolveThinkingDisplay(c, this.proseOnlyThinking).visible),
					);

				if (thinkingIndex === 0) {
					this.#thinkingLabel = new Text(theme.fg("muted", "Thinking"), 2, 0);
					this.addChild(this.#thinkingLabel);
				}
				const displayedText = this.#withParagraphCuts(i, thinkingText);
				const md = new Markdown(displayedText, 2, 0, getMarkdownTheme(), THINKING_MARKDOWN_STYLE, 2);
				md.transientRenderCache = this.#lastUpdateTransient;
				this.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "thinking", lastText: displayedText });
				this.#appendThinkingExtensions(i, thinkingIndex, thinkingText);
				hasRenderedContent = true;
				thinkingIndex += 1;
				if (hasVisibleContentAfter) {
					this.addChild(new Spacer(1));
				}
			} else if (content.type === "image" && content.data && content.mimeType) {
				this.#renderImageEntries([{ image: content, key: `native:${i}` }], hasRenderedContent);
				hasRenderedContent ||= this.#showImages;
			}
		}

		if (this.#shouldAnimateThinking(message)) {
			if (hasVisibleContent) this.addChild(new Spacer(1));
			this.#thinkingDots = new Text(this.#thinkingDotsLabel(), 1, 0);
			this.addChild(this.#thinkingDots);
			this.#startThinkingAnimation();
		} else {
			this.#stopThinkingAnimation();
		}

		const errorPresentation = resolveAssistantErrorPresentation(message);
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (errorPresentation.kind === "compact-recovered") {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", errorPresentation.text), 1, 0));
		} else if (errorPresentation.kind === "interrupted") {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", `${theme.symbol("status.aborted")} ${errorPresentation.text}`), 1, 0));
		} else if (!hasToolCalls && errorPresentation.kind === "full") {
			if (message.stopReason === "aborted") {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", errorPresentation.text), 1, 0));
			} else {
				this.#hasTruncatableError = true;

				if (!(message.stopReason === "error" && this.#errorPinned) || this.#errorExpanded) {
					this.addChild(new Spacer(1));
					this.#appendErrorBlock(errorPresentation.text);
				}
			}
		}

		if (shouldCapture) {
			this.#fastPathItems = captureItems;
			this.#fastPathKey = this.#computeShapeKey(message);
			this.#applyItemTransience(this.#lastUpdateTransient);
		} else {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
		}
	}

	#applyItemTransience(transient: boolean): void {
		const items = this.#fastPathItems;
		if (!items) return;
		for (let i = 0; i < items.length; i++) {
			items[i]!.md.transientRenderCache = transient && i === items.length - 1;
		}
	}
}
