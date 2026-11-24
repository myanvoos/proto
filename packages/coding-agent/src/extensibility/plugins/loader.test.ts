import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import {
	getEnabledPlugins,
	readProjectPluginOverrides,
	resolvePluginExtensionPaths,
	resolvePluginManifestEntries,
} from "./loader";
import type { InstalledPlugin } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

test("plugin manifest entries cannot escape the package root", async () => {
	const tempDir = await makeTempDir("proto-plugin-manifest-");
	const pluginRoot = path.join(tempDir, "nested", "plugin");
	const outsidePath = path.join(tempDir, "outside.ts");
	await fs.mkdir(pluginRoot, { recursive: true });
	await Bun.write(outsidePath, "export default {};\n");
	const plugin: InstalledPlugin = {
		name: "unsafe-plugin",
		version: "1.0.0",
		path: pluginRoot,
		manifest: { version: "1.0.0", commands: ["../../outside.ts"] },
		enabledFeatures: null,
		enabled: true,
	};

	expect(resolvePluginManifestEntries(plugin, "commands")).toEqual([
		{ entry: "../../outside.ts", resolvedPath: null },
	]);
});

test("plugin manifest entries cannot escape through a symlink", async () => {
	const tempDir = await makeTempDir("proto-plugin-manifest-link-");
	const pluginRoot = path.join(tempDir, "plugin");
	const outsidePath = path.join(tempDir, "outside.ts");
	await fs.mkdir(pluginRoot, { recursive: true });
	await Bun.write(outsidePath, "export default {};\n");
	await fs.symlink(outsidePath, path.join(pluginRoot, "command.ts"));
	const plugin: InstalledPlugin = {
		name: "unsafe-plugin",
		version: "1.0.0",
		path: pluginRoot,
		manifest: { version: "1.0.0", commands: ["command.ts"] },
		enabledFeatures: null,
		enabled: true,
	};

	expect(resolvePluginManifestEntries(plugin, "commands")).toEqual([{ entry: "command.ts", resolvedPath: null }]);
});

test("non-string manifest entries are reported as unresolved and valid siblings still resolve", async () => {
	const pluginRoot = await makeTempDir("proto-plugin-manifest-nonstring-");
	await Bun.write(path.join(pluginRoot, "index.js"), "export default function () {};\n");
	// Manifest JSON is not validated at read time, so an entry can be an object
	// or null. `path.join` used to throw ERR_INVALID_ARG_TYPE here and abort
	// extension loading for every plugin.
	const plugin: InstalledPlugin = {
		name: "fixture-plugin",
		version: "1.0.0",
		path: pluginRoot,
		manifest: {
			version: "1.0.0",
			extensions: [{ path: "./index.js" }, null, "./index.js"] as unknown as string[],
		},
		enabledFeatures: null,
		enabled: true,
	};
	const indexPath = await fs.realpath(path.join(pluginRoot, "index.js"));

	expect(resolvePluginManifestEntries(plugin, "extensions")).toEqual([
		{ entry: '{"path":"./index.js"}', resolvedPath: null },
		{ entry: "null", resolvedPath: null },
		{ entry: "./index.js", resolvedPath: indexPath },
	]);
	expect(resolvePluginExtensionPaths(plugin)).toEqual([indexPath]);
});

test("invalid project overrides fail closed before project-controlled plugins load", async () => {
	const tempDir = await makeTempDir("proto-plugin-overrides-");
	const home = path.join(tempDir, "home");
	const cwd = path.join(tempDir, "project");
	const pluginRoot = getPluginsDir(home);
	const packageRoot = path.join(pluginRoot, "node_modules", "disabled-plugin");
	await fs.mkdir(packageRoot, { recursive: true });
	await Bun.write(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "plugins", private: true, dependencies: { "disabled-plugin": "1.0.0" } }),
	);
	await Bun.write(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: "disabled-plugin", version: "1.0.0", proto: { version: "1.0.0" } }),
	);
	const overridesPath = path.join(cwd, ".proto", "plugin-overrides.json");
	await Bun.write(overridesPath, '{"disabled":["disabled-plugin"]');

	await expect(getEnabledPlugins(cwd, { home })).rejects.toThrow(/project plugin overrides/i);
});

test("schema-invalid project overrides are rejected", async () => {
	const tempDir = await makeTempDir("proto-plugin-overrides-schema-");
	const overridesPath = path.join(tempDir, "plugin-overrides.json");
	await Bun.write(overridesPath, JSON.stringify({ disabled: "disabled-plugin" }));

	await expect(readProjectPluginOverrides(overridesPath)).rejects.toThrow(/Invalid project plugin overrides/);
});

async function writePlugin(dir: string, name: string): Promise<void> {
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", proto: { version: "1.0.0" } }),
	);
}

test("lockfile-only plugins load only when linked, unless the root has no package.json", async () => {
	const tempDir = await makeTempDir("proto-plugin-stale-lock-");
	const home = path.join(tempDir, "home");
	const cwd = path.join(tempDir, "project");
	const pluginRoot = getPluginsDir(home);
	const nodeModules = path.join(pluginRoot, "node_modules");
	const linkedSource = path.join(tempDir, "linked-source");
	await Promise.all([
		writePlugin(path.join(nodeModules, "declared"), "declared"),
		writePlugin(path.join(nodeModules, "stale"), "stale"),
		writePlugin(linkedSource, "linked"),
	]);
	await fs.symlink(linkedSource, path.join(nodeModules, "linked"), "dir");
	const enabled = { version: "1.0.0", enabledFeatures: null, enabled: true };
	await Bun.write(
		path.join(pluginRoot, "proto-plugins.lock.json"),
		JSON.stringify({ plugins: { declared: enabled, stale: enabled, linked: enabled }, settings: {} }),
	);

	const packageJsonPath = path.join(pluginRoot, "package.json");
	await Bun.write(packageJsonPath, JSON.stringify({ dependencies: { declared: "1.0.0" } }));
	expect((await getEnabledPlugins(cwd, { home })).map(plugin => plugin.name).sort()).toEqual(["declared", "linked"]);

	await fs.rm(packageJsonPath);
	const manifestlessCwd = path.join(tempDir, "other-project");
	expect((await getEnabledPlugins(manifestlessCwd, { home })).map(plugin => plugin.name).sort()).toEqual([
		"declared",
		"linked",
		"stale",
	]);
});
