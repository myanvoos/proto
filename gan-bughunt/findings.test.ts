import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");

const norm = (s: string): string => s.replace(/\s+/g, "");

interface Finding {
	id: string;
	path: string;
	kind: string;
	line_start: number;
	line_end: number;
	rationale: string;
	excerpt: string;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

const findings: Finding[] = JSON.parse(
	await Bun.file(path.join(REPO, "gan-bughunt", "findings.json")).text(),
) as Finding[];
const markdown = await Bun.file(path.join(REPO, "gan-bughunt", "findings.md")).text();

function pkgOf(findingPath: string): string | null {
	const m = /^(packages|crates)\/([^/]+)\//.exec(findingPath);
	return m ? `${m[1]}/${m[2]}` : null;
}

function overlaps(a: Finding, b: Finding): boolean {
	return a.line_start <= b.line_end && b.line_start <= a.line_end;
}

test("at least 12 findings with valid path, line, rationale, and excerpt anchors", async () => {
	expect(findings.length).toBeGreaterThanOrEqual(12);
	for (const f of findings) {
		expect(["bug", "dead-code"], `finding ${f.id}: kind must be bug|dead-code`).toContain(f.kind);
		expect(
			f.path.startsWith("packages/") || f.path.startsWith("crates/"),
			`finding ${f.id}: path ${f.path} must live under packages/ or crates/`,
		).toBe(true);
		expect(await pathExists(path.join(REPO, f.path)), `finding ${f.id}: ${f.path} must exist`).toBe(true);
		expect(Number.isInteger(f.line_start), `finding ${f.id}: line_start integer`).toBe(true);
		expect(Number.isInteger(f.line_end), `finding ${f.id}: line_end integer`).toBe(true);
		expect(f.line_start, `finding ${f.id}: 1 <= line_start`).toBeGreaterThanOrEqual(1);
		expect(f.line_start, `finding ${f.id}: line_start <= line_end`).toBeLessThanOrEqual(f.line_end);
		expect(f.line_end, `finding ${f.id}: line_end <= line_start + 200`).toBeLessThanOrEqual(f.line_start + 200);
		expect(f.rationale.trim().length, `finding ${f.id}: rationale non-empty`).toBeGreaterThan(0);
		const text = await Bun.file(path.join(REPO, f.path)).text();
		const slice = text.split("\n").slice(f.line_start - 1, f.line_end).join("\n");
		expect(
			norm(slice),
			`finding ${f.id}: excerpt must be anchored verbatim to ${f.path}:${f.line_start}-${f.line_end}`,
		).toContain(norm(f.excerpt));
	}
});

test("no two findings share path + kind with overlapping line ranges", () => {
	for (let i = 0; i < findings.length; i++) {
		for (let j = i + 1; j < findings.length; j++) {
			const a = findings[i];
			const b = findings[j];
			const clash = a.path === b.path && a.kind === b.kind && overlaps(a, b);
			expect(clash, `findings ${a.id} and ${b.id} overlap in ${a.path}`).toBe(false);
		}
	}
});

test("findings span at least 3 distinct workspace packages with at least 3 of each kind", () => {
	const pkgs = new Set(findings.map((f) => pkgOf(f.path)).filter((p) => p !== null));
	expect(pkgs.size).toBeGreaterThanOrEqual(3);
	expect(findings.filter((f) => f.kind === "bug").length).toBeGreaterThanOrEqual(3);
	expect(findings.filter((f) => f.kind === "dead-code").length).toBeGreaterThanOrEqual(3);
});

test("findings.md renders every finding and ends with a Halt section carrying final tallies", () => {
	const haltIdx = markdown.lastIndexOf("## Halt");
	expect(haltIdx, "findings.md must contain a '## Halt' section").toBeGreaterThanOrEqual(0);
	const afterHalt = markdown.slice(haltIdx + 1);
	expect(afterHalt.includes("\n## "), "no section may follow '## Halt'").toBe(false);
	for (const f of findings) {
		expect(markdown.includes(String(f.id)), `findings.md must render finding ${f.id}`).toBe(true);
		expect(markdown.includes(f.path), `findings.md must render path of finding ${f.id}`).toBe(true);
	}
	expect(afterHalt).toContain("Rounds completed");
	expect(afterHalt).toContain("Hit rate");
	expect(afterHalt).toContain("Findings by kind");
});
