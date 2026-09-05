import { rm, writeFile } from "node:fs/promises";
import {
	preflightStreamedInput,
	resetStreamedAssertionPreflight,
	streamedAssertionPreflightCacheStats,
} from "../src/eval/assertion-preflight";

const SAMPLE_COUNT = 3;
const MAX_SOURCE_BYTES = 1024 * 1024;
const REPRESENTATIVE_ENTRIES = 256;
const REPRESENTATIVE_SOURCE_CODE_UNITS = 256 * 1024;
const STRESS_ENTRIES = 64;
const STRESS_SOURCE_CODE_UNITS = MAX_SOURCE_BYTES;

interface Sample {
	rssDelta: number;
	heapDelta: number;
	cacheEntries: number;
	cacheBytes: number;
	uncappedSourceBytes: number;
	cachedSourceBytes: number;
}

function memory(): NodeJS.MemoryUsage {
	return process.memoryUsage();
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function pythonCell(file: string, sourceCodeUnits: number, filler: string): string {
	const base = [
		"from pathlib import Path",
		`p = Path(${JSON.stringify(file)})`,
		"text = p.read_text()",
		'old = "needle"',
		'new = "replacement"',
		"assert text.count(old) == 1",
	].join("\n");
	const prefix = `${base}\n# `;
	const suffix = "\n";
	const remaining = Math.max(0, sourceCodeUnits - prefix.length - suffix.length);
	const repeated = filler.repeat(Math.floor(remaining / filler.length));
	const padding = " ".repeat(remaining - repeated.length);
	return `${prefix}${repeated}${padding}${suffix}`;
}

async function runSample(
	scenario: string,
	entries: number,
	sourceCodeUnits: number,
	filler: string,
	sample: number,
): Promise<Sample> {
	resetStreamedAssertionPreflight();
	Bun.gc(true);
	const file = `/tmp/proto-preflight-cache-bench-${process.pid}-${scenario}-${sample}.txt`;
	await writeFile(file, "haystack\n", "utf8");
	const cell = pythonCell(file, sourceCodeUnits, filler);
	const command = `python3 - <<'PY'\n${cell}\nPY\n`;
	const raw = JSON.stringify({ command });
	const before = memory();
	for (let index = 0; index < entries; index++) {
		const failure = await preflightStreamedInput(`bench-${scenario}-${sample}-${index}`, raw, {
			session: { cwd: "/tmp" },
			sessionKey: `bench-${scenario}-${sample}`,
		});
		if (!failure) throw new Error(`preflight did not find expected failure for ${scenario} entry ${index}`);
	}
	Bun.gc(true);
	const after = memory();
	const cache = streamedAssertionPreflightCacheStats();
	await rm(file, { force: true });
	return {
		rssDelta: after.rss - before.rss,
		heapDelta: after.heapUsed - before.heapUsed,
		cacheEntries: cache.entries,
		cacheBytes: cache.bytes,
		uncappedSourceBytes: entries * Buffer.byteLength(cell),
		cachedSourceBytes: cache.entries * Buffer.byteLength(cell.slice(0, Math.min(cell.length, MAX_SOURCE_BYTES))),
	};
}

async function runScenario(name: string, entries: number, sourceCodeUnits: number, filler: string): Promise<void> {
	const samples: Sample[] = [];
	for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
		samples.push(await runSample(name, entries, sourceCodeUnits, filler, sample));
	}
	const representative = samples[0]!;
	console.log(
		JSON.stringify({
			scenario: name,
			entries,
			sourceCodeUnits,
			uncappedSourceBytes: representative.uncappedSourceBytes,
			cachedSourceBytes: samples.map(sample => sample.cachedSourceBytes),
			cacheBytes: samples.map(sample => sample.cacheBytes),
			cacheEntries: samples.map(sample => sample.cacheEntries),
			rssDelta: samples.map(sample => sample.rssDelta),
			heapDelta: samples.map(sample => sample.heapDelta),
			medianRssDelta: median(samples.map(sample => sample.rssDelta)),
			medianHeapDelta: median(samples.map(sample => sample.heapDelta)),
		}),
	);
	resetStreamedAssertionPreflight();
}

await runScenario("representative", REPRESENTATIVE_ENTRIES, REPRESENTATIVE_SOURCE_CODE_UNITS, "z");
await runScenario("stress-1MiB-code-units", STRESS_ENTRIES, STRESS_SOURCE_CODE_UNITS, "é");
