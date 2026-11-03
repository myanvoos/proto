import { afterAll, afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { $ } from "bun";
import * as git from "../utils/git";
import { readRetainedBackend } from "./isolation-ownership";
import {
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	commitToBranch,
	ensureIsolation,
	IsolationBaselineTooLargeError,
} from "./worktree";

const repos: string[] = [];

afterEach(() => vi.restoreAllMocks());

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

test("copied linked worktrees are excluded from nested baselines without hiding independent repos", async () => {
	const repo = await makeRepo();
	await Bun.write(path.join(repo, ".gitignore"), ".claude/worktrees/\nvendor/\n");
	await $`git add .gitignore`.cwd(repo).quiet();
	await $`git commit -qm ignores`.cwd(repo).quiet();
	await $`git worktree add -q .claude/worktrees/linked -b linked`.cwd(repo).quiet();
	const independent = await makeRepo();
	await fs.mkdir(path.join(repo, "vendor"));
	await fs.cp(independent, path.join(repo, "vendor", "lib"), { recursive: true });
	const copy = await fs.mkdtemp(path.join(os.tmpdir(), "proto-linked-copy-"));
	repos.push(copy);
	await fs.cp(repo, copy, { recursive: true });
	// Copied worktree pointers still refer to the original checkout's admin directory.
	const baseline = await captureBaseline(copy, undefined, [copy, repo]);
	expect(baseline.nested.map(entry => entry.relativePath)).toEqual([path.join("vendor", "lib")]);
});

test("rejects a .gitmodules path that could copy objects outside the checkout", async () => {
	const repo = await makeRepo();
	await Bun.write(path.join(repo, ".gitmodules"), '[submodule "escape"]\npath = ../outside\nurl = ./other\n');
	await expect(git.ls.submodules(repo)).rejects.toThrow("Unsafe submodule path");
});

test("isolated submodule commits leave source refs untouched and survive isolation removal", async () => {
	const repo = await makeRepo();
	const moduleRepo = await makeRepo();
	await $`git -c protocol.file.allow=always submodule add ${moduleRepo} module`.cwd(repo).quiet();
	await $`git commit -qam module`.cwd(repo).quiet();
	const sourceModule = path.join(repo, "module");
	const originalHead = await git.head.sha(sourceModule);
	const baseline = await captureBaseline(repo);
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Apfs,
		candidates: [natives.IsoBackendKind.Apfs],
		fellBack: false,
		reason: undefined,
	});
	vi.spyOn(natives, "isoStart").mockImplementation(async (_backend, source, target) => {
		await fs.cp(source, target, { recursive: true });
	});
	vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
	const isolated = await ensureIsolation(repo, `module-${Date.now()}`);
	repos.push(path.dirname(isolated.mergedDir));
	const childModule = path.join(isolated.mergedDir, "module");
	await $`git config user.email test@example.com`.cwd(childModule).quiet();
	await $`git config user.name test`.cwd(childModule).quiet();
	await Bun.write(path.join(childModule, "tracked.txt"), "isolated change\n");
	await $`git commit -qam child`.cwd(childModule).quiet();
	const childHead = await git.head.sha(childModule);
	expect(await git.head.sha(sourceModule)).toBe(originalHead);
	const delta = await captureDeltaPatch(isolated.mergedDir, baseline);
	expect(delta.rootPatch).toContain(`+Subproject commit ${childHead}`);
	await cleanupIsolation(isolated);
	expect((await $`git cat-file -t ${childHead}`.cwd(sourceModule).quiet()).text().trim()).toBe("commit");
	expect(await git.head.sha(sourceModule)).toBe(originalHead);
});

test("branch replay handles an agent commit that excludes an untracked baseline file", async () => {
	const repo = await makeRepo();
	await Bun.write(path.join(repo, "scratch.txt"), "parent untracked WIP\n");
	const baseline = await captureBaseline(repo);
	const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "proto-filtered-replay-"));
	repos.push(isolated);
	await $`git worktree add --detach ${isolated} HEAD`.cwd(repo).quiet();
	await Bun.write(path.join(isolated, "tracked.txt"), "agent committed change\n");
	await $`git commit -qam agent-change`.cwd(isolated).quiet();
	const branch = await commitToBranch(isolated, baseline, "wip-replay", "agent change");
	expect(branch?.branchName).toBe("proto/task/wip-replay");
	expect((await $`git show ${branch!.branchName}:tracked.txt`.cwd(repo).quiet()).text()).toBe(
		"agent committed change\n",
	);
	expect((await $`git ls-tree -r --name-only ${branch!.branchName}`.cwd(repo).quiet()).text()).not.toContain(
		"scratch.txt",
	);
	expect(await Bun.file(path.join(repo, "scratch.txt")).text()).toBe("parent untracked WIP\n");
});

test("a failed mount teardown retains workspace contents for explicit recovery", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "proto-retain-mounted-"));
	repos.push(base);
	const mergedDir = path.join(base, "m");
	await Bun.write(path.join(mergedDir, "important.txt"), "recover me\n");
	vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("mount still busy"));
	await cleanupIsolation({
		mergedDir,
		backend: natives.IsoBackendKind.Overlayfs,
		fellBack: false,
		fallbackReason: null,
	});
	expect(await Bun.file(path.join(mergedDir, "important.txt")).text()).toBe("recover me\n");
	expect(await readRetainedBackend(base)).toBe(natives.IsoBackendKind.Overlayfs);
});

test("failed isolation setup never recursively removes a backend that could not stop", async () => {
	const repo = await makeRepo();
	let retainedDir = "";
	vi.spyOn(natives, "isoResolve").mockResolvedValue({
		kind: natives.IsoBackendKind.Overlayfs,
		candidates: [natives.IsoBackendKind.Overlayfs],
		fellBack: false,
		reason: undefined,
	});
	vi.spyOn(natives, "isoStart").mockImplementation(async (_backend, _source, target) => {
		retainedDir = target;
		repos.push(path.dirname(target));
		await Bun.write(path.join(target, "important.txt"), "recover this partial setup\n");
		throw new Error("setup failed after mount");
	});
	vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("unmount failed"));
	await expect(ensureIsolation(repo, `failed-mount-${Date.now()}`)).rejects.toThrow("workspace retained");
	expect(await Bun.file(path.join(retainedDir, "important.txt")).text()).toBe("recover this partial setup\n");
	expect(await readRetainedBackend(path.dirname(retainedDir))).toBe(natives.IsoBackendKind.Overlayfs);
});
