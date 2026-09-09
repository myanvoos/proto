/**
 * Startup probe: fresh process, measures (1) cold import of pi-tui,
 * (2) TUI construction + tree build, (3) first frame compose+diff+write.
 * Prints one JSON line. Spawned repeatedly by perf-run.ts.
 */
const importStart = performance.now();
const { TUI } = await import("../src");
const { Editor } = await import("../src/components/editor");
const { Markdown } = await import("../src/components/markdown");
const importMs = performance.now() - importStart;

const { FakeTerminal, syncScheduler, makeEditorTheme, makeMarkdownTheme, makeMarkdownCorpus, BENCH_WIDTH } =
	await import("./perf-helpers");

const constructStart = performance.now();
const terminal = new FakeTerminal();
terminal.columns = BENCH_WIDTH;
const tui = new TUI(terminal, false, { renderScheduler: syncScheduler });
const editor = new Editor(makeEditorTheme());
editor.focused = true;
tui.addChild(new Markdown(makeMarkdownCorpus(40), 1, 0, makeMarkdownTheme()));
tui.addChild(editor);
const constructMs = performance.now() - constructStart;

const frameStart = performance.now();
tui.requestRender(true);
await Promise.resolve();
const firstFrameMs = performance.now() - frameStart;

tui.stop?.();

process.stdout.write(
	`${JSON.stringify({ importMs, constructMs, firstFrameMs, rssMb: process.memoryUsage.rss() / 1024 / 1024 })}\n`,
);
process.exit(0);
