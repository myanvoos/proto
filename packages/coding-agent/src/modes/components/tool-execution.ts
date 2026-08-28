import type { SnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	type NativeScrollbackLiveRegion,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { getProjectDir, isRecord, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { EDIT_MODE_STRATEGIES, type EditMode, type PerFileDiffPreview } from "../../edit";
import type { Theme } from "../../modes/theme/theme";
import { getThemeEpoch, theme } from "../../modes/theme/theme";
import { BASH_DEFAULT_PREVIEW_LINES } from "../../tools/bash";
import { formatDefaultToolExecution } from "../../tools/default-renderer";
import { EVAL_DEFAULT_PREVIEW_LINES } from "../../tools/eval";
import { isWaitingPollDetails } from "../../tools/fleet";
import { formatStatusIcon, replaceTabs, resolveImageOptions } from "../../tools/render-utils";
import { type FirstResultViewportRepaint, type ToolRenderer, toolRenderers } from "../../tools/renderers";
import { TODO_STRIKE_TOTAL_FRAMES, type TodoToolDetails } from "../../tools/todo";
import type { XdevState } from "../../tools/xdev";
import { isFramedBlockComponent, markFramedBlockComponent, renderStatusLine, WidthAwareText } from "../../tui";
import { convertImageToPng } from "../../utils/image-loading";
import { sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import { renderDiff } from "./diff";

const COMPOSER_INSET_COLS = 2;

function stripTrailingUnbalancedRemoval(diff: string | undefined): string | undefined {
	if (!diff) return diff;
	const lines = diff.split("\n");
	let lastAddIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith("+")) {
			lastAddIdx = i;
			break;
		}
	}
	let hasTrailingUnbalanced = false;
	for (let i = lastAddIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("-") || line.startsWith("@@")) {
			hasTrailingUnbalanced = true;
			break;
		}
	}
	if (!hasTrailingUnbalanced) return diff;
	if (lastAddIdx === -1) return "";
	return lines.slice(0, lastAddIdx + 1).join("\n");
}

type DisplaceableToolName = "fleet" | "todo";

function isTodoToolDetails(details: unknown): details is TodoToolDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		"phases" in details &&
		Array.isArray((details as { phases?: unknown }).phases)
	);
}

interface ToolImageBlock {
	data?: string;
	mimeType?: string;
}

function imageBlocksFromDetails(details: unknown): ToolImageBlock[] {
	if (!isRecord(details) || !Array.isArray(details.images)) return [];
	return details.images.filter(
		(image): image is ToolImageBlock =>
			isRecord(image) &&
			(image.data === undefined || typeof image.data === "string") &&
			(image.mimeType === undefined || typeof image.mimeType === "string"),
	);
}

function displaceableToolName(
	toolName: string,
	result: { details?: unknown; isError?: boolean },
	isPartial: boolean,
): DisplaceableToolName | undefined {
	if (result.isError === true) return undefined;
	if (toolName === "fleet" && isWaitingPollDetails(result.details)) return "fleet";
	if (toolName === "todo" && !isPartial && isTodoToolDetails(result.details)) return "todo";
	return undefined;
}

function isFleetWaitArgs(args: unknown): boolean {
	return isRecord(args) && args.op === "wait";
}

function stabilizeStreamingPreviews(previews: PerFileDiffPreview[]): PerFileDiffPreview[] {
	let changed = false;
	const next = previews.map(preview => {
		if (!preview.diff) return preview;
		const trimmed = stripTrailingUnbalancedRemoval(preview.diff);
		if (trimmed === preview.diff) return preview;
		changed = true;
		return { ...preview, diff: trimmed ?? "" };
	});
	return changed ? next : previews;
}

function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

function resolveEditModeForTool(toolName: string, tool: AgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	return (tool as { mode?: EditMode } | undefined)?.mode;
}

function rawTextInputFromPartialJson(partialJson: unknown): string | undefined {
	if (typeof partialJson !== "string") return undefined;
	if (partialJson.length === 0) return undefined;
	const trimmed = partialJson.trimStart();
	if (trimmed.length === 0) return undefined;
	const first = trimmed[0];

	if (first === "{" || first === '"') return undefined;
	return partialJson;
}

function partialJsonOf(args: unknown): string | undefined {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = args.__partialJson;
	return typeof value === "string" ? value : undefined;
}

function getArgsWithStreamedTextInput(args: unknown): unknown {
	if (args == null || typeof args !== "object") return args;
	const record = args as Record<string, unknown>;
	if (typeof record.input === "string") return args;
	const input = rawTextInputFromPartialJson(record.__partialJson);
	return input === undefined ? args : { ...record, input };
}

type ToolRendererStage = "call" | "result";

class SafeToolRendererComponent implements Component {
	#toolName: string;
	#stage: ToolRendererStage;
	#component: Component;
	#fallback: () => Component | undefined;
	#warned = false;
	readonly wantsKeyRelease: boolean | undefined;

	constructor(
		toolName: string,
		stage: ToolRendererStage,
		component: Component,
		fallback: () => Component | undefined,
	) {
		this.#toolName = toolName;
		this.#stage = stage;
		this.#component = component;
		this.#fallback = fallback;
		this.wantsKeyRelease = component.wantsKeyRelease;
		if (isFramedBlockComponent(component)) {
			markFramedBlockComponent(this);
		}
	}

	render(width: number): readonly string[] {
		try {
			return this.#component.render(width);
		} catch (err) {
			if (!this.#warned) {
				this.#warned = true;
				logger.warn("Tool renderer failed", { tool: this.#toolName, stage: this.#stage, error: String(err) });
			}
			return this.#fallback()?.render(width) ?? [];
		}
	}

	handleInput(data: string): void {
		const handleInput = this.#component.handleInput;
		if (handleInput === undefined) return;
		handleInput.call(this.#component, data);
	}

	invalidate(): void {
		const invalidate = this.#component.invalidate;
		if (invalidate === undefined) return;
		invalidate.call(this.#component);
	}

	setIgnoreTight(ignore: boolean): void {
		const setIgnoreTight = this.#component.setIgnoreTight;
		if (setIgnoreTight === undefined) return;
		setIgnoreTight.call(this.#component, ignore);
	}

	dispose(): void {
		const dispose = this.#component.dispose;
		if (dispose === undefined) return;
		dispose.call(this.#component);
	}
}

interface TranscriptLiveRegionProbe {
	isBlockInLiveRegion(component: Component): boolean;

	isBlockUncommitted?(component: Component): boolean;
}

export interface ToolExecutionUi {
	requestRender(): void;
	requestComponentRender(component: Component): void;
	resetDisplay(): void;
	imageBudget?: TUI["imageBudget"];
}

interface ToolExecutionOptions {
	snapshots?: SnapshotStore;
	showImages?: boolean;

	useBuiltInRenderer?: boolean;
	editFuzzyThreshold?: number;
	editAllowFuzzy?: boolean;

	liveRegion?: TranscriptLiveRegionProbe;
}

export interface ToolExecutionHandle extends Component {
	updateArgs(args: any, toolCallId?: string): void;
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
	setArgsComplete(toolCallId?: string): void;
	setExecutionStarted(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	setToolActivityVisible(visible: boolean): void;

	seal(): void;
}

export const SPINNER_RENDER_INTERVAL_MS = 80;

export const SPINNER_GLYPH_ADVANCE_MS = 80;

export function sharedSpinnerFrame(frameCount: number, now: number = performance.now()): number {
	return frameCount > 0 ? Math.floor(now / SPINNER_GLYPH_ADVANCE_MS) % frameCount : 0;
}

const liveSpinnerBlocks = new Set<ToolExecutionComponent>();
let sharedSpinnerTimer: NodeJS.Timeout | undefined;

function ensureSharedSpinnerTicker(): void {
	if (sharedSpinnerTimer) return;
	sharedSpinnerTimer = setInterval(() => {
		const frame = sharedSpinnerFrame(theme.spinnerFrames.length);

		for (const block of liveSpinnerBlocks) block.tickSpinner(frame);
	}, SPINNER_RENDER_INTERVAL_MS);
}

function registerSpinnerBlock(block: ToolExecutionComponent): void {
	liveSpinnerBlocks.add(block);
	ensureSharedSpinnerTicker();
}

function unregisterSpinnerBlock(block: ToolExecutionComponent): void {
	if (!liveSpinnerBlocks.delete(block)) return;
	if (liveSpinnerBlocks.size === 0 && sharedSpinnerTimer) {
		clearInterval(sharedSpinnerTimer);
		sharedSpinnerTimer = undefined;
	}
}

export function stopSharedSpinnerTicker(): void {
	liveSpinnerBlocks.clear();
	if (sharedSpinnerTimer) {
		clearInterval(sharedSpinnerTimer);
		sharedSpinnerTimer = undefined;
	}
}

let toolExecutionInstanceSeq = 0;

export class ToolExecutionComponent extends Container implements NativeScrollbackLiveRegion {
	#contentBox: Box;
	#contentText: WidthAwareText;

	#usesContentBox = false;
	#multiFileBoxes: (Box | Spacer)[] = [];
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	readonly #instanceId = ++toolExecutionInstanceSeq;
	#toolName: string;
	#toolLabel: string;
	#args: any;
	#expanded = false;
	#toolActivityVisible = true;
	#showImages: boolean;
	#editFuzzyThreshold: number | undefined;
	#editAllowFuzzy: boolean | undefined;
	#snapshots?: SnapshotStore;
	#isPartial = true;
	#resultVersion = 0;

	#blockVersion = 0;
	#lastDisplayKey: string | undefined;

	#displayInputVersion = 0;

	#displayBuilt = false;

	#renderedImageCount = 0;
	#tool?: AgentTool;
	#renderer?: ToolRenderer;
	#ui: ToolExecutionUi;
	#cwd: string;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};

	#editMode?: EditMode;
	#editDiffPreview?: PerFileDiffPreview[];
	#editDiffAbort?: AbortController;
	#editDiffLastArgsKey?: string;

	#editDiffInFlight?: Promise<void>;

	#editDiffDirty = false;

	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();

	#spinnerFrame?: number;
	#spinnerActive = false;

	#todoStrikeInterval?: NodeJS.Timeout;

	#argsComplete = false;
	#executionStarted = false;

	#sealed = false;

	#displaceableByToolName: DisplaceableToolName | undefined;

	#liveRegion?: TranscriptLiveRegionProbe;

	#firstResultViewportRepaintShapePainted = false;
	#partialResultShapePainted = false;
	#renderState: {
		spinnerFrame?: number;
		expanded: boolean;
		isPartial: boolean;
		argsComplete?: boolean;
		executionStarted?: boolean;
		renderContext?: Record<string, unknown>;
	} = {
		expanded: false,
		isPartial: true,
		argsComplete: false,
		executionStarted: false,
	};

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		tool: AgentTool | undefined,
		ui: ToolExecutionUi,
		cwd: string = getProjectDir(),
		_toolCallId?: string,
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#renderer = options.useBuiltInRenderer === false ? undefined : toolRenderers[toolName];
		this.#showImages = options.showImages ?? true;
		this.#editFuzzyThreshold = options.editFuzzyThreshold;
		this.#editAllowFuzzy = options.editAllowFuzzy;
		this.#snapshots = options.snapshots;
		this.#liveRegion = options.liveRegion;
		this.#tool = tool;
		this.#ui = ui;
		this.#cwd = cwd;
		this.#args = args;
		this.#editMode = resolveEditModeForTool(toolName, tool);

		this.#contentBox = new Box(COMPOSER_INSET_COLS, 1);
		this.#contentText = new WidthAwareText(contentWidth => this.#renderDefaultCard(contentWidth), 1, 1);

		const hasCustomRenderer = !!(tool?.renderCall || tool?.renderResult);
		this.#usesContentBox = hasCustomRenderer || this.#renderer !== undefined;
		if (this.#usesContentBox) {
			this.addChild(this.#contentBox);
		} else {
			this.addChild(this.#contentText);
		}

		this.setIgnoreTight(true);

		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		this.#schedulePreviewDiff();
	}

	updateArgs(args: any, _toolCallId?: string): void {
		if (args === this.#args) return;
		this.#args = args;
		this.#displayInputVersion++;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {
		const alreadyComplete = this.#argsComplete;
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
		if (alreadyComplete) return;
		this.#displayInputVersion++;
		this.#updateDisplay();
	}

	setExecutionStarted(_toolCallId?: string): void {
		if (this.#executionStarted) return;
		this.#executionStarted = true;
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		this.#schedulePreviewDiff();
		this.#displayInputVersion++;
		this.#updateDisplay();
	}

	async whenPreviewSettled(): Promise<void> {
		await this.#editDiffInFlight;
	}

	#schedulePreviewDiff(): void {
		if (!this.#editMode) return;
		this.#editDiffDirty = true;
		if (this.#editDiffInFlight) return;
		this.#editDiffInFlight = this.#drainPreviewDiff().finally(() => {
			this.#editDiffInFlight = undefined;
		});
	}

	async #drainPreviewDiff(): Promise<void> {
		await undefined;
		while (this.#editDiffDirty) {
			this.#editDiffDirty = false;
			await this.#computePreviewDiff();
		}
	}

	#previewDiffSettled(): boolean {
		const result = this.#result;
		return result !== undefined && !this.#isPartial && (result.isError === true || result.details != null);
	}
	async #computePreviewDiff(): Promise<void> {
		if (this.#previewDiffSettled()) return;
		const editMode = this.#editMode;
		if (!editMode) return;
		const strategy = EDIT_MODE_STRATEGIES[editMode];
		if (!strategy) return;

		const args = this.#args;
		if (args == null || typeof args !== "object") return;

		const previewArgs = getArgsWithStreamedTextInput(args);
		const partialJson = partialJsonOf(previewArgs);
		const isStreaming = !this.#argsComplete;
		let effectiveArgs: unknown;
		try {
			effectiveArgs = strategy.extractCompleteEdits(previewArgs, partialJson);
		} catch {
			effectiveArgs = previewArgs;
		}

		const streamingState = this.#argsComplete ? "final" : "stream";
		let argsKey: string;
		try {
			argsKey = `${streamingState}:${Bun.hash(JSON.stringify(effectiveArgs))}`;
		} catch {
			argsKey = `${streamingState}:partial:${Bun.hash(partialJson ?? "")}`;
		}
		if (argsKey === this.#editDiffLastArgsKey) return;
		this.#editDiffLastArgsKey = argsKey;

		const controller = new AbortController();
		this.#editDiffAbort = controller;

		try {
			if (editMode === "hashline" && !this.#snapshots) return;
			const previews = await strategy.computeDiffPreview(effectiveArgs, {
				cwd: this.#cwd,
				signal: controller.signal,
				snapshots: this.#snapshots!,
				fuzzyThreshold: this.#editFuzzyThreshold,
				allowFuzzy: this.#editAllowFuzzy,
				isStreaming,
			});
			if (controller.signal.aborted) return;
			if (previews) {
				this.#editDiffPreview = isStreaming ? stabilizeStreamingPreviews(previews) : previews;
				this.#displayInputVersion++;
				this.#updateDisplay();
				this.#ui.requestRender();
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			logger.warn("Edit preview diff failed", { tool: this.#toolName, error: String(err) });
		}
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial = false,
		_toolCallId?: string,
	): void {
		const hadNoResult = this.#result === undefined;
		const wasPartialResult = this.#result !== undefined && this.#isPartial;
		const firstResultRepaintShapePainted = this.#firstResultViewportRepaintShapePainted;
		const partialResultPainted = this.#partialResultShapePainted;
		this.#firstResultViewportRepaintShapePainted = false;
		this.#partialResultShapePainted = false;
		this.#result = result;
		this.#resultVersion++;
		this.#blockVersion++;
		this.#isPartial = isPartial;
		this.#displaceableByToolName = displaceableToolName(this.#toolName, result, isPartial);

		if (!isPartial) {
			this.#argsComplete = true;
		}
		if (this.#editMode && this.#previewDiffSettled()) {
			this.#editDiffDirty = false;
			this.#editDiffAbort?.abort();
		}
		this.#updateSpinnerAnimation();
		this.#updateTodoStrikeAnimation();
		this.#updateDisplay();
		this.#resetDisplayForResultTopologyChange(
			hadNoResult && firstResultRepaintShapePainted,
			wasPartialResult && partialResultPainted,
			isPartial,
		);

		this.#maybeConvertImagesForKitty();
	}

	#getAllImageBlocks(): ToolImageBlock[] {
		if (!this.#result) return [];
		const contentImages = this.#result.content.filter(block => block.type === "image");
		const details = this.#result.details;
		const detailImages = imageBlocksFromDetails(details);
		const xdevImages = isRecord(details) && isRecord(details.xdev) ? imageBlocksFromDetails(details.xdev.inner) : [];
		return [...contentImages, ...detailImages, ...xdevImages];
	}

	#maybeConvertImagesForKitty(): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		if (!this.#result) return;

		const imageBlocks = this.#getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;

			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;

			const index = i;
			convertImageToPng({ type: "image", data: img.data, mimeType: img.mimeType })
				.then(converted => {
					this.#convertedImages.set(index, converted);
					this.#displayInputVersion++;
					this.#updateDisplay();
					this.#ui.requestRender();
				})
				.catch(() => {});
		}
	}

	#updateSpinnerAnimation(): void {
		const isStreamingArgs = !this.#argsComplete && (isEditLikeToolName(this.#toolName) || this.#toolName === "write");
		const isBackgroundAsyncRunning =
			(this.#result?.details as { async?: { state?: string } } | undefined)?.async?.state === "running";
		const renderer = this.#renderer;
		const pendingAnimation = renderer?.animatedPendingPreview;
		const partialAnimation = renderer?.animatedPartialResult;
		const pendingCallConsumesSpinner =
			this.#result === undefined &&
			(renderer === undefined
				? !this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof pendingAnimation === "function"
					? pendingAnimation(this.#args)
					: pendingAnimation === true);
		const partialResultConsumesSpinner =
			this.#result !== undefined &&
			(renderer === undefined
				? !this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof partialAnimation === "function"
					? partialAnimation(this.#args)
					: partialAnimation === true);
		const isLivePartialTool =
			this.#isPartial &&
			this.#toolName !== "todo" &&
			!isBackgroundAsyncRunning &&
			(pendingCallConsumesSpinner || partialResultConsumesSpinner);
		const needsSpinner = isStreamingArgs || isLivePartialTool || this.#displaceableByToolName === "fleet";
		if (needsSpinner && !this.#spinnerActive) {
			const frameCount = theme.spinnerFrames.length;
			const frame = sharedSpinnerFrame(frameCount);
			this.#spinnerFrame = frame;
			this.#renderState.spinnerFrame = frame;
			this.#spinnerActive = true;
			registerSpinnerBlock(this);
		} else if (!needsSpinner && this.#spinnerActive) {
			this.#spinnerActive = false;
			unregisterSpinnerBlock(this);

			if (!this.#todoStrikeInterval) {
				this.#spinnerFrame = undefined;
				this.#renderState.spinnerFrame = undefined;
			}
		}
	}

	tickSpinner(frame: number): void {
		this.#spinnerFrame = frame;
		this.#renderState.spinnerFrame = frame;
		this.#ui.requestComponentRender(this);
	}

	#updateTodoStrikeAnimation(): void {
		if (this.#toolName !== "todo" || this.#isPartial || this.#result?.isError) {
			this.#stopTodoStrikeAnimation();
			return;
		}
		const completedTasks = (this.#result?.details as { completedTasks?: unknown[] } | undefined)?.completedTasks;
		if (!completedTasks || completedTasks.length === 0) {
			this.#stopTodoStrikeAnimation();
			return;
		}
		if (this.#todoStrikeInterval) return;

		this.#spinnerFrame = 0;
		this.#renderState.spinnerFrame = 0;
		this.#todoStrikeInterval = setInterval(() => {
			const nextFrame = (this.#spinnerFrame ?? 0) + 1;
			if (nextFrame > TODO_STRIKE_TOTAL_FRAMES) {
				this.#stopTodoStrikeAnimation();
			} else {
				this.#spinnerFrame = nextFrame;
				this.#renderState.spinnerFrame = nextFrame;
			}

			this.#ui.requestComponentRender(this);
		}, 65);
	}

	#stopTodoStrikeAnimation(): void {
		if (this.#todoStrikeInterval) {
			clearInterval(this.#todoStrikeInterval);
			this.#todoStrikeInterval = undefined;
		}
		if (!this.#spinnerActive) {
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.isTranscriptBlockFinalized() ? undefined : 0;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		if (this.isTranscriptBlockFinalized()) return false;
		if (this.#displaceableByToolName !== undefined) return true;

		return this.#toolName === "fleet" && isFleetWaitArgs(this.#args);
	}

	isTranscriptBlockFinalized(): boolean {
		if (!this.#toolActivityVisible) return true;
		if (this.#sealed) return true;
		if (this.#result === undefined) return false;

		if (this.#displaceableByToolName) return false;
		if (!this.#isPartial) return true;

		return (this.#result.details as { async?: { state?: string } } | undefined)?.async?.state === "running";
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	seal(): void {
		if (this.#sealed) return;
		this.#sealed = true;
		this.#blockVersion++;
		this.#displaceableByToolName = undefined;
		this.stopAnimation();
		this.#updateDisplay();
		this.#ui.requestRender();
	}

	isDisplaceableBlock(): boolean {
		return this.#displaceableByToolName !== undefined && !this.#sealed;
	}

	canBeDisplacedBy(nextToolName: string | undefined): boolean {
		return (
			this.#displaceableByToolName !== undefined && this.#displaceableByToolName === nextToolName && !this.#sealed
		);
	}

	stopAnimation(): void {
		if (this.#spinnerActive) {
			this.#spinnerActive = false;
			unregisterSpinnerBlock(this);
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
		this.#editDiffAbort?.abort();
		this.#editDiffAbort = undefined;

		this.#editDiffDirty = false;
	}

	override dispose(): void {
		this.stopAnimation();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	setShowImages(show: boolean): void {
		this.#showImages = show;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const key = `${this.#resultVersion}|${this.#expanded}|${this.#isPartial}|${this.#argsComplete ? "1" : "0"}|${this.#executionStarted ? "1" : "0"}|${this.#spinnerFrame ?? "-"}|${this.#showImages}|${getThemeEpoch()}|${this.#displayInputVersion}|${TERMINAL.imageProtocol ?? "-"}|${this.#imageSizeKey()}`;
		if (key === this.#lastDisplayKey && this.#displayBuilt) return;
		this.#lastDisplayKey = key;

		this.#rebuildDisplay();
		this.#displayBuilt = true;
	}

	#rendererFlag(name: "forceResultViewportRepaintOnSettle"): boolean {
		const toolValue = (this.#tool as Record<string, unknown> | undefined)?.[name];
		const rendererValue = this.#renderer?.[name];
		return toolValue === true || (toolValue === undefined && rendererValue === true);
	}

	#needsFirstResultViewportRepaintAtRender(): boolean {
		if (this.#result !== undefined) return false;
		const toolValue = (this.#tool as { forceFirstResultViewportRepaint?: FirstResultViewportRepaint } | undefined)
			?.forceFirstResultViewportRepaint;
		const value = toolValue !== undefined ? toolValue : this.#renderer?.forceFirstResultViewportRepaint;
		if (typeof value === "function") return value(this.#args, this.#renderState);
		return value === true;
	}

	#resetDisplayForResultTopologyChange(
		firstResultAfterRepaintShapePaint: boolean,
		partialResultPaintedBeforeSettle: boolean,
		isPartial: boolean,
	): void {
		const provisionalResultSettled =
			partialResultPaintedBeforeSettle && !isPartial && this.#rendererFlag("forceResultViewportRepaintOnSettle");
		if (firstResultAfterRepaintShapePaint || provisionalResultSettled) {
			this.#ui.resetDisplay();
		}
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		const lines = super.render(width);

		this.#firstResultViewportRepaintShapePainted = this.#needsFirstResultViewportRepaintAtRender();
		this.#partialResultShapePainted = this.#result !== undefined && this.#isPartial;
		return lines;
	}

	#imageSizeKey(): string {
		if (this.#renderedImageCount === 0) return "-";
		const o = resolveImageOptions();
		return `${o.maxWidthCells}:${o.maxHeightCells ?? "-"}`;
	}

	#rebuildDisplay(): void {
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.argsComplete = this.#argsComplete;
		this.#renderState.executionStarted = this.#executionStarted;
		this.#renderState.spinnerFrame = this.#spinnerFrame;

		const benignSkip = this.#isBenignSkip();
		if (benignSkip) {
			this.#renderBenignSkipCard();
		} else if (this.#tool && (this.#tool.renderCall || this.#tool.renderResult)) {
			const tool = this.#tool;
			const mergeCallAndResult = Boolean((tool as { mergeCallAndResult?: boolean }).mergeCallAndResult);

			this.#contentBox.setBgFn(undefined);
			this.#contentBox.clear();

			this.#renderState.renderContext = this.#buildRenderContext();

			const shouldRenderCall = !this.#result || !mergeCallAndResult;
			if (shouldRenderCall) {
				if (tool.renderCall) {
					try {
						const callArgs = this.#getCallArgsForRender();
						const callComponent = tool.renderCall(callArgs, this.#renderState, theme) as Component | undefined;
						if (callComponent) {
							this.#contentBox.addChild(
								new SafeToolRendererComponent(
									this.#toolName,
									"call",
									callComponent,
									() => new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0),
								),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });

						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					}
				} else {
					this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
				}
			}

			if (this.#result && tool.renderResult) {
				try {
					const renderResult = tool.renderResult as (
						result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
						options: { expanded: boolean; isPartial: boolean; spinnerFrame?: number },
						theme: Theme,
						args?: unknown,
					) => Component;
					const resultComponent = renderResult(
						{
							content: this.#result.content as any,
							details: this.#result.details,
							isError: this.#result.isError,
						},
						this.#renderState,
						theme,
						this.#args,
					);
					if (resultComponent) {
						this.#contentBox.addChild(
							new SafeToolRendererComponent(this.#toolName, "result", resultComponent, () => {
								const output = this.#getTextOutput();
								if (!output) return undefined;
								return new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0);
							}),
						);
					}
				} catch (err) {
					logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });

					const output = this.#getTextOutput();
					if (output) {
						this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
					}
				}
			} else if (this.#result) {
				const output = this.#getTextOutput();
				if (output) {
					this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
				}
			}
			this.#contentBox.setPaddingX(COMPOSER_INSET_COLS);
			this.#contentBox.setBgFn(undefined);
		} else if (this.#renderer) {
			const renderer = this.#renderer;

			for (const box of this.#multiFileBoxes) {
				this.removeChild(box);
			}
			this.#multiFileBoxes = [];

			const perFileResults = this.#result?.details?.perFileResults as
				| Array<{ path: string; isError?: boolean }>
				| undefined;
			if (perFileResults && perFileResults.length > 1) {
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				for (let i = 0; i < perFileResults.length; i++) {
					const fileResult = perFileResults[i];
					if (i > 0) {
						const spacer = new Spacer(1);
						this.#multiFileBoxes.push(spacer);
						this.addChild(spacer);
					}
					const fileBox = new Box(COMPOSER_INSET_COLS, 0);
					try {
						const resultComponent = renderer.renderResult(
							{ content: [], details: fileResult, isError: fileResult.isError },
							this.#renderState,
							theme,
						);
						if (resultComponent) {
							fileBox.addChild(
								new SafeToolRendererComponent(this.#toolName, "result", resultComponent, () => undefined),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					}
					this.#multiFileBoxes.push(fileBox);
					this.addChild(fileBox);
				}

				const totalFiles = this.#args?.edits
					? new Set((this.#args.edits as any[]).map((e: any) => e?.path).filter(Boolean)).size
					: 0;
				const remaining = Math.max(0, totalFiles - perFileResults.length);
				if (remaining > 0 && this.#isPartial) {
					const pendingSpacer = new Spacer(1);
					this.#multiFileBoxes.push(pendingSpacer);
					this.addChild(pendingSpacer);
					const pendingBox = new Box(COMPOSER_INSET_COLS, 0);
					const spinner =
						this.#spinnerFrame !== undefined ? formatStatusIcon("running", theme, this.#spinnerFrame) : "";
					const pendingText = renderStatusLine(
						{
							iconOverride: spinner,
							title: "Edit",
							description: theme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						theme,
					);
					pendingBox.addChild(new Text(pendingText, 0, 0));
					this.#multiFileBoxes.push(pendingBox);
					this.addChild(pendingBox);
				}
			} else {
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				const shouldRenderCall = !this.#result || !renderer.mergeCallAndResult;
				if (shouldRenderCall) {
					try {
						const callArgs = this.#getCallArgsForRender();
						const callComponent = renderer.renderCall(callArgs, this.#renderState, theme);
						if (callComponent) {
							this.#contentBox.addChild(
								new SafeToolRendererComponent(
									this.#toolName,
									"call",
									callComponent,
									() => new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0),
								),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });

						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					}
				}

				if (this.#result) {
					try {
						const resultComponent = renderer.renderResult(
							{
								content: this.#result.content as any,
								details: this.#result.details,
								isError: this.#result.isError,
							},
							this.#renderState,
							theme,
							this.#getCallArgsForRender(),
						);
						if (resultComponent) {
							this.#contentBox.addChild(
								new SafeToolRendererComponent(this.#toolName, "result", resultComponent, () => {
									const output = this.#getTextOutput();
									if (!output) return undefined;
									return new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0);
								}),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });

						const output = this.#getTextOutput();
						if (output) {
							this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
						}
					}
				}
			}
		} else {
			this.#contentText.setCustomBgFn(undefined);
			this.#contentText.invalidate();
		}

		for (const img of this.#imageComponents) {
			this.removeChild(img);
		}
		this.#imageComponents = [];
		for (const spacer of this.#imageSpacers) {
			this.removeChild(spacer);
		}
		this.#imageSpacers = [];

		if (this.#result) {
			const imageBlocks = this.#getAllImageBlocks();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (TERMINAL.imageProtocol && this.#showImages && img.data && img.mimeType) {
					const converted = this.#convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.#imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ ...resolveImageOptions(), budget: this.#ui.imageBudget, imageKey: `te${this.#instanceId}:${i}` },
					);
					this.#imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
		this.#renderedImageCount = this.#imageComponents.length;
	}

	#getCallArgsForRender(): any {
		const renderArgs = getArgsWithStreamedTextInput(this.#args);
		if (!isEditLikeToolName(this.#toolName)) {
			return renderArgs;
		}
		const previews = this.#editDiffPreview;
		if (!previews || previews.length === 0) {
			return renderArgs;
		}

		const first = previews[0];
		if (!first?.diff) {
			return renderArgs;
		}
		return { ...(renderArgs as Record<string, unknown>), previewDiff: first.diff };
	}

	#buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		const normalizeTimeoutSeconds = (value: unknown, maxSeconds: number): number | undefined => {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			return Math.max(1, Math.min(maxSeconds, value));
		};

		if (this.#toolName === "bash") {
			if (this.#result) {
				const output = this.#getTextOutput().trimEnd();
				context.output = output;
			}
			context.expanded = this.#expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds(this.#args?.timeout, 3600);
		} else if (this.#toolName === "eval" && this.#result) {
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = EVAL_DEFAULT_PREVIEW_LINES;
		} else if (isEditLikeToolName(this.#toolName)) {
			context.editMode = this.#editMode;
			const previews = this.#editDiffPreview;
			if (previews && previews.length > 0) {
				const first = previews[0];
				if (first?.diff || first?.error) {
					context.editDiffPreview = first.error
						? { error: first.error }
						: { diff: first.diff ?? "", firstChangedLine: first.firstChangedLine };
				}
				if (previews.length > 1) {
					context.perFileDiffPreview = previews;
				}
			}
			if (!previews?.some(preview => preview.diff)) {
				const editMode = this.#editMode;
				const strategy = editMode ? EDIT_MODE_STRATEGIES[editMode] : undefined;
				const fallback = strategy?.renderStreamingFallback(getArgsWithStreamedTextInput(this.#args), theme);
				if (fallback) context.editStreamingFallback = fallback;
			}
			context.renderDiff = renderDiff;
		} else if (this.#toolName === "write") {
			const writeTool = this.#tool as { session?: { xdev?: XdevState } } | undefined;
			const xdev = writeTool?.session?.xdev;
			if (xdev) {
				context.resolveXdevMounted = (name: string) =>
					xdev.mountedNames.has(name) ? xdev.tools.get(name) : undefined;
			}
		}

		return context;
	}

	#getTextOutput(): string {
		if (!this.#result) return "";

		const textBlocks = this.#result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.#getAllImageBlocks();

		let output = textBlocks
			.map((c: any) => {
				return sanitizeWithOptionalSixelPassthrough(c.text || "", sanitizeText);
			})
			.join("\n");

		if (imageBlocks.length > 0 && (!TERMINAL.imageProtocol || !this.#showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	#renderDefaultCard(contentWidth: number): string {
		return formatDefaultToolExecution(
			{
				label: this.#toolLabel,
				args: this.#args,
				result: this.#result
					? { output: this.#getTextOutput(), isError: this.#result.isError, skipped: this.#isBenignSkip() }
					: undefined,
				options: this.#renderState,
			},
			contentWidth,
			theme,
		);
	}

	#isBenignSkip(): boolean {
		if (this.#isPartial || !this.#result) return false;
		const details = this.#result.details as
			| { __synthetic?: boolean; __interrupted?: boolean; source?: string; execution?: string }
			| undefined;
		if (details?.source !== "interrupt_skipped") return false;
		return details.__synthetic === true || (details.__interrupted === true && details.execution === "started");
	}

	#renderBenignSkipCard(): void {
		if (!this.#usesContentBox) {
			this.#contentText.setCustomBgFn(undefined);
			this.#contentText.invalidate();
			return;
		}
		for (const box of this.#multiFileBoxes) {
			this.removeChild(box);
		}
		this.#multiFileBoxes = [];
		this.#contentBox.setPaddingX(COMPOSER_INSET_COLS);
		this.#contentBox.setBgFn(undefined);
		this.#contentBox.clear();
		this.#contentBox.addChild(new WidthAwareText(contentWidth => this.#renderDefaultCard(contentWidth), 0, 0));
	}
}
