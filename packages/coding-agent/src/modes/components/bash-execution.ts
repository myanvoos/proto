import {
	Container,
	Ellipsis,
	ImageProtocol,
	type Loader,
	TERMINAL,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import type { ExecutionMetadata } from "../../session/execution-metadata";
import type { TruncationMeta } from "../../tools/output-meta";
import { getSixelLineMask, isSixelPassthroughEnabled, sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import {
	buildExecutionFrame,
	buildStatusFooter,
	createCollapsedPreview,
	type ExecutionStatus,
	formatExecutionMetadata,
	resolveExecutionStatus,
} from "./execution-shared";

const PREVIEW_LINES = 20;
const STREAMING_LINE_CAP = PREVIEW_LINES * 5;
const MAX_DISPLAY_LINE_CHARS = 4000;

const CHUNK_THROTTLE_MS = 50;

export class BashExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#execution?: ExecutionMetadata;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;

	#blockVersion = 0;
	#onTranscriptBlockChange?: () => void;
	#displayDirty = false;
	#chunkGate = false;
	#contentContainer: Container;
	#headerText: Text;

	constructor(
		private readonly command: string,
		ui: TUI,
		excludeFromContext = false,
	) {
		super();

		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		this.#headerText = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	setTranscriptBlockChangeListener(listener: (() => void) | undefined): void {
		this.#onTranscriptBlockChange = listener;
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	override invalidate(): void {
		super.invalidate();
		this.#displayDirty = false;
		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	override dispose(): void {
		this.#onTranscriptBlockChange?.();
		this.#onTranscriptBlockChange = undefined;
		super.dispose();
	}

	appendOutput(chunk: string): void {
		if (this.#chunkGate) return;
		this.#chunkGate = true;
		setTimeout(() => {
			this.#chunkGate = false;
		}, CHUNK_THROTTLE_MS);

		const incomingLines = chunk.split("\n");
		if (this.#outputLines.length > 0 && incomingLines.length > 0) {
			const lastIndex = this.#outputLines.length - 1;
			const mergedLines = [`${this.#outputLines[lastIndex]}${incomingLines[0]}`, ...incomingLines.slice(1)];
			const clampedMergedLines = this.#clampLinesPreservingSixel(mergedLines);
			this.#outputLines[lastIndex] = clampedMergedLines[0] ?? "";
			this.#outputLines.push(...clampedMergedLines.slice(1));
		} else {
			this.#outputLines.push(...this.#clampLinesPreservingSixel(incomingLines));
		}

		if (this.#outputLines.length > STREAMING_LINE_CAP) {
			this.#outputLines = this.#outputLines.slice(-STREAMING_LINE_CAP);
		}

		this.#displayDirty = true;
		this.#onTranscriptBlockChange?.();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta; execution?: ExecutionMetadata },
	): void {
		this.#exitCode = exitCode;
		this.#execution = options?.execution ? { ...options.execution, renderer: { state: "complete" } } : undefined;
		this.#status = resolveExecutionStatus(exitCode, cancelled, this.#execution);
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		this.#loader.stop();

		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	override render(width: number): readonly string[] {
		if (this.#displayDirty) {
			this.#displayDirty = false;
			this.#updateDisplay();
		}
		return super.render(width);
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;

		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const sixelLineMask =
			TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled()
				? getSixelLineMask(availableLines)
				: undefined;
		const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
		const showingAllLines = this.#expanded || hasSixelOutput;

		const hiddenLineCount = showingAllLines ? 0 : availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();

		this.#contentContainer.addChild(this.#headerText);
		const executionLine = formatExecutionMetadata(this.#execution);
		if (executionLine) this.#contentContainer.addChild(new Text(executionLine, 1, 0));

		if (availableLines.length > 0) {
			if (showingAllLines) {
				const displayText = availableLines
					.map((line, index) => (sixelLineMask?.[index] ? line : theme.fg("muted", line)))
					.join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, PREVIEW_LINES));
			}
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
				suppressHiddenCount: hasSixelOutput,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#clampDisplayLine(line: string): string {
		const visible = visibleWidth(line);
		if (visible <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = visible - MAX_DISPLAY_LINE_CHARS;
		return `${truncateToWidth(line, MAX_DISPLAY_LINE_CHARS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
	}

	#clampLinesPreservingSixel(lines: string[]): string[] {
		if (lines.length === 0) return [];
		const sixelLineMask = getSixelLineMask(lines);
		if (!sixelLineMask.some(Boolean)) {
			return lines.map(line => this.#clampDisplayLine(line));
		}
		return lines.map((line, index) => (sixelLineMask[index] ? line : this.#clampDisplayLine(line)));
	}

	#setOutput(output: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(output, sanitizeText);
		this.#outputLines = clean ? this.#clampLinesPreservingSixel(clean.split("\n")) : [];
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCommand(): string {
		return this.command;
	}
}
