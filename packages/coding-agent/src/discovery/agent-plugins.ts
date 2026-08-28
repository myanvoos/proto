import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getPluginsDir, isEnoent, normalizeFrontmatterKeys, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	type AgentPluginManifest,
	classifyAgentPluginRoot,
	parseAgentPluginMcp,
	validateAgentSkillFrontmatter,
} from "./agent-plugin-format";
import { resolveContainedPath } from "./contained-path";
import { compareSkillOrder, createSourceMeta, listClaudePluginRoots } from "./helpers";
import { listOmpExtensionRoots } from "./proto-extension-roots";

const PROVIDER_ID = "agent-plugins";
const DISPLAY_NAME = "Agent Plugins";
const DESCRIPTION = "Portable Agent Plugins packages (plugin.json, skills/, mcp.json) per agent-plugins.org";

const PRIORITY = 75;

interface CandidateRoot {
	path: string;
	level: "user" | "project";

	instanceKey: string;
}

async function listCandidateRoots(ctx: LoadContext): Promise<CandidateRoot[]> {
	const [marketplace, extensionRoots] = await Promise.all([
		listClaudePluginRoots(ctx.home, ctx.cwd),
		listOmpExtensionRoots(ctx),
	]);
	const seen = new Set<string>();
	const candidates: CandidateRoot[] = [];
	for (const root of marketplace.roots) {
		if (seen.has(root.path)) continue;
		seen.add(root.path);
		candidates.push({
			path: root.path,
			level: root.scope,
			instanceKey: root.marketplace === "__local__" ? `dir:${root.path}` : `${root.id}#${root.scope}`,
		});
	}
	for (const root of extensionRoots) {
		if (seen.has(root.path)) continue;
		seen.add(root.path);
		candidates.push({ path: root.path, level: root.level, instanceKey: `ext:${root.path}` });
	}
	return candidates;
}

function pluginDataDir(home: string, manifestName: string, instanceKey: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(instanceKey).digest("hex").slice(0, 16);
	return path.join(getPluginsDir(home), "data", `${manifestName}-${digest}`);
}

async function scanStandardSkills(realRoot: string, level: "user" | "project"): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	const skillsDir = await resolveContainedPath(realRoot, path.join(realRoot, "skills"));

	if (skillsDir.status === "missing") return { items, warnings };
	if (skillsDir.status === "outside") {
		warnings.push(`skills/ resolves outside the plugin root`);
		return { items, warnings };
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(skillsDir.realPath, { withFileTypes: true });
	} catch {
		warnings.push(`skills/ does not resolve to a directory`);
		return { items, warnings };
	}

	await Promise.all(
		entries.map(async entry => {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) return;

			const resolved = await resolveContainedPath(realRoot, path.join(skillsDir.realPath, entry.name, "SKILL.md"));
			if (resolved.status === "missing") return;
			if (resolved.status === "outside") {
				warnings.push(`Skipping skill "${entry.name}": SKILL.md resolves outside the plugin root`);
				return;
			}
			const skillPath = resolved.realPath;
			let stat: Stats;
			try {
				stat = await fs.stat(skillPath);
			} catch {
				return;
			}
			if (!stat.isFile()) return;
			const content = await readFile(skillPath);
			if (content === null) {
				warnings.push(`Skipping skill "${entry.name}": failed to read SKILL.md`);
				return;
			}

			let rawFrontmatter: Record<string, unknown>;
			let body: string;
			try {
				({ frontmatter: rawFrontmatter, body } = parseFrontmatter(content, {
					source: skillPath,
					level: "fatal",
					repair: false,
					rawKeys: true,
				}));
			} catch {
				warnings.push(`Skipping skill "${entry.name}": malformed YAML frontmatter`);
				return;
			}

			const violation = validateAgentSkillFrontmatter(rawFrontmatter, entry.name);
			if (violation !== null) {
				warnings.push(`Skipping skill "${entry.name}": ${violation}`);
				return;
			}

			const frontmatter = normalizeFrontmatterKeys(rawFrontmatter) as SkillFrontmatter;
			items.push({
				name: entry.name,
				containRoot: realRoot,
				path: skillPath,
				content: body,
				frontmatter,
				level,
				_source: createSourceMeta(PROVIDER_ID, skillPath, level),
			});
		}),
	);

	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return { items, warnings };
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const candidates = await listCandidateRoots(ctx);
	const results = await Promise.all(
		candidates.map(async (candidate): Promise<LoadResult<Skill>> => {
			const status = await classifyAgentPluginRoot(candidate.path);
			if (status.kind === "none") return { items: [] };
			if (status.kind === "invalid") {
				return { items: [], warnings: [`[agent-plugins] Rejected plugin at ${candidate.path}: ${status.reason}`] };
			}
			const scan = await scanStandardSkills(status.realRoot, candidate.level);
			return {
				items: scan.items,
				warnings: [...status.warnings, ...(scan.warnings ?? [])].map(
					warning => `[agent-plugins] ${status.manifest.name}: ${warning}`,
				),
			};
		}),
	);
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

async function loadPluginMCPServers(
	realRoot: string,
	manifest: AgentPluginManifest,
	candidate: CandidateRoot,
	home: string,
): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const resolved = await resolveContainedPath(realRoot, path.join(realRoot, "mcp.json"));
	if (resolved.status === "missing") return { items, warnings };
	if (resolved.status === "outside") {
		warnings.push(`mcp.json resolves outside the plugin root`);
		return { items, warnings };
	}
	const mcpPath = resolved.realPath;

	let stat: Stats;
	try {
		stat = await fs.stat(mcpPath);
	} catch (err) {
		if (!isEnoent(err)) warnings.push(`Failed to read mcp.json: ${String(err)}`);
		return { items, warnings };
	}
	if (!stat.isFile()) {
		warnings.push(`mcp.json does not resolve to a regular file`);
		return { items, warnings };
	}
	const raw = await readFile(mcpPath);
	if (raw === null) {
		warnings.push(`Failed to read mcp.json`);
		return { items, warnings };
	}

	const pluginData = pluginDataDir(home, manifest.name, candidate.instanceKey);
	const result = await parseAgentPluginMcp(raw, { pluginRoot: realRoot, pluginData });
	if (result.status === "disabled") {
		warnings.push(`MCP disabled: ${result.reason}`);
		return { items, warnings };
	}
	warnings.push(...result.warnings);

	if (result.servers.some(server => server.transport === "stdio")) {
		await fs.mkdir(pluginData, { recursive: true });
	}

	for (const server of result.servers) {
		items.push({
			name: `${manifest.name}:${server.name}`,
			transport: server.transport,
			...(server.command !== undefined && { command: server.command }),
			...(server.args !== undefined && { args: server.args }),
			...(server.env !== undefined && { env: server.env }),

			...(server.command !== undefined && { envPolicy: "literal" as const }),
			...(server.cwd !== undefined && { cwd: server.cwd }),
			...(server.url !== undefined && { url: server.url }),
			...(server.headers !== undefined && { headers: server.headers }),

			...(server.url !== undefined && { headerPolicy: "origin-locked" as const }),
			_source: createSourceMeta(PROVIDER_ID, mcpPath, candidate.level),
		});
	}
	return { items, warnings };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const candidates = await listCandidateRoots(ctx);
	const results = await Promise.all(
		candidates.map(async (candidate): Promise<LoadResult<MCPServer>> => {
			const status = await classifyAgentPluginRoot(candidate.path);

			if (status.kind !== "standard") return { items: [] };
			const loaded = await loadPluginMCPServers(status.realRoot, status.manifest, candidate, ctx.home);
			return {
				items: loaded.items,
				warnings: (loaded.warnings ?? []).map(warning => `[agent-plugins] ${status.manifest.name}: ${warning}`),
			};
		}),
	);
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});
