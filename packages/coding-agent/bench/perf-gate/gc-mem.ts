#!/usr/bin/env bun
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
/**
 * GC/memory harness: fixed allocation-heavy workload (assistant component
 * construction + render churn, JSONL serialization), then timed forced full
 * GC (pause proxy), heap stats, and VmHWM peak RSS.
 * Usage: bun bench/perf-gate/gc-mem.ts
 */
import { AssistantMessageComponent } from "../../src/modes/components/assistant-message";
import { initTheme } from "../../src/modes/theme/theme";
import { median, writeResults } from "./lib";

await Settings.init({ inMemory: true });
await initTheme("dark");

const WIDTH = 100;
const CHURN = 1500;

function makeCorpus(size: number): string {
	const para = "The quick brown fox jumps over the lazy dog while emoji and code spans exercise the markdown lexer. ";
	let out = "";
	while (out.length < size) out += para;
	return out.slice(0, size);
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

function readVmHwmKb(): number {
	const fs = require("node:fs");
	const text = fs.readFileSync("/proc/self/status", "utf8");
	const m = text.match(/VmHWM:\s+(\d+) kB/);
	return m ? Number(m[1]) : -1;
}

// Workload: churn + retention
const keep: AssistantMessageComponent[] = [];
const jsonlChunks: string[] = [];
for (let i = 0; i < CHURN; i++) {
	const comp = new AssistantMessageComponent(makeMessage(makeCorpus(800 + (i % 6) * 300)));
	comp.render(WIDTH);
	if (i % 4 === 0) keep.push(comp); // retain 1/4 (live set)
	if (i % 8 === 0) jsonlChunks.push(JSON.stringify(makeMessage(makeCorpus(2000))));
}
const serialized = jsonlChunks.join("\n");

const heapBefore = process.memoryUsage();
const gcSamples: number[] = [];
for (let i = 0; i < 5; i++) {
	const t0 = Bun.nanoseconds();
	Bun.gc(true);
	gcSamples.push(Number(Bun.nanoseconds() - t0) / 1e6);
}
const heapAfter = process.memoryUsage();

const result = {
	ts: new Date().toISOString(),
	churn: CHURN,
	retainedComponents: keep.length,
	serializedBytes: serialized.length,
	forcedFullGcMs: { p50: median(gcSamples), min: Math.min(...gcSamples), max: Math.max(...gcSamples) },
	retainedBytes: heapAfter.heapUsed,
	retainedBytesPerComponent: keep.length > 0 ? heapAfter.heapUsed / keep.length : 0,
	heapUsedBeforeMb: heapBefore.heapUsed / 2 ** 20,
	heapUsedAfterMb: heapAfter.heapUsed / 2 ** 20,
	rssMb: heapAfter.rss / 2 ** 20,
	vmHwmMb: readVmHwmKb() / 1024,
};
const file = writeResults("gc-mem.json", result);
console.log(
	`gc-mem: forced-full-GC p50 ${result.forcedFullGcMs.p50.toFixed(2)}ms  heapUsed ${result.heapUsedAfterMb.toFixed(1)}MB  ` +
		`retained/component ${(result.retainedBytesPerComponent / 1024).toFixed(1)}KB  rss ${result.rssMb.toFixed(1)}MB  ` +
		`VmHWM ${result.vmHwmMb.toFixed(1)}MB  -> ${file}`,
);
