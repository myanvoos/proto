import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getWorktreesDir, pathIsWithin, relativePathWithinRoot, setWorktreesDir } from "./dirs";

const tempDirs: string[] = [];

async function makeTree(...children: string[]): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-utils-dirs-"));
	tempDirs.push(root);
	await Promise.all(children.map(child => fs.mkdir(path.join(root, child), { recursive: true })));
	return root;
}

afterAll(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("pathIsWithin", () => {
	test("accepts children whose name begins with dots but does not traverse upward", async () => {
		const root = await makeTree("..foo", "...bar", "normal", "..foo/nested");

		// Regression: a leading `..` in the relative path only escapes the root when it
		// is a whole path segment. `..foo` is an ordinary child directory.
		expect(pathIsWithin(root, path.join(root, "..foo"))).toBe(true);
		expect(pathIsWithin(root, path.join(root, "...bar"))).toBe(true);
		expect(pathIsWithin(root, path.join(root, "..foo", "nested"))).toBe(true);
		expect(pathIsWithin(root, path.join(root, "normal"))).toBe(true);
		expect(pathIsWithin(root, root)).toBe(true);
	});

	test("rejects paths that traverse above the root", async () => {
		const root = await makeTree("child");
		const parent = path.dirname(root);

		expect(pathIsWithin(root, parent)).toBe(false);
		expect(pathIsWithin(path.join(root, "child"), root)).toBe(false);
	});
});

describe("relativePathWithinRoot", () => {
	test("returns the relative path for dot-prefixed children instead of null", async () => {
		const root = await makeTree("..foo/nested");

		expect(relativePathWithinRoot(root, path.join(root, "..foo", "nested"))).toBe(path.join("..foo", "nested"));
		expect(relativePathWithinRoot(root, path.dirname(root))).toBeNull();
	});
});

describe("worktree base expansion", () => {
	test("expands both accepted tilde forms to a real home-relative path", () => {
		// Regression: `~\\wt` used to be concatenated verbatim, leaving the backslash as
		// a literal filename character on POSIX (`/home/u\\wt`).
		for (const input of ["~/wt", "~\\wt"]) {
			setWorktreesDir(input);
			expect(getWorktreesDir()).toBe(path.join(os.homedir(), "wt"));
		}
		setWorktreesDir("~");
		expect(getWorktreesDir()).toBe(os.homedir());
		setWorktreesDir(undefined);
	});
});
