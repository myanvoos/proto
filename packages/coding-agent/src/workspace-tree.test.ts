import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDirectoryTree } from "./workspace-tree";

test("directory read metadata uses single separators instead of padding to the longest filename", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-tree-spacing-"));
	try {
		await Bun.write(path.join(root, "short.txt"), "a");
		await Bun.write(path.join(root, "a-much-longer-filename.txt"), "b");
		const mtime = new Date(Date.now() - 3_600_000);
		await fs.utimes(path.join(root, "short.txt"), mtime, mtime);
		await fs.utimes(path.join(root, "a-much-longer-filename.txt"), mtime, mtime);
		const tree = await buildDirectoryTree(root);
		const line = tree.rendered.split("\n").find(line => line.includes("short.txt"));
		expect(line).toMatch(/short\.txt [^ ]+ [^ ]/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
