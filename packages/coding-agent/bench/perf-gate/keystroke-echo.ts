#!/usr/bin/env bun
/**
 * Keystroke-echo latency harness: time from feeding a key into the real TUI
 * input path to the next paint hitting the terminal sink. Modes: cold editor,
 * editor over a 400-line loaded transcript, and a large paste burst.
 * Usage: bun bench/perf-gate/keystroke-echo.ts
 */
import { type Terminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../src/config/settings";
import { CustomEditor } from "../../src/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "../../src/modes/theme/theme";
import { FakeTerminal } from "./fake-terminal";
import { envInt, mean, pct, writeResults } from "./lib";

await Settings.init({ inMemory: true });
await initTheme("dark");

const KEYS = envInt("KEYS", 60);
const LOAD_LINES = 400;

function makeText(lines: number): string[] {
	return Array.from({ length: lines }, (_, i) => `msg ${i}: the quick brown fox jumps over the lazy dog`);
}

async function measureEcho(term: FakeTerminal, keys: string[]): Promise<number[]> {
	const samples: number[] = [];
	for (const k of keys) {
		const startIdx = term.writeTimesNs.length;
		const t0 = Bun.nanoseconds();
		term.feed(k);
		let guard = 0;
		while (term.writeTimesNs.length <= startIdx && guard++ < 250) await Bun.sleep(1);
		if (term.writeTimesNs.length <= startIdx) continue;
		samples.push((Number(term.writeTimesNs[term.writeTimesNs.length - 1]!) - Number(t0)) / 1e6);
	}
	return samples;
}

async function main() {
	const results: Record<string, { samples: number[]; p50: number; p95: number; max: number; mean: number }> = {};
	const keys = "the quick brown fox jumps over the lazy dog 0123456789".slice(0, KEYS).split("");

	// Mode A: cold editor
	{
		const term = new FakeTerminal();
		const ui = new TUI(term as unknown as Terminal, false);
		const editor = new CustomEditor(getEditorTheme());
		ui.addChild(editor);
		ui.setFocus(editor);
		ui.start();
		await Bun.sleep(80);
		term.writeTimesNs.length = 0;
		term.lastWriteNs = 0n;
		const samples = await measureEcho(term, keys);
		await ui.stop();
		results.cold = {
			samples,
			p50: pct(samples, 50),
			p95: pct(samples, 95),
			max: Math.max(...samples),
			mean: mean(samples),
		};
	}

	// Mode B: loaded transcript (400 text lines pre-appended)
	{
		const term = new FakeTerminal();
		const ui = new TUI(term as unknown as Terminal, false);
		for (const line of makeText(LOAD_LINES)) ui.addChild(new Text(line));
		const editor = new CustomEditor(getEditorTheme());
		ui.addChild(editor);
		ui.setFocus(editor);
		ui.start();
		await Bun.sleep(120);
		term.writeTimesNs.length = 0;
		term.lastWriteNs = 0n;
		const samples = await measureEcho(term, keys);
		await ui.stop();
		results.loaded = {
			samples,
			p50: pct(samples, 50),
			p95: pct(samples, 95),
			max: Math.max(...samples),
			mean: mean(samples),
		};
	}

	// Mode C: paste burst (2KB in one feed)
	{
		const term = new FakeTerminal();
		const ui = new TUI(term as unknown as Terminal, false);
		const editor = new CustomEditor(getEditorTheme());
		ui.addChild(editor);
		ui.setFocus(editor);
		ui.start();
		await Bun.sleep(80);
		term.writeTimesNs.length = 0;
		term.lastWriteNs = 0n;
		const samples = await measureEcho(term, ["x".repeat(2048)]);
		await ui.stop();
		results.paste = {
			samples,
			p50: pct(samples, 50),
			p95: pct(samples, 95),
			max: Math.max(...samples),
			mean: mean(samples),
		};
	}

	const summary = Object.fromEntries(
		Object.entries(results).map(([k, v]) => [k, { p50: v.p50, p95: v.p95, max: v.max, mean: v.mean }]),
	);
	const file = writeResults("keystroke-echo.json", { ts: new Date().toISOString(), keys: KEYS, results: summary });
	console.log("keystroke-echo:");
	for (const [k, v] of Object.entries(summary)) {
		console.log(`  ${k}: p50 ${v.p50.toFixed(2)}ms  p95 ${v.p95.toFixed(2)}ms  max ${v.max.toFixed(2)}ms`);
	}
	console.log(`  -> ${file}`);
}

await main();
