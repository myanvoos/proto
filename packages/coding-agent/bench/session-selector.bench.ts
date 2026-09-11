/**
 * Session selector rendering harness. Synthesizes a deterministic corpus and measures
 * full SessionList renders, navigation + render, and search filtering + render.
 * Run: bun packages/coding-agent/bench/session-selector.bench.ts [--count=500] [--width=120]
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { SessionSelectorComponent } from "../src/modes/components/session-selector";
import { initThemeSync } from "../src/modes/theme/theme";
import type { SessionInfo } from "../src/session/session-listing";

function argValue(flag: string): string | undefined {
	const prefix = `--${flag}=`;
	return process.argv
		.slice(2)
		.find(value => value.startsWith(prefix))
		?.slice(prefix.length);
}

function stats(samples: number[]): { p50: number; p90: number; p99: number; n: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const pick = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
	return { p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), n: sorted.length };
}

function row(label: string, samples: number[]): string {
	const result = stats(samples);
	return `${label}.p50=${result.p50.toFixed(3)}ms p90=${result.p90.toFixed(3)}ms p99=${result.p99.toFixed(3)}ms (n=${result.n})`;
}

function makeSessions(count: number, directory: string): SessionInfo[] {
	const modified = new Date("2026-09-01T12:00:00.000Z").getTime();
	return Array.from({ length: count }, (_, index) => {
		const hasTitle = index % 3 !== 0;
		return {
			path: path.join(directory, `2026-09-01T12-00-${String(index).padStart(4, "0")}_session-${index}.jsonl`),
			id: `session-${index}`,
			cwd: index % 4 === 0 ? "/home/spark-mint/code/proto" : "/home/spark-mint/code/proto/packages/coding-agent",
			title: hasTitle ? `Implement session browser optimization ${index}` : undefined,
			created: new Date(modified - index * 60_000),
			modified: new Date(modified - index * 60_000),
			messageCount: 20 + (index % 37),
			size: 1_024 + index * 97,
			firstMessage: `Review session-${index}: inspect the session browser and improve selector latency.`,
			allMessagesText: `session-${index} selector browser latency optimization`,
			status: index % 5 === 0 ? "complete" : index % 5 === 1 ? "interrupted" : undefined,
			parentSessionPath:
				index % 11 === 0 && index > 0 ? path.join(directory, `parent-${index - 1}.jsonl`) : undefined,
		};
	});
}

await Settings.init({ inMemory: true });
initThemeSync();
const width = Number(argValue("width") ?? 120);
const count = Math.max(500, Number(argValue("count") ?? 750));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-selector-bench-"));
const sessions = makeSessions(count, tempDir);
const selector = new SessionSelectorComponent(
	sessions,
	() => {},
	() => {},
	() => {},
	{
		showCwd: true,
		getTerminalRows: () => 24,
	},
);
const list = selector.getSessionList();
const rows: string[] = [];
try {
	// Warm component/theme code and establish a stable render baseline.
	list.render(width);
	const renderSamples: number[] = [];
	for (let i = 0; i < 30; i++) {
		const start = performance.now();
		const lines = list.render(width);
		if (lines.length === 0) throw new Error("selector render produced no lines");
		renderSamples.push(performance.now() - start);
	}
	rows.push(row("render", renderSamples));

	const navigationSamples: number[] = [];
	for (let i = 0; i < 30; i++) {
		const start = performance.now();
		list.handleInput("\x1b[B");
		const lines = list.render(width);
		if (lines.length === 0) throw new Error("selector navigation render produced no lines");
		navigationSamples.push(performance.now() - start);
	}
	rows.push(row("navigation", navigationSamples));

	const query = "session-42";
	const searchSamples: number[] = [];
	for (const character of query) {
		const start = performance.now();
		list.handleInput(character);
		const lines = list.render(width);
		if (lines.length === 0) throw new Error("selector search render produced no lines");
		searchSamples.push(performance.now() - start);
	}
	rows.push(row("search", searchSamples));

	for (const line of rows) console.log(line);
	console.log(`(sessions: ${sessions.length}, width: ${width})`);
	const output = argValue("out");
	if (output) await Bun.write(output, `${JSON.stringify({ rows, count: sessions.length, width }, null, 2)}\n`);
} finally {
	selector.dispose();
	await fs.rm(tempDir, { recursive: true, force: true });
}
