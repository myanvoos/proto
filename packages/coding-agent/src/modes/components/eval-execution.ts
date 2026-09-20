import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component as TuiComponent } from "@oh-my-pi/pi-tui";
import { Container, Image, ImageProtocol, type Loader, Markdown, TERMINAL, Text, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { KernelDisplayOutput } from "../../eval/py/display";
import { normalizeKernelDisplayOutput, PythonDisplayBudget, type PythonDisplayOutput } from "../../eval/py/display";
import { getMarkdownTheme, highlightCode, theme } from "../../modes/theme/theme";
import type { ExecutionMetadata } from "../../session/execution-metadata";
import type { TruncationMeta } from "../../tools/output-meta";
import { resolveImageOptions } from "../../tools/render-utils";
import { convertImageToPng } from "../../utils/image-loading";
import {
	buildExecutionFrame,
	buildStatusFooter,
	createCollapsedPreview,
	type ExecutionColorKey,
	type ExecutionStatus,
	resolveExecutionStatus,
} from "./execution-shared";

const PREVIEW_LINES = 20;
const MAX_DISPLAY_LINE_CHARS = 4000;
// Coalesce streaming rich blocks into one rebuild per frame window; flush
// synchronously on completion/disposal so nothing is lost at the end.
const DISPLAY_FLUSH_MS = 33;

type EvalExecutionLanguage = "python" | "js";

/** Per-card instance seed: rich-image keys must be unique across cards. */
let nextEvalExecutionUid = 0;

export class EvalExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#execution?: ExecutionMetadata;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;

	#blockVersion = 0;
	#onTranscriptBlockChange?: () => void;
	#contentContainer: Container;
	#ui: TUI;
	#displayBudget = new PythonDisplayBudget();
	#imageKeyPrefix = `py${++nextEvalExecutionUid}`;
	#kittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#displayFlushTimer: ReturnType<typeof setTimeout> | undefined;
	#complete = false;

	#highlightLang(): "python" | "javascript" {
		return this.language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: ExecutionColorKey): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 1, 0);
	}

	constructor(
		private readonly code: string,
		ui: TUI,
		private readonly excludeFromContext = false,
		private readonly language: EvalExecutionLanguage = "python",
	) {
		super();
		this.#ui = ui;

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		this.#contentContainer.addChild(this.#formatHeader(colorKey));
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
		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	override dispose(): void {
		if (this.#displayFlushTimer) {
			clearTimeout(this.#displayFlushTimer);
			this.#displayFlushTimer = undefined;
		}
		this.#complete = true;
		this.#onTranscriptBlockChange?.();
		this.#onTranscriptBlockChange = undefined;
		super.dispose();
	}

	appendOutput(chunk: string): void {
		// Streaming chunks render before completion; sanitize like #setOutput.
		const newLines = sanitizeText(chunk)
			.split("\n")
			.map(line => this.#clampDisplayLine(line));
		if (this.#outputLines.length > 0 && newLines.length > 0) {
			this.#outputLines[this.#outputLines.length - 1] = this.#clampDisplayLine(
				`${this.#outputLines[this.#outputLines.length - 1]}${newLines[0]}`,
			);
			this.#outputLines.push(...newLines.slice(1));
		} else {
			this.#outputLines.push(...newLines);
		}

		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: {
			output?: string;
			truncation?: TruncationMeta;
			execution?: ExecutionMetadata;
			displayOutputs?: PythonDisplayOutput[];
		},
	): void {
		this.#exitCode = exitCode;
		this.#execution = options?.execution;
		this.#status = resolveExecutionStatus(exitCode, cancelled, this.#execution);
		this.#truncation = options?.truncation;
		if (options?.displayOutputs !== undefined) {
			// Rebuild path: hydrate the persisted blocks wholesale (the live
			// onDisplay stream never ran for a rebuilt card). They were capped
			// when persisted, so adopt without re-gating.
			this.#displayBudget = new PythonDisplayBudget();
			this.#displayBudget.adopt(options.displayOutputs);
		}
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		this.#complete = true;
		this.#flushDisplayBlocks();
		this.#loader.stop();
		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	/**
	 * Live rich-display stream from the kernel. Each output is normalized to
	 * its persisted presentation block; text/markdown/json render inline in
	 * the card, images go through the shared terminal image pipeline with a
	 * stable per-block key so ImageBudget treats replays as the same image.
	 */
	appendDisplayOutput(output: KernelDisplayOutput): void {
		if (this.#complete) return;
		const block = normalizeKernelDisplayOutput(output);
		if (!block) return;
		// The shared budget enforces per-block clipping, aggregate text,
		// image-count, and persistence caps identically to the persist path.
		this.#displayBudget.add(block);
		this.#scheduleDisplayFlush();
	}

	#scheduleDisplayFlush(): void {
		if (this.#displayFlushTimer) return;
		this.#displayFlushTimer = setTimeout(() => {
			this.#displayFlushTimer = undefined;
			this.#flushDisplayBlocks();
		}, DISPLAY_FLUSH_MS);
		this.#displayFlushTimer.unref?.();
	}

	#flushDisplayBlocks(): void {
		if (this.#displayFlushTimer) {
			clearTimeout(this.#displayFlushTimer);
			this.#displayFlushTimer = undefined;
		}
		this.#convertKittyImages();
		this.#updateDisplay();
		this.#onTranscriptBlockChange?.();
	}

	#convertKittyImages(): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const block of this.#displayBudget.blocks) {
			if (block.type !== "image" || block.mimeType === "image/png") continue;
			const key = this.#imageKeyForBlock(block);
			if (this.#kittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			const image: ImageContent = { type: "image", data: block.data, mimeType: block.mimeType };
			void convertImageToPng(image)
				.then(converted => {
					this.#kittyConversionsInFlight.delete(key);
					this.#kittyImages.set(key, converted);
					this.#updateDisplay();
					this.#ui.requestRender();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	#imageKeyForBlock(block: PythonDisplayOutput): string {
		const index = this.#displayBudget.blocks.indexOf(block);
		// The prefix is unique per card instance: two cards rendering
		// different payloads must never share one ImageBudget identity, and
		// rebuilt cards retransmit instead of replaying a dead payload.
		return `${this.#imageKeyPrefix}:${index}`;
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);

		const hiddenLineCount = this.#expanded ? 0 : availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		if (availableLines.length > 0) {
			if (this.#expanded) {
				const displayText = availableLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, PREVIEW_LINES));
			}
		}

		for (const block of this.#displayBudget.blocks) {
			const child = this.#renderDisplayBlock(block);
			if (child) this.#contentContainer.addChild(child);
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#renderDisplayBlock(block: PythonDisplayOutput): TuiComponent | undefined {
		switch (block.type) {
			case "text": {
				const text = this.#clampDisplayLine(sanitizeText(block.text));
				return text ? new Text(theme.fg("muted", text), 1, 0) : undefined;
			}
			case "markdown": {
				const text = this.#clampDisplayLine(sanitizeText(block.text));
				return text ? new Markdown(text, 1, 0, getMarkdownTheme()) : undefined;
			}
			case "json": {
				const text = this.#clampDisplayLine(sanitizeText(block.text));
				return text ? new Text(theme.fg("muted", text), 1, 0) : undefined;
			}
			case "notice":
				return new Text(theme.fg("toolOutput", sanitizeText(`[display] ${block.text}`)), 1, 0);
			case "image": {
				const key = this.#imageKeyForBlock(block);
				const displayImage =
					TERMINAL.imageProtocol === ImageProtocol.Kitty && block.mimeType !== "image/png"
						? this.#kittyImages.get(key)
						: ({ type: "image", data: block.data, mimeType: block.mimeType } satisfies ImageContent);
				if (!TERMINAL.imageProtocol || !displayImage) {
					return new Text(theme.fg("toolOutput", `[Image: ${block.mimeType}]`), 1, 0);
				}
				return new Image(
					displayImage.data,
					displayImage.mimeType,
					{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
					{ ...resolveImageOptions(), budget: this.#ui.imageBudget, imageKey: key },
				);
			}
		}
	}

	#clampDisplayLine(line: string): string {
		if (line.length <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = line.length - MAX_DISPLAY_LINE_CHARS;
		return `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}… [${omitted} chars omitted]`;
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputLines = clean ? clean.split("\n").map(line => this.#clampDisplayLine(line)) : [];
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCode(): string {
		return this.code;
	}
}
