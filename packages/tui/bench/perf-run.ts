/**
 * TUI performance harness: startup, keystroke→render latency, full-render
 * frame time, memory. Run: `bun bench/perf-run.ts [--out=file.json] [--compare=file.json]`
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TUI } from "../src";
import { Editor } from "../src/components/editor";
import { Markdown } from "../src/components/markdown";
import {
	BENCH_WIDTH,
	FakeTerminal,
	makeEditorTheme,
	makeMarkdownCorpus,
	makeMarkdownTheme,
	stats,
	syncScheduler,
} from "./perf-helpers";

const STARTUP_SPAWNS = 15;
const KEYSTROKE_SAMPLES = 1500;
const FULL_FRAME_SAMPLES = 300;
const CHURN_FRAMES = 1500;
const MARKDOWN_BLOCKS = 40;

function argValue(flag: string): string | undefined {
	const prefix = `--${flag}=`;
	const arg = process.argv.slice(2).find(a => a.startsWith(prefix));
	return arg?.slice(prefix.length);
}

async function measureStartup(): Promise<number[]> {
	const samples: number[] = [];
	const probe = path.join(import.meta.dir, "startup-probe.ts");
	for (let i = 0; i < STARTUP_SPAWNS; i++) {
		const proc = Bun.spawn(["bun", "run", probe], { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) {
			throw new Error(`startup probe failed (${exitCode}): ${await new Response(proc.stderr).text()}`);
		}
		const line = stdout.trim().split("\n").at(-1);
		if (!line) throw new Error("startup probe produced no output");
		samples.push(JSON.parse(line));
	}
	return samples;
}

function buildTui(): { tui: TUI; terminal: FakeTerminal; editor: Editor; transcriptTail: Markdown } {
	const terminal = new FakeTerminal();
	terminal.columns = BENCH_WIDTH;
	const tui = new TUI(terminal, false, { renderScheduler: syncScheduler });
	const editor = new Editor(makeEditorTheme());
	editor.focused = true;
	const transcriptTail = new Markdown(makeMarkdownCorpus(4), 1, 0, makeMarkdownTheme());
	tui.addChild(new Markdown(makeMarkdownCorpus(MARKDOWN_BLOCKS), 1, 0, makeMarkdownTheme()));
	tui.addChild(transcriptTail);
	tui.addChild(editor);
	return { tui, terminal, editor, transcriptTail };
}

async function drain(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function measureLatency(editor: Editor, tui: TUI): Promise<{ inputOnly: number[]; inputPlusFrame: number[] }> {
	const chars = "abcdefghijklmnopqrstuvwxyz .,!?\n";
	const inputOnly: number[] = [];
	const inputPlusFrame: number[] = [];
	// Warm caches (wrap cache, compose caches) so steady-state typing is measured.
	for (let i = 0; i < 200; i++) {
		editor.handleInput(chars[i % chars.length]);
		tui.requestRender(true);
		await drain();
	}
	for (let i = 0; i < KEYSTROKE_SAMPLES; i++) {
		const char = chars[i % chars.length];
		let start = performance.now();
		editor.handleInput(char);
		inputOnly.push(performance.now() - start);
		start = performance.now();
		tui.requestRender(true);
		await drain();
		inputPlusFrame.push(performance.now() - start);
	}
	// Balance the newline-heavy charset so the editor does not grow without bound.
	for (let i = 0; i < KEYSTROKE_SAMPLES / chars.length; i++) {
		editor.handleInput("\x7f");
		tui.requestRender(true);
		await drain();
	}
	return { inputOnly, inputPlusFrame };
}

async function measureFullFrames(tui: TUI, transcriptTail: Markdown): Promise<number[]> {
	const samples: number[] = [];
	const token = " streaming token words follow ";
	let text = makeMarkdownCorpus(4);
	for (let i = 0; i < 50; i++) {
		text += token;
		transcriptTail.setText(text);
		tui.requestRender(true);
		await drain();
	}
	for (let i = 0; i < FULL_FRAME_SAMPLES; i++) {
		text += token;
		transcriptTail.setText(text);
		const start = performance.now();
		tui.requestRender(true);
		await drain();
		samples.push(performance.now() - start);
	}
	return samples;
}

async function measureMemory(editor: Editor, tui: TUI): Promise<{ rssMb: number; heapMb: number; retainedMb: number }> {
	const chars = "abcdefghij";
	Bun.gc(true);
	const before = process.memoryUsage();
	const created: Markdown[] = [];
	for (let i = 0; i < CHURN_FRAMES; i++) {
		editor.handleInput(chars[i % chars.length]);
		tui.requestRender(true);
		await drain();
		if (i % 25 === 0) {
			// Create and drop components the way streaming turns do.
			created.push(new Markdown(makeMarkdownCorpus(4), 1, 0, makeMarkdownTheme()));
			if (created.length > 60) created.shift();
		}
	}
	created.length = 0;
	Bun.gc(true);
	const after = process.memoryUsage();
	return {
		rssMb: after.rss / 1024 / 1024,
		heapMb: after.heapUsed / 1024 / 1024,
		retainedMb: (after.heapUsed - before.heapUsed) / 1024 / 1024,
	};
}

const rows: string[] = [];
function row(label: string, value: string): void {
	rows.push(`${label}: ${value}`);
	console.log(`${label}: ${value}`);
}

const startup = await measureStartup();
const startupStats = {
	importMs: stats(startup.map(s => s.importMs)),
	constructMs: stats(startup.map(s => s.constructMs)),
	firstFrameMs: stats(startup.map(s => s.firstFrameMs)),
	rssMb: stats(startup.map(s => s.rssMb)),
};
console.log("\n== startup (fresh process, n=%d) ==", STARTUP_SPAWNS);
row("startup.importMs.p50", startupStats.importMs.p50.toFixed(3));
row("startup.firstFrameMs.p50", startupStats.firstFrameMs.p50.toFixed(3));
row("startup.rssMb.p50", startupStats.rssMb.p50.toFixed(1));

const { tui, editor, transcriptTail } = buildTui();
const { inputOnly, inputPlusFrame } = await measureLatency(editor, tui);
const fullFrames = await measureFullFrames(tui, transcriptTail);
const memory = await measureMemory(editor, tui);

console.log("\n== keystroke→render (n=%d) ==", KEYSTROKE_SAMPLES);
const inputStats = stats(inputOnly);
const frameStats = stats(inputPlusFrame);
row("keystroke.inputOnlyMs.p50", inputStats.p50.toFixed(4));
row("keystroke.inputOnlyMs.p99", inputStats.p99.toFixed(4));
row("keystroke.frameMs.p50", frameStats.p50.toFixed(4));
row("keystroke.frameMs.p90", frameStats.p90.toFixed(4));
row("keystroke.frameMs.p99", frameStats.p99.toFixed(4));

console.log("\n== full-render frame (n=%d) ==", FULL_FRAME_SAMPLES);
const fullStats = stats(fullFrames);
row("fullFrame.ms.p50", fullStats.p50.toFixed(4));
row("fullFrame.ms.p90", fullStats.p90.toFixed(4));
row("fullFrame.ms.p99", fullStats.p99.toFixed(4));

console.log("\n== memory after churn ==");
row("memory.rssMb", memory.rssMb.toFixed(1));
row("memory.heapMb", memory.heapMb.toFixed(1));
row("memory.retainedMb", memory.retainedMb.toFixed(2));

tui.stop();

const report = {
	meta: {
		date: new Date().toISOString(),
		bun: Bun.version,
		cpus: navigator.hardwareConcurrency,
		platform: process.platform,
		markdownBlocks: MARKDOWN_BLOCKS,
		samples: { startup: STARTUP_SPAWNS, keystroke: KEYSTROKE_SAMPLES, fullFrame: FULL_FRAME_SAMPLES },
	},
	startup: startupStats,
	keystroke: { inputOnly: inputStats, inputPlusFrame: frameStats },
	fullFrame: fullStats,
	memory,
	rows,
};

const out = argValue("out");
if (out) {
	await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`\nwritten: ${out}`);
}

const comparePath = argValue("compare");
if (comparePath) {
	const baseline = JSON.parse(await Bun.file(comparePath).text());
	console.log("\n== vs baseline (%s) ==", comparePath);
	const deltas: Record<string, number> = {};
	const compare = (label: string, current: number, base: number, lowerIsBetter = true) => {
		if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return;
		const deltaPct = ((current - base) / base) * 100;
		deltas[label] = deltaPct;
		const arrow = lowerIsBetter ? (deltaPct < 0 ? "improved" : "regressed") : deltaPct > 0 ? "improved" : "regressed";
		console.log(`${label}: ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% (${arrow})`);
	};
	compare("startup.importMs.p50", startupStats.importMs.p50, baseline.startup.importMs.p50);
	compare("startup.firstFrameMs.p50", startupStats.firstFrameMs.p50, baseline.startup.firstFrameMs.p50);
	compare("keystroke.frameMs.p50", frameStats.p50, baseline.keystroke.inputPlusFrame.p50);
	compare("keystroke.frameMs.p99", frameStats.p99, baseline.keystroke.inputPlusFrame.p99);
	compare("fullFrame.ms.p50", fullStats.p50, baseline.fullFrame.p50);
	compare("fullFrame.ms.p99", fullStats.p99, baseline.fullFrame.p99);
	compare("memory.rssMb", memory.rssMb, baseline.memory.rssMb);
	if (out && out === comparePath) {
		await fs.writeFile(out, `${JSON.stringify({ ...report, vsBaseline: deltas }, null, 2)}\n`);
	}
}
