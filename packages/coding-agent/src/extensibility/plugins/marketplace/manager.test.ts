import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPluginsDir, logger } from "@oh-my-pi/pi-utils";
import { clearClaudePluginRootsCache } from "../../../discovery/helpers";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "../loader";
import { MarketplaceManager } from "./manager";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	clearClaudePluginRootsCache();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

test("uninstall refuses registry install paths outside the plugin cache", async () => {
	const tempDir = await makeTempDir("proto-marketplace-uninstall-");
	const cacheDir = path.join(tempDir, "cache", "plugins");
	const outsideDir = path.join(tempDir, "outside-cache");
	await fs.mkdir(cacheDir, { recursive: true });
	await fs.mkdir(outsideDir, { recursive: true });
	const markerPath = path.join(outsideDir, "must-survive.txt");
	await Bun.write(markerPath, "safe");

	const installedRegistryPath = path.join(tempDir, "runtime", "installed_plugins.json");
	await Bun.write(
		installedRegistryPath,
		JSON.stringify({
			version: 2,
			plugins: {
				"danger@market": [
					{
						scope: "user",
						installPath: outsideDir,
						version: "1.0.0",
						installedAt: "2026-01-01T00:00:00.000Z",
						lastUpdated: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		}),
	);
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	const manager = new MarketplaceManager({
		marketplacesRegistryPath: path.join(tempDir, "marketplaces.json"),
		installedRegistryPath,
		marketplacesCacheDir: path.join(tempDir, "cache", "marketplaces"),
		pluginsCacheDir: cacheDir,
	});

	await manager.uninstallPlugin("danger@market", "user");

	expect(await Bun.file(markerPath).exists()).toBe(true);
	expect(warn.mock.calls.some(([message]) => String(message).includes("outside the plugin cache"))).toBe(true);
});

test("a legitimate marketplace plugin installs, links, loads, and uninstalls", async () => {
	const tempDir = await makeTempDir("proto-marketplace-happy-");
	const home = path.join(tempDir, "home");
	const pluginRoot = getPluginsDir(home);
	const marketplaceRoot = path.join(tempDir, "marketplace");
	const sourceRoot = path.join(marketplaceRoot, "plugin");
	const cwd = path.join(tempDir, "project");
	await fs.mkdir(sourceRoot, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(
		path.join(sourceRoot, "package.json"),
		JSON.stringify({
			name: "legit-plugin",
			version: "1.0.0",
			proto: { version: "1.0.0", extensions: ["index.ts"] },
		}),
	);
	await Bun.write(path.join(sourceRoot, "index.ts"), "export default () => {};\n");
	const catalogPath = path.join(marketplaceRoot, "marketplace.json");
	await Bun.write(
		catalogPath,
		JSON.stringify({
			name: "market",
			owner: { name: "test" },
			plugins: [{ name: "legit", source: "./plugin", version: "1.0.0" }],
		}),
	);
	const marketplacesRegistryPath = path.join(pluginRoot, "marketplaces.json");
	await Bun.write(
		marketplacesRegistryPath,
		JSON.stringify({
			version: 1,
			marketplaces: [
				{
					name: "market",
					sourceType: "local",
					sourceUri: marketplaceRoot,
					catalogPath,
					addedAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		}),
	);
	const installedRegistryPath = path.join(pluginRoot, "installed_plugins.json");
	const manager = new MarketplaceManager({
		marketplacesRegistryPath,
		installedRegistryPath,
		marketplacesCacheDir: path.join(pluginRoot, "cache", "marketplaces"),
		pluginsCacheDir: path.join(pluginRoot, "cache", "plugins"),
		clearPluginRootsCache: () => clearClaudePluginRootsCache(),
	});

	const installed = await manager.installPlugin("legit", "market");
	const linkPath = path.join(pluginRoot, "node_modules", "legit-plugin");
	expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
	expect(await fs.realpath(linkPath)).toBe(await fs.realpath(installed.installPath));

	const loaded = await getEnabledPlugins(cwd, { home });
	expect(loaded.map(plugin => plugin.name)).toEqual(["legit-plugin"]);
	const extensionPaths = resolvePluginExtensionPaths(loaded[0]!);
	expect(extensionPaths).toHaveLength(1);
	expect(await fs.realpath(extensionPaths[0]!)).toBe(path.join(await fs.realpath(installed.installPath), "index.ts"));

	await manager.uninstallPlugin("legit@market", "user");
	expect(await Bun.file(installed.installPath).exists()).toBe(false);
	expect(await Bun.file(linkPath).exists()).toBe(false);
	expect(await getEnabledPlugins(cwd, { home })).toEqual([]);
});
