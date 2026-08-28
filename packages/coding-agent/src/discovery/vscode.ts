import { tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep, getProjectPath } from "./helpers";

const PROVIDER_ID = "vscode";
const DISPLAY_NAME = "VS Code";
const PRIORITY = 20;

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from .vscode/mcp.json",
	priority: PRIORITY,
	async load(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
		const items: MCPServer[] = [];
		const warnings: string[] = [];

		const projectPath = getProjectPath(ctx, "vscode", "mcp.json");
		if (projectPath) {
			const result = await loadMCPConfig(ctx, projectPath, "project");
			items.push(...result.items);
			if (result.warnings) warnings.push(...result.warnings);
		}

		return { items, warnings };
	},
});

async function loadMCPConfig(
	_ctx: LoadContext,
	path: string,
	level: "user" | "project",
): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const content = await readFile(path);
	if (!content) {
		warnings.push(`Failed to read ${path}`);
		return { items, warnings };
	}

	const parsed = tryParseJson<{ mcp?: { servers?: Record<string, unknown> } }>(content);
	if (!parsed) {
		warnings.push(`Invalid JSON in ${path}`);
		return { items, warnings };
	}

	const servers = parsed.mcp?.servers;
	if (!servers || typeof servers !== "object") {
		return { items, warnings };
	}

	for (const [name, config] of Object.entries(servers)) {
		if (!config || typeof config !== "object") {
			warnings.push(`Invalid config for server "${name}" in ${path}`);
			continue;
		}

		const raw = config as Record<string, unknown>;

		const expanded = expandEnvVarsDeep(raw);

		const server: MCPServer = {
			name,
			enabled: typeof expanded.enabled === "boolean" ? expanded.enabled : undefined,
			command: typeof expanded.command === "string" ? expanded.command : undefined,
			args: Array.isArray(expanded.args) ? (expanded.args as string[]) : undefined,
			env: expanded.env && typeof expanded.env === "object" ? (expanded.env as Record<string, string>) : undefined,
			url: typeof expanded.url === "string" ? expanded.url : undefined,
			headers:
				expanded.headers && typeof expanded.headers === "object"
					? (expanded.headers as Record<string, string>)
					: undefined,
			transport: ["stdio", "sse", "http"].includes(expanded.transport as string)
				? (expanded.transport as "stdio" | "sse" | "http")
				: undefined,
			timeout: typeof expanded.timeout === "number" ? expanded.timeout : undefined,
			_source: createSourceMeta(PROVIDER_ID, path, level),
		};

		items.push(server);
	}

	return { items, warnings };
}
