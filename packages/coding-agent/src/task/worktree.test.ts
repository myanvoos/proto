import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { captureBaseline, IsolationBaselineTooLargeError } from "./worktree";

const repos: string[] = [];

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-worktree-baseline-"));
	repos.push(dir);
	await $`git init -q .`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
	await $`git config user.name test`.cwd(dir).quiet();
	await Bun.write(path.join(dir, "README.md"), "hi\n");
	await Bun.write(path.join(dir, "tracked.txt"), "tracked\n");
	await $`git add .`.cwd(dir).quiet();
	await $`git commit -qm init`.cwd(dir).quiet();
	return dir;
}

async function captureError(repo: string, budget: number): Promise<unknown> {
	return captureBaseline(repo, budget).then(
		() => null,
		(error: unknown) => error,
	);
}

afterAll(async () => {
	await Promise.all(repos.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Baseline diffs used to be read under the generic git output cap and silently truncated, baking a corrupt patch
// into the isolated snapshot; an oversized diff must refuse the spawn with the typed budget error instead.
describe("captureBaseline budget", () => {
	test("refuses a staged diff over the budget", async () => {
		const repo = await makeRepo();
		await Bun.write(path.join(repo, "staged.txt"), "staged content that outgrows a tiny budget\n".repeat(64));
		await $`git add staged.txt`.cwd(repo).quiet();

		const error = await captureError(repo, 256);
		expect(error).toBeInstanceOf(IsolationBaselineTooLargeError);
		expect((error as IsolationBaselineTooLargeError).budgetBytes).toBe(256);
		expect((error as IsolationBaselineTooLargeError).contentBytes).toBeUndefined();

		expect((await captureBaseline(repo)).root.staged).toContain("+++ b/staged.txt");
	});

	test("charges the unstaged diff against the budget the staged diff left", async () => {
		const repo = await makeRepo();
		await Bun.write(path.join(repo, "staged.txt"), "staged line\n".repeat(20));
		await $`git add staged.txt`.cwd(repo).quiet();
		await Bun.write(path.join(repo, "tracked.txt"), "unstaged line\n".repeat(20));

		const { staged, unstaged } = (await captureBaseline(repo)).root;
		const budget = Math.max(staged.length, unstaged.length) + 16;
		expect(staged.length + unstaged.length).toBeGreaterThan(budget);

		const error = await captureError(repo, budget);
		expect(error).toBeInstanceOf(IsolationBaselineTooLargeError);
		expect((error as IsolationBaselineTooLargeError).contentBytes).toBeUndefined();
	});
});
