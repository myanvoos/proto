import type { Component, RenderScheduler, Terminal } from "../src";
import type { BoxSymbols } from "../src/components/box";
import type { EditorTheme } from "../src/components/editor";
import { Editor } from "../src/components/editor";
import type { MarkdownTheme } from "../src/components/markdown";
import { Markdown } from "../src/components/markdown";
import type { SelectListTheme, SymbolTheme } from "../src/components/select-list";

export const BENCH_WIDTH = 120;
export const BENCH_ROWS = 45;

const box: BoxSymbols = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
	cross: "+",
	teeDown: "+",
	teeUp: "+",
	teeLeft: "+",
	teeRight: "+",
};

export function makeSymbolTheme(): SymbolTheme {
	return {
		cursor: ">",
		inputCursor: "|",
		boxRound: box,
		boxSharp: box,
		table: box,
		quoteBorder: "|",
		hrChar: "-",
		colorSwatch: "[]",
		spinnerFrames: ["-", "\\", "|", "/"],
	};
}

const id = (text: string) => text;

export function makeEditorTheme(): EditorTheme {
	const symbols = makeSymbolTheme();
	const selectList: SelectListTheme = {
		selectedPrefix: id,
		selectedText: id,
		description: id,
		scrollInfo: id,
		noMatch: id,
		symbols,
	};
	return { borderColor: id, accentColor: id, surfaceColor: id, selectList, symbols };
}

export function makeMarkdownTheme(): MarkdownTheme {
	const symbols = makeSymbolTheme();
	return {
		heading: id,
		link: id,
		linkUrl: id,
		code: id,
		codeBlock: id,
		codeBlockBorder: id,
		quote: id,
		quoteBorder: id,
		hr: id,
		listBullet: id,
		bold: id,
		italic: id,
		strikethrough: id,
		underline: id,
		symbols,
	};
}

/** Captures everything the TUI emits; no real terminal involved. */
export class FakeTerminal implements Terminal {
	columns = BENCH_WIDTH;
	rows = BENCH_ROWS;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	readonly pendingOutputBytes = 0;
	frames: string[] = [];
	onInputHandler: ((data: string) => void) | undefined;

	/** Bounded so long benchmark runs do not retain every frame ever written. */
	write(data: string): void {
		this.frames.push(data);
		if (this.frames.length > 8) this.frames.splice(0, this.frames.length - 8);
	}

	start(onInput: (data: string) => void): void {
		this.onInputHandler = onInput;
	}

	stop(): void {}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	get appearance(): undefined {
		return undefined;
	}
}

export const syncScheduler: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => queueMicrotask(callback),
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timer) };
	},
};

const PARAGRAPH =
	"The quick brown fox jumps over the lazy dog while 🚀 emoji and a `code span` " +
	"plus **bold** and _italic_ text exercise the markdown lexer and the grapheme segmenter. ";

const CODE_BLOCK = "\n```ts\nconst x: number = compute(a, b) + delta;\nreturn x.toFixed(2);\n```\n\n";
const LIST = "\n- first bullet item\n- second bullet item with `inline`\n- third\n\n";

export function makeMarkdownCorpus(blockCount: number): string {
	let out = "";
	let i = 0;
	while (out.split("\n").length < blockCount * 6) {
		out += `## Section ${++i}\n\n${PARAGRAPH}${PARAGRAPH}${CODE_BLOCK}${LIST}`;
	}
	return out;
}

/** Realistic transcript-shaped component list: markdown transcript + live editor at the bottom. */
export function buildComponents(markdownBlocks: number): Component[] {
	const components: Component[] = [];
	for (let i = 0; i < markdownBlocks; i++) {
		// Alternate content shapes so caches never trivially hit one code path.
		const text =
			i % 3 === 0
				? `## Turn ${i}\n\n${PARAGRAPH}`
				: i % 3 === 1
					? `${PARAGRAPH}${PARAGRAPH}${CODE_BLOCK}`
					: `${LIST}- item ${i} with text\n\n${PARAGRAPH}`;
		components.push(new Markdown(text, 1, 0, makeMarkdownTheme()));
	}
	const editor = new Editor(makeEditorTheme());
	editor.focused = true;
	components.push(editor);
	return components;
}

export function percentile(samples: number[], p: number): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index];
}

export function stats(samples: number[]): { p50: number; p90: number; p99: number; mean: number; n: number } {
	return {
		p50: percentile(samples, 50),
		p90: percentile(samples, 90),
		p99: percentile(samples, 99),
		mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
		n: samples.length,
	};
}

export type { Component };
