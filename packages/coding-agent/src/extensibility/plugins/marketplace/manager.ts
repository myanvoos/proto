import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEnoent, logger, pathIsWithin } from "@oh-my-pi/pi-utils";
import { expandTilde } from "../../../tools/path-utils";
import { normalizePluginRuntimeConfig, writePluginRuntimeConfig } from "../runtime-config";
import type { PluginRuntimeConfig, PluginRuntimeState } from "../types";

import { cachePlugin, getCachedPluginPath, isValidVersionForCache } from "./cache";
import {
	classifySource,
	fetchMarketplace,
	parseMarketplaceCatalog,
	promoteCloneToCache,
	pruneAbandonedMarketplaceClones,
} from "./fetcher";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	assertMarketplaceNameAvailable,
	collectReferencedPaths,
	getInstalledPlugin,
	getMarketplaceEntry,
	getProjectRegistriesIndexPath,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	readProjectRegistriesIndex,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
	writeProjectRegistriesIndex,
} from "./registry";
import { resolvePluginSource, validatePluginSource } from "./source-resolver";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
	InstalledPluginsRegistry,
	MarketplaceCatalog,
	MarketplacePluginEntry,
	MarketplaceRegistryEntry,
} from "./types";
import { buildPluginId, parsePluginId } from "./types";

const RUNTIME_PACKAGE_NAME_RE = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;
const MAX_RUNTIME_PACKAGE_NAME_LENGTH = 214;

function assertRuntimePackageName(name: string): string {
	if (name.length > MAX_RUNTIME_PACKAGE_NAME_LENGTH || !RUNTIME_PACKAGE_NAME_RE.test(name)) {
		throw new Error(`Invalid marketplace plugin package name: ${JSON.stringify(name)}`);
	}
	return name;
}

interface InstallValidation {
	scope: "user" | "project";
	registryPath: string;
	marketplaceClonePath: string;
	catalog: MarketplaceCatalog;
	pluginEntry: MarketplacePluginEntry;
	pluginId: string;
	existing: InstalledPluginEntry[] | undefined;
	instReg: InstalledPluginsRegistry;
	sourcePath: string | undefined;
}

interface RemovedRuntimeState {
	state?: PluginRuntimeState;
	settings?: Record<string, unknown>;
}

interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;

	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;

	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
}

export type VersionChange = "upgrade" | "reinstall" | "downgrade";

/**
 * How moving an installed plugin from `from` to `to` counts. Newer semver is an upgrade; any other
 * pair of different non-semver tags also counts as an upgrade, since their order is unknown.
 */
export function classifyVersionChange(from: string, to: string): VersionChange {
	if (to === from) return "reinstall";
	try {
		const order = Bun.semver.order(to, from);
		return order > 0 ? "upgrade" : order < 0 ? "downgrade" : "reinstall";
	} catch {
		return "upgrade";
	}
}

export class MarketplaceManager {
	#opts: MarketplaceManagerOptions;

	constructor(options: MarketplaceManagerOptions) {
		this.#opts = options;
	}

	#clearCache(): void {
		const extra = this.#opts.projectInstalledRegistryPath
			? ([this.#opts.projectInstalledRegistryPath] as readonly string[])
			: undefined;
		this.#opts.clearPluginRootsCache?.(extra);
	}

	async #removeCachedInstallPath(installPath: string): Promise<void> {
		const cacheDir = this.#opts.pluginsCacheDir;
		const strictlyWithinCache = pathIsWithin(cacheDir, installPath) && !pathIsWithin(installPath, cacheDir);
		if (!strictlyWithinCache) {
			logger.warn("Refusing to remove installed plugin path outside the plugin cache", {
				installPath,
				pluginsCacheDir: cacheDir,
			});
			return;
		}
		await fs.rm(installPath, { recursive: true, force: true });
	}

	async addMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);

		const { catalog, clonePath } = await fetchMarketplace(source, this.#opts.marketplacesCacheDir);

		try {
			assertMarketplaceNameAvailable(reg, catalog.name);
		} catch (err) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw err;
		}

		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		const sourceType = classifySource(source);
		const normalizedSource = sourceType === "local" ? path.resolve(expandTilde(source)) : source;

		const catalogPath = path.resolve(
			expandTilde(path.join(this.#opts.marketplacesCacheDir, catalog.name, "marketplace.json")),
		);

		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: normalizedSource,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};

		const updated = addMarketplaceEntry(reg, entry);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		logger.debug("Marketplace added", { name: catalog.name, sourceType });
		return entry;
	}

	async removeMarketplace(name: string): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);

		const updated = removeMarketplaceEntry(reg, name);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		await fs.rm(path.join(this.#opts.marketplacesCacheDir, name), {
			recursive: true,
			force: true,
		});

		logger.debug("Marketplace removed", { name });
	}

	async updateMarketplace(name: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existing = getMarketplaceEntry(reg, name);
		if (!existing) {
			throw new Error(`Marketplace "${name}" not found`);
		}

		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, this.#opts.marketplacesCacheDir);

		if (catalog.name !== name) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(
				`Marketplace catalog name changed from "${name}" to "${catalog.name}". ` +
					`Remove and re-add the marketplace to update.`,
			);
		}

		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		const catalogPath = path.resolve(expandTilde(existing.catalogPath));
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const updatedEntry: MarketplaceRegistryEntry = {
			...existing,
			catalogPath,
			updatedAt: new Date().toISOString(),
		};

		const updatedReg = {
			...reg,
			marketplaces: reg.marketplaces.map(m => (m.name === name ? updatedEntry : m)),
		};
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updatedReg);

		logger.debug("Marketplace updated", { name });
		return updatedEntry;
	}

	async updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const marketplaces = await this.listMarketplaces();
		const results: MarketplaceRegistryEntry[] = [];
		for (const m of marketplaces) {
			const updated = await this.updateMarketplace(m.name);
			results.push(updated);
		}
		return results;
	}

	async listMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		return reg.marketplaces;
	}

	async listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);

		if (marketplace !== undefined) {
			const entry = reg.marketplaces.find(m => m.name === marketplace);
			if (!entry) {
				throw new Error(`Marketplace "${marketplace}" not found`);
			}
			const catalog = await this.#readCatalog(entry);
			return catalog.plugins;
		}

		const all: MarketplacePluginEntry[] = [];
		for (const entry of reg.marketplaces) {
			const catalog = await this.#readCatalog(entry);
			all.push(...catalog.plugins);
		}
		return all;
	}

	async getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null> {
		const plugins = await this.listAvailablePlugins(marketplace);
		return plugins.find(p => p.name === name) ?? null;
	}

	// Every check an install can make without cloning or writing, shared with `--dry-run` previews.
	async #validateInstall(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<InstallValidation> {
		const force = options?.force ?? false;
		const scope = options?.scope ?? "user";
		const registryPath = this.#registryPath(scope);

		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const mktEntry = getMarketplaceEntry(mktReg, marketplace);
		if (!mktEntry) {
			throw new Error(`Marketplace "${marketplace}" not found`);
		}

		const catalog = await this.#readCatalog(mktEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) {
			throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);
		}
		if (
			typeof pluginEntry.version === "string" &&
			pluginEntry.version.length > 0 &&
			!isValidVersionForCache(pluginEntry.version)
		) {
			throw new Error(`Invalid version for cache: "${pluginEntry.version}"`);
		}

		const marketplaceClonePath = this.#resolveMarketplaceRoot(mktEntry);
		if (mktEntry.sourceType === "url" && typeof pluginEntry.source === "string") {
			throw new Error(
				`Plugin "${name}" uses a relative source path but marketplace "${marketplace}" was added via URL. ` +
					`Relative sources require a git or local marketplace. Re-add the marketplace using its git URL.`,
			);
		}
		const sourcePath = await validatePluginSource(pluginEntry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
		});
		await this.#validateEmbeddedDapPath(pluginEntry, sourcePath);

		const pluginId = buildPluginId(name, marketplace);
		const instReg = await readInstalledPluginsRegistry(registryPath);
		const existing = getInstalledPlugin(instReg, pluginId);
		if (existing && existing.length > 0 && !force) {
			throw new Error(`Plugin "${pluginId}" is already installed. Use force option to reinstall.`);
		}

		return {
			scope,
			registryPath,
			marketplaceClonePath,
			catalog,
			pluginEntry,
			pluginId,
			existing,
			instReg,
			sourcePath,
		};
	}

	async validateInstallPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<void> {
		const { scope, registryPath, pluginId, existing, sourcePath, instReg, pluginEntry } = await this.#validateInstall(
			name,
			marketplace,
			options,
		);
		// `installPlugin` also rejects a runtime package name another plugin owns, a resolved version
		// that is unsafe as a cache path, and a cache path that case-collides with another installed
		// plugin — but only after it has resolved the source. A source already on disk needs no clone
		// and no write for those checks, so a preview of it raises the same errors in the same order.
		// A source the install must fetch keeps its name and its version unknown until then.
		if (sourcePath === undefined) return;
		const packageName = await this.#resolvePluginPackageName(sourcePath, name);
		const previousPackageNames = await this.#resolveInstalledPackageNames(existing ?? [], name);
		await this.#assertRuntimePackageNameAvailable(scope, packageName, instReg, pluginId, previousPackageNames);
		const version = (await this.#resolveCatalogVersion(pluginEntry, sourcePath)) ?? "0.0.0";
		const prospectiveCachePath = getCachedPluginPath(this.#opts.pluginsCacheDir, marketplace, name, version);
		const otherRegistryPath =
			scope === "user" ? this.#opts.projectInstalledRegistryPath : this.#opts.installedRegistryPath;
		const registriesToCheck =
			otherRegistryPath && otherRegistryPath !== registryPath
				? [instReg, await readInstalledPluginsRegistry(otherRegistryPath)]
				: [instReg];
		this.#assertCachePathAvailable(prospectiveCachePath, pluginId, registriesToCheck);
	}

	async installPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<InstalledPluginEntry> {
		const { scope, registryPath, marketplaceClonePath, catalog, pluginEntry, pluginId, existing } =
			await this.#validateInstall(name, marketplace, options);

		const { dir: sourcePath, tempCloneRoot } = await resolvePluginSource(pluginEntry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
			tmpDir: os.tmpdir(),
		});

		// The cache is keyed by marketplace/plugin/version and shared across scopes, so a forced
		// reinstall also replaces the copy the other scope references; its runtime names are
		// captured first so a manifest rename can migrate that scope's link and lockfile key.
		const otherScope: "user" | "project" = scope === "user" ? "project" : "user";
		const otherRegistryPath =
			otherScope === "project" ? this.#opts.projectInstalledRegistryPath : this.#opts.installedRegistryPath;
		const otherScopeOldNames = new Map<string, string>();
		let otherScopeEntries: readonly InstalledPluginEntry[] = [];

		// Registration identity is validated before cachePlugin replaces an active cache: a forced
		// reinstall reuses the cache key, so a later failure would already have destroyed it.
		let version!: string;
		let cachePath!: string;
		let packageName!: string;
		let previousPackageNames!: Set<string>;
		try {
			otherScopeEntries = otherRegistryPath
				? (getInstalledPlugin(await readInstalledPluginsRegistry(otherRegistryPath), pluginId) ?? [])
				: [];
			for (const entry of otherScopeEntries) {
				otherScopeOldNames.set(entry.installPath, await this.#resolvePluginPackageName(entry.installPath, name));
			}

			version = (await this.#resolveCatalogVersion(pluginEntry, sourcePath)) ?? "0.0.0";
			packageName = await this.#resolvePluginPackageName(sourcePath, name);
			// Read before cachePlugin overwrites the cache, or a case-only rename (Foo → foo)
			// would strand the old runtime link and lockfile key.
			previousPackageNames = await this.#resolveInstalledPackageNames(existing ?? [], name);
			const targetReg = await readInstalledPluginsRegistry(registryPath);
			await this.#assertRuntimePackageNameAvailable(scope, packageName, targetReg, pluginId, previousPackageNames);
			const registriesToCheck =
				otherRegistryPath && otherRegistryPath !== registryPath
					? [targetReg, await readInstalledPluginsRegistry(otherRegistryPath)]
					: [targetReg];
			this.#assertCachePathAvailable(
				getCachedPluginPath(this.#opts.pluginsCacheDir, marketplace, name, version),
				pluginId,
				registriesToCheck,
			);
			cachePath = await cachePlugin(sourcePath, this.#opts.pluginsCacheDir, marketplace, name, version);
			await this.#writeEmbeddedDapConfig(pluginEntry, cachePath);
		} finally {
			if (tempCloneRoot) {
				await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
			}
		}

		const now = new Date().toISOString();
		const wasDisabled = existing?.some(e => e.enabled === false);
		const installedEntry: InstalledPluginEntry = {
			scope,
			installPath: cachePath,
			version,
			installedAt: now,
			lastUpdated: now,
			...(wasDisabled ? { enabled: false } : {}),
		};
		const currentInstReg = await readInstalledPluginsRegistry(registryPath);
		const baseInstReg = existing?.length ? removeInstalledPlugin(currentInstReg, pluginId) : currentInstReg;
		// CHECKLIST(install-atomicity): Persisting the registry before the runtime link/config means a later failure can
		// leave an installed entry that the runtime cannot load. Commit these updates as one rollback-safe transaction.
		// Replace the entry in one write, before deleting the superseded cache.
		await writeInstalledPluginsRegistry(registryPath, addInstalledPlugin(baseInstReg, pluginId, installedEntry));
		if (scope === "project") await this.#trackProjectRegistry();
		if (existing?.length) {
			await this.#removeUnreferencedCachePaths(
				existing.map(entry => entry.installPath).filter(installPath => installPath !== cachePath),
			);
		}

		// Carry the renamed-from key's feature selection and settings so a case-only rename keeps them.
		let carried: RemovedRuntimeState | undefined;
		for (const previousPackageName of previousPackageNames) {
			if (previousPackageName !== packageName) {
				const removed = await this.#removeRuntimePlugin(scope, previousPackageName);
				carried ??= removed;
			}
		}
		await this.#registerRuntimePlugin(
			scope,
			packageName,
			cachePath,
			version,
			wasDisabled ? false : undefined,
			carried,
		);

		// The other scope shares the replaced cache: migrate its link and lockfile key to the new
		// runtime name so it does not resolve the new content under the stale name.
		for (const entry of otherScopeEntries) {
			if (entry.installPath !== cachePath) continue;
			const oldName = otherScopeOldNames.get(entry.installPath);
			if (oldName === undefined || oldName === packageName) continue;
			const removed = await this.#removeRuntimePlugin(otherScope, oldName);
			await this.#registerRuntimePlugin(
				otherScope,
				packageName,
				cachePath,
				entry.version,
				entry.enabled === false ? false : undefined,
				removed,
			);
		}

		this.#clearCache();

		logger.debug("Plugin installed", { pluginId, version, cachePath });
		return installedEntry;
	}

	async #validateEmbeddedDapPath(entry: MarketplacePluginEntry, sourcePath: string | undefined): Promise<void> {
		const value = entry.dapAdapters;
		if (!sourcePath || typeof value !== "string" || value.length === 0) return;
		const resolved = path.resolve(sourcePath, value);
		if (!pathIsWithin(sourcePath, resolved)) {
			throw new Error(`Plugin "${entry.name}" dapAdapters path escapes the plugin directory`);
		}
		try {
			if (!(await fs.stat(resolved)).isFile()) throw new Error("not a file");
		} catch {
			throw new Error(`Plugin "${entry.name}" dapAdapters file does not exist`);
		}
	}

	async #writeEmbeddedDapConfig(entry: MarketplacePluginEntry, cachePath: string): Promise<void> {
		const dapAdapters = entry.dapAdapters;
		if (!dapAdapters) return;

		if (typeof dapAdapters === "string") {
			const sourcePath = path.resolve(cachePath, dapAdapters);
			if (!pathIsWithin(cachePath, sourcePath)) {
				throw new Error(`Plugin "${entry.name}" dapAdapters path escapes the plugin directory`);
			}
			const extension = path.extname(sourcePath).toLowerCase();
			const targetFilename = extension === ".yaml" || extension === ".yml" ? `.dap${extension}` : ".dap.json";
			const targetPath = path.join(cachePath, targetFilename);
			const content = await Bun.file(sourcePath).text();
			await Bun.write(targetPath, content);
			return;
		}

		const targetPath = path.join(cachePath, ".dap.json");
		await Bun.write(targetPath, `${JSON.stringify({ adapters: dapAdapters }, null, 2)}\n`);
	}

	async #resolveCatalogVersion(
		entry: MarketplacePluginEntry,
		pluginDir: string | undefined,
	): Promise<string | undefined> {
		if (typeof entry.source !== "string" && entry.version) return entry.version;
		if (!pluginDir) return undefined;
		const readVersion = async (file: string): Promise<string | undefined> => {
			try {
				const content = await Bun.file(path.join(pluginDir, file)).json();
				return typeof content?.version === "string" && content.version ? content.version : undefined;
			} catch {
				// Missing or invalid — try next source
				return undefined;
			}
		};

		const manifestVersion =
			(await readVersion(path.join(".claude-plugin", "plugin.json"))) ?? (await readVersion("plugin.json"));
		if (manifestVersion) return manifestVersion;
		if (entry.version) return entry.version;
		const packageVersion = await readVersion("package.json");
		if (packageVersion) return packageVersion;
		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha) {
			return entry.source.sha.slice(0, 7);
		}
		return undefined;
	}

	async uninstallPlugin(pluginId: string, scope?: "user" | "project", options?: { dryRun?: boolean }): Promise<void> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID format: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);
		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to remove.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const targetEntries = targetScope === "project" ? projectEntries! : userEntries!;
		const targetReg = targetScope === "project" ? projectReg : userReg;
		const registryPath = this.#registryPath(targetScope);
		const packageNames = await this.#resolveInstalledPackageNames(targetEntries, parsed.name);

		if (options?.dryRun) {
			return;
		}

		const updatedReg = removeInstalledPlugin(targetReg, pluginId);
		await writeInstalledPluginsRegistry(registryPath, updatedReg);

		await this.#removeUnreferencedCachePaths(targetEntries.map(entry => entry.installPath));

		for (const packageName of packageNames) {
			await this.#removeRuntimePlugin(targetScope, packageName);
		}

		this.#clearCache();

		logger.debug("Plugin uninstalled", { pluginId, scope: targetScope });
	}

	async listInstalledPlugins(): Promise<InstalledPluginSummary[]> {
		const userReg = await readInstalledPluginsRegistry(this.#opts.installedRegistryPath);
		const projectReg = this.#opts.projectInstalledRegistryPath
			? await readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
			: null;

		const activeProjectIds = new Set(
			projectReg
				? Object.entries(projectReg.plugins)
						.filter(([, entries]) => entries.length > 0 && entries[0].enabled !== false)
						.map(([id]) => id)
				: [],
		);
		const results: InstalledPluginSummary[] = [];

		if (projectReg) {
			for (const [id, entries] of Object.entries(projectReg.plugins)) {
				results.push({ id, scope: "project", entries });
			}
		}

		for (const [id, entries] of Object.entries(userReg.plugins)) {
			results.push({
				id,
				scope: "user",
				entries,
				...(activeProjectIds.has(id) ? { shadowedBy: "project" as const } : {}),
			});
		}
		return results;
	}

	async setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to modify.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const reg = targetScope === "project" ? projectReg : userReg;
		const entries = targetScope === "project" ? projectEntries! : userEntries!;
		const registryPath = this.#registryPath(targetScope);

		const updated = {
			...reg,
			plugins: {
				...reg.plugins,
				[pluginId]: entries.map(e => ({ ...e, enabled })),
			},
		};
		await writeInstalledPluginsRegistry(registryPath, updated);

		const fallbackName = parsePluginId(pluginId)?.name ?? pluginId;
		const packageNames = await this.#resolveInstalledPackageNames(entries, fallbackName);
		for (const packageName of packageNames) {
			await this.#setRuntimePluginEnabled(targetScope, packageName, enabled);
		}

		this.#clearCache();

		logger.debug("Plugin enabled state changed", { pluginId, enabled, scope: targetScope });
	}

	async refreshStaleMarketplaces(): Promise<void> {
		await pruneAbandonedMarketplaceClones(this.#opts.marketplacesCacheDir);
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const staleMs = 24 * 60 * 60 * 1000;
		for (const entry of reg.marketplaces) {
			if (Date.now() - Date.parse(entry.updatedAt) >= staleMs) {
				try {
					await this.updateMarketplace(entry.name);
				} catch {}
			}
		}
	}

	async checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>> {
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const row of await this.listCatalogVersions()) {
			const { to } = row;
			if (to && row.declared && classifyVersionChange(row.from, to) === "upgrade") {
				updates.push({ pluginId: row.pluginId, scope: row.scope, from: row.from, to });
			}
		}
		return updates;
	}

	// Every installed (pluginId, scope) pair whose marketplace catalog still lists the plugin, with the
	// installed version and the version a reinstall would record now. A local source that declares no
	// version gets `installPlugin`'s "0.0.0" fallback, and `declared` is false for that row; `to` is
	// undefined only for a remote source with no catalog version (known only after cloning). Same,
	// older and newer versions all appear; reads only the registries, cached catalogs and local
	// manifests.
	async listCatalogVersions(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string | undefined; declared: boolean }>
	> {
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const rows: Array<{
			pluginId: string;
			scope: "user" | "project";
			from: string;
			to: string | undefined;
			declared: boolean;
		}> = [];

		// Keyed by (path, scope) so each scope is checked independently.
		// A plugin current in user scope but stale in project scope must still appear.
		const registryEntries: Array<[string, "user" | "project"]> = [[this.#opts.installedRegistryPath, "user"]];
		if (this.#opts.projectInstalledRegistryPath) {
			registryEntries.push([this.#opts.projectInstalledRegistryPath, "project"]);
		}

		for (const [regPath, scope] of registryEntries) {
			const instReg = await readInstalledPluginsRegistry(regPath);
			for (const [pluginId, entries] of Object.entries(instReg.plugins)) {
				const parsed = parsePluginId(pluginId);
				if (!parsed) continue;
				const installed = entries[0];
				if (!installed) continue;

				const mktEntry = mktReg.marketplaces.find(m => m.name === parsed.marketplace);
				if (!mktEntry) continue;

				let catalogVersion: string | undefined;
				let declared = false;
				try {
					const catalog = await this.#readCatalog(mktEntry);
					const pluginEntry = catalog.plugins.find(p => p.name === parsed.name);
					if (!pluginEntry) continue;
					// Relative sources resolve into the marketplace clone, whose manifests
					// `updateMarketplace` refreshes; remote sources yield no local dir.
					const pluginDir = await validatePluginSource(pluginEntry, {
						marketplaceClonePath: this.#resolveMarketplaceRoot(mktEntry),
						catalogMetadata: catalog.metadata,
					});
					const resolved = await this.#resolveCatalogVersion(pluginEntry, pluginDir);
					declared = resolved !== undefined;
					catalogVersion = resolved ?? (pluginDir ? "0.0.0" : undefined);
				} catch {
					continue;
				}

				rows.push({ pluginId, scope, from: installed.version, to: catalogVersion, declared });
			}
		}

		return rows;
	}

	// Re-install a specific plugin at the latest catalog version (force-overwrites).
	async upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry> {
		const { name, marketplace, scopes } = await this.#resolveUpgradeScopes(pluginId, scope, { across: false });
		return this.installPlugin(name, marketplace, { force: true, scope: scopes[0] });
	}

	// Upgrade a plugin across all scopes where it is installed.
	// Returns one entry per scope upgraded (0–2 entries).
	async upgradePluginAcrossScopes(pluginId: string): Promise<InstalledPluginEntry[]> {
		const { name, marketplace, scopes } = await this.#resolveUpgradeScopes(pluginId, undefined, { across: true });
		const results: InstalledPluginEntry[] = [];
		for (const target of scopes) {
			results.push(await this.installPlugin(name, marketplace, { force: true, scope: target }));
		}
		return results;
	}

	// What `upgradePlugin(pluginId, scope)` (scope given) or `upgradePluginAcrossScopes(pluginId)`
	// (no scope) would reinstall, one row per scope in the same order, without changing anything.
	// Throws the errors the real upgrade would throw before it writes. `to` is undefined only when a
	// remote source declares no catalog version (known only after fetching the source).
	async previewUpgradePlugin(
		pluginId: string,
		scope?: "user" | "project",
	): Promise<
		Array<{ scope: "user" | "project"; from: string | undefined; to: string | undefined; change?: VersionChange }>
	> {
		const { name, marketplace, scopes } = await this.#resolveUpgradeScopes(pluginId, scope, { across: !scope });
		const versions = await this.listCatalogVersions();
		const rows: Array<{
			scope: "user" | "project";
			from: string | undefined;
			to: string | undefined;
			change?: VersionChange;
		}> = [];
		for (const target of scopes) {
			await this.validateInstallPlugin(name, marketplace, { force: true, scope: target });
			const row = versions.find(v => v.pluginId === pluginId && v.scope === target);
			const change = row?.to ? classifyVersionChange(row.from, row.to) : undefined;
			rows.push({ scope: target, from: row?.from, to: row?.to, change });
		}
		return rows;
	}

	// The scopes an upgrade of `pluginId` reinstalls. `across`: every installed scope, project first.
	// Otherwise exactly one: `scope` if given, else the only installed scope.
	async #resolveUpgradeScopes(
		pluginId: string,
		scope: "user" | "project" | undefined,
		opts: { across: boolean },
	): Promise<{ name: string; marketplace: string; scopes: Array<"user" | "project"> }> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let scopes: Array<"user" | "project">;
		if (opts.across) {
			scopes = [];
			if (inProject) scopes.push("project");
			if (inUser) scopes.push("user");
		} else if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to upgrade.`,
				);
			}
			scopes = [scope];
		} else if (inProject) {
			if (scope === "user") throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			scopes = ["project"];
		} else {
			if (scope === "project") throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			scopes = ["user"];
		}

		return { name: parsed.name, marketplace: parsed.marketplace, scopes };
	}

	// Upgrade every (pluginId, scope) pair that checkForUpdates reports as outdated.
	// Only stale scopes are touched; a current user install is not re-installed when only
	// the project scope is stale. Per-entry failures are skipped — partial success is returned.
	async upgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const updates = await this.checkForUpdates();
		const results: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of updates) {
			try {
				const entry = await this.upgradePlugin(update.pluginId, update.scope);
				results.push({ pluginId: update.pluginId, scope: update.scope, from: update.from, to: entry.version });
			} catch {
				// Skip this entry; partial upgrades are better than none.
			}
		}
		return results;
	}

	// What `upgradeAllPlugins()` would reinstall, without changing anything. A row whose install the
	// current state already refuses (a runtime package name another plugin owns, a version unsafe as
	// a cache path) is left out, because the real run skips it too.
	async previewUpgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const rows: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of await this.checkForUpdates()) {
			const parsed = parsePluginId(update.pluginId);
			if (!parsed) continue;
			try {
				await this.validateInstallPlugin(parsed.name, parsed.marketplace, { force: true, scope: update.scope });
			} catch {
				continue;
			}
			rows.push(update);
		}
		return rows;
	}

	#runtimeRoot(scope: "user" | "project"): string {
		return path.dirname(this.#registryPath(scope));
	}

	#nodeModulesPath(scope: "user" | "project"): string {
		return path.join(this.#runtimeRoot(scope), "node_modules");
	}

	#runtimeLockPath(scope: "user" | "project"): string {
		return path.join(this.#runtimeRoot(scope), "proto-plugins.lock.json");
	}

	async #loadRuntimeConfig(scope: "user" | "project"): Promise<PluginRuntimeConfig> {
		try {
			return normalizePluginRuntimeConfig(await Bun.file(this.#runtimeLockPath(scope)).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn("Failed to load marketplace plugin runtime config", {
				path: this.#runtimeLockPath(scope),
				error: String(err),
			});
			return normalizePluginRuntimeConfig({});
		}
	}

	async #writeRuntimeConfig(scope: "user" | "project", config: PluginRuntimeConfig): Promise<void> {
		await writePluginRuntimeConfig(this.#runtimeLockPath(scope), config);
	}

	async #resolvePluginPackageName(installPath: string, fallbackName: string): Promise<string> {
		try {
			const pkg: { name?: unknown } = await Bun.file(path.join(installPath, "package.json")).json();
			const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : fallbackName;
			return assertRuntimePackageName(name);
		} catch (err) {
			if (isEnoent(err)) return assertRuntimePackageName(fallbackName);
			throw err;
		}
	}

	#runtimePackagePath(scope: "user" | "project", packageName: string): string {
		const nodeModules = path.resolve(this.#nodeModulesPath(scope));
		const linkPath = path.resolve(nodeModules, assertRuntimePackageName(packageName));
		const relative = path.relative(nodeModules, linkPath);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Marketplace plugin package path escapes node_modules: ${JSON.stringify(packageName)}`);
		}
		return linkPath;
	}

	// A different plugin id whose cache path differs only by case is the same directory on
	// case-insensitive filesystems; cachePlugin would clobber it under its live registry entry.
	#assertCachePathAvailable(
		cachePath: string,
		pluginId: string,
		registries: readonly InstalledPluginsRegistry[],
	): void {
		const key = cachePath.toLowerCase();
		for (const registry of registries) {
			for (const installedPluginId in registry.plugins) {
				if (installedPluginId === pluginId) continue;
				for (const entry of registry.plugins[installedPluginId]) {
					if (entry.installPath.toLowerCase() === key) {
						throw new Error(
							`Plugin cache path for "${pluginId}" case-collides with installed plugin "${installedPluginId}" ` +
								`on case-insensitive filesystems. Uninstall "${installedPluginId}" first.`,
						);
					}
				}
			}
		}
	}

	// Registering links node_modules/<packageName>; a case-insensitive filesystem would clobber
	// another plugin's link whose name differs only by case.
	async #assertRuntimePackageNameAvailable(
		scope: "user" | "project",
		packageName: string,
		registry: InstalledPluginsRegistry,
		pluginId: string,
		targetScopeOwnNames: ReadonlySet<string>,
	): Promise<void> {
		const key = packageName.toLowerCase();

		for (const installedPluginId in registry.plugins) {
			if (installedPluginId === pluginId) continue;
			const fallbackName = parsePluginId(installedPluginId)?.name ?? installedPluginId;
			const installedNames = await this.#resolveInstalledPackageNames(
				registry.plugins[installedPluginId],
				fallbackName,
			);
			for (const installedName of installedNames) {
				if (installedName.toLowerCase() === key) {
					throw new Error(
						`Runtime package name "${packageName}" conflicts with installed plugin "${installedPluginId}"`,
					);
				}
			}
		}

		// Names this plugin id already owns in the target scope (including a case-only rename of
		// its own key) are not collisions; the other scope has its own node_modules tree.
		const owned = new Set<string>();
		for (const ownName of targetScopeOwnNames) owned.add(ownName.toLowerCase());

		// npm dependencies and linked plugins (lockfile entries) share the same node_modules tree.
		const runtimeNames = await this.#readRuntimeDependencyNames(scope);
		const config = await this.#loadRuntimeConfig(scope);
		for (const configuredName in config.plugins) runtimeNames.add(configuredName);
		for (const runtimeName of runtimeNames) {
			const runtimeKey = runtimeName.toLowerCase();
			if (runtimeKey === key && !owned.has(runtimeKey)) {
				throw new Error(`Runtime package name "${packageName}" conflicts with installed package "${runtimeName}"`);
			}
		}
	}

	async #readRuntimeDependencyNames(scope: "user" | "project"): Promise<Set<string>> {
		const names = new Set<string>();
		try {
			const pkg: { dependencies?: Record<string, unknown> } = await Bun.file(
				path.join(this.#runtimeRoot(scope), "package.json"),
			).json();
			if (pkg.dependencies && typeof pkg.dependencies === "object") {
				for (const dep in pkg.dependencies) names.add(dep);
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return names;
	}

	async #resolveInstalledPackageNames(
		entries: readonly InstalledPluginEntry[],
		fallbackName: string,
	): Promise<Set<string>> {
		const packageNames = new Set<string>();
		for (const entry of entries) {
			packageNames.add(await this.#resolvePluginPackageName(entry.installPath, fallbackName));
		}
		return packageNames;
	}

	async #registerRuntimePlugin(
		scope: "user" | "project",
		packageName: string,
		cachePath: string,
		version: string,
		enabled: boolean | undefined,
		carry?: RemovedRuntimeState,
	): Promise<void> {
		const linkPath = this.#runtimePackagePath(scope, packageName);
		await fs.mkdir(path.dirname(linkPath), { recursive: true });
		await fs.rm(linkPath, { recursive: true, force: true });
		await fs.symlink(cachePath, linkPath, "dir");

		const config = await this.#loadRuntimeConfig(scope);
		const previous = config.plugins[packageName];
		config.plugins[packageName] = {
			version,
			enabledFeatures: previous?.enabledFeatures ?? carry?.state?.enabledFeatures ?? null,
			enabled: enabled ?? previous?.enabled ?? carry?.state?.enabled ?? true,
		};
		if (carry?.settings !== undefined && config.settings[packageName] === undefined) {
			config.settings[packageName] = carry.settings;
		}
		await this.#writeRuntimeConfig(scope, config);
	}

	async #removeRuntimePlugin(scope: "user" | "project", packageName: string): Promise<RemovedRuntimeState> {
		await fs.rm(this.#runtimePackagePath(scope, packageName), { recursive: true, force: true });

		const config = await this.#loadRuntimeConfig(scope);
		const state = config.plugins[packageName];
		const settings = config.settings[packageName];
		delete config.plugins[packageName];
		delete config.settings[packageName];
		await this.#writeRuntimeConfig(scope, config);
		return { state, settings };
	}

	async #setRuntimePluginEnabled(scope: "user" | "project", packageName: string, enabled: boolean): Promise<void> {
		const config = await this.#loadRuntimeConfig(scope);
		const previous = config.plugins[packageName];
		if (!previous) return;

		config.plugins[packageName] = { ...previous, enabled };
		await this.#writeRuntimeConfig(scope, config);
	}

	async #trackProjectRegistry(): Promise<void> {
		const indexPath = getProjectRegistriesIndexPath(this.#opts.installedRegistryPath);
		try {
			const registryPath = path.resolve(this.#registryPath("project"));
			const indexed = await readProjectRegistriesIndex(indexPath);
			if (!indexed.includes(registryPath)) await writeProjectRegistriesIndex(indexPath, [...indexed, registryPath]);
		} catch (error) {
			// Keep a damaged index intact: cleanup will conservatively retain every cache directory.
			logger.warn("Could not update project plugin registry index", { path: indexPath, error });
		}
	}

	async #removeUnreferencedCachePaths(candidates: readonly string[]): Promise<void> {
		const indexPath = getProjectRegistriesIndexPath(this.#opts.installedRegistryPath);
		try {
			const indexed = await readProjectRegistriesIndex(indexPath);
			const projectPaths = new Set(indexed);
			if (this.#opts.projectInstalledRegistryPath)
				projectPaths.add(path.resolve(this.#opts.projectInstalledRegistryPath));
			projectPaths.delete(path.resolve(this.#opts.installedRegistryPath));
			const registries = [await readInstalledPluginsRegistry(this.#opts.installedRegistryPath, { strict: true })];
			const live: string[] = [];
			for (const registryPath of projectPaths) {
				const registry = await readInstalledPluginsRegistry(registryPath, { strict: true });
				if (Object.keys(registry.plugins).length === 0) continue;
				registries.push(registry);
				live.push(registryPath);
			}
			if (live.length !== indexed.length || live.some((entry, index) => entry !== indexed[index])) {
				await writeProjectRegistriesIndex(indexPath, live);
			}
			const referenced = collectReferencedPaths(...registries);
			for (const candidate of candidates) {
				if (!referenced.has(candidate)) await this.#removeCachedInstallPath(candidate);
			}
		} catch (error) {
			// A leaked cache directory is preferable to breaking another project's plugin link.
			logger.warn("Unreadable plugin registry; keeping cached plugins", { path: indexPath, error });
		}
	}

	#registryPath(scope: "user" | "project"): string {
		if (scope === "project") {
			if (!this.#opts.projectInstalledRegistryPath) {
				throw new Error("project-scoped install requires running inside a project directory");
			}
			return this.#opts.projectInstalledRegistryPath;
		}
		return this.#opts.installedRegistryPath;
	}

	async #findInBothRegistries(pluginId: string): Promise<{
		userEntries: InstalledPluginEntry[] | undefined;
		projectEntries: InstalledPluginEntry[] | undefined;
		userReg: InstalledPluginsRegistry;
		projectReg: InstalledPluginsRegistry;
	}> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		return {
			userEntries: getInstalledPlugin(userReg, pluginId),
			projectEntries: getInstalledPlugin(projectReg, pluginId),
			userReg,
			projectReg,
		};
	}

	async #readCatalog(entry: MarketplaceRegistryEntry): Promise<MarketplaceCatalog> {
		const catalogPath = path.resolve(expandTilde(entry.catalogPath));
		try {
			const content = await Bun.file(catalogPath).text();
			return parseMarketplaceCatalog(content, catalogPath);
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Marketplace catalog not found at ${catalogPath}. Try: /marketplace update ${entry.name}`);
			}
			throw err;
		}
	}

	#resolveMarketplaceRoot(entry: MarketplaceRegistryEntry): string {
		if (entry.sourceType === "local") {
			return path.resolve(expandTilde(entry.sourceUri));
		}

		return path.dirname(path.resolve(expandTilde(entry.catalogPath)));
	}
}
