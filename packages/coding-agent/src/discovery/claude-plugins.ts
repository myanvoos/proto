import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { legacyProviderAllowed } from "./agent-plugin-format";
import {
	type ClaudePluginRoot,
	createSourceMeta,
	expandEnvVarsDeep,
	listClaudePluginRoots,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

import { resolvePluginStdioPaths, substitutePluginRoot } from "./substitute-plugin-root";

const PROVIDER_ID = "claude-plugins";
const DISPLAY_NAME = "Claude Code Marketplace";
const PRIORITY = 70;

async function allowedRoots(
	ctx: LoadContext,
	surface: "skills" | "mcp" | "other",
): Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }> {
	const { roots, warnings } = await listClaudePluginRoots(ctx.home, ctx.cwd);
	const flags = await Promise.all(roots.map(root => legacyProviderAllowed(root.path, surface)));
	return { roots: roots.filter((_, i) => flags[i]), warnings };
}

interface ClaudePluginManifest {
	skills?: string | string[];
	"slash-commands"?: string | string[];
	commands?: string | string[];
}

interface ResolvedPluginDir {
	dirs: string[];
	warnings: string[];
}

interface ResolvedMCPConfig {
	path: string | null;

	inlineServers: Record<string, unknown> | null;

	sourcePath: string;

	baseDir: string;

	declared: boolean;
	warnings: string[];
}

async function readPluginManifest(root: ClaudePluginRoot): Promise<ClaudePluginManifest | null> {
	const manifestPath = path.join(root.path, ".claude-plugin", "plugin.json");
	const raw = await readFile(manifestPath);
	if (raw === null) return null;

	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ClaudePluginManifest;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function skillsManifestReplacesFallback(root: ClaudePluginRoot): Promise<boolean> {
	const raw = await readFile(path.join(root.path, "marketplace.json"));
	if (raw === null) return false;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return false;
		const plugins = parsed.plugins;
		return (
			Array.isArray(plugins) &&
			plugins.some(entry => isRecord(entry) && entry.name === root.plugin && entry.source === "./")
		);
	} catch {
		return false;
	}
}

function isWithinPluginRoot(rootPath: string, targetPath: string): boolean {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvePluginDir(
	root: ClaudePluginRoot,
	manifestKeys: ReadonlyArray<keyof ClaudePluginManifest>,
	fallback: string,
	includeFallback: boolean,
): Promise<ResolvedPluginDir> {
	const manifest = await readPluginManifest(root);
	const fallbackDir = path.join(root.path, fallback);

	let configured: string[] | undefined;
	let matchedKey: keyof ClaudePluginManifest | undefined;
	for (const key of manifestKeys) {
		const val = manifest?.[key];
		const candidates: string[] = [];
		if (typeof val === "string") {
			const trimmed = val.trim();
			if (trimmed) candidates.push(trimmed);
		} else if (Array.isArray(val)) {
			for (const entry of val) {
				if (typeof entry !== "string") continue;
				const trimmed = entry.trim();
				if (trimmed) candidates.push(trimmed);
			}
		}
		if (candidates.length > 0) {
			configured = candidates;
			matchedKey = key;
			break;
		}
	}

	if (configured === undefined) {
		return { dirs: [fallbackDir], warnings: [] };
	}

	const seen = new Set<string>();
	const dirs: string[] = [];
	const warnings: string[] = [];
	if (includeFallback) {
		seen.add(fallbackDir);
		dirs.push(fallbackDir);
	}
	for (const entry of configured) {
		const resolved = path.resolve(root.path, entry);
		if (!isWithinPluginRoot(root.path, resolved)) {
			warnings.push(
				`[claude-plugins] Ignoring ${String(matchedKey)} path outside plugin root for ${root.id}: ${entry}`,
			);
			continue;
		}
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		dirs.push(resolved);
	}

	return { dirs, warnings };
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "skills");
	warnings.push(...rootWarnings);
	const results = await Promise.all(
		roots.map(async root => {
			const includeFallback = !(await skillsManifestReplacesFallback(root));
			const { dirs: skillsDirs, warnings: resolveWarnings } = await resolvePluginDir(
				root,
				["skills"],
				"skills",
				includeFallback,
			);
			const scanResults = await Promise.all(
				skillsDirs.map(dir =>
					scanSkillsFromDir(ctx, {
						dir,
						providerId: PROVIDER_ID,
						level: root.scope,
						includeSelf: true,
					}),
				),
			);
			return { scanResults, resolveWarnings };
		}),
	);
	for (const { scanResults, resolveWarnings } of results) {
		warnings.push(...resolveWarnings);

		for (const result of scanResults) {
			items.push(...result.items);
			if (result.warnings) warnings.push(...result.warnings);
		}
	}
	return { items, warnings };
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const { dirs: commandsDirs, warnings: resolveWarnings } = await resolvePluginDir(
				root,
				["commands", "slash-commands"],
				"commands",
				false,
			);
			const commandResults = await Promise.all(
				commandsDirs.map(async dir => {
					try {
						const stats = await fs.stat(dir);
						if (stats.isFile()) {
							if (path.extname(dir) !== ".md") return { items: [], warnings: [] };
							const content = await readFile(dir);
							if (content === null) return { items: [], warnings: [`Failed to read file: ${dir}`] };
							const cmdName = path.basename(dir).replace(/\.md$/, "");
							return {
								items: [
									{
										name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
										path: dir,
										content,
										level: root.scope,
										_source: createSourceMeta(PROVIDER_ID, dir, root.scope),
									},
								],
								warnings: [],
							};
						}
					} catch {}
					return loadFilesFromDir<SlashCommand>(ctx, dir, PROVIDER_ID, root.scope, {
						extensions: ["md"],
						transform: (name, content, filePath, source) => {
							const cmdName = name.replace(/\.md$/, "");
							return {
								name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
								path: filePath,
								content,
								level: root.scope,
								_source: source,
							};
						},
					});
				}),
			);
			return { commandResults, resolveWarnings };
		}),
	);

	for (const { commandResults, resolveWarnings } of results) {
		warnings.push(...resolveWarnings);
		for (const commandResult of commandResults) {
			items.push(...commandResult.items);
			if (commandResult.warnings) warnings.push(...commandResult.warnings);
		}
	}

	return { items, warnings };
}

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	warnings.push(...rootWarnings);

	const hookTypes = ["pre", "post"] as const;

	const loadTasks: { root: ClaudePluginRoot; hookType: "pre" | "post" }[] = [];
	for (const root of roots) {
		for (const hookType of hookTypes) {
			loadTasks.push({ root, hookType });
		}
	}

	const results = await Promise.all(
		loadTasks.map(async ({ root, hookType }) => {
			const hooksDir = path.join(root.path, "hooks", hookType);
			return loadFilesFromDir<Hook>(ctx, hooksDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");
					return {
						name,
						path: filePath,
						type: hookType,
						tool: toolName,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const toolsDir = path.join(root.path, "tools");
			return loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, root.scope, {
				extensions: ["ts", "js"],
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(ts|js)$/, "");
					return {
						name: toolName,
						path: filePath,
						description: `${toolName} custom tool`,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function extractServerMap(obj: Record<string, unknown>): Record<string, unknown> | null {
	if (isRecord(obj.mcpServers)) return obj.mcpServers;
	if (!("mcpServers" in obj)) return obj;
	return null;
}

async function resolvePluginMCPConfig(root: ClaudePluginRoot): Promise<ResolvedMCPConfig> {
	const fallback = path.join(root.path, ".mcp.json");
	for (const manifestDir of [".proto-plugin", ".claude-plugin"]) {
		const manifestPath = path.join(root.path, manifestDir, "plugin.json");
		const raw = await readFile(manifestPath);
		if (raw === null) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		const pointer = parsed.mcpServers;

		if (isRecord(pointer)) {
			return {
				path: null,
				inlineServers: pointer,
				sourcePath: manifestPath,
				baseDir: root.path,
				declared: true,
				warnings: [],
			};
		}

		if (typeof pointer === "string") {
			const configured = pointer.trim();
			if (configured.length === 0) continue;
			const resolved = path.resolve(root.path, configured);
			if (!isWithinPluginRoot(root.path, resolved)) {
				return {
					path: null,
					inlineServers: null,
					sourcePath: manifestPath,
					baseDir: root.path,
					declared: true,
					warnings: [
						`[claude-plugins] Ignoring mcpServers path outside plugin root for ${root.id}: ${configured}`,
					],
				};
			}
			return {
				path: resolved,
				inlineServers: null,
				sourcePath: resolved,
				baseDir: path.dirname(resolved),
				declared: true,
				warnings: [],
			};
		}
	}

	return {
		path: fallback,
		inlineServers: null,
		sourcePath: fallback,
		baseDir: path.dirname(fallback),
		declared: false,
		warnings: [],
	};
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "mcp");
	warnings.push(...rootWarnings);

	for (const root of roots) {
		const resolved = await resolvePluginMCPConfig(root);
		warnings.push(...resolved.warnings);

		let servers: Record<string, unknown> | null;
		if (resolved.inlineServers) {
			servers = resolved.inlineServers;
		} else if (resolved.path !== null) {
			const raw = await readFile(resolved.path);
			if (raw === null) {
				if (resolved.declared) {
					const warning = `[claude-plugins] Missing mcpServers file declared by ${root.id}: ${resolved.path}`;
					warnings.push(warning);
					logger.warn(warning);
				}
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				warnings.push(`[claude-plugins] Invalid JSON in ${resolved.path}`);
				logger.warn(`[claude-plugins] Invalid JSON in ${resolved.path}`);
				continue;
			}

			if (!isRecord(parsed)) continue;
			servers = extractServerMap(parsed);
		} else {
			continue;
		}
		if (servers === null) continue;

		const { sourcePath, baseDir } = resolved;
		for (const serverName in servers) {
			const serverCfg = servers[serverName];
			if (!serverCfg || typeof serverCfg !== "object" || Array.isArray(serverCfg)) continue;
			const raw = serverCfg as {
				enabled?: boolean;
				timeout?: number;
				command?: string;
				args?: string[];
				env?: Record<string, string>;
				cwd?: string;
				url?: string;
				headers?: Record<string, string>;
				auth?: MCPServer["auth"];
				oauth?: MCPServer["oauth"];
				type?: string;
			};

			if (typeof raw.command !== "string" && typeof raw.url !== "string") {
				warnings.push(
					`[claude-plugins] Skipping MCP server "${serverName}" in ${sourcePath}: missing command or url`,
				);
				continue;
			}
			const namespacedName = root.plugin ? `${root.plugin}:${serverName}` : serverName;
			const substitutedCommand =
				raw.command !== undefined ? substitutePluginRoot(raw.command, root.path) : undefined;
			const substitutedCwd = raw.cwd !== undefined ? substitutePluginRoot(raw.cwd, root.path) : undefined;

			const rooted = resolvePluginStdioPaths({ command: substitutedCommand, cwd: substitutedCwd }, baseDir);
			// Expand before inserting the plugin root so placeholders inside the
			// install path are not scanned as untrusted environment references.
			const expandedEnv = raw.env !== undefined ? expandEnvVarsDeep(raw.env) : undefined;
			const server: MCPServer = {
				name: namespacedName,
				...(raw.enabled !== undefined && { enabled: raw.enabled }),
				...(raw.timeout !== undefined && { timeout: raw.timeout }),
				...(rooted.command !== undefined && { command: rooted.command }),
				...(raw.args !== undefined && { args: substitutePluginRoot(raw.args, root.path) }),
				...(expandedEnv !== undefined && { env: substitutePluginRoot(expandedEnv, root.path) }),
				...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
				...(raw.url !== undefined && { url: expandEnvVarsDeep(raw.url) }),
				...(raw.headers !== undefined && { headers: expandEnvVarsDeep(raw.headers) }),
				...(raw.auth !== undefined && { auth: raw.auth }),
				...(raw.oauth !== undefined && { oauth: raw.oauth }),
				...(raw.type !== undefined && { transport: raw.type as MCPServer["transport"] }),
				_source: createSourceMeta(PROVIDER_ID, sourcePath, root.scope),
			};
			items.push(server);
		}
	}

	return { items, warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from Claude Code marketplace plugins (~/.claude/plugins/cache/)",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from marketplace plugin .mcp.json files",
	priority: PRIORITY,
	load: loadMCPServers,
});
