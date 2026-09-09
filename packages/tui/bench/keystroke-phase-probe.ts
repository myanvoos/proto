// Splits keystroke frame cost: editor input vs compose+diff (render) vs emit (terminal.write).
const { TUI } = await import("../src");
const { Editor } = await import("../src/components/editor");
const { Markdown } = await import("../src/components/markdown");

import {
	BENCH_WIDTH,
	FakeTerminal,
	makeEditorTheme,
	makeMarkdownCorpus,
	makeMarkdownTheme,
	stats,
	syncScheduler,
} from "./perf-helpers";

const N = 2000;
const emitMs: number[] = [];
let emitAccum = 0;
let emitting = false;

class TimingTerminal extends FakeTerminal {
	override write(data: string): void {
		if (emitting) {
			const t = performance.now();
			super.write(data);
			emitAccum += performance.now() - t;
		} else {
			super.write(data);
		}
	}
}

const terminal = new TimingTerminal();
terminal.columns = BENCH_WIDTH;
const tui = new TUI(terminal, false, { renderScheduler: syncScheduler });
const editor = new Editor(makeEditorTheme());
editor.focused = true;
tui.addChild(new Markdown(makeMarkdownCorpus(40), 1, 0, makeMarkdownTheme()));
tui.addChild(editor);

const chars = "abcdefghijklmnopqrstuvwxyz .,!?\n";
for (let i = 0; i < 300; i++) {
	editor.handleInput(chars[i % chars.length]);
	tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
}

const inputMs: number[] = [];
const frameMs: number[] = [];
for (let i = 0; i < N; i++) {
	const char = chars[i % chars.length];
	let t = performance.now();
	editor.handleInput(char);
	inputMs.push(performance.now() - t);
	t = performance.now();
	emitAccum = 0;
	emitting = true;
	tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
	emitting = false;
	frameMs.push(performance.now() - t);
	emitMs.push(emitAccum);
}
const s = stats(frameMs);
const e = stats(emitMs);
const i = stats(inputMs);
console.log(
	JSON.stringify({
		frameP50us: s.p50 * 1000,
		frameP90us: s.p90 * 1000,
		emitP50us: e.p50 * 1000,
		emitP90us: e.p90 * 1000,
		emitShareP50: e.p50 / s.p50,
		inputP50us: i.p50 * 1000,
		nonEmitP50us: (s.p50 - e.p50) * 1000,
	}),
);
process.exit(0);
