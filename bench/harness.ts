import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

export interface BenchCase {
	/** stable identifier; used as the key in the saved artifact */
	name: string;
	/** optional per-case override of the suite iteration count */
	runs?: number;
	/** optional per-case override of the suite warmup count */
	warmup?: number;
	/** prepared once before warmup; the resolved value is passed to `run` */
	setup?: () => unknown | Promise<unknown>;
	run: (fixture: never) => unknown | Promise<unknown>;
}

export interface CaseStats {
	name: string;
	runs: number;
	warmup: number;
	/** milliseconds */
	min: number;
	median: number;
	p95: number;
	max: number;
	mean: number;
	stddev: number;
	opsPerSec: number;
}

export interface SuiteArtifact {
	suite: string;
	label: string;
	recordedAt: string;
	commit: string;
	bunVersion: string;
	platform: string;
	cases: CaseStats[];
}

const NS_PER_MS = 1_000_000;

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = fraction * (sorted.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	if (low === high) return sorted[low]!;
	return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

function summarize(name: string, samples: number[], warmup: number): CaseStats {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
	return {
		name,
		runs: samples.length,
		warmup,
		min: sorted[0]!,
		median: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted[sorted.length - 1]!,
		mean,
		stddev: Math.sqrt(variance),
		opsPerSec: mean > 0 ? 1000 / mean : Number.POSITIVE_INFINITY,
	};
}

async function commitHash(): Promise<string> {
	const result = await $`git rev-parse --short HEAD`.quiet().nothrow();
	return result.exitCode === 0 ? result.text().trim() : "unknown";
}

/** Directory holding saved suite artifacts. */
export const RESULTS_DIR = path.join(import.meta.dir, "results");

export function artifactPath(suite: string, label: string): string {
	return path.join(RESULTS_DIR, `${suite}.${label}.json`);
}

/** Reads the `--label <name>` argument (default `local`) from `Bun.argv`. */
export function labelFromArgv(fallback = "local"): string {
	const index = Bun.argv.indexOf("--label");
	if (index !== -1 && Bun.argv[index + 1]) return Bun.argv[index + 1]!;
	return fallback;
}

export interface SuiteOptions {
	runs?: number;
	warmup?: number;
	label?: string;
	/** when false the artifact is not written (used by compare tooling) */
	save?: boolean;
}

export async function runSuite(suite: string, cases: BenchCase[], options: SuiteOptions = {}): Promise<SuiteArtifact> {
	const defaultRuns = options.runs ?? 20;
	const defaultWarmup = options.warmup ?? 5;
	const label = options.label ?? labelFromArgv();
	const stats: CaseStats[] = [];

	for (const benchCase of cases) {
		const runs = benchCase.runs ?? defaultRuns;
		const warmup = benchCase.warmup ?? defaultWarmup;
		const fixture = (await benchCase.setup?.()) as never;
		for (let i = 0; i < warmup; i++) await benchCase.run(fixture);
		const samples: number[] = [];
		for (let i = 0; i < runs; i++) {
			const started = Bun.nanoseconds();
			await benchCase.run(fixture);
			samples.push((Bun.nanoseconds() - started) / NS_PER_MS);
		}
		stats.push(summarize(benchCase.name, samples, warmup));
	}

	const artifact: SuiteArtifact = {
		suite,
		label,
		recordedAt: new Date().toISOString(),
		commit: await commitHash(),
		bunVersion: Bun.version,
		platform: `${process.platform}-${process.arch}`,
		cases: stats,
	};

	if (options.save !== false) {
		await Bun.write(artifactPath(suite, label), `${JSON.stringify(artifact, null, "\t")}\n`);
	}
	return artifact;
}

export function formatArtifact(artifact: SuiteArtifact): string {
	const rows = artifact.cases.map(entry => ({
		case: entry.name,
		median: `${entry.median.toFixed(3)} ms`,
		p95: `${entry.p95.toFixed(3)} ms`,
		mean: `${entry.mean.toFixed(3)} ms`,
		stddev: `${entry.stddev.toFixed(3)} ms`,
		runs: String(entry.runs),
	}));
	const headers = ["case", "median", "p95", "mean", "stddev", "runs"] as const;
	const widths = headers.map(header => Math.max(header.length, ...rows.map(row => row[header].length)));
	const line = (values: readonly string[]) => values.map((value, index) => value.padEnd(widths[index]!)).join("  ");
	const out = [
		`${artifact.suite} @ ${artifact.commit} [${artifact.label}] ${artifact.platform} bun ${artifact.bunVersion}`,
		line(headers),
		line(widths.map(width => "-".repeat(width))),
		...rows.map(row => line(headers.map(header => row[header]))),
	];
	return out.join("\n");
}

export async function loadArtifact(suite: string, label: string): Promise<SuiteArtifact | null> {
	try {
		return (await Bun.file(artifactPath(suite, label)).json()) as SuiteArtifact;
	} catch {
		return null;
	}
}

/** Prints a before/after comparison; returns the worst regression ratio seen (1 = unchanged). */
export function compareArtifacts(before: SuiteArtifact, after: SuiteArtifact): number {
	const byName = new Map(before.cases.map(entry => [entry.name, entry]));
	let worst = 0;
	const rows: string[][] = [["case", "before", "after", "delta"]];
	for (const entry of after.cases) {
		const baseline = byName.get(entry.name);
		if (!baseline) {
			rows.push([entry.name, "-", `${entry.median.toFixed(3)} ms`, "new"]);
			continue;
		}
		const ratio = entry.median / baseline.median;
		worst = Math.max(worst, ratio);
		const pct = (ratio - 1) * 100;
		rows.push([
			entry.name,
			`${baseline.median.toFixed(3)} ms`,
			`${entry.median.toFixed(3)} ms`,
			`${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
		]);
	}
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
	for (const row of rows) {
		process.stdout.write(`${row.map((value, index) => value.padEnd(widths[index]!)).join("  ")}\n`);
	}
	return worst;
}

/** Removes a results file; used by tests and ad-hoc reruns. */
export async function clearArtifact(suite: string, label: string): Promise<void> {
	await fs.rm(artifactPath(suite, label), { force: true });
}
