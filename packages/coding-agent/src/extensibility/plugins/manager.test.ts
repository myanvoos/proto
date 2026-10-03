import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
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

test("plugin link replaces a real directory left by a git install", async () => {
	const { manager, nodeModules, sourceRoot } = await setupManager("git-installed");
	const linkPath = path.join(nodeModules, "git-installed");
	await Bun.write(path.join(linkPath, "package.json"), JSON.stringify({ name: "git-installed", version: "0.9.0" }));

	await manager.link(sourceRoot, { force: true });

	expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
	expect(await fs.realpath(linkPath)).toBe(await fs.realpath(sourceRoot));
});

async function seedVersionDrift(diskVersion: string, lockVersion: string) {
	const { manager, pluginRoot, nodeModules } = await setupManager("unused");
	const name = "@scope/plugin";
	await Bun.write(
		path.join(nodeModules, name, "package.json"),
		JSON.stringify({ name, version: diskVersion, proto: { version: diskVersion } }),
	);
	await Bun.write(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ private: true, dependencies: { [name]: `^${lockVersion}` } }),
	);
	await Bun.write(
		path.join(pluginRoot, "proto-plugins.lock.json"),
		JSON.stringify({
			plugins: { [name]: { version: lockVersion, enabledFeatures: null, enabled: true } },
			settings: {},
		}),
	);
	return { manager, nodeModules, name };
}

test("doctor reports lock-vs-disk version drift", async () => {
	const { manager, name } = await seedVersionDrift("1.0.2", "1.0.3");

	const drift = (await manager.doctor()).find(check => check.name === `plugin:${name}:version`);

	expect(drift?.status).toBe("error");
	expect(drift?.message).toContain("v1.0.3");
	expect(drift?.message).toContain("v1.0.2");
});

test("doctor --fix restores the drifted package when the repair fails", async () => {
	const { manager, nodeModules, name } = await seedVersionDrift("1.0.2", "1.0.3");
	const failedInstall = Bun.spawn(["bun", "-e", "process.exit(1)"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	vi.spyOn(Bun, "spawn").mockReturnValue(failedInstall);

	const drift = (await manager.doctor({ fix: true })).find(check => check.name === `plugin:${name}:version`);

	expect(drift).toMatchObject({ status: "error", fixed: false });
	expect(await Bun.file(path.join(nodeModules, name, "package.json")).json()).toMatchObject({ version: "1.0.2" });
});

test("npm install prunes stale and malformed manifest keys bun would append next to", async () => {
	const { manager, pluginRoot, nodeModules } = await setupManager("unused");
	const pkgJsonPath = path.join(pluginRoot, "package.json");
	await Bun.write(
		pkgJsonPath,
		JSON.stringify({
			private: true,
			dependencies: { "npm:pi-lens@4.1.6": "npm:pi-lens@4.1.6", "pi-lens": "npm:pi-lens@4.1.6" },
		}),
	);
	// `bun install` appends the new edge and keeps every existing key.
	vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const exited = (async () => {
			if (cmd[1] === "install") {
				const current: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
				await Bun.write(
					pkgJsonPath,
					JSON.stringify({
						private: true,
						dependencies: { ...current.dependencies, "pi-lens": "npm:pi-lens@4.2.0" },
					}),
				);
				await Bun.write(
					path.join(nodeModules, "pi-lens", "package.json"),
					JSON.stringify({ name: "pi-lens", version: "4.2.0", proto: { version: "4.2.0" } }),
				);
			}
			return 0;
		})();
		return { pid: 1, stdout: new Response("").body, stderr: new Response("").body, exited } as Subprocess;
	}) as typeof Bun.spawn);

	await manager.install("npm:pi-lens@4.2.0");

	expect((await Bun.file(pkgJsonPath).json()).dependencies).toEqual({ "pi-lens": "npm:pi-lens@4.2.0" });
});

test("upgrade re-installs an npm plugin by name and keeps its runtime state", async () => {
	const { manager, pluginRoot, nodeModules } = await setupManager("unused");
	const pkgJsonPath = path.join(pluginRoot, "package.json");
	const installedPkgPath = path.join(nodeModules, "pi-lens", "package.json");
	await Bun.write(
		installedPkgPath,
		JSON.stringify({
			name: "pi-lens",
			version: "4.1.6",
			proto: { version: "4.1.6", features: { kept: {}, dropped: {} } },
		}),
	);
	await Bun.write(pkgJsonPath, JSON.stringify({ private: true, dependencies: { "pi-lens": "^4.1.6" } }));
	await Bun.write(
		path.join(pluginRoot, "proto-plugins.lock.json"),
		JSON.stringify({
			plugins: { "pi-lens": { version: "4.1.6", enabledFeatures: ["kept", "dropped"], enabled: false } },
			settings: {},
		}),
	);
	const spawned: string[][] = [];
	vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		spawned.push(cmd);
		const exited = (async () => {
			await Bun.write(pkgJsonPath, JSON.stringify({ private: true, dependencies: { "pi-lens": "^4.2.0" } }));
			await Bun.write(
				installedPkgPath,
				JSON.stringify({ name: "pi-lens", version: "4.2.0", proto: { version: "4.2.0", features: { kept: {} } } }),
			);
			return 0;
		})();
		return { pid: 1, stdout: new Response("").body, stderr: new Response("").body, exited } as Subprocess;
	}) as typeof Bun.spawn);

	const result = await manager.upgrade("pi-lens");

	expect(spawned).toEqual([["bun", "install", "--no-cache", "pi-lens"]]);
	expect(result).toMatchObject({ from: "4.1.6", changed: true, plugin: { version: "4.2.0" } });
	expect((await Bun.file(path.join(pluginRoot, "proto-plugins.lock.json")).json()).plugins["pi-lens"]).toEqual({
		version: "4.2.0",
		enabledFeatures: ["kept"],
		enabled: false,
	});
	await expect(manager.upgrade("missing-plugin")).rejects.toThrow(/missing-plugin is not installed/);
});
