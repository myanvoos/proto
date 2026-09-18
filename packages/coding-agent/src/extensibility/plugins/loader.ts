import * as fs from "node:fs";
import * as path from "node:path";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { getPluginsDir, getPluginsLockfile, hasFsCode, isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "../../config";
import { registerPluginCacheInvalidator, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { normalizePluginRuntimeConfig } from "./runtime-config";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

interface ScopedInstalledPlugin extends InstalledPlugin {
	scope: "user" | "project";
}

const enabledPluginsCache = new Map<string, Promise<ScopedInstalledPlugin[]>>();

function enabledPluginsCacheKey(cwd: string, home?: string): string {
	return `${path.resolve(cwd)}\0${home === undefined ? "" : path.resolve(home)}`;
}

function clearEnabledPluginsCache(): void {
	enabledPluginsCache.clear();
}

registerPluginCacheInvalidator(clearEnabledPluginsCache);

const projectPluginOverridesSchema = type({
	"disabled?": "string[]",
	"features?": { "[string]": "string[]" },
	"settings?": { "[string]": { "[string]": "unknown" } },
});

export async function readProjectPluginOverrides(overridesPath: string): Promise<ProjectPluginOverrides | null> {
	let raw: unknown;
	try {
		raw = await Bun.file(overridesPath).json();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw new Error(`Failed to load project plugin overrides at ${overridesPath}`, { cause: err });
	}

	const checked = projectPluginOverridesSchema(raw);
	if (checked instanceof OmpErrors) {
		throw new Error(`Invalid project plugin overrides at ${overridesPath}: ${checked.summary}`);
	}
	return checked;
}

async function loadRuntimeConfig(home?: string): Promise<PluginRuntimeConfig> {
	const lockPath = getPluginsLockfile(home);
	try {
		return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
	} catch (err) {
		if (isEnoent(err)) return normalizePluginRuntimeConfig({});
		throw err;
	}
}

async function loadProjectOverrides(cwd: string): Promise<ProjectPluginOverrides> {
	for (const overridesPath of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		const overrides = await readProjectPluginOverrides(overridesPath);
		if (overrides) return overrides;
	}
	return {};
}

async function collectPluginsAtRoot(
	root: string,
	projectOverrides: ProjectPluginOverrides,
	scope: ScopedInstalledPlugin["scope"],
): Promise<ScopedInstalledPlugin[]> {
	const nodeModulesPath = path.join(root, "node_modules");
	if (!fs.existsSync(nodeModulesPath)) return [];

	let depsKeys: string[] = [];
	const pkgJsonPath = path.join(root, "package.json");
	try {
		const pkg: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
		depsKeys = Object.keys(pkg.dependencies ?? {});
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	const lockPath = path.join(root, "proto-plugins.lock.json");
	let runtimeConfig: PluginRuntimeConfig;
	try {
		runtimeConfig = normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
	} catch (err) {
		if (!isEnoent(err)) throw err;
		runtimeConfig = normalizePluginRuntimeConfig({});
	}

	const names = new Set<string>(depsKeys);
	for (const name of Object.keys(runtimeConfig.plugins ?? {})) {
		names.add(name);
	}

	const plugins: ScopedInstalledPlugin[] = [];
	for (const name of names) {
		const pluginPkgPath = path.join(nodeModulesPath, name, "package.json");
		let pluginPkg: { version: string; proto?: PluginManifest; pi?: PluginManifest };
		try {
			pluginPkg = await Bun.file(pluginPkgPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}

		const manifest: PluginManifest | undefined = pluginPkg.proto || pluginPkg.pi;
		if (!manifest) {
			continue;
		}
		manifest.version = pluginPkg.version;

		const runtimeState = runtimeConfig.plugins[name];

		if (runtimeState && !runtimeState.enabled) {
			continue;
		}

		if (projectOverrides.disabled?.includes(name)) {
			continue;
		}

		const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;
		plugins.push({
			name,
			version: pluginPkg.version,
			path: path.join(nodeModulesPath, name),
			scope,
			manifest,
			enabledFeatures,
			enabled: true,
		});
	}

	return plugins;
}

export async function getEnabledPlugins(cwd: string, opts: { home?: string } = {}): Promise<ScopedInstalledPlugin[]> {
	const { home } = opts;
	const cacheKey = enabledPluginsCacheKey(cwd, home);
	const cached = enabledPluginsCache.get(cacheKey);
	if (cached) return cached;

	const loadPromise = loadEnabledPlugins(cwd, home);
	enabledPluginsCache.set(cacheKey, loadPromise);
	try {
		return await loadPromise;
	} catch (err) {
		if (enabledPluginsCache.get(cacheKey) === loadPromise) {
			enabledPluginsCache.delete(cacheKey);
		}
		throw err;
	}
}

async function loadEnabledPlugins(cwd: string, home?: string): Promise<ScopedInstalledPlugin[]> {
	const projectOverrides = await loadProjectOverrides(cwd);

	const userRoot = getPluginsDir(home);
	const userPlugins = await collectPluginsAtRoot(userRoot, projectOverrides, "user");

	let projectPlugins: ScopedInstalledPlugin[] = [];
	const projectRegistryPath = await resolveActiveProjectRegistryPath(cwd);
	if (projectRegistryPath) {
		const projectRoot = path.dirname(projectRegistryPath);
		if (projectRoot !== userRoot) {
			projectPlugins = await collectPluginsAtRoot(projectRoot, projectOverrides, "project");
		}
	}

	if (projectPlugins.length === 0) return userPlugins;
	if (userPlugins.length === 0) return projectPlugins;

	const merged = new Map<string, ScopedInstalledPlugin>();
	for (const plugin of userPlugins) merged.set(plugin.name, plugin);
	for (const plugin of projectPlugins) merged.set(plugin.name, plugin);
	return Array.from(merged.values());
}

const MANIFEST_ENTRY_MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];
const MANIFEST_ENTRY_INDEX_NAMES = MANIFEST_ENTRY_MODULE_EXTENSIONS.map(ext => `index${ext}`);

const DECLARATION_FILE_RE = /\.d\.[mc]?ts$/;

function isModuleFile(name: string): boolean {
	return MANIFEST_ENTRY_MODULE_EXTENSIONS.includes(path.extname(name)) && !DECLARATION_FILE_RE.test(name);
}

function realpathFromExistingParentSync(candidate: string): string | null {
	let current = path.resolve(candidate);
	const unresolved: string[] = [];
	while (true) {
		try {
			return path.resolve(fs.realpathSync(current), ...unresolved.reverse());
		} catch (err) {
			if (!isEnoent(err) && !hasFsCode(err, "ENOTDIR")) return null;
			const parent = path.dirname(current);
			if (parent === current) return null;
			unresolved.push(path.basename(current));
			current = parent;
		}
	}
}

function resolveContainedManifestPathSync(packageRootRealpath: string, candidate: string): string | null {
	const candidateRealpath = realpathFromExistingParentSync(candidate);
	if (
		candidateRealpath === null ||
		candidateRealpath === packageRootRealpath ||
		!pathIsWithin(packageRootRealpath, candidateRealpath)
	) {
		return null;
	}
	return candidateRealpath;
}

function findDirectoryIndex(packageRootRealpath: string, dir: string): string | null {
	for (const name of MANIFEST_ENTRY_INDEX_NAMES) {
		const candidate = resolveContainedManifestPathSync(packageRootRealpath, path.join(dir, name));
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	return null;
}

interface DeclaredManifestEntries {
	declared: boolean;

	files: string[];
}

function readDeclaredManifestEntries(packageRootRealpath: string, dir: string): DeclaredManifestEntries {
	const packageJsonPath = resolveContainedManifestPathSync(packageRootRealpath, path.join(dir, "package.json"));
	if (!packageJsonPath) return { declared: false, files: [] };

	let raw: string;
	try {
		raw = fs.readFileSync(packageJsonPath, "utf8");
	} catch {
		return { declared: false, files: [] };
	}
	let pkg: { proto?: { extensions?: unknown }; pi?: { extensions?: unknown } };
	try {
		pkg = JSON.parse(raw) as { proto?: { extensions?: unknown }; pi?: { extensions?: unknown } };
	} catch {
		return { declared: false, files: [] };
	}
	const declared = (pkg.proto ?? pkg.pi)?.extensions;
	if (!Array.isArray(declared) || declared.length === 0) {
		return { declared: false, files: [] };
	}
	const files: string[] = [];
	for (const entry of declared) {
		if (typeof entry !== "string") continue;
		const candidate = resolveContainedManifestPathSync(packageRootRealpath, path.resolve(dir, entry));
		if (!candidate) continue;
		let candidateStats: fs.Stats;
		try {
			candidateStats = fs.statSync(candidate);
		} catch {
			continue;
		}
		if (candidateStats.isDirectory()) {
			const index = findDirectoryIndex(packageRootRealpath, candidate);
			if (index) files.push(index);
		} else {
			files.push(candidate);
		}
	}
	return { declared: true, files };
}

function resolveDirectoryEntries(packageRootRealpath: string, dir: string): string[] {
	const manifest = readDeclaredManifestEntries(packageRootRealpath, dir);
	if (manifest.declared) return manifest.files;

	const directIndex = findDirectoryIndex(packageRootRealpath, dir);
	if (directIndex) return [directIndex];

	let children: string[];
	try {
		children = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const resolved: string[] = [];
	for (const child of children.sort()) {
		const childPath = resolveContainedManifestPathSync(packageRootRealpath, path.join(dir, child));
		if (!childPath) continue;
		let childStats: fs.Stats;
		try {
			childStats = fs.statSync(childPath);
		} catch {
			continue;
		}
		if (childStats.isDirectory()) {
			const childManifest = readDeclaredManifestEntries(packageRootRealpath, childPath);
			if (childManifest.declared) {
				resolved.push(...childManifest.files);
			} else {
				const index = findDirectoryIndex(packageRootRealpath, childPath);
				if (index) resolved.push(index);
			}
		} else if (isModuleFile(child)) {
			resolved.push(childPath);
		}
	}
	return resolved;
}

function resolveManifestEntryFiles(packageRoot: string, joined: string, expandDirectory: boolean): string[] {
	let packageRootRealpath: string;
	try {
		packageRootRealpath = fs.realpathSync(packageRoot);
	} catch {
		return [];
	}
	const containedPath = resolveContainedManifestPathSync(packageRootRealpath, joined);
	if (!containedPath) return [];

	let stats: fs.Stats;
	try {
		stats = fs.statSync(containedPath);
	} catch {
		return [];
	}
	if (!stats.isDirectory()) {
		return [containedPath];
	}
	if (expandDirectory) {
		return resolveDirectoryEntries(packageRootRealpath, containedPath);
	}
	const index = findDirectoryIndex(packageRootRealpath, containedPath);
	return index ? [index] : [];
}

function resolvePluginPaths(plugin: InstalledPlugin, key: "tools" | "hooks" | "commands" | "extensions"): string[] {
	const resolved: string[] = [];
	for (const entry of resolvePluginManifestEntries(plugin, key)) {
		if (entry.resolvedPath) {
			resolved.push(entry.resolvedPath);
		}
	}
	return resolved;
}

export function resolvePluginManifestEntries(
	plugin: InstalledPlugin,
	key: "tools" | "hooks" | "commands" | "extensions",
): Array<{ entry: string; resolvedPath: string | null }> {
	const declared: Array<{ entry: string; resolvedPath: string | null }> = [];
	const manifest = plugin.manifest;

	const expandDirectory = key === "extensions";
	const resolveEntry = (entry: string): Array<{ entry: string; resolvedPath: string | null }> => {
		const files = resolveManifestEntryFiles(plugin.path, path.join(plugin.path, entry), expandDirectory);
		return files.length > 0 ? files.map(resolvedPath => ({ entry, resolvedPath })) : [{ entry, resolvedPath: null }];
	};

	const base = manifest[key];
	if (base) {
		const entries = Array.isArray(base) ? base : [base];
		for (const entry of entries) {
			declared.push(...resolveEntry(entry));
		}
	}

	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);
		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;
			if (feat[key]) {
				for (const entry of feat[key]) {
					declared.push(...resolveEntry(entry));
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;
			if (feat[key]) {
				for (const entry of feat[key]) {
					declared.push(...resolveEntry(entry));
				}
			}
		}
	}

	return declared;
}

export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "tools");
}

export function resolvePluginExtensionPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "extensions");
}

export async function getAllPluginToolPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

export async function getAllPluginExtensionPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginExtensionPaths(plugin));
	}

	return paths;
}

export async function getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
