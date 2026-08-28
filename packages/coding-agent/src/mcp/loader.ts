import { logger } from "@oh-my-pi/pi-utils";
import type { LoadedCustomTool } from "../extensibility/custom-tools/types";
import { AgentStorage } from "../session/agent-storage";
import type { AuthStorage } from "../session/auth-storage";
import { type MCPLoadResult, MCPManager } from "./manager";
import type { McpConnectionStatusEvent } from "./startup-events";
import { MCPToolCache } from "./tool-cache";

export interface MCPToolsLoadResult {
	manager: MCPManager;

	tools: LoadedCustomTool[];

	errors: Array<{ path: string; error: string }>;

	connectedServers: string[];

	exaApiKeys: string[];
}

interface MCPToolsLoadOptions {
	onStatus?: (event: McpConnectionStatusEvent) => void;

	enableProjectConfig?: boolean;

	filterExa?: boolean;

	filterBrowser?: boolean;

	cacheStorage?: AgentStorage | null;

	authStorage?: AuthStorage;
}

async function resolveToolCache(storage: AgentStorage | null | undefined): Promise<MCPToolCache | null> {
	if (storage === null) return null;
	try {
		const resolved = storage ?? (await AgentStorage.open());
		return new MCPToolCache(resolved);
	} catch (error) {
		logger.warn("MCP tool cache unavailable", { error: String(error) });
		return null;
	}
}

export async function discoverAndLoadMCPTools(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
	const toolCache = await resolveToolCache(options?.cacheStorage);
	const manager = new MCPManager(cwd, toolCache);
	if (options?.authStorage) {
		manager.setAuthStorage(options.authStorage);
	}

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect({
			onStatus: options?.onStatus,
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: options?.filterBrowser,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			manager,
			tools: [],
			errors: [{ path: ".mcp.json", error: message }],
			connectedServers: [],
			exaApiKeys: [],
		};
	}

	const loadedTools: LoadedCustomTool[] = result.tools.map(tool => {
		const mcpTool = tool as { mcpServerName?: string };
		const serverName = mcpTool.mcpServerName;

		const connection = serverName ? manager.getConnection(serverName) : undefined;
		const source = serverName ? manager.getSource(serverName) : undefined;
		const providerName =
			connection?._source?.providerName ?? source?.providerName ?? connection?._source?.provider ?? source?.provider;

		const path = serverName && providerName ? `mcp:${serverName} via ${providerName}` : `mcp:${tool.name}`;

		return {
			path,
			resolvedPath: `mcp:${tool.name}`,
			tool: tool as any,
		};
	});

	const errors: Array<{ path: string; error: string }> = [];
	for (const [serverName, errorMsg] of result.errors) {
		errors.push({ path: `mcp:${serverName}`, error: errorMsg });
	}

	return {
		manager,
		tools: loadedTools,
		errors,
		connectedServers: result.connectedServers,
		exaApiKeys: result.exaApiKeys,
	};
}
