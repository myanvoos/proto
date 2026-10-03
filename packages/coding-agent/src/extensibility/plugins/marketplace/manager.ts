import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEnoent, logger, pathIsWithin } from "@oh-my-pi/pi-utils";
import { expandTilde } from "../../../tools/path-utils";
import { normalizePluginRuntimeConfig } from "../runtime-config";
import type { PluginRuntimeConfig, PluginRuntimeState } from "../types";

import { cachePlugin, getCachedPluginPath, isValidVersionForCache } from "./cache";
import { classifySource, fetchMarketplace, parseMarketplaceCatalog, promoteCloneToCache } from "./fetcher";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	assertMarketplaceNameAvailable,
	collectReferencedPaths,
	getInstalledPlugin,
	getMarketplaceEntry,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
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

		return { scope, registryPath, marketplaceClonePath, catalog, pluginEntry, pluginId, existing };
	}

	async validateInstallPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<void> {
		await this.#validateInstall(name, marketplace, options);
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

			version = await this.#resolvePluginVersion(pluginEntry, sourcePath);
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

		if (existing && existing.length > 0) {
			const prunedReg = removeInstalledPlugin(await readInstalledPluginsRegistry(registryPath), pluginId);
			await writeInstalledPluginsRegistry(registryPath, prunedReg);

			const [userReg, projectReg] = await Promise.all([
				readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
				this.#opts.projectInstalledRegistryPath
					? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
					: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
			]);
			const referenced = collectReferencedPaths(userReg, projectReg);

			for (const entry of existing) {
				if (entry.installPath !== cachePath && !referenced.has(entry.installPath)) {
					await this.#removeCachedInstallPath(entry.installPath);
				}
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

		const freshInstReg = await readInstalledPluginsRegistry(registryPath);
		const newInstReg = addInstalledPlugin(freshInstReg, pluginId, installedEntry);
		// CHECKLIST(install-atomicity): Persisting the registry before the runtime link/config means a later failure can
		// leave an installed entry that the runtime cannot load. Commit these updates as one rollback-safe transaction.
		await writeInstalledPluginsRegistry(registryPath, newInstReg);

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

	async #resolvePluginVersion(entry: MarketplacePluginEntry, sourcePath: string): Promise<string> {
		if (entry.version) return entry.version;

		for (const manifestPath of [
			path.join(sourcePath, ".claude-plugin", "plugin.json"),
			path.join(sourcePath, "plugin.json"),
			path.join(sourcePath, "package.json"),
		]) {
			try {
				const content = await Bun.file(manifestPath).json();
				if (typeof content?.version === "string" && content.version) {
					return content.version;
				}
			} catch {}
		}

		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha) {
			return entry.source.sha.slice(0, 7);
		}

		return "0.0.0";
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

		const [freshUserReg, freshProjectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(freshUserReg, freshProjectReg);

		for (const entry of targetEntries) {
			if (!referenced.has(entry.installPath)) {
				await this.#removeCachedInstallPath(entry.installPath);
			}
		}

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
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];

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
				try {
					const catalog = await this.#readCatalog(mktEntry);
					catalogVersion = catalog.plugins.find(p => p.name === parsed.name)?.version;
				} catch {
					continue;
				}

				if (!catalogVersion || catalogVersion === installed.version) continue;

				let isNewer: boolean;
				try {
					isNewer = Bun.semver.order(catalogVersion, installed.version) > 0;
				} catch {
					isNewer = catalogVersion !== installed.version;
				}

				if (isNewer) {
					updates.push({ pluginId, scope, from: installed.version, to: catalogVersion });
				}
			}
		}

		return updates;
	}

	async upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry> {
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

		let resolvedScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to upgrade.`,
				);
			}
			resolvedScope = scope;
		} else if (inProject) {
			if (scope === "user") throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			resolvedScope = "project";
		} else {
			if (scope === "project") throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			resolvedScope = "user";
		}

		return this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: resolvedScope });
	}

	async upgradePluginAcrossScopes(pluginId: string): Promise<InstalledPluginEntry[]> {
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

		const results: InstalledPluginEntry[] = [];

		if (inProject) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "project" });
			results.push(entry);
		}
		if (inUser) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "user" });
			results.push(entry);
		}

		return results;
	}

	async upgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const updates = await this.checkForUpdates();
		const results: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of updates) {
			try {
				const entry = await this.upgradePlugin(update.pluginId, update.scope);
				results.push({ pluginId: update.pluginId, scope: update.scope, from: update.from, to: entry.version });
			} catch {}
		}
		return results;
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
		await Bun.write(this.#runtimeLockPath(scope), JSON.stringify(config, null, 2));
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
