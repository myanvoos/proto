import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { PluginManager } from "./manager";
import { MarketplaceManager } from "./marketplace/manager";
import { setInstalledPluginEnabled } from "./toggle";

afterEach(() => vi.restoreAllMocks());

async function managers(root: string) {
	const lock = path.join(root, "runtime", "proto-plugins.lock.json");
	spyOn(utils, "getPluginsDir").mockReturnValue(path.join(root, "runtime"));
	spyOn(utils, "getPluginsLockfile").mockReturnValue(lock);
	const userRegistry = path.join(root, "user-installed.json");
	const projectRegistry = path.join(root, "project-installed.json");
	const marketplace = new MarketplaceManager({
		marketplacesRegistryPath: path.join(root, "marketplaces.json"),
		installedRegistryPath: userRegistry,
		projectInstalledRegistryPath: projectRegistry,
		marketplacesCacheDir: path.join(root, "cache", "marketplaces"),
		pluginsCacheDir: path.join(root, "cache", "plugins"),
	});
	return { npm: new PluginManager(root), marketplace, lock, userRegistry, projectRegistry };
}

test("toggling an npm-only plugin persists its enabled state instead of treating it as an absent marketplace plugin", async () => {
	using tmp = utils.TempDir.createSync("@plugin-toggle-npm-");
	const fixture = await managers(tmp.path());
	await Bun.write(
		fixture.lock,
		JSON.stringify({ plugins: { "npm-fixture": { version: "1.0.0", enabled: true } }, settings: {} }),
	);
	await setInstalledPluginEnabled("npm-fixture", { ...fixture, enabled: false, marketplaceIds: new Set() });
	const saved = await Bun.file(fixture.lock).json();
	expect(saved.plugins["npm-fixture"].enabled).toBe(false);
});

test("an ambiguous scoped marketplace install cannot silently fall back to the global npm toggle", async () => {
	using tmp = utils.TempDir.createSync("@plugin-toggle-scoped-");
	const fixture = await managers(tmp.path());
	const name = "plugin@market";
	const entry = {
		scope: "user",
		installPath: path.join(tmp.path(), "plugin"),
		version: "1.0.0",
		installedAt: "2026-01-01",
		lastUpdated: "2026-01-01",
	};
	await Bun.write(fixture.userRegistry, JSON.stringify({ version: 2, plugins: { [name]: [entry] } }));
	await Bun.write(
		fixture.projectRegistry,
		JSON.stringify({ version: 2, plugins: { [name]: [{ ...entry, scope: "project" }] } }),
	);
	await expect(
		setInstalledPluginEnabled(name, { ...fixture, enabled: false, marketplaceIds: new Set([name]) }),
	).rejects.toThrow("both user and project scope");
	expect(await Bun.file(fixture.lock).exists()).toBe(false);
});
