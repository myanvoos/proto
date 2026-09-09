// Measures bytes written to the terminal per keystroke frame and per idle frame.
const { TUI } = await import("../src");
const { Editor } = await import("../src/components/editor");
const { Markdown } = await import("../src/components/markdown");

import {
	BENCH_WIDTH,
	FakeTerminal,
	makeEditorTheme,
	makeMarkdownCorpus,
	makeMarkdownTheme,
	syncScheduler,
} from "./perf-helpers";

const terminal = new FakeTerminal();
terminal.columns = BENCH_WIDTH;
const tui = new TUI(terminal, false, { renderScheduler: syncScheduler });
const editor = new Editor(makeEditorTheme());
editor.focused = true;
const tail = new Markdown(makeMarkdownCorpus(4), 1, 0, makeMarkdownTheme());
tui.addChild(new Markdown(makeMarkdownCorpus(40), 1, 0, makeMarkdownTheme()));
tui.addChild(tail);
tui.addChild(editor);

let bytes = 0;
const origWrite = terminal.write.bind(terminal);
terminal.write = (data: string) => {
	bytes += data.length;
	origWrite(data);
};

const chars = "abcdefghij";
for (let i = 0; i < 300; i++) {
	editor.handleInput(chars[i % chars.length]);
	tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
}
bytes = 0;
for (let i = 0; i < 20; i++) {
	editor.handleInput(chars[i % chars.length]);
	tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
}
const perKeystroke = bytes / 20;
bytes = 0;
for (let i = 0; i < 20; i++) {
	tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
}
const perIdleForced = bytes / 20;
bytes = 0;
for (let i = 0; i < 20; i++) {
	editor.handleInput(chars[i % chars.length]);
	tui.requestRender();
	await Promise.resolve();
	await Promise.resolve();
}
const perOrdinary = bytes / 20;
console.log(
	JSON.stringify({
		perKeystrokeForced: Math.round(perKeystroke),
		perIdleForced: Math.round(perIdleForced),
		perKeystrokeOrdinary: Math.round(perOrdinary),
	}),
);
process.exit(0);
