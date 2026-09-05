#!/usr/bin/env bun

import { performance } from "node:perf_hooks";
import { parseStreamedInputForCompletion, STREAMED_INPUT_OBSERVATION_INTERVAL_MS } from "../src/eval/speculation";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

const PREFIX_COUNT = 4_000;
const SOURCE_CODE_UNITS = 64 * 1024;

function makeSession(): ToolSession {
	const values = new Map<string, unknown>([
		["kernel.speculation.enabled", true],
		["kernel.assertPreflight.enabled", false],
	]);
	return {
		cwd: process.cwd(),
		settings: {
			get: (key: string) => values.get(key),
			getShellConfig: () => ({ env: {} }),
		},
	} as unknown as ToolSession;
}

function makePrefixes(): string[] {
	const body = `python <<'PY'\n${"# ".repeat(Math.ceil(SOURCE_CODE_UNITS / 2))}\nPY`;
	const prefixes: string[] = [];
	for (let index = 1; index <= PREFIX_COUNT; index++) {
		const length = Math.max(1, Math.floor((body.length * index) / PREFIX_COUNT));
		prefixes.push(JSON.stringify({ command: body.slice(0, length) }));
	}
	return prefixes;
}

function inputBytes(prefixes: readonly string[]): number {
	return prefixes.reduce((total, raw) => total + Buffer.byteLength(raw), 0);
}

function runBaseline(prefixes: readonly string[]): { elapsedMs: number; checksum: number } {
	let checksum = 0;
	const start = performance.now();
	for (const raw of prefixes) {
		const parsed = parseStreamedInputForCompletion(raw);
		checksum += parsed.input.command?.length ?? 0;
	}
	return { elapsedMs: performance.now() - start, checksum };
}

async function runCoalesced(prefixes: readonly string[]): Promise<{ elapsedMs: number; finalInputBytes: number }> {
	const bash = new BashTool(makeSession());
	const start = performance.now();
	for (const raw of prefixes) void bash.observeStreamedInput("bench-stream", raw);
	await bash.flushStreamedInput("bench-stream");
	const elapsedMs = performance.now() - start;
	const finalInputBytes = Buffer.byteLength(prefixes[prefixes.length - 1]!);
	bash.cancelStreamedInput("bench-stream");
	return { elapsedMs, finalInputBytes };
}

const prefixes = makePrefixes();
const baseline = runBaseline(prefixes);
const coalesced = await runCoalesced(prefixes);
const bytes = inputBytes(prefixes);
console.log(`METRIC streamed_interval_ms=${STREAMED_INPUT_OBSERVATION_INTERVAL_MS}`);
console.log(`METRIC prefix_count=${prefixes.length}`);
console.log(`METRIC input_bytes=${bytes}`);
console.log(`METRIC baseline_parser_elapsed_ms=${baseline.elapsedMs.toFixed(3)}`);
console.log(`METRIC coalesced_observer_elapsed_ms=${coalesced.elapsedMs.toFixed(3)}`);
console.log(`METRIC final_prefix_input_bytes=${coalesced.finalInputBytes}`);
console.log(`METRIC baseline_checksum=${baseline.checksum}`);
