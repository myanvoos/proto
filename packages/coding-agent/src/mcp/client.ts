import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { createMCPTimeout, describeMCPTimeout, resolveMCPTimeoutMs } from "./timeout";
import { HttpTransport } from "./transports/http";
import { LegacySseTransport } from "./transports/sse";
import { StdioTransport } from "./transports/stdio";
import type {
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types";

import { MCP_PROTOCOL_VERSION } from "./types";

const CLIENT_INFO = {
	name: "proto-coding-agent",
	version: "1.0.0",
};

async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

function createTransport(config: MCPServerConfig): MCPTransport {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return new StdioTransport(config as MCPStdioServerConfig);
		case "http":
			return new HttpTransport(config as MCPHttpServerConfig);
		case "sse":
			return new LegacySseTransport(config as MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortReason(signal);
}

async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;

		onInitialized?: () => void | Promise<void>;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);

	throwIfAborted(options?.signal);

	transport.setProtocolVersion?.(result.protocolVersion);

	await transport.notify("notifications/initialized", undefined, { signal: options?.signal });
	throwIfAborted(options?.signal);

	await options?.onInitialized?.();
	throwIfAborted(options?.signal);

	return result;
}

export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	const timeout = createMCPTimeout(timeoutMs, options?.signal);
	const signal = timeout.signal;

	try {
		throwIfAborted(signal);
		const connectedTransport = createTransport(config);
		try {
			await connectedTransport.connect({ signal });
			throwIfAborted(signal);

			if (options?.onNotification) {
				connectedTransport.onNotification = options.onNotification;
			}

			connectedTransport.onRequest = options?.onRequest ?? defaultRequestHandler;

			const initResult = await initializeConnection(connectedTransport, {
				signal,
				async onInitialized() {
					if (connectedTransport.startSSEListener) await connectedTransport.startSSEListener({ signal });
				},
			});

			return {
				name,
				config,
				transport: connectedTransport,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				instructions: initResult.instructions,
			};
		} catch (error) {
			await connectedTransport.close({ signal }).catch(() => {});
			throw error;
		}
	} catch (error) {
		if (timeout.timedOut()) {
			throw new Error(`Connection to MCP server "${name}" timed out after ${describeMCPTimeout(timeoutMs)}`);
		}
		throw error;
	} finally {
		timeout.clear();
	}
}

export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	if (!connection.capabilities.tools) {
		return [];
	}

	if (connection.tools) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPToolsListResult>("tools/list", params, options);
		allTools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);

	connection.tools = allTools;

	return allTools;
}

export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	return connection.transport.request<MCPToolCallResult>(
		"tools/call",
		params as unknown as Record<string, unknown>,
		options,
	);
}

export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourcesListResult>("resources/list", params, options);
		allResources.push(...result.resources);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resources = allResources;
	return allResources;
}

function isMethodNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("-32601") || /method not found/i.test(message);
}

export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	try {
		do {
			const params: Record<string, unknown> = {};
			if (cursor) {
				params.cursor = cursor;
			}

			const result = await connection.transport.request<MCPResourceTemplatesListResult>(
				"resources/templates/list",
				params,
				options,
			);
			allTemplates.push(...result.resourceTemplates);
			cursor = result.nextCursor;
		} while (cursor);
	} catch (error) {
		if (isMethodNotFoundError(error)) {
			connection.resourceTemplates = [];
			return [];
		}
		throw error;
	}

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	return connection.transport.request<MCPResourceReadResult>(
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPPromptsListResult>("prompts/list", params, options);
		allPrompts.push(...result.prompts);
		cursor = result.nextCursor;
	} while (cursor);

	connection.prompts = allPrompts;
	return allPrompts;
}

export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	return connection.transport.request<MCPGetPromptResult>(
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
}

export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
