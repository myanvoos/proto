import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getConfigDirName,
	getPluginsDir,
	getProjectDir,
	parseFrontmatter,
	tryParseJson,
} from "@oh-my-pi/pi-utils";
import type { ExtensionModule } from "../capability/extension-module";
import { invalidate as invalidateFsCache, readDirEntries, readFile } from "../capability/fs";
import { parseRuleConditionAndScope, type Rule, type RuleFrontmatter } from "../capability/rule";
import type { Skill, SkillFrontmatter } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { resolveClaudePaths } from "../config/claude-paths";
import type { MCPRequestIdFormat } from "../mcp/types";
import { parseThinkingLevel, type ThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";

import { realpathIfExists, resolveContainedPath } from "./contained-path";
import { buildPluginDirRoot } from "./plugin-dir-roots";

export const SOURCE_PATHS = {
	native: {
		get userBase() {
			return getConfigDirName();
		},
		get userAgent() {
			return `${getConfigDirName()}/agent`;
		},
		projectDir: CONFIG_DIR_NAME,
	},
	claude: {
		userBase: ".claude",
		userAgent: ".claude",
		projectDir: ".claude",
	},
	codex: {
		userBase: ".codex",
		userAgent: ".codex",
		projectDir: ".codex",
	},
	gemini: {
		userBase: ".gemini",
		userAgent: ".gemini",
		projectDir: ".gemini",
	},
	opencode: {
		userBase: ".config/opencode",
		userAgent: ".config/opencode",
		projectDir: ".opencode",
	},
	cursor: {
		userBase: ".cursor",
		userAgent: ".cursor",
		projectDir: ".cursor",
	},
	windsurf: {
		userBase: ".codeium/windsurf",
		userAgent: ".codeium/windsurf",
		projectDir: ".windsurf",
	},
	cline: {
		userBase: ".cline",
		userAgent: ".cline",
		projectDir: null,
	},
	github: {
		userBase: null,
		userAgent: null,
		projectDir: ".github",
	},
	vscode: {
		userBase: ".vscode",
		userAgent: ".vscode",
		projectDir: ".vscode",
	},
} as const;

type SourceId = keyof typeof SOURCE_PATHS;

export function getUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	if (source === "native") return path.join(getAgentDir(), subpath);
	if (source === "claude") return path.join(resolveClaudePaths(ctx.home).configDir, subpath);
	const paths = SOURCE_PATHS[source];
	if (!paths.userAgent) return null;
	return path.join(ctx.home, paths.userAgent, subpath);
}

export function getProjectPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.projectDir) return null;

	return path.join(ctx.cwd, paths.projectDir, subpath);
}

export function resolveCopilotHome(home: string): string {
	const override = process.env.COPILOT_HOME?.trim();
	return override ? override : path.join(home, ".copilot");
}

export function createSourceMeta(provider: string, filePath: string, level: "user" | "project"): SourceMeta {
	return {
		provider,
		providerName: "",
		path: path.resolve(filePath),
		level,
	};
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

export function parseRequestIdFormat(value: unknown): MCPRequestIdFormat | undefined {
	if (value === "string" || value === "number") return value;
	return undefined;
}

export function parseCSV(value: string): string[] {
	return value
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
}

function parseArrayOrCSV(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const filtered = value.filter((item): item is string => typeof item === "string");
		return filtered.length > 0 ? filtered : undefined;
	}
	if (typeof value === "string") {
		const parsed = parseCSV(value);
		return parsed.length > 0 ? parsed : undefined;
	}
	return undefined;
}

export function buildRuleFromMarkdown(
	name: string,
	content: string,
	filePath: string,
	source: SourceMeta,
	options?: {
		ruleName?: string;
		stripNamePattern?: RegExp;
	},
): Rule {
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	const { condition, astCondition, scope } = parseRuleConditionAndScope(frontmatter as RuleFrontmatter);

	let globs: string[] | undefined;
	if (Array.isArray(frontmatter.globs)) {
		globs = frontmatter.globs.filter((item): item is string => typeof item === "string");
	} else if (typeof frontmatter.globs === "string") {
		globs = [frontmatter.globs];
	}

	const resolvedName = options?.ruleName ?? name.replace(options?.stripNamePattern ?? /\.(md|mdc)$/, "");
	const rawMode = frontmatter.interruptMode;
	const interruptMode: Rule["interruptMode"] =
		rawMode === "never" || rawMode === "prose-only" || rawMode === "tool-only" || rawMode === "always"
			? rawMode
			: undefined;
	return {
		name: resolvedName,
		path: filePath,
		content: body,
		globs,
		alwaysApply: frontmatter.alwaysApply === true,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		condition,
		astCondition,
		scope,
		interruptMode,
		_source: source,
	};
}

function parseModelList(value: unknown): string[] | undefined {
	const parsed = parseArrayOrCSV(value);
	if (!parsed) return undefined;
	const normalized = parsed.map(entry => entry.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

interface ParsedAgentFields {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	output?: unknown;
	thinkingLevel?: ThinkingLevel;
	autoloadSkills?: string[];
	readSummarize?: boolean;

	prewalk?: boolean | string;

	advisor?: boolean | string;
}

export function parseAgentFields(frontmatter: Record<string, unknown>): ParsedAgentFields | null {
	const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	if (!name || !description) {
		return null;
	}

	let tools = parseArrayOrCSV(frontmatter.tools);
	if (tools) tools = normalizeToolNames(tools);

	if (tools && !tools.includes("yield")) {
		tools = [...tools, "yield"];
	}

	let spawns: string[] | "*" | undefined;
	if (frontmatter.spawns === "*") {
		spawns = "*";
	} else if (typeof frontmatter.spawns === "string") {
		const trimmed = frontmatter.spawns.trim();
		if (trimmed === "*") {
			spawns = "*";
		} else {
			spawns = parseArrayOrCSV(trimmed);
		}
	} else {
		spawns = parseArrayOrCSV(frontmatter.spawns);
	}

	const output = frontmatter.output !== undefined ? frontmatter.output : undefined;
	const rawThinkingLevel =
		typeof frontmatter.thinkingLevel === "string"
			? frontmatter.thinkingLevel
			: typeof frontmatter.thinking === "string"
				? frontmatter.thinking
				: undefined;

	const thinkingLevel = parseThinkingLevel(rawThinkingLevel);
	const model = parseModelList(frontmatter.model);
	const readSummarize = parseBoolean(frontmatter.readSummarize);

	let prewalk: boolean | string | undefined = parseBoolean(frontmatter.prewalk);
	if (prewalk === undefined && typeof frontmatter.prewalk === "string") {
		const trimmed = frontmatter.prewalk.trim();
		if (trimmed) prewalk = trimmed;
	}

	let advisor: boolean | string | undefined = parseBoolean(frontmatter.advisor);
	if (advisor === undefined && typeof frontmatter.advisor === "string") {
		const trimmed = frontmatter.advisor.trim();
		if (trimmed) advisor = trimmed;
	}
	const autoloadSkills = parseArrayOrCSV(frontmatter.autoloadSkills)
		?.map(s => s.trim())
		.filter(Boolean);
	return {
		name,
		description,
		tools,
		spawns,
		model,
		output,
		thinkingLevel,
		autoloadSkills,
		readSummarize,
		prewalk,
		advisor,
	};
}

async function globIf(
	dir: string,
	pattern: string,
	fileType: FileType,
	recursive: boolean = true,
): Promise<Array<{ path: string }>> {
	try {
		const result = await glob({ pattern, path: dir, gitignore: true, hidden: false, fileType, recursive });
		return result.matches;
	} catch {
		return [];
	}
}

interface ScanSkillsFromDirOptions {
	dir: string;
	providerId: string;
	level: "user" | "project";
	requireDescription?: boolean;

	includeSelf?: boolean;
}

export function compareSkillOrder(aName: string, aPath: string, bName: string, bPath: string): number {
	const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	const lowerCompare = cmp(aName.toLowerCase(), bName.toLowerCase());
	if (lowerCompare !== 0) return lowerCompare;
	const nameCompare = cmp(aName, bName);
	if (nameCompare !== 0) return nameCompare;
	return cmp(aPath, bPath);
}

export async function scanSkillsFromDir(
	_ctx: LoadContext,
	options: ScanSkillsFromDirOptions,
): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { dir, level, providerId, requireDescription = false } = options;

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(`Failed to read skills directory: ${dir} (${String(error)})`);
		}
		return { items, warnings };
	}
	const loadSkill = async (skillPath: string) => {
		try {
			const content = await readFile(skillPath);
			if (!content) return;
			const { frontmatter, body } = parseFrontmatter(content, { source: skillPath });
			if (frontmatter.enabled === false) {
				return;
			}
			if (requireDescription && !frontmatter.description) {
				return;
			}
			const skillDirName = path.basename(path.dirname(skillPath));
			const rawName = frontmatter.name;
			const name = typeof rawName === "string" ? rawName.trim() || skillDirName : skillDirName;
			items.push({
				name,
				path: skillPath,
				content: body,
				frontmatter: frontmatter as SkillFrontmatter,
				level,
				_source: createSourceMeta(providerId, skillPath, level),
			});
		} catch {
			warnings.push(`Failed to read skill file: ${skillPath}`);
		}
	};

	const work: Promise<void>[] = [];
	if (options.includeSelf) {
		const selfSkillPath = path.join(dir, "SKILL.md");
		if (fs.existsSync(selfSkillPath)) {
			work.push(loadSkill(selfSkillPath));
		}
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const skillPath = path.join(dir, entry.name, "SKILL.md");
		if (fs.existsSync(skillPath)) {
			work.push(loadSkill(skillPath));
		}
	}
	await Promise.all(work);

	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));

	return { items, warnings };
}

function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? Bun.env[varName];
		if (envValue !== undefined) return envValue;
		if (defaultValue !== undefined) return defaultValue;
		return `\${${varName}}`;
	});
}

export function expandEnvVarsDeep<T>(obj: T, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") {
		return expandEnvVars(obj, extraEnv) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map(item => expandEnvVarsDeep(item, extraEnv)) as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsDeep(value, extraEnv);
		}
		return result as T;
	}
	return obj;
}

export async function loadFilesFromDir<T>(
	_ctx: LoadContext,
	dir: string,
	provider: string,
	level: "user" | "project",
	options: {
		extensions?: string[];

		transform: (name: string, content: string, path: string, source: SourceMeta) => T | null;

		recursive?: boolean;
	},
): Promise<LoadResult<T>> {
	const items: T[] = [];
	const warnings: string[] = [];

	const { extensions, recursive = false } = options;

	let pattern: string;
	if (extensions && extensions.length > 0) {
		const extPattern = extensions.length === 1 ? extensions[0] : `{${extensions.join(",")}}`;
		pattern = recursive ? `**/*.${extPattern}` : `*.${extPattern}`;
	} else {
		pattern = recursive ? "**/*" : "*";
	}

	let matches: Array<{ path: string }>;
	try {
		const result = await glob({
			pattern,
			path: dir,
			gitignore: true,
			hidden: false,
			fileType: FileType.File,

			recursive,
		});
		matches = result.matches;
	} catch {
		return { items, warnings };
	}

	const fileResults = await Promise.all(
		matches.map(async match => {
			const filePath = path.join(dir, match.path);
			const content = await readFile(filePath);
			return { filePath, content };
		}),
	);

	for (const { filePath, content } of fileResults) {
		if (content === null) {
			warnings.push(`Failed to read file: ${filePath}`);
			continue;
		}

		const name = path.basename(filePath);
		const source = createSourceMeta(provider, filePath, level);

		try {
			const item = options.transform(name, content, filePath, source);
			if (item !== null) {
				items.push(item);
			}
		} catch (err) {
			warnings.push(`Failed to parse ${filePath}: ${err}`);
		}
	}
	return { items, warnings };
}

export function calculateDepth(cwd: string, targetDir: string, separator: string): number {
	return cwd.split(separator).length - targetDir.split(separator).length;
}

interface ExtensionModuleManifest {
	extensions?: string[];
}

async function discoverLinkedExtensionModuleFiles(dir: string): Promise<{
	indexFiles: Array<{ path: string }>;
	packageJsonFiles: Array<{ path: string }>;
}> {
	const entries = await readDirEntries(dir);
	const indexFiles: Array<{ path: string }> = [];
	const packageJsonFiles: Array<{ path: string }> = [];

	await Promise.all(
		entries.map(async entry => {
			if (entry.name.startsWith(".") || entry.isDirectory()) return;

			const entryPath = path.join(dir, entry.name);
			const stat = await fs.promises.stat(entryPath).catch(() => null);
			if (!stat?.isDirectory()) return;

			const [packageJsonContent, indexTsContent, indexJsContent] = await Promise.all([
				readFile(path.join(entryPath, "package.json")),
				readFile(path.join(entryPath, "index.ts")),
				readFile(path.join(entryPath, "index.js")),
			]);

			if (packageJsonContent !== null) {
				packageJsonFiles.push({ path: `${entry.name}/package.json` });
			}
			if (indexTsContent !== null) {
				indexFiles.push({ path: `${entry.name}/index.ts` });
			} else if (indexJsContent !== null) {
				indexFiles.push({ path: `${entry.name}/index.js` });
			}
		}),
	);

	return { indexFiles, packageJsonFiles };
}

async function readExtensionModuleManifest(
	_ctx: LoadContext,
	packageJsonPath: string,
): Promise<ExtensionModuleManifest | null> {
	const content = await readFile(packageJsonPath);
	if (!content) return null;

	const pkg = tryParseJson<{ proto?: ExtensionModuleManifest; pi?: ExtensionModuleManifest }>(content);
	const manifest = pkg?.proto ?? pkg?.pi;
	if (manifest && typeof manifest === "object") {
		return manifest;
	}
	return null;
}

export async function discoverExtensionModulePaths(_ctx: LoadContext, dir: string): Promise<string[]> {
	const discovered = new Set<string>();

	const [directFiles, globIndexFiles, globPackageJsonFiles, linkedFiles] = await Promise.all([
		globIf(dir, "*.{ts,js}", FileType.File, false),

		globIf(dir, "*/index.{ts,js}", FileType.File, false),

		globIf(dir, "*/package.json", FileType.File, false),

		discoverLinkedExtensionModuleFiles(dir),
	]);
	const indexFiles = [...globIndexFiles, ...linkedFiles.indexFiles];
	const packageJsonFiles = [...globPackageJsonFiles, ...linkedFiles.packageJsonFiles];

	const topLevelEntries = await readDirEntries(dir);
	for (const entry of topLevelEntries) {
		if (!entry.isSymbolicLink()) continue;

		const subEntries = await readDirEntries(path.join(dir, entry.name));
		const hasEntry = (name: string): boolean =>
			subEntries.some(e => e.name === name && (e.isFile() || e.isSymbolicLink()));
		if (hasEntry("package.json")) packageJsonFiles.push({ path: `${entry.name}/package.json` });
		if (hasEntry("index.ts")) indexFiles.push({ path: `${entry.name}/index.ts` });
		else if (hasEntry("index.js")) indexFiles.push({ path: `${entry.name}/index.js` });
	}

	for (const match of directFiles) {
		if (match.path.includes("/")) continue;
		discovered.add(path.join(dir, match.path));
	}

	const subdirsWithDeclaredExtensions = new Set<string>();
	for (const match of packageJsonFiles) {
		const subdir = path.dirname(match.path);
		const packageJsonPath = path.join(dir, match.path);
		const manifest = await readExtensionModuleManifest(_ctx, packageJsonPath);
		const declaredExtensions =
			manifest?.extensions?.filter((extPath): extPath is string => typeof extPath === "string") ?? [];
		if (declaredExtensions.length === 0) continue;
		subdirsWithDeclaredExtensions.add(subdir);
		const subdirPath = path.join(dir, subdir);
		for (const extPath of declaredExtensions) {
			let resolvedExtPath = path.resolve(subdirPath, extPath);
			const entries = await readDirEntries(resolvedExtPath);
			if (entries.length !== 0) {
				const pluginFilePath = entries.find(
					e => e.isFile() && (e.name === "index.ts" || e.name === "index.js"),
				)?.name;
				resolvedExtPath = pluginFilePath ? path.join(resolvedExtPath, pluginFilePath) : resolvedExtPath;
			}
			const content = await readFile(resolvedExtPath);
			if (content !== null) {
				discovered.add(resolvedExtPath);
			}
		}
	}
	const preferredIndexBySubdir = new Map<string, string>();
	for (const match of indexFiles) {
		if (match.path.split("/").length !== 2) continue;
		const subdir = path.dirname(match.path);
		if (subdirsWithDeclaredExtensions.has(subdir)) continue;
		const existing = preferredIndexBySubdir.get(subdir);
		if (!existing || (existing.endsWith("index.js") && match.path.endsWith("index.ts"))) {
			preferredIndexBySubdir.set(subdir, match.path);
		}
	}
	for (const preferredPath of preferredIndexBySubdir.values()) {
		discovered.add(path.join(dir, preferredPath));
	}
	return [...discovered];
}

export function getExtensionNameFromPath(extensionPath: string): string {
	const base = extensionPath.replace(/\\/g, "/").split("/").pop() ?? extensionPath;

	if (base === "index.ts" || base === "index.js") {
		const parts = extensionPath.replace(/\\/g, "/").split("/");
		const parent = parts[parts.length - 2];
		return parent ?? base;
	}

	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		return base.slice(0, dot);
	}

	return base;
}

export function buildExtensionModuleItems(
	providerId: string,
	userPaths: string[],
	projectPaths: string[],
): ExtensionModule[] {
	return [
		...userPaths.map(extPath => ({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level: "user" as const,
			_source: createSourceMeta(providerId, extPath, "user"),
		})),
		...projectPaths.map(extPath => ({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level: "project" as const,
			_source: createSourceMeta(providerId, extPath, "project"),
		})),
	];
}

interface ClaudePluginEntry {
	scope?: "user" | "project" | "local";
	installPath: string;
	version: string;
	installedAt: string;
	lastUpdated: string;
	gitCommitSha?: string;
	enabled?: boolean;

	projectPath?: string;
}

export interface ClaudePluginsRegistry {
	version: number;
	plugins: Record<string, ClaudePluginEntry[]>;
}

export interface ClaudePluginRoot {
	id: string;

	marketplace: string;

	plugin: string;

	version: string;

	path: string;

	scope: "user" | "project";
}

export function parseClaudePluginsRegistry(content: string): ClaudePluginsRegistry | null {
	const data = tryParseJson<ClaudePluginsRegistry>(content);
	if (!data || typeof data !== "object") return null;
	if (
		typeof data.version !== "number" ||
		!data.plugins ||
		typeof data.plugins !== "object" ||
		Array.isArray(data.plugins)
	)
		return null;
	return data;
}

export async function resolveActiveProjectRegistryPath(cwd: string): Promise<string | null> {
	const homeDir = os.homedir();
	let dir = path.resolve(cwd);
	while (dir !== homeDir) {
		try {
			const stat = await fs.promises.stat(path.join(dir, getConfigDirName()));
			if (stat.isDirectory()) {
				return path.join(dir, getConfigDirName(), "plugins", "installed_plugins.json");
			}
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	dir = path.resolve(cwd);
	while (dir !== homeDir) {
		try {
			await fs.promises.stat(path.join(dir, ".git"));
			return path.join(dir, getConfigDirName(), "plugins", "installed_plugins.json");
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}

export async function resolveOrDefaultProjectRegistryPath(cwd: string): Promise<string | undefined> {
	const resolved = await resolveActiveProjectRegistryPath(cwd);
	if (resolved) return resolved;

	if (path.resolve(cwd) === os.homedir()) return undefined;
	return path.join(cwd, getConfigDirName(), "plugins", "installed_plugins.json");
}

async function canonicalClaudeProjectPath(projectPath: string): Promise<string | null> {
	try {
		return await fs.promises.realpath(path.resolve(projectPath));
	} catch {
		return null;
	}
}

async function readClaudeEnabledPlugins(
	claudeConfigDir: string,
	projectDirs: string[],
): Promise<{ enabled: Map<string, boolean>; sources: string[] }> {
	const enabled = new Map<string, boolean>();
	const sources: string[] = [];
	const candidates = [path.join(claudeConfigDir, "settings.json")];
	for (const dir of projectDirs) {
		candidates.push(path.join(dir, ".claude", "settings.json"), path.join(dir, ".claude", "settings.local.json"));
	}
	for (const file of candidates) {
		const content = await readFile(file);
		if (!content) continue;
		const data = tryParseJson<{ enabledPlugins?: unknown }>(content);
		if (!data || typeof data !== "object") continue;
		const map = data.enabledPlugins;
		if (!map || typeof map !== "object" || Array.isArray(map)) continue;
		sources.push(file);
		for (const [pluginId, value] of Object.entries(map as Record<string, unknown>)) {
			if (typeof value === "boolean") enabled.set(pluginId, value);
		}
	}
	return { enabled, sources };
}

const pluginRootsCache = new Map<string, { roots: ClaudePluginRoot[]; warnings: string[] }>();

const pluginCacheInvalidators = new Set<() => void>();

export function registerPluginCacheInvalidator(invalidator: () => void): void {
	pluginCacheInvalidators.add(invalidator);
}

export async function listClaudePluginRoots(
	home: string,
	cwd?: string,
): Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }> {
	const claudeConfigDir = resolveClaudePaths(home).configDir;
	const ompRegistryPath = path.join(getPluginsDir(home), "installed_plugins.json");
	const resolvedProjectPath = cwd ? await resolveActiveProjectRegistryPath(cwd) : null;
	const projectRoot = resolvedProjectPath ? path.dirname(path.dirname(path.dirname(resolvedProjectPath))) : cwd;
	const activeClaudeProjectPath = projectRoot ? await canonicalClaudeProjectPath(projectRoot) : null;
	const canonicalCwd = cwd ? await canonicalClaudeProjectPath(cwd) : null;
	const settingsDirs = [...new Set([activeClaudeProjectPath, canonicalCwd].filter((d): d is string => !!d))];
	const enabledOverrides = await readClaudeEnabledPlugins(claudeConfigDir, settingsDirs);
	const cacheKey = `${claudeConfigDir}:${ompRegistryPath}:${resolvedProjectPath ?? ""}:${activeClaudeProjectPath ?? ""}:${canonicalCwd ?? ""}:${enabledOverrides.sources.join("|")}`;
	const cached = pluginRootsCache.get(cacheKey);
	if (cached) return cached;

	const roots: ClaudePluginRoot[] = [];
	const warnings: string[] = [];
	const projectRoots: ClaudePluginRoot[] = [];
	const canonicalClaudeProjectPaths = new Map<string, string | null>();

	const registryPath = path.join(claudeConfigDir, "plugins", "installed_plugins.json");
	const content = await readFile(registryPath);

	if (content) {
		const registry = parseClaudePluginsRegistry(content);
		if (!registry) {
			warnings.push(`Failed to parse Claude Code plugin registry: ${registryPath}`);
		} else {
			for (const [pluginId, entries] of Object.entries(registry.plugins)) {
				if (!Array.isArray(entries) || entries.length === 0) continue;

				const atIndex = pluginId.lastIndexOf("@");
				if (atIndex === -1) {
					warnings.push(`Invalid plugin ID format (missing @marketplace): ${pluginId}`);
					continue;
				}

				const pluginName = pluginId.slice(0, atIndex);
				const marketplace = pluginId.slice(atIndex + 1);

				for (const entry of entries) {
					if (!entry.installPath || typeof entry.installPath !== "string") {
						warnings.push(`Plugin ${pluginId} entry has no installPath`);
						continue;
					}
					if (entry.enabled === false) continue;

					const override = enabledOverrides.enabled.get(pluginId);
					if (override === false) continue;
					if ((entry.scope === "local" || entry.scope === "project") && override !== true) {
						if (!entry.projectPath || !activeClaudeProjectPath) continue;
						let entryProjectPath = canonicalClaudeProjectPaths.get(entry.projectPath);
						if (entryProjectPath === undefined) {
							entryProjectPath = await canonicalClaudeProjectPath(entry.projectPath);
							canonicalClaudeProjectPaths.set(entry.projectPath, entryProjectPath);
						}
						if (entryProjectPath !== activeClaudeProjectPath) continue;
					}

					roots.push({
						id: pluginId,
						marketplace,
						plugin: pluginName,
						version: entry.version || "unknown",
						path: entry.installPath,
						scope: entry.scope === "local" ? "project" : entry.scope || "user",
					});
				}
			}
		}
	}

	const ompContent = await readFile(ompRegistryPath);
	if (ompContent) {
		const ompRegistry = parseClaudePluginsRegistry(ompContent);
		if (ompRegistry) {
			for (const [pluginId, entries] of Object.entries(ompRegistry.plugins)) {
				if (!Array.isArray(entries) || entries.length === 0) continue;

				const atIndex = pluginId.lastIndexOf("@");
				if (atIndex === -1) {
					warnings.push(`Invalid plugin ID format (missing @marketplace): ${pluginId}`);
					continue;
				}
				const pluginName = pluginId.slice(0, atIndex);
				const marketplace = pluginId.slice(atIndex + 1);

				const filtered = roots.filter(r => r.id !== pluginId);
				roots.length = 0;
				roots.push(...filtered);

				for (const entry of entries) {
					if (!entry.installPath || typeof entry.installPath !== "string") {
						warnings.push(`Plugin ${pluginId} entry has no installPath`);
						continue;
					}
					if (entry.enabled === false) continue;

					if (roots.some(r => r.id === pluginId && r.path === entry.installPath)) continue;

					roots.push({
						id: pluginId,
						marketplace,
						plugin: pluginName,
						version: entry.version || "unknown",
						path: entry.installPath,
						scope: entry.scope === "local" ? "project" : entry.scope || "user",
					});
				}
			}
		} else {
			warnings.push(`Failed to parse PROTO plugin registry: ${ompRegistryPath}`);
		}
	}

	if (resolvedProjectPath) {
		const projectContent = await readFile(resolvedProjectPath);
		if (projectContent) {
			const projectRegistry = parseClaudePluginsRegistry(projectContent);
			if (projectRegistry) {
				for (const [pluginId, entries] of Object.entries(projectRegistry.plugins)) {
					if (!Array.isArray(entries) || entries.length === 0) continue;
					const atIndex = pluginId.lastIndexOf("@");
					if (atIndex === -1) {
						warnings.push(`Invalid plugin ID format (missing @marketplace): ${pluginId}`);
						continue;
					}
					const pluginName = pluginId.slice(0, atIndex);
					const marketplace = pluginId.slice(atIndex + 1);
					for (const entry of entries) {
						if (!entry.installPath || typeof entry.installPath !== "string") {
							warnings.push(`Plugin ${pluginId} entry has no installPath`);
							continue;
						}
						if (entry.enabled === false) continue;
						projectRoots.push({
							id: pluginId,
							marketplace,
							plugin: pluginName,
							version: entry.version || "unknown",
							path: entry.installPath,
							scope: "project",
						});
					}
				}
			} else {
				warnings.push(`Failed to parse project plugin registry: ${resolvedProjectPath}`);
			}
		}
	}

	if (projectRoots.length > 0) {
		const projectIds = new Set(projectRoots.map(r => r.id));
		const deduped = roots.filter(r => !projectIds.has(r.id));
		roots.length = 0;
		roots.push(...projectRoots, ...deduped);
	}

	if (injectedPluginDirRoots.length > 0) {
		const injectedIds = new Set(injectedPluginDirRoots.map(r => r.id));
		const filtered = roots.filter(r => !injectedIds.has(r.id));
		roots.length = 0;
		roots.push(...injectedPluginDirRoots, ...filtered);
	}

	const result = { roots, warnings };
	pluginRootsCache.set(cacheKey, result);
	return result;
}

export function clearClaudePluginRootsCache(): void {
	pluginRootsCache.clear();
	for (const invalidate of pluginCacheInvalidators) invalidate();
	preloadedPluginRoots = [...injectedPluginDirRoots];

	if (lastPreloadHome) {
		void preloadPluginRoots(lastPreloadHome, getProjectDir());
	}
}

export function clearPluginRootsAndCaches(extraPaths?: readonly string[]): void {
	invalidateFsCache(path.join(resolveClaudePaths().configDir, "plugins", "installed_plugins.json"));
	invalidateFsCache(path.join(getPluginsDir(), "installed_plugins.json"));
	for (const p of extraPaths ?? []) invalidateFsCache(p);
	clearClaudePluginRootsCache();
}

let preloadedPluginRoots: ClaudePluginRoot[] = [];
let injectedPluginDirRoots: ClaudePluginRoot[] = [];
let lastPreloadHome: string | undefined;

export async function preloadPluginRoots(home: string, cwd?: string): Promise<void> {
	lastPreloadHome = home;
	const { roots } = await listClaudePluginRoots(home, cwd);
	preloadedPluginRoots = roots;
}

export function getPreloadedPluginRoots(): readonly ClaudePluginRoot[] {
	return preloadedPluginRoots;
}

export async function injectPluginDirRoots(home: string, dirs: string[], cwd?: string): Promise<void> {
	const injected: ClaudePluginRoot[] = [];
	for (const dir of dirs) {
		const resolved = path.resolve(dir);

		let pluginName = path.basename(resolved);
		const realRoot = await realpathIfExists(resolved);
		if (realRoot !== null) {
			for (const manifestPath of [
				path.join(realRoot, ".claude-plugin", "plugin.json"),
				path.join(realRoot, "plugin.json"),
			]) {
				const contained = await resolveContainedPath(realRoot, manifestPath);
				if (contained.status !== "ok") continue;
				try {
					const manifest = await Bun.file(contained.realPath).json();
					if (typeof manifest?.name === "string" && manifest.name) {
						pluginName = manifest.name;
						break;
					}
				} catch {}
			}
		}

		injected.push(buildPluginDirRoot(resolved, pluginName));
	}

	injectedPluginDirRoots = injected;
	lastPreloadHome = home;

	pluginRootsCache.clear();

	const { roots } = await listClaudePluginRoots(home, cwd);
	preloadedPluginRoots = roots;
}
