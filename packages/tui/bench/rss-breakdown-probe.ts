// Reports /proc/self/status + smaps_rollup after building the tree and churning frames.
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
for (let i = 0; i < 1500; i++) {
	text += " streaming token words follow ";
	if (i % 4 === 0) tail.setText(text);
	tui.requestRender(true);
	await Promise.resolve();
	await Promise.resolve();
}
Bun.gc(true);
const status = await Bun.file("/proc/self/status").text();
const rollup = await Bun.file("/proc/self/smaps_rollup").text();
const grab = (src: string, key: string) => Number(src.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0) / 1024;
console.log(
	JSON.stringify({
		rssMb: grab(status, "VmRSS"),
		anonMb: grab(rollup, "Anonymous"),
		fileMb: grab(rollup, "RssFile"),
		sharedMb: grab(rollup, "Shared_Clean") + grab(rollup, "Shared_Dirty"),
		heapMb: process.memoryUsage().heapUsed / 1024 / 1024,
	}),
);
process.exit(0);
