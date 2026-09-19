import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "./artifacts";

async function tempRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "proto-artifacts-test-"));
}

test("an id lookup returns a real artifact inside the directory", async () => {
	const root = await tempRoot();
	const manager = new ArtifactManager(path.join(root, "artifacts"));
	const id = await manager.save("hello artifact", "tool");

	const resolved = await manager.getPath(id);
	expect(resolved).not.toBeNull();
	expect(await Bun.file(resolved!).text()).toBe("hello artifact");

	await fs.rm(root, { recursive: true, force: true });
});

test("an id lookup refuses a symlink pointing outside the artifacts directory", async () => {
	const root = await tempRoot();
	const dir = path.join(root, "artifacts");
	await fs.mkdir(dir, { recursive: true });
	const secret = path.join(root, "secret.txt");
	await Bun.write(secret, "not for the model");
	await fs.symlink(secret, path.join(dir, "0.tool.log"));

	const manager = new ArtifactManager(dir);
	expect(await manager.getPath("0")).toBeNull();

	await fs.rm(root, { recursive: true, force: true });
});
