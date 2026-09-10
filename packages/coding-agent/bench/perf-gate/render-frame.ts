#!/usr/bin/env bun
/**
 * Render frame-time harness: TUI differential frame cost with a large
 * transcript (full repaint) and incremental append (one new message per frame).
 * Usage: bun bench/perf-gate/render-frame.ts
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Terminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../src/config/settings";
import { AssistantMessageComponent } from "../../src/modes/components/assistant-message";
import { initTheme } from "../../src/modes/theme/theme";
import { FakeTerminal } from "./fake-terminal";
import { envInt, pct, writeResults } from "./lib";

await Settings.init({ inMemory: true });
await initTheme("dark");

const SIZES = [100, 300];
const INCREMENTAL = envInt("INCREMENTAL", 100);

function makeMarkdownCorpus(targetGraphemes: number): string {
	const para =
		"The quick brown fox jumps over the lazy dog while \u{1F680} emoji and a `code span` " +
		"plus **bold** and _italic_ text exercise the markdown lexer and the grapheme segmenter. ";
	const codeBlock = "\n```ts\nconst x: number = compute(a, b) + delta;\nreturn x.toFixed(2);\n```\n\n";
	const list = "\n- first bullet item\n- second bullet item with `inline`\n- third\n\n";
	let out = "";
	let i = 0;
	while (out.length < targetGraphemes) {
		out += `## Section ${++i}\n\n${para}${para}${codeBlock}${list}`;
	}
	return out.slice(0, targetGraphemes);
}

function makeMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

async function timedFrame(term: FakeTerminal, fn: () => void): Promise<number | null> {
	const startIdx = term.writeTimesNs.length;
	const t0 = Bun.nanoseconds();
	fn();
	let guard = 0;
	while (term.writeTimesNs.length <= startIdx && guard++ < 250) await Bun.sleep(1);
	if (term.writeTimesNs.length <= startIdx) return null; // no frame produced
	return (Number(term.writeTimesNs[term.writeTimesNs.length - 1]!) - Number(t0)) / 1e6;
}

function collect(samples: (number | null)[]): { p50: number; p95: number; max: number; timeouts: number } {
	const ok = samples.filter((s): s is number => s !== null);
	return { p50: pct(ok, 50), p95: pct(ok, 95), max: Math.max(...ok), timeouts: samples.length - ok.length };
}

async function main() {
	const out: Record<string, unknown> = {};

	// Full repaint frame time with N-message transcript.
	for (const n of SIZES) {
		const term = new FakeTerminal();
		const ui = new TUI(term as unknown as Terminal, false);
		ui.start();
		await Bun.sleep(80);
		for (let i = 0; i < n; i++) {
			const comp = new AssistantMessageComponent(makeMessage(makeMarkdownCorpus(600 + (i % 5) * 200)));
			ui.addChild(comp);
		}
		await Bun.sleep(150);
		term.writeTimesNs.length = 0;
		term.lastWriteNs = 0n;
		const samples: (number | null)[] = [];
		const FRAMES = 20;
		for (let f = 0; f < FRAMES; f++) {
			samples.push(await timedFrame(term, () => ui.requestRender(true)));
		}
		await ui.stop();
		out[`full-${n}`] = collect(samples);
	}

	// Incremental append: add one message per frame over a 300-message base.
	{
		const term = new FakeTerminal();
		const ui = new TUI(term as unknown as Terminal, false);
		ui.start();
		await Bun.sleep(80);
		for (let i = 0; i < 300; i++) {
			ui.addChild(new AssistantMessageComponent(makeMessage(makeMarkdownCorpus(600 + (i % 5) * 200))));
		}
		await Bun.sleep(150);
		term.writeTimesNs.length = 0;
		term.lastWriteNs = 0n;
		const samples: (number | null)[] = [];
		for (let i = 0; i < INCREMENTAL; i++) {
			const comp = new AssistantMessageComponent(makeMessage(makeMarkdownCorpus(600)));
			samples.push(
				await timedFrame(term, () => {
					ui.addChild(comp);
					ui.requestRender();
				}),
			);
		}
		await ui.stop();
		out["incremental-append-1"] = collect(samples);
	}

	// Text-only baseline: 3000 text lines, full repaint (layout/diff stress).
	{
		const term = new FakeTerminal();
		const ui = new TUI(term as unknown as Terminal, false);
		ui.start();
		await Bun.sleep(80);
		for (let i = 0; i < 3000; i++) ui.addChild(new Text(`line ${i}: lorem ipsum dolor sit amet ${i % 7}`));
		await Bun.sleep(150);
		term.writeTimesNs.length = 0;
		term.lastWriteNs = 0n;
		const samples: (number | null)[] = [];
		for (let f = 0; f < 20; f++) samples.push(await timedFrame(term, () => ui.requestRender(true)));
		await ui.stop();
		out["text-3000-full"] = collect(samples);
	}

	const file = writeResults("render-frame.json", { ts: new Date().toISOString(), ...out });
	console.log("render-frame:");
	for (const [k, v] of Object.entries(out)) {
		const s = v as { p50: number; p95: number; max: number };
		console.log(`  ${k}: p50 ${s.p50.toFixed(2)}ms  p95 ${s.p95.toFixed(2)}ms  max ${s.max.toFixed(2)}ms`);
	}
	console.log(`  -> ${file}`);
}

await main();
