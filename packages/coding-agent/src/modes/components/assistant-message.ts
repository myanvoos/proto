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
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { expandKeyHint, getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { convertImageToPng } from "../../utils/image-loading";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";

const MAX_TRANSCRIPT_ERROR_LINES = 8;

const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };

const EMPTY_THINKING_RENDERERS: readonly AssistantThinkingRenderer[] = [];

function resolveThinkingDisplay(block: ThinkingContentBlock, proseOnly: boolean): { text: string; visible: boolean } {
	const rawThinking = (block as DisplayThinkingContentBlock).rawThinking;

	const formatted = rawThinking !== undefined ? block.thinking : formatThinkingForDisplay(block.thinking, proseOnly);
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(rawThinking ?? block.thinking, formatted),
	};
}

function containsMermaidFence(text: string): boolean {
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const fenceMatch = CODE_FENCE_LINE.exec(line);
		if (fence !== null) {
			if (
				fenceMatch &&
				fenceMatch[2]!.trim() === "" &&
				fenceMatch[1]![0] === fence[0] &&
				fenceMatch[1]!.length >= fence.length
			) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			if (/^mermaid\b/.test(fenceMatch[2]!.trim())) return true;
			fence = fenceMatch[1]!;
		}
	}
	return false;
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
	#cacheInvalidationMarker?: CacheInvalidationMarkerComponent;
	#widthEpochBoundaries?: WeakMap<object, { childBoundary: unknown; markerRows: number }>;
	#lastMessage?: AssistantMessage;
	#messagePersistenceKey?: string;
	#staticTextBlocks?: readonly string[];
	#toolImagesByCallId?: Map<string, ImageContent[]>;
	#convertedKittyImages?: Map<string, ImageContent>;
	#showImages = true;
	#showToolResultImages = true;
	#kittyConversionsInFlight?: Set<string>;
	#transcriptBlockFinalized: boolean;

	#containsMermaidSource = false;

	#errorPinned = false;

	#errorExpanded = false;

	#hasTruncatableError = false;

	#blockVersion = 0;

	#lastUpdateTransient = false;

	#lastRenderWidth = 0;

	#fastPathKey: string | undefined;
	#fastPathItems:
		| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
		| undefined;

	#thinkingDots: Text | undefined;
	#thinkingDotsTimer: NodeJS.Timeout | undefined;
	#thinkingDotsFrame = 0;

	#lastTokenCount: number | undefined;
	#lastTokenTime = 0;

	#thinkingTokens = 0;

	#thinkingRateLive = false;

	#textColorTransform?: (text: string) => string;

	#onTranscriptBlockChange?: () => void;

	setTranscriptBlockChangeListener(listener: (() => void) | undefined): void {
		this.#onTranscriptBlockChange = listener;
	}

	setTextColorTransform(transform?: (text: string) => string): void {
		if (this.#textColorTransform === transform) return;
		this.#textColorTransform = transform;
		if (!this.#lastMessage && this.#staticTextBlocks !== undefined) this.#rebuildStaticTextContent();
		this.#onTranscriptBlockChange?.();
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
			this.updateContent(message);
		}
	}

	setCacheInvalidation(info: CacheInvalidation | undefined): void {
		this.#cacheInvalidationMarker = info ? new CacheInvalidationMarkerComponent(info) : undefined;
		this.#blockVersion++;
		this.#onTranscriptBlockChange?.();
	}

	override invalidate(): void {
		super.invalidate();
		this.#cacheInvalidationMarker?.invalidate();

		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
		this.#onTranscriptBlockChange?.();
	}

	override render(width: number): readonly string[] {
		this.#lastRenderWidth = width;
		// Finalized messages render through the memoized Container path: the
		// differential renderer hits per-child render caches, so repeated frames
		// are O(dirty) instead of re-parsing every block. Memory slimming happens
		// once at finalize (#compactFinalMessage), never per render.
		const contentLines = this.#renderStreamingChildren(width);
		const marker = this.#cacheInvalidationMarker;
		const lines = marker ? marker.render(width).concat(contentLines) : contentLines;
		if (this.#transcriptBlockFinalized) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			this.#compactFinalMessage();
		}
		return lines;
	}

	override setNativeScrollbackCommittedRows(rows: number): void {
		const markerRows = this.#cacheInvalidationMarker?.render(this.#lastRenderWidth).length ?? 0;
		super.setNativeScrollbackCommittedRows(Math.max(0, rows - markerRows));
	}

	override captureNativeScrollbackWidthEpoch(): unknown {
		if (this.#transcriptBlockFinalized) {
			super.render(this.#lastRenderWidth);
		}
		const childBoundary = super.captureNativeScrollbackWidthEpoch();
		if (childBoundary === undefined) return undefined;
		const marker = {};
		const boundaries = this.#widthEpochBoundaries ?? new WeakMap();
		this.#widthEpochBoundaries = boundaries;
		boundaries.set(marker, {
			childBoundary,
			markerRows: this.#cacheInvalidationMarker?.render(this.#lastRenderWidth).length ?? 0,
		});
		return marker;
	}

	override resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null) return undefined;
		const captured = this.#widthEpochBoundaries?.get(boundary);
		if (!captured) return undefined;
		const markerRows = this.#cacheInvalidationMarker?.render(this.#lastRenderWidth).length ?? 0;
		if (markerRows !== captured.markerRows) return undefined;
		const rows = super.resolveNativeScrollbackWidthEpoch(captured.childBoundary);
		return rows === undefined ? undefined : rows + markerRows;
	}

	override getNativeScrollbackWidthEpochRows(): number | undefined {
		if (this.#transcriptBlockFinalized) {
			const markerRows = this.#cacheInvalidationMarker?.render(this.#lastRenderWidth).length ?? 0;
			const rows = this.#canRenderFinalWithoutCache()
				? this.#renderChildren(this.#lastRenderWidth).length
				: this.#renderStreamingChildren(this.#lastRenderWidth).length;
			return rows + markerRows;
		}
		const rows = super.getNativeScrollbackWidthEpochRows();
		if (rows === undefined) return undefined;
		return rows + (this.#cacheInvalidationMarker?.render(this.#lastRenderWidth).length ?? 0);
	}

	override isNativeScrollbackWidthEpochAppendOnly(boundary: unknown): boolean {
		if (typeof boundary !== "object" || boundary === null) return true;
		const captured = this.#widthEpochBoundaries?.get(boundary);
		if (!captured) return super.isNativeScrollbackWidthEpochAppendOnly(boundary);
		const markerRows = this.#cacheInvalidationMarker?.render(this.#lastRenderWidth).length ?? 0;
		return markerRows === captured.markerRows && super.isNativeScrollbackWidthEpochAppendOnly(captured.childBoundary);
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.hideThinkingBlock = hide;
		this.#onTranscriptBlockChange?.();
	}

	setProseOnlyThinking(proseOnly: boolean): void {
		if (this.proseOnlyThinking === proseOnly) return;
		this.proseOnlyThinking = proseOnly;
		this.#onTranscriptBlockChange?.();
	}

	override dispose(): void {
		this.#stopThinkingAnimation();
		this.#onTranscriptBlockChange?.();
		this.#onTranscriptBlockChange = undefined;
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
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.#errorExpanded === expanded) return;
		this.#errorExpanded = expanded;
		if (this.#hasTruncatableError && this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	getTranscriptBlockSettledRows(): number {
		if (this.#transcriptBlockFinalized || !this.#lastUpdateTransient) return 0;
		if (this.#containsMermaidSource) return 0;
		if (this.#cacheInvalidationMarker) return 0;
		const items = this.#fastPathItems;
		const width = this.#lastRenderWidth;
		if (!items || items.length === 0 || width <= 0) return 0;
		const streaming = items[items.length - 1]!.md;

		let itemIndex = 0;
		let settled = 0;
		for (const child of this.children) {
			if (child === streaming) return settled + streaming.getLastRenderSettledRows();
			if (itemIndex < items.length - 1 && items[itemIndex]!.md === child) {
				itemIndex++;
				settled += child.render(width).length;
				continue;
			}
			if (child instanceof Spacer) {
				settled += child.render(width).length;
				continue;
			}

			return settled;
		}
		return settled;
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
		this.#stopThinkingAnimation();

		if (this.#thinkingDots) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			if (this.#lastMessage) this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
		this.#onTranscriptBlockChange?.();
	}

	applyRetryRecovery(retryRecovery: AssistantMessage["retryRecovery"]): void {
		if (!this.#lastMessage || !retryRecovery) return;
		this.setErrorPinned(false);
		this.updateContent({ ...this.#lastMessage, retryRecovery });
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
		this.#renderToolImages();
		super.invalidate();
		this.#onTranscriptBlockChange?.();
	}

	#clearContent(): void {
		while (this.children.length > 0) this.removeChild(this.children[this.children.length - 1]!);
	}

	#renderStreamingChildren(width: number): readonly string[] {
		return super.render(width);
	}

	#canRenderFinalWithoutCache(): boolean {
		return this.children.every(
			child => child instanceof Markdown || child instanceof Text || child instanceof Spacer,
		);
	}

	#renderChildren(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
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
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		} else if (this.#staticTextBlocks !== undefined) {
			this.#rebuildStaticTextContent();
		}
	}

	setToolResultImagesVisible(visible: boolean): void {
		if (this.#showToolResultImages === visible) return;
		this.#showToolResultImages = visible;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		} else if (this.#staticTextBlocks !== undefined) {
			this.#rebuildStaticTextContent();
		}
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of Array.from(this.#convertedKittyImages?.keys() ?? [])) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages?.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight ?? [])) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight?.delete(key);
			}
		}
		if (this.#convertedKittyImages?.size === 0) this.#convertedKittyImages = undefined;
		if (validImages.length === 0) {
			this.#toolImagesByCallId?.delete(toolCallId);
		} else {
			const toolImagesByCallId = this.#toolImagesByCallId ?? new Map<string, ImageContent[]>();
			this.#toolImagesByCallId = toolImagesByCallId;
			toolImagesByCallId.set(toolCallId, validImages);
			this.#convertImagesForKitty(validImages.map((image, index) => ({ image, key: `${toolCallId}:${index}` })));
		}
		if (this.#toolImagesByCallId?.size === 0) this.#toolImagesByCallId = undefined;
		if (this.#kittyConversionsInFlight?.size === 0) this.#kittyConversionsInFlight = undefined;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
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
						this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
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

	#renderToolImages(): void {
		if (!this.#showToolResultImages || !this.#toolImagesByCallId) return;
		const entries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		this.#renderImageEntries(entries, true);
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
		if ((this.#toolImagesByCallId?.size ?? 0) > 0) return false;
		const errorPresentation = resolveAssistantErrorPresentation(message);
		if (errorPresentation.kind === "compact-recovered") return false;
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
						if (display.text !== item.lastText) return false;
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
				newText = content.text.trim();
			} else if (item.blockType === "thinking" && content.type === "thinking") {
				newText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
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
		this.#onTranscriptBlockChange?.();
		this.#blockVersion++;
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

		this.#containsMermaidSource = message.content.some(content => {
			if (content.type === "text") return containsMermaidFence(content.text);
			if (content.type === "thinking" && !this.hideThinkingBlock) {
				const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
				return display.visible && containsMermaidFence(display.text);
			}
			return false;
		});

		if (this.#tryFastPathUpdate(message, opts)) return;

		this.#clearContent();
		this.#thinkingDots = undefined;
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
				const trimmed = content.text.trim();
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
					const label = new Text(theme.fg("muted", "Thinking"), 2, 0);
					this.addChild(label);
				}
				const md = new Markdown(thinkingText, 2, 0, getMarkdownTheme(), THINKING_MARKDOWN_STYLE, 2);
				md.transientRenderCache = this.#lastUpdateTransient;
				this.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "thinking", lastText: thinkingText });
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

		this.#renderToolImages();
		const errorPresentation = resolveAssistantErrorPresentation(message);
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (errorPresentation.kind === "compact-recovered") {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", errorPresentation.text), 1, 0));
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
