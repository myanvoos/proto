import { expect, test } from "bun:test";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");

interface JudgeEntry {
	file: string;
	line_start: number;
	line_end: number;
	kind: string;
	rationale: string;
}

interface DefectManifest {
	kind: string;
	file: string;
	line_start: number;
	line_end: number;
	excerpt: string;
}

interface RoundRecord {
	id: number;
	started_at: string;
	ended_at: string;
	target: string;
	copy_path: string;
	defect: DefectManifest;
	judge_report: JudgeEntry[];
	hit: boolean;
	judge_score: number;
	implementor_score: number;
}

const records: RoundRecord[] = (await Bun.file(path.join(REPO, "gan-bughunt", "rounds.jsonl")).text())
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0)
	.map((line) => JSON.parse(line) as RoundRecord);

// Halt-prep wall. Original objective set 06:30 local on 2026-09-04; the user amended it
// during the stretch (~07:14 local: "ignore 7:00, go on"), so the bound moved to end-of-day local.
const HALT_PREP_WALL = new Date(2026, 8, 4, 23, 59, 0).getTime();

function judgeHitRecomputed(r: RoundRecord): boolean {
	return r.judge_report.some(
		(e) => e.file === r.defect.file && e.line_start - 10 <= r.defect.line_end && e.line_end + 10 >= r.defect.line_start,
	);
}

function targetPackage(file: string): string | null {
	const m = /^(packages|crates)\/([^/]+)\//.exec(file);
	return m ? `${m[1]}/${m[2]}` : null;
}

test("at least 12 rounds with strictly sequential ids and chronological timestamps", () => {
	expect(records.length).toBeGreaterThanOrEqual(12);
	for (let i = 0; i < records.length; i++) {
		expect(records[i].id, `record ${i} must carry sequential id ${i + 1}`).toBe(i + 1);
	}
	for (let i = 1; i < records.length; i++) {
		const prev = Date.parse(records[i - 1].started_at);
		const cur = Date.parse(records[i].started_at);
		expect(Number.isNaN(prev), `round ${records[i - 1].id}: started_at must be ISO-8601`).toBe(false);
		expect(Number.isNaN(cur), `round ${records[i].id}: started_at must be ISO-8601`).toBe(false);
		expect(cur, `round ${records[i].id} must start after round ${records[i - 1].id}`).toBeGreaterThan(prev);
	}
});

test("every round started before the halt-prep wall (local time; amended by user)", () => {
	for (const r of records) {
		const started = Date.parse(r.started_at);
		expect(
			started,
			`round ${r.id} started_at ${r.started_at} must precede the halt-prep wall on 2026-09-04`,
		).toBeLessThan(HALT_PREP_WALL);
	}
});

test("defect kinds: at least 4 bug plants and at least 4 dead-code plants", () => {
	const bugs = records.filter((r) => r.defect.kind === "bug").length;
	const deadCode = records.filter((r) => r.defect.kind === "dead-code").length;
	expect(bugs).toBeGreaterThanOrEqual(4);
	expect(deadCode).toBeGreaterThanOrEqual(4);
});

test("targets span at least 3 distinct workspace packages", () => {
	const pkgs = new Set(records.map((r) => targetPackage(r.defect.file)).filter((p) => p !== null));
	expect(pkgs.size).toBeGreaterThanOrEqual(3);
});

test("cumulative judge hit-rate is at least 25%", () => {
	const hits = records.filter((r) => r.hit).length;
	expect(hits / records.length).toBeGreaterThanOrEqual(0.25);
});

test("recorded hit matches recomputed judge geometry in both directions", () => {
	for (const r of records) {
		expect(
			r.hit,
			`round ${r.id}: recorded hit=${String(r.hit)} but judge/defect geometry recomputes to ${String(judgeHitRecomputed(r))}`,
		).toBe(judgeHitRecomputed(r));
	}
});
