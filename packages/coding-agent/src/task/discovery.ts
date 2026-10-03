import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { isProviderEnabled } from "../capability";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { pluginUsesClaudeModelDialect } from "../discovery/agent-plugin-format";
import { listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/proto-extension-roots";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

const AGENT_CONFIG_SOURCE = ".proto";

export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
	/** Agent directories searched, in precedence order (for "unknown agent" diagnostics). */
	searchedDirs: string[];
}

interface AgentDirectory {
	dir: string;
	source: AgentSource;
	/** Drop `model:` frontmatter written as Claude Code aliases, which are not proto model selectors. */
	ignoreModel?: boolean;
}

async function loadAgentsFromDir({ dir, source, ignoreModel }: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => {
					const agent = parseAgent(filePath, content, source, "warn");
					if (ignoreModel) agent.model = undefined;
					return agent;
				})
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

export async function discoverAgents(cwd: string, home: string = os.homedir()): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	const extensionRoots = isProviderEnabled("proto-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null })
		: [];
	for (const root of extensionRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const sortedPluginRoots = [...pluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	// Claude Code aliases such as `sonnet` are not proto selectors; such agents inherit the parent's model unless
	// settings override it.
	const pluginModelDrops = await Promise.all(
		sortedPluginRoots.map(plugin => pluginUsesClaudeModelDialect(plugin.path)),
	);
	for (const [index, plugin] of sortedPluginRoots.entries()) {
		orderedDirs.push({
			dir: path.join(plugin.path, "agents"),
			source: plugin.scope === "project" ? "project" : "user",
			ignoreModel: pluginModelDrops[index],
		});
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(loadAgentsFromDir))).flat().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return {
		agents: [...loadedAgents, ...bundledAgents],
		projectAgentsDir,
		searchedDirs: orderedDirs.map(entry => entry.dir),
	};
}

export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
