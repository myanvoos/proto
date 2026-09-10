#!/usr/bin/env bun
/**
 * perf-gate run-all: executes every harness and compares against the recorded
 * baselines in results/baseline/. Gates: >=25% improvement on each latency
 * metric, marathon VmHWM <= 800MB.
 * Usage: bun bench/perf-gate/run-all.ts [--quick]
 */
import * as path from "node:path";
import { median, PKG_ROOT, RESULTS_DIR, readJson } from "./lib";

const quick = process.argv.includes("--quick");
const baselineDir = path.join(RESULTS_DIR, "baseline");
void median;

interface Gate {
	name: string;
	baseline: number;
	current: number | null;
	target: number;
	pass: boolean | null;
	note: string;
}

const gates: Gate[] = [];
function addLatencyGate(name: string, baseline: number, current: number | null, note = ""): void {
	const target = baseline * 0.75;
	gates.push({ name, baseline, current, target, pass: current === null ? null : current <= target, note });
}

function pctDelta(base: number, cur: number): string {
	return `${(((cur - base) / base) * 100).toFixed(1)}%`;
}

async function runHarness(file: string, args: string[] = []): Promise<number> {
	const proc = Bun.spawn(["bun", path.join("bench", "perf-gate", file), ...args], {
		cwd: PKG_ROOT,
		stdout: "inherit",
		stderr: "inherit",
	});
	return await proc.exited;
}

// 1. Startup
console.log("== startup ==");
const skip = quick ? [] : [];
void skip;
{
	const code = await runHarness("startup-latency.ts", ["--label", "gate"]);
	const res = readJson<{ medianMs: number }>(path.join(RESULTS_DIR, "startup.json"));
	const base = readJson<{ medianMs: number }>(path.join(baselineDir, "startup.json"));
	addLatencyGate("startup medianMs", base?.medianMs ?? Number.NaN, res?.medianMs ?? null);
	if (code !== 0)
		gates.push({
			name: "startup harness exit",
			baseline: 0,
			current: code,
			target: 0,
			pass: false,
			note: "harness failed",
		});
}

// 2. Keystroke echo
console.log("== keystroke-echo ==");
{
	await runHarness("keystroke-echo.ts");
	const res = readJson<{ results: Record<string, { p50: number }> }>(
		path.join(RESULTS_DIR, "keystroke-echo.json"),
	)?.results;
	const base = readJson<{ results: Record<string, { p50: number }> }>(
		path.join(baselineDir, "keystroke-echo.json"),
	)?.results;
	for (const mode of ["cold", "loaded"]) {
		addLatencyGate(`echo ${mode} p50`, base?.[mode]?.p50 ?? Number.NaN, res?.[mode]?.p50 ?? null);
	}
	const paste = res?.paste?.p50;
	if (paste !== undefined && base?.paste?.p50 !== undefined) {
		gates.push({
			name: "echo paste p50 (report)",
			baseline: base.paste.p50,
			current: paste,
			target: base.paste.p50 * 0.75,
			pass: null,
			note: pctDelta(base.paste.p50, paste),
		});
	}
}

// 3. Render frames
console.log("== render-frame ==");
{
	await runHarness("render-frame.ts");
	const res = readJson<Record<string, { p50: number; p95: number }>>(path.join(RESULTS_DIR, "render-frame.json"));
	const base = readJson<Record<string, { p50: number; p95: number }>>(path.join(baselineDir, "render-frame.json"));
	addLatencyGate(
		"render incremental-append-1 p50",
		base?.["incremental-append-1"]?.p50 ?? Number.NaN,
		res?.["incremental-append-1"]?.p50 ?? null,
	);
	addLatencyGate(
		"render text-3000-full p95",
		base?.["text-3000-full"]?.p95 ?? Number.NaN,
		res?.["text-3000-full"]?.p95 ?? null,
	);
}

// 4. GC / heap
console.log("== gc-mem ==");
{
	await runHarness("gc-mem.ts");
	const res = readJson<{
		forcedFullGcMs: { p50: number };
		heapUsedAfterMb: number;
		retainedBytesPerComponent?: number;
	}>(path.join(RESULTS_DIR, "gc-mem.json"));
	const base = readJson<{ forcedFullGcMs: { p50: number }; heapUsedAfterMb: number }>(
		path.join(baselineDir, "gc-mem.json"),
	);
	addLatencyGate("gc forced full p50", base?.forcedFullGcMs.p50 ?? Number.NaN, res?.forcedFullGcMs.p50 ?? null);
	addLatencyGate("gc heapUsedAfterMb", base?.heapUsedAfterMb ?? Number.NaN, res?.heapUsedAfterMb ?? null);
}

// 5. Shutdown
console.log("== shutdown ==");
{
	await runHarness("shutdown-latency.ts");
	const res = readJson<{ "exit-cmd": { median: number }; sigterm: { median: number } }>(
		path.join(RESULTS_DIR, "shutdown.json"),
	);
	const base = readJson<{ "exit-cmd": { median: number }; sigterm: { median: number } }>(
		path.join(baselineDir, "shutdown.json"),
	);
	addLatencyGate("shutdown /exit median", base?.["exit-cmd"]?.median ?? Number.NaN, res?.["exit-cmd"]?.median ?? null);
	addLatencyGate("shutdown SIGTERM median", base?.sigterm?.median ?? Number.NaN, res?.sigterm?.median ?? null);
}

// 6. Marathon RSS (gate: absolute 800MB)
console.log("== rss-marathon ==");
{
	const code = await runHarness("rss-marathon.ts", [quick ? "60" : "120"]);
	const res = readJson<{ vmHwmMb: number; compactions: number }>(path.join(RESULTS_DIR, "rss-marathon.json"));
	if (res) {
		gates.push({
			name: "marathon VmHWM <= 800MB",
			baseline: Number.NaN,
			current: res.vmHwmMb,
			target: 800,
			pass: res.vmHwmMb <= 800,
			note: `compactions ${res.compactions}`,
		});
	}
	if (code !== 0)
		gates.push({
			name: "marathon harness exit",
			baseline: 0,
			current: code,
			target: 0,
			pass: false,
			note: "harness failed",
		});
}

console.log("\n================ PERF GATE RESULTS ================");
console.log("metric                              baseline   now     target  verdict");
let failed = 0;
for (const g of gates) {
	if (g.pass === false) failed++;
	const verdict = g.pass === null ? "info" : g.pass ? "PASS" : "FAIL";
	const base = Number.isFinite(g.baseline) ? g.baseline.toFixed(2) : "n/a";
	const cur = g.current === null ? "n/a" : g.current.toFixed(2);
	console.log(
		`${g.name.padEnd(34)}  ${base.padStart(8)}  ${cur.padStart(7)}  ${g.target.toFixed(2).padStart(7)}  ${verdict}${g.note ? `  (${g.note})` : ""}`,
	);
}
console.log("===================================================");
console.log(failed === 0 ? "ALL GATES PASS" : `${failed} GATE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
