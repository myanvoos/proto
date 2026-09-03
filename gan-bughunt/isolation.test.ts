import { expect, test } from "bun:test";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");

interface Baseline {
	head: string;
	dirty: string[];
	recorded_at: string;
}

const baseline: Baseline = JSON.parse(
	await Bun.file(path.join(REPO, "gan-bughunt", "baseline.json")).text(),
) as Baseline;

function git(args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
	return proc.stdout.toString();
}

test("baseline.json records a HEAD commit and the stretch-start dirty list", () => {
	expect(baseline.head).toMatch(/^[0-9a-f]{40}$/);
	expect(Array.isArray(baseline.dirty)).toBe(true);
	expect(baseline.recorded_at.length).toBeGreaterThan(0);
});

test("HEAD is unchanged since stretch start", () => {
	expect(git(["rev-parse", "HEAD"]).trim()).toBe(baseline.head);
});

test("tracked-source diff matches the recorded baseline exactly", () => {
	const current = git(["diff", "--name-only"])
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.sort();
	expect(current).toEqual([...baseline.dirty].sort());
});
