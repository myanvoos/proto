import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../mcp/manager";
import type { MCPResourceReadResult } from "../mcp/types";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUriTemplateMatchScore(
	uri: string,
	uriTemplate: string,
): { literalChars: number; expressionCount: number } | undefined {
	const expressionPattern = /\{[^}]+\}/g;
	const literalSegments = uriTemplate.split(expressionPattern);
	const expressionCount = (uriTemplate.match(expressionPattern) ?? []).length;
	const pattern = literalSegments.map(escapeRegex).join("(.*?)");
	const regex = new RegExp(`^${pattern}$`);
	if (!regex.test(uri)) return undefined;
	const literalChars = literalSegments.reduce((total, segment) => total + segment.length, 0);
	return { literalChars, expressionCount };
}

function extractResourceUri(url: InternalUrl): string {
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (scheme !== "mcp") {
		return url.rawHref ?? url.href;
	}

	const host = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/";
	const uri = `${host}${hasPath ? rawPathname : ""}${url.search}${url.hash}`.trim();
	if (!uri) {
		throw new Error("mcp:// URL requires a resource URI: mcp://<resource-uri>");
	}
	return uri;
}

function resolveTargetServer(mcpManager: MCPManager, uri: string, exact = false): string | undefined {
	const servers = mcpManager.getConnectedServers();
	for (const name of servers) {
		const serverResources = mcpManager.getServerResources(name);
		if (serverResources?.resources.some(r => r.uri === uri)) {
			return name;
		}
	}

	if (exact) return undefined;

	let bestTemplateMatch:
		| {
				serverName: string;
				literalChars: number;
				expressionCount: number;
				serverIndex: number;
				templateIndex: number;
		  }
		| undefined;

	for (const [serverIndex, name] of servers.entries()) {
		const serverResources = mcpManager.getServerResources(name);
		if (!serverResources) continue;

		for (const [templateIndex, template] of serverResources.templates.entries()) {
			const match = getUriTemplateMatchScore(uri, template.uriTemplate);
			if (!match) continue;

			const isBetterMatch =
				!bestTemplateMatch ||
				match.literalChars > bestTemplateMatch.literalChars ||
				(match.literalChars === bestTemplateMatch.literalChars &&
					(match.expressionCount < bestTemplateMatch.expressionCount ||
						(match.expressionCount === bestTemplateMatch.expressionCount &&
							(serverIndex < bestTemplateMatch.serverIndex ||
								(serverIndex === bestTemplateMatch.serverIndex &&
									templateIndex < bestTemplateMatch.templateIndex)))));

			if (isBetterMatch) {
				bestTemplateMatch = {
					serverName: name,
					literalChars: match.literalChars,
					expressionCount: match.expressionCount,
					serverIndex,
					templateIndex,
				};
			}
		}
	}

	return bestTemplateMatch?.serverName;
}

function formatAvailableResources(mcpManager: MCPManager): string {
	const available = mcpManager
		.getConnectedServers()
		.flatMap(name => {
			const serverResources = mcpManager.getServerResources(name);
			if (!serverResources) return [];
			const concrete = serverResources.resources.map(r => `  ${r.uri} (${name})`);
			const templates = serverResources.templates.map(t => `  ${t.uriTemplate} (${name}, template)`);
			return [...concrete, ...templates];
		})
		.join("\n");
	return available || "  (none)";
}

/** Exact advertised URIs let MCP publish skills without claiming loaded skill names. */
export async function readMcpResource(
	mcpManager: MCPManager,
	url: InternalUrl,
	options: { exact?: boolean; waitMs?: number; signal?: AbortSignal } = {},
): Promise<InternalResource | undefined> {
	const { exact = false, waitMs, signal } = options;
	const uri = extractResourceUri(url);
	let targetServer = resolveTargetServer(mcpManager, uri, exact);
	if (!targetServer) {
		const settleCatalogs = async (): Promise<void> => {
			await Promise.allSettled(mcpManager.getConnectedServers().map(name => mcpManager.ensureServerResources(name)));
			if (resolveTargetServer(mcpManager, uri, exact)) return;
			await mcpManager.waitForPendingConnections();
			await Promise.allSettled(mcpManager.getConnectedServers().map(name => mcpManager.ensureServerResources(name)));
		};
		const settling = settleCatalogs();
		await untilAborted(
			signal,
			waitMs === undefined ? settling : withTimeout(settling, waitMs, "MCP wait budget spent").catch(() => {}),
		);
		targetServer = resolveTargetServer(mcpManager, uri, exact);
	}
	if (!targetServer) return undefined;
	let result: MCPResourceReadResult | undefined;
	try {
		result = await mcpManager.readServerResource(targetServer, uri);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`MCP resource read error: ${message}`);
	}

	if (!result) {
		throw new Error(`Server "${targetServer}" returned no content for "${uri}".`);
	}

	const textParts: string[] = [];
	for (const item of result.contents) {
		if (item.text !== undefined && item.text !== null) {
			textParts.push(item.text);
		} else if (item.blob) {
			textParts.push(`[Binary content: ${item.mimeType ?? "unknown"}, base64 length ${item.blob.length}]`);
		}
	}

	const content = textParts.length > 0 ? textParts.join("\n---\n") : "(empty resource)";
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [`MCP server: ${targetServer}`],
	};
}

export class McpResourceNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpResourceNotFoundError";
	}
}

export class McpProtocolHandler implements ProtocolHandler {
	readonly scheme = "mcp";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const manager = MCPManager.instance();
		if (!manager) throw new Error("No MCP manager available. MCP servers may not be configured.");
		const resource = await readMcpResource(manager, url, { signal: context?.signal });
		if (resource) return resource;
		throw new McpResourceNotFoundError(
			`No MCP server has resource "${extractResourceUri(url)}".\n\nAvailable resources:\n${formatAvailableResources(manager)}`,
		);
	}
}
