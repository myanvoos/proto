import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";
import { INTENT_FIELD, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../capability/types";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import { resolveLocalUrlToFile } from "../internal-urls/local-protocol";
import type { Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import { normalizeLocalScheme } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { callTool } from "./client";
import { sanitizeMCPDiagnostic } from "./errors";
import { renderMCPCall, renderMCPResult } from "./render";
import type {
	MCPAuthChallenge,
	MCPContent,
	MCPServerConnection,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
} from "./types";

export type MCPReconnect = (options?: { authChallenge?: MCPAuthChallenge }) => Promise<MCPServerConnection | null>;

const RETRIABLE_PATTERNS = [
	"econnrefused",
	"econnreset",
	"epipe",
	"enetunreach",
	"ehostunreach",
	"fetch failed",
	"transport not connected",
	"transport closed",
	"network error",
];

export function isRetriableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();

	if (/^http (404|502|503):/.test(msg)) return true;
	return RETRIABLE_PATTERNS.some(p => msg.includes(p));
}

type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;

function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

function isUnusedOptionalPlaceholder(value: unknown): boolean {
	return (
		value === undefined ||
		value === "" ||
		(typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
	);
}

function omitUnusedOptionalArgs(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	const properties = inputSchema.properties;
	if (!properties) return args;

	let cleaned: MCPToolArgs | undefined;
	const required = new Set(inputSchema.required ?? []);
	for (const [key, value] of Object.entries(args)) {
		if (required.has(key) || !Object.hasOwn(properties, key) || !isUnusedOptionalPlaceholder(value)) {
			continue;
		}
		cleaned ??= { ...args };
		delete cleaned[key];
	}

	return cleaned ?? args;
}

function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (inputSchema.properties && Object.hasOwn(inputSchema.properties, INTENT_FIELD)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

async function resolveOutboundLocalUrlArgs(
	value: unknown,
	context: CustomToolContext,
	seen: WeakSet<object> = new WeakSet(),
): Promise<unknown> {
	if (typeof value === "string") {
		const normalized = normalizeLocalScheme(value);
		if (!normalized.startsWith("local://")) return value;
		const localFile = await resolveLocalUrlToFile(normalized, {
			cwd: context.sessionManager?.getCwd?.(),
			settings: context.settings,
			localProtocolOptions: context.localProtocolOptions,
		});
		return localFile?.path ?? value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (Array.isArray(value)) {
		let resolved: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = await resolveOutboundLocalUrlArgs(item, context, seen);
			if (next === item && !resolved) continue;
			resolved ??= value.slice();
			resolved[index] = next;
		}
		return resolved ?? value;
	}

	const input = value as Record<string, unknown>;
	let resolved: Record<string, unknown> | undefined;
	for (const key in input) {
		const item = input[key];
		const next = await resolveOutboundLocalUrlArgs(item, context, seen);
		if (next === item && !resolved) continue;
		resolved ??= { ...input };
		resolved[key] = next;
	}
	return resolved ?? value;
}

async function prepareOutboundArgs(
	params: unknown,
	inputSchema: MCPToolDefinition["inputSchema"],
	context: CustomToolContext,
): Promise<MCPToolArgs> {
	const args = omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
	return (await resolveOutboundLocalUrlArgs(args, context)) as MCPToolArgs;
}

export interface MCPToolDetails {
	serverName: string;

	mcpToolName: string;

	isError?: boolean;

	rawContent?: MCPContent[];

	mcpMeta?: Record<string, unknown>;

	provider?: string;

	providerName?: string;

	meta?: OutputMeta;
}

function formatMCPContent(content: MCPContent[]): Array<TextContent | ImageContent> {
	const blocks: Array<TextContent | ImageContent> = [];
	let text = "";
	const flushText = () => {
		if (!text) return;
		blocks.push({ type: "text", text });
		text = "";
	};
	const appendText = (value: string) => {
		text += text ? `\n\n${value}` : value;
	};

	for (const item of content) {
		switch (item.type) {
			case "text":
				appendText(item.text);
				break;
			case "image":
				flushText();
				blocks.push(item);
				break;
			case "resource":
				appendText(
					item.resource.text
						? `[Resource: ${item.resource.uri}]\n${item.resource.text}`
						: `[Resource: ${item.resource.uri}]`,
				);
				break;
		}
	}
	flushText();
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function buildResult(
	result: MCPToolCallResult,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const content = formatMCPContent(result.content);
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: result.isError,
		rawContent: result.content,
		mcpMeta: result._meta,
		provider,
		providerName,
	};
	if (result.isError) {
		if (content[0]?.type === "text") {
			content[0] = { type: "text", text: `Error: ${content[0].text}` };
		} else {
			content.unshift({ type: "text", text: "Error:" });
		}
	}
	const toolResult: CustomToolResult<MCPToolDetails> = { content, details };
	if (result.isError) {
		toolResult.isError = true;
	}
	return toolResult;
}

function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const message = sanitizeMCPDiagnostic(error instanceof Error ? error.message : String(error));
	return {
		content: [{ type: "text", text: `MCP error: ${message}` }],
		details: { serverName, mcpToolName, isError: true, provider, providerName },
		isError: true,
	};
}

type MCPToolCallAttempt = {
	connection: MCPServerConnection;
	result?: MCPToolCallResult;
	error?: unknown;
};

function getMcpAuthChallenge(result: MCPToolCallResult): MCPAuthChallenge | undefined {
	if (!result.isError) return undefined;
	const values = result._meta?.["mcp/www_authenticate"];
	if (!Array.isArray(values)) return undefined;
	const wwwAuthenticate = values.filter((value): value is string => typeof value === "string" && value.trim() !== "");
	return wwwAuthenticate.length > 0 ? { wwwAuthenticate } : undefined;
}

async function callToolWithAuthRetry(
	connection: MCPServerConnection,
	toolName: string,
	args: MCPToolArgs,
	reconnect: MCPReconnect | undefined,
	signal?: AbortSignal,
): Promise<MCPToolCallAttempt> {
	const result = await callTool(connection, toolName, args, { signal });
	const authChallenge = getMcpAuthChallenge(result);
	if (!authChallenge || !reconnect) return { connection, result };

	let newConnection: MCPServerConnection | null;
	try {
		newConnection = await reconnectWithAbort(reconnect, signal, { authChallenge });
	} catch (error) {
		rethrowIfAborted(error, signal);
		return { connection, error };
	}
	if (!newConnection) return { connection, result };

	try {
		return {
			connection: newConnection,
			result: await callTool(newConnection, toolName, args, { signal }),
		};
	} catch (error) {
		rethrowIfAborted(error, signal);
		return { connection: newConnection, error };
	}
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
	if (error instanceof ToolAbortError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
	if (signal?.aborted) throw new ToolAbortError();
}

async function reconnectWithAbort(
	reconnect: MCPReconnect,
	signal?: AbortSignal,
	options?: { authChallenge?: MCPAuthChallenge },
): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, () => reconnect(options));
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

const MAX_MCP_TOOL_NAME_LENGTH = 64;

const MCP_TOOL_NAME_HASH_LENGTH = 8;

function capMCPToolNameLength(name: string): string {
	if (name.length <= MAX_MCP_TOOL_NAME_LENGTH) return name;
	const hash = Bun.hash(name).toString(36).slice(0, MCP_TOOL_NAME_HASH_LENGTH);
	const keep = MAX_MCP_TOOL_NAME_LENGTH - hash.length - 1;
	return `${name.slice(0, keep)}_${hash}`;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");

	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return capMCPToolNameLength(`mcp__${sanitizedServerName}_${normalizedToolName}`);
}

interface MCPToolOriginSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

export function getMCPToolOriginKey(tool: MCPToolOriginSource): string | undefined {
	if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") return undefined;
	return `${tool.mcpServerName}\u0000${tool.mcpToolName}`;
}

export function deduplicateMCPToolsByName<T extends MCPToolOriginSource>(tools: readonly T[]): T[] {
	const deduplicated: T[] = [];
	const registered = new Map<string, { tool: T; originKey: string; index: number }>();

	for (const tool of tools) {
		const originKey = getMCPToolOriginKey(tool);
		if (originKey === undefined) {
			deduplicated.push(tool);
			continue;
		}
		const existing = registered.get(tool.name);
		if (!existing) {
			registered.set(tool.name, { tool, originKey, index: deduplicated.length });
			deduplicated.push(tool);
			continue;
		}

		if (existing.originKey === originKey) continue;

		const keepExisting = existing.originKey < originKey;
		const winner = keepExisting ? existing.tool : tool;
		const loser = keepExisting ? tool : existing.tool;
		if (!keepExisting) {
			deduplicated[existing.index] = tool;
			existing.tool = tool;
			existing.originKey = originKey;
		}
		logger.warn("MCP tool name collision; keeping stable winner", {
			name: tool.name,
			keptServer: winner.mcpServerName,
			keptTool: winner.mcpToolName,
			ignoredServer: loser.mcpServerName,
			ignoredTool: loser.mcpToolName,
		});
	}

	return deduplicated;
}

export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp__")) return null;

	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;

	readonly mcpToolName: string;

	readonly mcpServerName: string;

	readonly mergeCallAndResult = true;

	readonly strict = false as const;

	static fromTools(connection: MCPServerConnection, tools: MCPToolDefinition[], reconnect?: MCPReconnect): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${connection.name}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = connection.name;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		const provider = this.connection._source?.provider;
		const providerName = this.connection._source?.providerName;

		try {
			const attempt = await callToolWithAuthRetry(this.connection, this.tool.name, args, this.reconnect, signal);
			if (attempt.error !== undefined) {
				return buildErrorResult(attempt.error, this.connection.name, this.tool.name, provider, providerName);
			}
			if (!attempt.result) {
				return buildErrorResult(
					new Error("MCP tool call returned no result"),
					this.connection.name,
					this.tool.name,
					provider,
					providerName,
				);
			}
			this.connection = attempt.connection;
			return buildResult(
				attempt.result,
				attempt.connection.name,
				this.tool.name,
				attempt.connection._source?.provider ?? provider,
				attempt.connection._source?.providerName ?? providerName,
			);
		} catch (error) {
			rethrowIfAborted(error, signal);
			if (this.reconnect && isRetriableConnectionError(error)) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					this.connection = newConn;
					const retryProvider = newConn._source?.provider ?? provider;
					const retryProviderName = newConn._source?.providerName ?? providerName;
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal });
						return buildResult(result, newConn.name, this.tool.name, retryProvider, retryProviderName);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(
							retryError,
							this.connection.name,
							this.tool.name,
							retryProvider,
							retryProviderName,
						);
					}
				}
			}
			return buildErrorResult(error, this.connection.name, this.tool.name, provider, providerName);
		}
	}
}

export class DeferredMCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;

	readonly mcpToolName: string;

	readonly mcpServerName: string;

	readonly mergeCallAndResult = true;

	readonly strict = false as const;

	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;

	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
	): DeferredMCPTool[] {
		return tools.map(tool => new DeferredMCPTool(serverName, tool, getConnection, source, reconnect));
	}

	constructor(
		private readonly serverName: string,
		private readonly tool: MCPToolDefinition,
		private readonly getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(serverName, tool.name);
		this.label = `${serverName}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${serverName}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.#fallbackProvider = source?.provider;
		this.#fallbackProviderName = source?.providerName;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		const provider = this.#fallbackProvider;
		const providerName = this.#fallbackProviderName;

		try {
			const connection = await untilAborted(signal, () => this.getConnection());
			throwIfAborted(signal);
			try {
				const attempt = await callToolWithAuthRetry(connection, this.tool.name, args, this.reconnect, signal);
				if (attempt.error !== undefined) {
					return buildErrorResult(
						attempt.error,
						this.serverName,
						this.tool.name,
						attempt.connection._source?.provider ?? provider,
						attempt.connection._source?.providerName ?? providerName,
					);
				}
				if (!attempt.result) {
					return buildErrorResult(
						new Error("MCP tool call returned no result"),
						this.serverName,
						this.tool.name,
						provider,
						providerName,
					);
				}
				return buildResult(
					attempt.result,
					this.serverName,
					this.tool.name,
					attempt.connection._source?.provider ?? provider,
					attempt.connection._source?.providerName ?? providerName,
				);
			} catch (callError) {
				rethrowIfAborted(callError, signal);
				if (this.reconnect && isRetriableConnectionError(callError)) {
					const newConn = await reconnectWithAbort(this.reconnect, signal);
					if (newConn) {
						const retryProvider = newConn._source?.provider ?? provider;
						const retryProviderName = newConn._source?.providerName ?? providerName;
						try {
							const result = await callTool(newConn, this.tool.name, args, { signal });
							return buildResult(result, this.serverName, this.tool.name, retryProvider, retryProviderName);
						} catch (retryError) {
							rethrowIfAborted(retryError, signal);
							return buildErrorResult(
								retryError,
								this.serverName,
								this.tool.name,
								retryProvider,
								retryProviderName,
							);
						}
					}
				}
				return buildErrorResult(callError, this.serverName, this.tool.name, provider, providerName);
			}
		} catch (connError) {
			rethrowIfAborted(connError, signal);
			if (this.reconnect) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal });
						return buildResult(
							result,
							this.serverName,
							this.tool.name,
							newConn._source?.provider ?? provider,
							newConn._source?.providerName ?? providerName,
						);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(retryError, this.serverName, this.tool.name, provider, providerName);
					}
				}
			}
			return buildErrorResult(connError, this.serverName, this.tool.name, provider, providerName);
		}
	}
}
