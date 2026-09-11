// TUI RSS soak: run `bun bench/rss-soak-probe.ts [mixed|editor|markdown]`.
// Samples a 10k-frame churn loop every 500 frames after an explicit GC.
import { TUI } from "../src";
import { Editor } from "../src/components/editor";
import { Markdown } from "../src/components/markdown";
import {
	BENCH_WIDTH,
	FakeTerminal,
	makeEditorTheme,
	makeMarkdownCorpus,
	makeMarkdownTheme,
	syncScheduler,
} from "./perf-helpers";

type Mode = "mixed" | "editor" | "markdown";
interface MemorySample {
	frame: number;
	rssMb: number;
	heapMb: number;
	rssDeltaMb: number;
	heapDeltaMb: number;
}

const mode = (process.argv[2] ?? "mixed") as Mode;
if (mode !== "mixed" && mode !== "editor" && mode !== "markdown") {
	throw new Error(`mode must be mixed, editor, or markdown (got ${mode})`);
}

const FRAMES = 10_000;
const SAMPLE_EVERY = 500;
const chars = "abcdefghij";
const terminal = new FakeTerminal();
terminal.columns = BENCH_WIDTH;
const tui = new TUI(terminal, false, { renderScheduler: syncScheduler });
const editor = new Editor(makeEditorTheme());
editor.focused = true;
const transcriptTail = new Markdown(makeMarkdownCorpus(4), 1, 0, makeMarkdownTheme());
tui.addChild(transcriptTail);

async function drain(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function memory(): { rssMb: number; heapMb: number } {
	const usage = process.memoryUsage();
	return { rssMb: usage.rss / 1024 / 1024, heapMb: usage.heapUsed / 1024 / 1024 };
}

Bun.gc(true);
const before = memory();
const samples: MemorySample[] = [];
try {
	for (let frame = 1; frame <= FRAMES; frame++) {
		if (mode === "mixed" || mode === "editor") editor.handleInput(chars[(frame - 1) % chars.length]);
		if (mode === "mixed" || mode === "markdown") {
			// Construct and immediately drop the same short-lived component shape
			// used by streaming turns; this intentionally does not retain a cache.
			new Markdown(makeMarkdownCorpus(4), 1, 0, makeMarkdownTheme());
			if (frame % 4 === 0) transcriptTail.setText(`${makeMarkdownCorpus(4)} streaming token words follow `);
		}
		tui.requestRender(true);
		await drain();
		if (frame % SAMPLE_EVERY === 0) {
			Bun.gc(true);
			const current = memory();
			samples.push({
				frame,
				rssMb: current.rssMb,
				heapMb: current.heapMb,
				rssDeltaMb: current.rssMb - before.rssMb,
				heapDeltaMb: current.heapMb - before.heapMb,
			});
			console.log(JSON.stringify({ mode, ...samples.at(-1) }));
		}
	}
} finally {
	tui.stop();
}

const after = samples.at(-1);
if (!after) throw new Error("soak produced no samples");
console.log(
	JSON.stringify({
		mode,
		frames: FRAMES,
		sampleEvery: SAMPLE_EVERY,
		before,
		after,
		rssDeltaMb: after.rssDeltaMb,
		heapDeltaMb: after.heapDeltaMb,
		samples,
	}),
);
