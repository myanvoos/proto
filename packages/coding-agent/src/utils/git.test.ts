import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { detachGitDir, stash } from "./git";

const repos: string[] = [];

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-git-stash-"));
	repos.push(dir);
	await $`git init -q .`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
	await $`git config user.name test`.cwd(dir).quiet();
	await Bun.write(path.join(dir, "file.txt"), "committed\n");
	await $`git add .`.cwd(dir).quiet();
	await $`git commit -qm init`.cwd(dir).quiet();
	return dir;
}

async function stashCount(dir: string): Promise<number> {
	const listed = await $`git stash list`.cwd(dir).quiet().text();
	return listed.split("\n").filter(Boolean).length;
}

afterAll(async () => {
	await Promise.all(repos.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("stash.tryPop", () => {
	test("leaves the working tree untouched when there is no stash entry", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "file.txt"), "uncommitted work\n");

		// Regression: `git stash pop` fails with no stash entry, and the failure path
		// used to run `git reset --hard`, destroying edits the pop never touched.
		expect(await stash.tryPop(dir)).toBe(false);
		expect(await Bun.file(path.join(dir, "file.txt")).text()).toBe("uncommitted work\n");
	});

	test("applies the stash and drops the entry when the tree is clean", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "file.txt"), "stashed change\n");
		await $`git stash -q`.cwd(dir).quiet();

		expect(await stash.tryPop(dir)).toBe(true);
		expect(await Bun.file(path.join(dir, "file.txt")).text()).toBe("stashed change\n");
		expect(await stashCount(dir)).toBe(0);
	});

	test("preserves conflicting local edits and keeps the stash entry", async () => {
		const dir = await makeRepo();
		await Bun.write(path.join(dir, "file.txt"), "stashed version\n");
		await $`git stash -q`.cwd(dir).quiet();
		await Bun.write(path.join(dir, "file.txt"), "local edit\n");

		expect(await stash.tryPop(dir)).toBe(false);
		expect(await Bun.file(path.join(dir, "file.txt")).text()).toBe("local edit\n");
		expect(await stashCount(dir)).toBe(1);
	});
});

describe("detachGitDir", () => {
	async function makeLinkedWorktree(): Promise<{ main: string; worktree: string }> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-git-detach-"));
		repos.push(root);
		const main = path.join(root, "main");
		const worktree = path.join(root, "wt");
		await fs.mkdir(main, { recursive: true });
		await $`git init -q .`.cwd(main).quiet();
		await $`git config user.email test@example.com`.cwd(main).quiet();
		await $`git config user.name test`.cwd(main).quiet();
		await Bun.write(path.join(main, "a.txt"), "hello\n");
		await $`git add .`.cwd(main).quiet();
		await $`git commit -qm init`.cwd(main).quiet();
		await $`git worktree add -q ${worktree} -b feature`.cwd(main).quiet().nothrow();
		return { main, worktree };
	}

	test("converts a linked worktree into a standalone repository", async () => {
		const { main, worktree } = await makeLinkedWorktree();

		expect(await detachGitDir(worktree, path.join(main, ".git"))).toBe("detached");

		// `.git` was a pointer file in a linked worktree; detaching makes it a real dir.
		expect((await fs.stat(path.join(worktree, ".git"))).isDirectory()).toBe(true);
		const log = await $`git log --oneline`.cwd(worktree).quiet().text();
		expect(log).toContain("init");
		const leftovers = (await fs.readdir(worktree)).filter(name => name.includes("proto-detach"));
		expect(leftovers).toEqual([]);
	});

	test("restores the original git metadata when the rebuild fails", async () => {
		const { main, worktree } = await makeLinkedWorktree();
		const adminParent = path.join(main, ".git", "worktrees");
		const pointerBefore = await Bun.file(path.join(worktree, ".git")).text();

		// Regression: the git dir used to be deleted up front, so any failure below
		// left the checkout detached from a repository that no longer existed.
		await fs.chmod(adminParent, 0o555);
		try {
			await expect(detachGitDir(worktree, path.join(main, ".git"))).rejects.toThrow();
		} finally {
			await fs.chmod(adminParent, 0o755);
		}

		expect(await Bun.file(path.join(worktree, ".git")).text()).toBe(pointerBefore);
		const log = await $`git log --oneline`.cwd(worktree).quiet().text();
		expect(log).toContain("init");
	});
});
