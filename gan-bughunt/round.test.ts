import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");

const norm = (s: string): string => s.replace(/\s+/g, "");

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

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

function resolveCopyPath(copyPath: string): string {
	if (path.isAbsolute(copyPath)) return copyPath;
	return path.join(REPO, copyPath);
}

function isIsolatedCopyPath(copyPath: string): boolean {
	const abs = resolveCopyPath(copyPath);
	const wtRoot = path.join(REPO, ".wt");
	const inWt = abs === wtRoot || abs.startsWith(wtRoot + path.sep);
	const tmp = os.tmpdir();
	const inTmp = abs === tmp || abs.startsWith(tmp + path.sep);
	const rel = path.relative(REPO, abs);
	const inTrackedSource =
		!rel.startsWith("..") && !path.isAbsolute(rel) && ["packages", "crates", "scripts"].includes(rel.split(path.sep)[0]);
	return (inWt || inTmp) && !inTrackedSource;
}

const records: RoundRecord[] = (await Bun.file(path.join(REPO, "gan-bughunt", "rounds.jsonl")).text())
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0)
	.map((line) => JSON.parse(line) as RoundRecord);

test("rounds.jsonl holds at least one complete round record", () => {
	expect(records.length).toBeGreaterThanOrEqual(1);
});

test("every round record satisfies schema, isolation, and anti-fabrication contracts", async () => {
	for (const r of records) {
		expect(Number.isInteger(r.id), `round id must be an integer (round ${r.id})`).toBe(true);
		expect(r.id).toBeGreaterThanOrEqual(1);
		const started = Date.parse(r.started_at);
		const ended = Date.parse(r.ended_at);
		expect(Number.isNaN(started), `round ${r.id}: started_at must be ISO-8601`).toBe(false);
		expect(Number.isNaN(ended), `round ${r.id}: ended_at must be ISO-8601`).toBe(false);
		expect(started, `round ${r.id}: started_at < ended_at`).toBeLessThan(ended);

		expect(typeof r.target).toBe("string");
		expect(r.target.length, `round ${r.id}: target must be non-empty`).toBeGreaterThan(0);
		expect(["bug", "dead-code"], `round ${r.id}: defect.kind must be bug|dead-code`).toContain(r.defect.kind);
		expect(
			await pathExists(path.join(REPO, r.defect.file)),
			`round ${r.id}: defect.file ${r.defect.file} must exist in the pristine tree`,
		).toBe(true);
		expect(Number.isInteger(r.defect.line_start), `round ${r.id}: defect.line_start integer`).toBe(true);
		expect(Number.isInteger(r.defect.line_end), `round ${r.id}: defect.line_end integer`).toBe(true);
		expect(r.defect.line_start, `round ${r.id}: 1 <= line_start`).toBeGreaterThanOrEqual(1);
		expect(r.defect.line_start, `round ${r.id}: line_start <= line_end`).toBeLessThanOrEqual(r.defect.line_end);

		expect(Array.isArray(r.judge_report), `round ${r.id}: judge_report array required`).toBe(true);
		expect(r.judge_report.length, `round ${r.id}: at least one judge entry required`).toBeGreaterThanOrEqual(1);
		for (const entry of r.judge_report) {
			expect(entry.file.length, `round ${r.id}: judge entry file non-empty`).toBeGreaterThan(0);
			expect(Number.isInteger(entry.line_start), `round ${r.id}: judge line_start integer`).toBe(true);
			expect(Number.isInteger(entry.line_end), `round ${r.id}: judge line_end integer`).toBe(true);
			expect(entry.line_start, `round ${r.id}: judge 1 <= line_start`).toBeGreaterThanOrEqual(1);
			expect(entry.line_start, `round ${r.id}: judge line_start <= line_end`).toBeLessThanOrEqual(entry.line_end);
			expect(entry.kind.length, `round ${r.id}: judge entry kind non-empty`).toBeGreaterThan(0);
			expect(entry.rationale.trim().length, `round ${r.id}: judge rationale non-empty`).toBeGreaterThan(0);
		}

		expect(typeof r.hit, `round ${r.id}: hit must be boolean`).toBe("boolean");
		expect(r.judge_score, `round ${r.id}: judge_score must be 1 exactly when hit`).toBe(r.hit ? 1 : 0);
		expect(r.implementor_score, `round ${r.id}: implementor_score must be 1 exactly when not hit`).toBe(r.hit ? 0 : 1);

		expect(
			isIsolatedCopyPath(r.copy_path),
			`round ${r.id}: copy_path ${r.copy_path} must be under .wt/ or the OS temp dir, never tracked source`,
		).toBe(true);
		expect(await pathExists(resolveCopyPath(r.copy_path)), `round ${r.id}: isolated copy must persist for audit`).toBe(true);

		const modifiedText = await Bun.file(path.join(resolveCopyPath(r.copy_path), r.defect.file)).text();
		const modifiedSlice = modifiedText.split("\n").slice(r.defect.line_start - 1, r.defect.line_end).join("\n");
		expect(
			norm(modifiedSlice),
			`round ${r.id}: excerpt must be verbatim from the modified copy at lines ${r.defect.line_start}-${r.defect.line_end}`,
		).toContain(norm(r.defect.excerpt));

		const pristineText = await Bun.file(path.join(REPO, r.defect.file)).text();
		const pristineSlice = pristineText.split("\n").slice(r.defect.line_start - 1, r.defect.line_end).join("\n");
		expect(
			norm(r.defect.excerpt),
			`round ${r.id}: planted excerpt must differ from pristine content at lines ${r.defect.line_start}-${r.defect.line_end}`,
		).not.toBe(norm(pristineSlice));
	}
});
