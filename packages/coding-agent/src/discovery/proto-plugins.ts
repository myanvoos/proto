import * as path from "node:path";
import { logger, parseFrontmatter, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readDirEntries, readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { legacyProviderAllowed } from "./agent-plugin-format";
import {
	buildRuleFromMarkdown,
	createSourceMeta,
	expandEnvVarsDeep,
	loadFilesFromDir,
	parseRequestIdFormat,
	scanSkillsFromDir,
} from "./helpers";
import { listOmpExtensionRoots, type OmpExtensionRoot } from "./proto-extension-roots";
import { resolvePluginStdioPaths } from "./substitute-plugin-root";

const PROVIDER_ID = "proto-plugins";
const DISPLAY_NAME = "PROTO Extension Packages";
const DESCRIPTION =
	"Sub-discovery (skills, hooks, tools, commands, rules, prompts, .mcp.json) inside extension packages";
const PRIORITY = 90;

async function allowedRoots(ctx: LoadContext, surface: "skills" | "mcp" | "other"): Promise<OmpExtensionRoot[]> {
	const roots = await listOmpExtensionRoots(ctx);
	const flags = await Promise.all(roots.map(root => legacyProviderAllowed(root.path, surface)));
	return roots.filter((_, i) => flags[i]);
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const roots = await allowedRoots(ctx, "skills");
	const results = await Promise.all(
		roots.map(root =>
			scanSkillsFromDir(ctx, {
				dir: path.join(root.path, "skills"),
				providerId: PROVIDER_ID,
				level: root.level,
				requireDescription: true,
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const roots = await allowedRoots(ctx, "other");
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<SlashCommand>(ctx, path.join(root.path, "commands"), PROVIDER_ID, root.level, {
				extensions: ["md"],
				transform: (name, content, filePath, source) => ({
					name: name.replace(/\.md$/, ""),
					path: filePath,
					content,
					level: root.level,
					_source: source,
				}),
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const roots = await allowedRoots(ctx, "other");
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<Rule>(ctx, path.join(root.path, "rules"), PROVIDER_ID, root.level, {
				extensions: ["md", "mdc"],
				transform: (name, content, filePath, source) =>
					buildRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const roots = await allowedRoots(ctx, "other");
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<Prompt>(ctx, path.join(root.path, "prompts"), PROVIDER_ID, root.level, {
				extensions: ["md"],
				transform: (name, content, filePath, source) => ({
					name: name.replace(/\.md$/, ""),
					path: filePath,
					content,
					_source: source,
				}),
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

const HOOK_TYPES: ReadonlyArray<"pre" | "post"> = ["pre", "post"];

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const roots = await allowedRoots(ctx, "other");
	const tasks: Array<{ root: OmpExtensionRoot; hookType: "pre" | "post" }> = [];
	for (const root of roots) {
		for (const hookType of HOOK_TYPES) {
			tasks.push({ root, hookType });
		}
	}
	const results = await Promise.all(
		tasks.map(({ root, hookType }) =>
			loadFilesFromDir<Hook>(ctx, path.join(root.path, "hooks", hookType), PROVIDER_ID, root.level, {
				transform: (name, _content, filePath, source) => {
					const baseName = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
					const tool = baseName === "*" ? "*" : baseName;
					return {
						name,
						path: filePath,
						type: hookType,
						tool,
						level: root.level,
						_source: source,
					};
				},
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

const TOOL_EXTENSIONS = ["json", "md", "ts", "js", "sh", "bash", "py"];

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const roots = await allowedRoots(ctx, "other");
	const perRoot = await Promise.all(
		roots.map(async root => {
			const toolsDir = path.join(root.path, "tools");
			const [filesResult, entries] = await Promise.all([
				loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, root.level, {
					extensions: TOOL_EXTENSIONS,
					transform: (name, content, filePath, source) => {
						if (name.endsWith(".json")) {
							const data = tryParseJson<{ name?: string; description?: string }>(content);
							const toolName = data?.name || name.replace(/\.json$/, "");
							const description =
								typeof data?.description === "string" && data.description.trim()
									? data.description
									: `${toolName} custom tool`;
							return { name: toolName, path: filePath, description, level: root.level, _source: source };
						}
						if (name.endsWith(".md")) {
							const { frontmatter } = parseFrontmatter(content, { source: filePath });
							const toolName = (frontmatter.name as string) || name.replace(/\.md$/, "");
							const description =
								typeof frontmatter.description === "string" && frontmatter.description.trim()
									? String(frontmatter.description)
									: `${toolName} custom tool`;
							return { name: toolName, path: filePath, description, level: root.level, _source: source };
						}
						const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
						return {
							name: toolName,
							path: filePath,
							description: `${toolName} custom tool`,
							level: root.level,
							_source: source,
						};
					},
				}),
				readDirEntries(toolsDir),
			]);

			const indexCandidates = entries
				.filter(e => !e.name.startsWith(".") && e.isDirectory())
				.map(e => path.join(toolsDir, e.name, "index.ts"));
			const indexContents = await Promise.all(indexCandidates.map(p => readFile(p)));
			const indexItems: CustomTool[] = [];
			for (let i = 0; i < indexCandidates.length; i++) {
				if (indexContents[i] === null) continue;
				const indexPath = indexCandidates[i];
				const toolName = path.basename(path.dirname(indexPath));
				indexItems.push({
					name: toolName,
					path: indexPath,
					description: `${toolName} custom tool`,
					level: root.level,
					_source: createSourceMeta(PROVIDER_ID, indexPath, root.level),
				});
			}

			return { filesResult, indexItems };
		}),
	);

	const items: CustomTool[] = [];
	const warnings: string[] = [];
	for (const { filesResult, indexItems } of perRoot) {
		items.push(...filesResult.items, ...indexItems);
		if (filesResult.warnings) warnings.push(...filesResult.warnings);
	}
	return { items, warnings };
}

const MCP_FILENAMES = [".mcp.json", "mcp.json"] as const;

interface RawMcpServer {
	enabled?: boolean;
	timeout?: number;
	requestIdFormat?: unknown;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: MCPServer["auth"];
	oauth?: MCPServer["oauth"];
	type?: MCPServer["transport"];
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const roots = await allowedRoots(ctx, "mcp");
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const tasks: Array<{ root: OmpExtensionRoot; mcpPath: string }> = [];
	for (const root of roots) {
		for (const filename of MCP_FILENAMES) {
			tasks.push({ root, mcpPath: path.join(root.path, filename) });
		}
	}
	const contents = await Promise.all(tasks.map(({ mcpPath }) => readFile(mcpPath)));

	for (let i = 0; i < tasks.length; i++) {
		const raw = contents[i];
		if (raw === null) continue;
		const { root, mcpPath } = tasks[i];

		const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(raw);
		if (!parsed) {
			warnings.push(`[proto-plugins] Invalid JSON in ${mcpPath}`);
			logger.warn(`[proto-plugins] Invalid JSON in ${mcpPath}`);
			continue;
		}
		const servers = expandEnvVarsDeep(parsed.mcpServers);
		if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;

		for (const [serverName, serverCfg] of Object.entries(servers)) {
			if (!serverCfg || typeof serverCfg !== "object" || Array.isArray(serverCfg)) continue;
			const cfg = serverCfg as RawMcpServer;
			if (typeof cfg.command !== "string" && typeof cfg.url !== "string") {
				warnings.push(`[proto-plugins] Skipping MCP server "${serverName}" in ${mcpPath}: missing command or url`);
				continue;
			}

			const rooted = resolvePluginStdioPaths({ command: cfg.command, cwd: cfg.cwd }, root.path);
			const requestIdFormat = parseRequestIdFormat(cfg.requestIdFormat);
			items.push({
				name: serverName,
				...(cfg.enabled !== undefined && { enabled: cfg.enabled }),
				...(cfg.timeout !== undefined && { timeout: cfg.timeout }),
				...(requestIdFormat !== undefined && { requestIdFormat }),
				...(rooted.command !== undefined && { command: rooted.command }),
				...(cfg.args !== undefined && { args: cfg.args }),
				...(cfg.env !== undefined && { env: cfg.env }),
				...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
				...(cfg.url !== undefined && { url: cfg.url }),
				...(cfg.headers !== undefined && { headers: cfg.headers }),
				...(cfg.auth !== undefined && { auth: cfg.auth }),
				...(cfg.oauth !== undefined && { oauth: cfg.oauth }),
				...(cfg.type !== undefined && { transport: cfg.type }),
				_source: createSourceMeta(PROVIDER_ID, mcpPath, root.level),
			});
		}
	}

	return { items, warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadRules,
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPrompts,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});
