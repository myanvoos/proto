import { type Component, Container, Markdown } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { attachmentSgr, collapseImageMarkers, renderPlaceholders } from "../composer-attachments";
import { imageReferenceHyperlink } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

export class UserMessageComponent extends Container {
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	#working = false;
	#version = 0;

	setWorking(working: boolean): void {
		if (this.#working === working) return;
		this.#working = working;
		this.#version++;
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		text = collapseImageMarkers(text, Number.POSITIVE_INFINITY, () => {});
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index, form) => {
					const styled =
						form === "chip"
							? `${attachmentSgr(kind, index)}\x1b[1m${label}\x1b[22m${keywordReset}`
							: theme.fg("accent", `\x1b[1m${label}\x1b[22m`);
					return kind === "image" ? imageReferenceHyperlink(label, index, imageLinks, () => styled) : styled;
				},
			});
		const md = new Markdown(text, 0, 1, getMarkdownTheme(), {
			color,
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(Math.max(1, width - 4));
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const gutter = `  ${theme.fg(this.#working ? "borderAccent" : "dim", "›")} `;
		let gutterPlaced = false;
		const wrapped = lines.map(line => {
			if (!gutterPlaced && Bun.stripANSI(line).trim().length > 0) {
				gutterPlaced = true;
				return gutter + line;
			}
			return line.length > 0 ? `    ${line}` : line;
		});
		wrapped[0] = OSC133_ZONE_START + wrapped[0]!;
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1]! + OSC133_ZONE_CLOSE;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

export class CollapsedSyntheticMessageComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: readonly string[] };
	#body?: UserMessageComponent;
	readonly #summary: string;

	constructor(
		private readonly text: string,
		private readonly imageLinks?: readonly (string | undefined)[],
	) {
		this.#summary = summarizeSyntheticInput(text);
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#body?.invalidate?.();
	}

	dispose(): void {
		this.#body?.dispose?.();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = this.#expanded ? this.#renderExpanded(width) : [` ${this.#summaryRow(width)}`];
		this.#cache = { width, lines };
		return lines;
	}

	#renderExpanded(width: number): readonly string[] {
		if (!this.#body) this.#body = new UserMessageComponent(this.text, true, this.imageLinks);
		return [` ${this.#summaryRow(width)}`, ...this.#body.render(width)];
	}

	#summaryRow(width: number): string {
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		return theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)));
	}
}

function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(text)} ${dot} ${size} ${dot} ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "Synthetic input" : "Synthetic input";
	}
	return "Synthetic input";
}
