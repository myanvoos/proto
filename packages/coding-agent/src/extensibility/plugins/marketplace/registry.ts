import * as path from "node:path";

import { OmpErrors, type } from "@oh-my-pi/omptype";
import { atomicWriteJson, getPluginsDir, isEnoent, logger, tryParseJson } from "@oh-my-pi/pi-utils";

export { getMarketplacesRegistryPath } from "@oh-my-pi/pi-utils";

import type {
	InstalledPluginEntry,
	InstalledPluginsRegistry,
	MarketplaceRegistryEntry,
	MarketplacesRegistry,
} from "./types";

export function getInstalledPluginsRegistryPath(): string {
	return path.join(getPluginsDir(), "installed_plugins.json");
}

export function getMarketplacesCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "marketplaces");
}

export function getPluginsCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "plugins");
}

function emptyMarketplacesRegistry(): MarketplacesRegistry {
	return { version: 1, marketplaces: [] };
}

export async function readMarketplacesRegistry(filePath: string): Promise<MarketplacesRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<MarketplacesRegistry>(content);
		if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.marketplaces)) {
			logger.warn("Invalid marketplaces registry, returning empty", { path: filePath });
			return emptyMarketplacesRegistry();
		}
		return data;
	} catch (err) {
		if (isEnoent(err)) return emptyMarketplacesRegistry();
		throw err;
	}
}

export async function writeMarketplacesRegistry(filePath: string, reg: MarketplacesRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

const installedPluginEntrySchema = type({
	scope: "'user' | 'project'",
	installPath: "string > 0",
	version: "string",
	installedAt: "string",
	lastUpdated: "string",
	"gitCommitSha?": "string",
	"enabled?": "boolean",
});

function emptyInstalledPluginsRegistry(): InstalledPluginsRegistry {
	return { version: 2, plugins: {} };
}

export async function readInstalledPluginsRegistry(filePath: string): Promise<InstalledPluginsRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data: unknown = tryParseJson<unknown>(content);
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			logger.warn("Invalid installed plugins registry, returning empty", { path: filePath });
			return emptyInstalledPluginsRegistry();
		}
		const candidate = data as { version?: unknown; plugins?: unknown };
		if (
			typeof candidate.version !== "number" ||
			!candidate.plugins ||
			typeof candidate.plugins !== "object" ||
			Array.isArray(candidate.plugins)
		) {
			logger.warn("Invalid installed plugins registry, returning empty", { path: filePath });
			return emptyInstalledPluginsRegistry();
		}

		const plugins: Record<string, InstalledPluginEntry[]> = {};
		for (const [pluginId, entries] of Object.entries(candidate.plugins as Record<string, unknown>)) {
			if (!Array.isArray(entries)) {
				logger.warn("Invalid installed plugin registry entries, skipping", {
					path: filePath,
					pluginId,
					error: "expected an array",
				});
				continue;
			}

			const validEntries: InstalledPluginEntry[] = [];
			for (const [index, entry] of entries.entries()) {
				const checked = installedPluginEntrySchema(entry);
				if (checked instanceof OmpErrors) {
					logger.warn("Invalid installed plugin registry entry, skipping", {
						path: filePath,
						pluginId,
						index,
						error: checked.summary,
					});
					continue;
				}
				validEntries.push(checked);
			}
			if (validEntries.length > 0 || entries.length === 0) {
				plugins[pluginId] = validEntries;
			}
		}

		return { version: 2, plugins };
	} catch (err) {
		if (isEnoent(err)) return emptyInstalledPluginsRegistry();
		throw err;
	}
}

export async function writeInstalledPluginsRegistry(filePath: string, reg: InstalledPluginsRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

export function addMarketplaceEntry(reg: MarketplacesRegistry, entry: MarketplaceRegistryEntry): MarketplacesRegistry {
	if (reg.marketplaces.some(m => m.name === entry.name)) {
		throw new Error(`Marketplace "${entry.name}" already exists`);
	}
	return { ...reg, marketplaces: [...reg.marketplaces, entry] };
}

export function removeMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplacesRegistry {
	const filtered = reg.marketplaces.filter(m => m.name !== name);
	if (filtered.length === reg.marketplaces.length) {
		throw new Error(`Marketplace "${name}" not found`);
	}
	return { ...reg, marketplaces: filtered };
}

export function getMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplaceRegistryEntry | undefined {
	return reg.marketplaces.find(m => m.name === name);
}

export function addInstalledPlugin(
	reg: InstalledPluginsRegistry,
	id: string,
	entry: InstalledPluginEntry,
): InstalledPluginsRegistry {
	const existing = reg.plugins[id] ?? [];
	return {
		...reg,
		plugins: { ...reg.plugins, [id]: [...existing, entry] },
	};
}

export function removeInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginsRegistry {
	if (!(id in reg.plugins)) {
		throw new Error(`Plugin "${id}" not found in registry`);
	}
	const { [id]: _, ...rest } = reg.plugins;
	return { ...reg, plugins: rest };
}

export function getInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginEntry[] | undefined {
	return reg.plugins[id];
}

export function collectReferencedPaths(...registries: InstalledPluginsRegistry[]): Set<string> {
	return new Set(
		registries.flatMap(r =>
			Object.values(r.plugins)
				.flat()
				.map(e => e.installPath),
		),
	);
}
