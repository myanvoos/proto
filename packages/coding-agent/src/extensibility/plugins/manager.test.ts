import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { PluginManager } from "./manager";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function setupManager(packageName: string): Promise<{
	manager: PluginManager;
	pluginRoot: string;
	nodeModules: string;
	sourceRoot: string;
}> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-plugin-link-"));
	tempDirs.push(tempDir);
	const pluginRoot = path.join(tempDir, "runtime");
	const nodeModules = path.join(pluginRoot, "node_modules");
	const sourceRoot = path.join(tempDir, "source");
	await fs.mkdir(sourceRoot, { recursive: true });
	await Bun.write(path.join(sourceRoot, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }));
	spyOn(utils, "getPluginsDir").mockReturnValue(pluginRoot);
	spyOn(utils, "getPluginsNodeModules").mockReturnValue(nodeModules);
	spyOn(utils, "getPluginsPackageJson").mockReturnValue(path.join(pluginRoot, "package.json"));
	spyOn(utils, "getPluginsLockfile").mockReturnValue(path.join(pluginRoot, "proto-plugins.lock.json"));
	return { manager: new PluginManager(tempDir), pluginRoot, nodeModules, sourceRoot };
}

test("plugin link rejects package names that escape node_modules", async () => {
	const { manager, pluginRoot, sourceRoot } = await setupManager("../escape");
	const escapedPath = path.join(pluginRoot, "escape");

	await expect(manager.link(sourceRoot)).rejects.toThrow(/Invalid npm package name/);
	expect(await Bun.file(escapedPath).exists()).toBe(false);
});

test("plugin link rejects symlinked destination parent directories", async () => {
	const { manager, nodeModules, sourceRoot } = await setupManager("@scope/name");
	const outsideScope = path.join(path.dirname(nodeModules), "outside-scope");
	await fs.mkdir(nodeModules, { recursive: true });
	await fs.mkdir(outsideScope, { recursive: true });
	await fs.symlink(outsideScope, path.join(nodeModules, "@scope"), "dir");

	await expect(manager.link(sourceRoot)).rejects.toThrow(/symlinked parent/);
	expect(await Bun.file(path.join(outsideScope, "name")).exists()).toBe(false);
});
