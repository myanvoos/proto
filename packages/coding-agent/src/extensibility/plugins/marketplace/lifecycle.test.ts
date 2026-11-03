import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "../../../utils/git";
import { cachePlugin } from "./cache";
import { fetchMarketplace, pruneAbandonedMarketplaceClones } from "./fetcher";
import { MarketplaceManager } from "./manager";

let root: string;
let runtime: string;
let marketplace: string;
let source: string;
let cache: string;
let userRegistry: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-marketplace-lifecycle-"));
	runtime = path.join(root, "runtime");
	marketplace = path.join(root, "marketplace");
	source = path.join(marketplace, "plugin");
	cache = path.join(runtime, "cache");
	userRegistry = path.join(runtime, "installed_plugins.json");
	await Bun.write(path.join(source, "package.json"), JSON.stringify({ name: "sample", version: "1.0.0" }));
	const catalogPath = path.join(marketplace, "marketplace.json");
	await Bun.write(
		catalogPath,
		JSON.stringify({ name: "market", owner: { name: "test" }, plugins: [{ name: "sample", source: "./plugin" }] }),
	);
	await Bun.write(
		path.join(runtime, "marketplaces.json"),
		JSON.stringify({
			version: 1,
			marketplaces: [
				{
					name: "market",
					sourceType: "local",
					sourceUri: marketplace,
					catalogPath,
					addedAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		}),
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

function manager(projectRegistry?: string): MarketplaceManager {
	return new MarketplaceManager({
		marketplacesRegistryPath: path.join(runtime, "marketplaces.json"),
		installedRegistryPath: userRegistry,
		projectInstalledRegistryPath: projectRegistry,
		marketplacesCacheDir: path.join(runtime, "marketplaces"),
		pluginsCacheDir: cache,
	});
}

test("uninstall keeps a shared cache until the last indexed project stops linking to it", async () => {
	const firstRegistry = path.join(root, "first", ".proto", "plugins", "installed_plugins.json");
	const secondRegistry = path.join(root, "second", ".proto", "plugins", "installed_plugins.json");
	const first = manager(firstRegistry);
	const second = manager(secondRegistry);
	const installed = await first.installPlugin("sample", "market", { scope: "project" });
	await second.installPlugin("sample", "market", { scope: "project" });
	await first.uninstallPlugin("sample@market", "project");
	const secondLink = path.join(path.dirname(secondRegistry), "node_modules", "sample");
	expect(await fs.realpath(secondLink)).toBe(await fs.realpath(installed.installPath));
	await second.uninstallPlugin("sample@market", "project");
	expect(await Bun.file(path.join(installed.installPath, "package.json")).exists()).toBe(false);
});

test("a malformed registry in another project retains caches rather than breaking its links", async () => {
	const firstRegistry = path.join(root, "first", "installed_plugins.json");
	const secondRegistry = path.join(root, "second", "installed_plugins.json");
	const first = manager(firstRegistry);
	const installed = await first.installPlugin("sample", "market", { scope: "project" });
	await manager(secondRegistry).installPlugin("sample", "market", { scope: "project" });
	await Bun.write(secondRegistry, "malformed json");
	await first.uninstallPlugin("sample@market", "project");
	expect((await Bun.file(path.join(installed.installPath, "package.json")).json()).name).toBe("sample");
});

test("the replacement registry entry is visible before an upgrade deletes the old cache", async () => {
	const plugins = manager();
	const old = await plugins.installPlugin("sample", "market");
	await Bun.write(path.join(source, "package.json"), JSON.stringify({ name: "sample", version: "2.0.0" }));
	const remove = fs.rm;
	let registeredWhenRemoved = "";
	vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
		if (String(target) === old.installPath) {
			const registry = await Bun.file(userRegistry).json();
			registeredWhenRemoved = registry.plugins["sample@market"][0].version;
		}
		return remove(target, options);
	});
	await plugins.upgradePlugin("sample@market", "user");
	expect(registeredWhenRemoved).toBe("2.0.0");
});

test("same-version recaching publishes the new directory before removing the previous copy", async () => {
	const target = await cachePlugin(source, cache, "market", "sample", "1.0.0");
	await Bun.write(path.join(source, "marker"), "new content");
	const remove = fs.rm;
	let observed: string | undefined;
	vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
		if (String(candidate).endsWith(".previous")) observed = await Bun.file(path.join(target, "marker")).text();
		return remove(candidate, options);
	});
	await cachePlugin(source, cache, "market", "sample", "1.0.0");
	expect(observed).toBe("new content");
});

test("failed concurrent clones have distinct staging paths and leave no partial checkouts", async () => {
	const targets: string[] = [];
	vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
	vi.spyOn(git, "clone").mockImplementation(async (_url, target) => {
		targets.push(target);
		await Bun.write(path.join(target, "partial"), "incomplete");
		throw new Error("clone failed");
	});
	const results = await Promise.allSettled([
		fetchMarketplace("owner/repo", cache),
		fetchMarketplace("owner/repo", cache),
	]);
	expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
	expect(new Set(targets).size).toBe(2);
	expect(await fs.readdir(cache)).toEqual([]);
});

test("clone pruning removes expired temporary directories but leaves in-flight and named caches", async () => {
	const now = Date.now();
	const old = `.tmp-clone-${now - 31 * 60 * 1000}-abandoned`;
	const recent = `.tmp-clone-${now}-active`;
	for (const dir of [old, recent, "market"]) await fs.mkdir(path.join(cache, dir), { recursive: true });
	await pruneAbandonedMarketplaceClones(cache);
	expect((await fs.readdir(cache)).sort()).toEqual([recent, "market"].sort());
});
