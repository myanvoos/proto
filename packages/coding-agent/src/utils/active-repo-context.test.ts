import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ActiveRepoContext, resolveActiveRepoContext, resolveActiveRepoContextSync } from "./active-repo-context";

function createGitDirectory(repoRoot: string): void {
	const gitDir = path.join(repoRoot, ".git");
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
}

async function expectResolvers(cwd: string, expected: ActiveRepoContext | null): Promise<void> {
	expect(resolveActiveRepoContextSync(cwd)).toEqual(expected);
	expect(await resolveActiveRepoContext(cwd)).toEqual(expected);
}

describe("resolveActiveRepoContext", () => {
	let tempRoot: string;
	let cwd: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proto-active-repo-context-"));
		cwd = path.join(tempRoot, "workspace");
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("ignores a leftover child .git directory without HEAD", async () => {
		fs.mkdirSync(path.join(cwd, "leftover", ".git", "objects"), { recursive: true });
		await expectResolvers(cwd, null);
	});

	it("does not accept a directory named HEAD as repository metadata", async () => {
		fs.mkdirSync(path.join(cwd, "leftover", ".git", "HEAD"), { recursive: true });
		await expectResolvers(cwd, null);
	});

	it("ignores malformed or dangling child .git files", async () => {
		fs.mkdirSync(path.join(cwd, "malformed"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "malformed", ".git"), "not a gitdir pointer\n", "utf8");
		fs.mkdirSync(path.join(cwd, "dangling"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "dangling", ".git"), "gitdir: ../../removed-admin\n", "utf8");
		await expectResolvers(cwd, null);
	});

	it("selects a valid child when a leftover sibling also has a .git marker", async () => {
		const repoRoot = path.join(cwd, "repo");
		fs.mkdirSync(path.join(cwd, "leftover", ".git"), { recursive: true });
		createGitDirectory(repoRoot);
		await expectResolvers(cwd, { cwd, repoRoot, relativeRepoRoot: "repo", source: "single-direct-child-repo" });
	});
});
