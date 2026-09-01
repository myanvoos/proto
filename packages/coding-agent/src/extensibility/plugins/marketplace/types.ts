const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_ID_LENGTH = 128;

export function isValidNameSegment(s: string): boolean {
	return s.length > 0 && s.length <= MAX_NAME_LENGTH && NAME_RE.test(s);
}

export function buildPluginId(name: string, marketplace: string): string {
	if (!isValidNameSegment(name)) {
		throw new Error(`Invalid plugin name: "${name}"`);
	}
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name: "${marketplace}"`);
	}
	const id = `${name}@${marketplace}`;
	if (id.length > MAX_ID_LENGTH) {
		throw new Error(`Plugin ID exceeds ${MAX_ID_LENGTH} characters: "${id}"`);
	}
	return id;
}

export function parsePluginId(id: string): { name: string; marketplace: string } | null {
	const atIndex = id.lastIndexOf("@");
	if (atIndex <= 0 || atIndex === id.length - 1) return null;

	const name = id.slice(0, atIndex);
	const marketplace = id.slice(atIndex + 1);

	if (!isValidNameSegment(name) || !isValidNameSegment(marketplace)) return null;

	return { name, marketplace };
}

interface MarketplaceCatalogOwner {
	name: string;
	email?: string;
}

export interface MarketplaceCatalogMetadata {
	description?: string;
	version?: string;

	pluginRoot?: string;
}

export interface MarketplaceCatalog {
	name: string;
	owner: MarketplaceCatalogOwner;
	metadata?: MarketplaceCatalogMetadata;
	plugins: MarketplacePluginEntry[];
}

interface MarketplacePluginAuthor {
	name: string;
	email?: string;
}

export interface MarketplacePluginEntry {
	name: string;
	source: PluginSource;
	description?: string;
	version?: string;
	author?: MarketplacePluginAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	strict?: boolean;
	commands?: string | string[];
	agents?: string | string[];
	hooks?: string | Record<string, unknown>;
	mcpServers?: string | Record<string, unknown>;
	dapAdapters?: string | Record<string, unknown>;
}

export type PluginSource = string | PluginSourceGitHub | PluginSourceUrl | PluginSourceGitSubdir | PluginSourceNpm;

interface PluginSourceGitHub {
	source: "github";
	repo: string;
	ref?: string;
	sha?: string;
}

interface PluginSourceUrl {
	source: "url";
	url: string;
	ref?: string;
	sha?: string;
}

interface PluginSourceGitSubdir {
	source: "git-subdir";
	url: string;
	path: string;
	ref?: string;
	sha?: string;
}

interface PluginSourceNpm {
	source: "npm";
	package: string;
	version?: string;
	registry?: string;
}

export interface MarketplacesRegistry {
	version: 1;
	marketplaces: MarketplaceRegistryEntry[];
}

export type MarketplaceSourceType = "github" | "git" | "url" | "local";

export interface MarketplaceRegistryEntry {
	name: string;
	sourceType: MarketplaceSourceType;
	sourceUri: string;
	catalogPath: string;
	addedAt: string;
	updatedAt: string;
}

export interface InstalledPluginsRegistry {
	version: 2;
	plugins: Record<string, InstalledPluginEntry[]>;
}

export interface InstalledPluginEntry {
	scope: "user" | "project";

	installPath: string;
	version: string;

	installedAt: string;

	lastUpdated: string;

	gitCommitSha?: string;

	enabled?: boolean;
}

export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	entries: InstalledPluginEntry[];

	shadowedBy?: "project";
}
