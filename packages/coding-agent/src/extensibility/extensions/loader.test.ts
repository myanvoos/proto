import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverExtensionPaths } from "./loader";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("extension package manifest entries cannot escape the package root", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-extension-manifest-"));
	tempDirs.push(tempDir);
	const packageRoot = path.join(tempDir, "nested", "extension");
	const outsidePath = path.join(tempDir, "outside.ts");
	await fs.mkdir(packageRoot, { recursive: true });
	await Bun.write(outsidePath, "export default () => {};\n");
	await Bun.write(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: "unsafe-extension", proto: { extensions: ["../../outside.ts"] } }),
	);

	const discovered = await discoverExtensionPaths([packageRoot], tempDir, [], {
		ambient: false,
		includeAmbientHooks: false,
	});

	expect(discovered).toEqual([]);
});
