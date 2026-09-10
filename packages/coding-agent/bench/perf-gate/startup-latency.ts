#!/usr/bin/env bun
/**
 * Startup latency harness: wall time for `bun src/cli.ts` (PI_TIMING=x) to
 * reach ready-to-enter-TUI and exit. Median over N runs; also captures the
 * PI_TIMING phase table for cost-center analysis.
 * Usage: bun bench/perf-gate/startup-latency.ts [--label <name>]
 */
import * as path from "node:path";
import { envInt, mean, median, PKG_ROOT, writeResults } from "./lib";

const RUNS = envInt("RUNS", 15);
const WARMUP = envInt("WARMUP", 3);
const CMD = ["bun", "src/cli.ts"];
const ENV = { ...process.env, PI_TIMING: "x", PI_STRICT_EDIT_MODE: "1" };

async function runOnce(): Promise<{ ms: number; out: string }> {
	const t0 = Bun.nanoseconds();
	const proc = Bun.spawn(CMD, { cwd: PKG_ROOT, env: ENV, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	await proc.exited;
	const ms = Number(Bun.nanoseconds() - t0) / 1e6;
	return { ms, out: out + err };
}

const labelIdx = process.argv.indexOf("--label");
const label = labelIdx >= 0 ? process.argv[labelIdx + 1]! : "startup";

for (let i = 0; i < WARMUP; i++) await runOnce();
const runs: number[] = [];
let timingsBlock = "";
for (let i = 0; i < RUNS; i++) {
	const { ms, out } = await runOnce();
	runs.push(ms);
	if (!timingsBlock) {
		const m = out.match(/--- Startup Timings ---[\s\S]*/);
		if (m) timingsBlock = m[0].slice(0, 8000);
	}
	process.stdout.write(`  run ${i + 1}/${RUNS}: ${ms.toFixed(0)}ms\n`);
}

const result = {
	label,
	ts: new Date().toISOString(),
	runs,
	medianMs: median(runs),
	meanMs: mean(runs),
	minMs: Math.min(...runs),
	maxMs: Math.max(...runs),
	timingsBlock,
};
const file = writeResults("startup.json", result);
console.log(
	`startup: median ${result.medianMs.toFixed(0)}ms  mean ${result.meanMs.toFixed(0)}ms  min ${result.minMs.toFixed(0)}ms  max ${result.maxMs.toFixed(0)}ms  -> ${path.relative(PKG_ROOT, file)}`,
);
if (timingsBlock) console.log(`\n${timingsBlock}`);
