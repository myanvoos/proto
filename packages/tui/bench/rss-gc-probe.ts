// RSS growth with GC forced every frame: distinguishes JS-garbage arena growth from native growth.
const mode = process.argv[2];
const { TUI } = await import("../src");
const { Editor } = await import("../src/components/editor");
const { Markdown } = await import("../src/components/markdown");
const { FakeTerminal, syncScheduler, makeEditorTheme, makeMarkdownTheme, makeMarkdownCorpus, BENCH_WIDTH } =
	await import("./perf-helpers");

const terminal = new FakeTerminal();
terminal.columns = BENCH_WIDTH;
const tui = new TUI(terminal, false, { renderScheduler: syncScheduler });
const editor = new Editor(makeEditorTheme());
editor.focused = true;
const tail = new Markdown(makeMarkdownCorpus(4), 1, 0, makeMarkdownTheme());
tui.addChild(new Markdown(makeMarkdownCorpus(40), 1, 0, makeMarkdownTheme()));
tui.addChild(tail);
tui.addChild(editor);

let text = makeMarkdownCorpus(4);
const chars = "abcdefghij";
for (let i = 0; i < 1500; i++) {
	if (mode === "editor") editor.handleInput(chars[i % chars.length]);
	if (mode === "markdown") {
		text += " streaming token words follow ";
		if (i % 4 === 0) tail.setText(text);
	}
	editor.focused && tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
	Bun.gc(true);
}
console.log(
	JSON.stringify({
		mode,
		rssMb: process.memoryUsage.rss() / 1024 / 1024,
		heapMb: process.memoryUsage().heapUsed / 1024 / 1024,
	}),
);
process.exit(0);
