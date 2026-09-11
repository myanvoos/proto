import * as path from "node:path";
import * as url from "node:url";
import { isDefinitiveOAuthFailure, type TSchema } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../capability/types";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type AuthStorage, REMOTE_REFRESH_SENTINEL } from "../session/auth-storage";
import {
	connectToServer,
	disconnectServer,
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import { type LoadMCPConfigsResult, loadAllMCPConfigs, validateServerConfig } from "./config";
import {
	lookupMcpOAuthCredential,
	type MCPOAuthCredentialLookup,
	refreshManagedMcpOAuthCredential,
	selectMcpOAuthRefreshMaterial,
} from "./oauth-credentials";
import type { MCPStoredOAuthCredential } from "./oauth-flow";
import type { McpConnectionStatusEvent } from "./startup-events";
import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { setGeneratedHeader } from "./transports/header-policy";
import type {
	MCPAuthChallenge,
	MCPGetPromptResult,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolDefinition,
	MCPTransport,
} from "./types";
import { MCPNotificationMethods } from "./types";

type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

interface AuthRefreshableMCPTransport extends MCPTransport {
	onAuthError?: () => Promise<Record<string, string> | null>;
}

function isAuthRefreshableMCPTransport(transport: MCPTransport): transport is AuthRefreshableMCPTransport {
	return "onAuthError" in transport;
}
type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

const STARTUP_TIMEOUT_MS = 250;

function createMcpStartupFailure(serverName: string, error: string, source?: SourceMeta): McpConnectionStatusEvent {
	return source
		? { type: "failed", serverName, error, sourcePath: source.path }
		: { type: "failed", serverName, error };
}

const RECONNECT_BURST_WINDOW_MS = 30_000;
const RECONNECT_BURST_LIMIT = 5;

const NOTIFICATION_BUFFER_CAP = 100;

function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = { promise, status: "pending" };
	promise.then(
		value => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		reason => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return tracked;
}

function deleteUnchangedMapEntries<K, V>(map: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
	for (const [key, value] of snapshot) {
		if (map.get(key) === value) map.delete(key);
	}
}

function delay(ms: number): Promise<void> {
	return Bun.sleep(ms);
}

export function sortMCPToolsByName<T extends { name: string }>(tools: T[]): T[] {
	tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return tools;
}

export function resolveSubscriptionPostAction(
	notificationsEnabled: boolean,
	currentEpoch: number,
	subscriptionEpoch: number,
): "rollback" | "ignore" | "apply" {
	if (!notificationsEnabled) return "rollback";
	if (currentEpoch !== subscriptionEpoch) return "ignore";
	return "apply";
}

export interface MCPLoadResult {
	tools: CustomTool<TSchema, MCPToolDetails>[];

	errors: Map<string, string>;

	connectedServers: string[];

	exaApiKeys: string[];
}

interface MCPDiscoverOptions {
	enableProjectConfig?: boolean;

	filterExa?: boolean;

	filterBrowser?: boolean;

	onStatus?: (event: McpConnectionStatusEvent) => void;
}

type MCPAuthHandler = (serverName: string, challenge: MCPAuthChallenge) => Promise<MCPServerConfig | undefined>;

export class MCPManager {
	static #instance: MCPManager | undefined;

	static instance(): MCPManager | undefined {
		return MCPManager.#instance;
	}

	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	static resetForTests(): void {
		MCPManager.#instance = undefined;
	}

	#connections = new Map<string, MCPServerConnection>();
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#sources = new Map<string, SourceMeta>();
	#authStorage: AuthStorage | null = null;
	#authHandler?: MCPAuthHandler;
	#notificationListeners = new Set<(serverName: string, method: string, params: unknown) => void>();

	#pendingNotifications: Array<{ server: string; method: string; params: unknown }> = [];
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>;
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();

	#serverConfigs = new Map<string, MCPServerConfig>();

	#reconnectHistory = new Map<string, number[]>();

	#epoch = 0;
	#disposed = false;
	#disposeCall?: Promise<void>;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
	) {}

	addNotificationListener(listener: (serverName: string, method: string, params: unknown) => void): () => void {
		const wasEmpty = this.#notificationListeners.size === 0;
		this.#notificationListeners.add(listener);

		if (wasEmpty && this.#pendingNotifications.length > 0) {
			const pending = this.#pendingNotifications.splice(0);
			for (const frame of pending) {
				try {
					listener(frame.server, frame.method, frame.params);
				} catch (error) {
					logger.debug("MCP notification listener threw during buffered drain", {
						path: `mcp:${frame.server}`,
						method: frame.method,
						error,
					});
				}
			}
		}

		return () => {
			this.#notificationListeners.delete(listener);
		};
	}

	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>): void {
		this.#onToolsChanged = handler;
	}

	setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void {
		this.#onResourcesChanged = handler;
	}

	setOnPromptsChanged(handler: (serverName: string) => void): void {
		this.#onPromptsChanged = handler;

		for (const [name, connection] of this.#connections) {
			if (connection.prompts?.length) {
				handler(name);
			}
		}
	}

	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		void subscribeToResources(connection, uris)
			.then(() => {
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					void unsubscribeFromResources(connection, uris).catch(error => {
						logger.debug("Failed to rollback stale MCP resource subscription", {
							path: `mcp:${name}`,
							error,
						});
					});
					return;
				}
				if (action === "ignore") {
					return;
				}
				this.#subscribedResources.set(name, new Set(uris));
			})
			.catch(error => {
				logger.debug("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			});
	}

	setNotificationsEnabled(enabled: boolean): void {
		const wasEnabled = this.#notificationsEnabled;
		this.#notificationsEnabled = enabled;
		if (enabled === wasEnabled) return;

		this.#notificationsEpoch += 1;
		const notificationEpoch = this.#notificationsEpoch;

		if (enabled) {
			for (const [name, connection] of this.#connections) {
				if (connection.capabilities.resources?.subscribe && connection.resources) {
					const uris = connection.resources.map(r => r.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		for (const [name, connection] of this.#connections) {
			const uris = this.#subscribedResources.get(name);
			if (uris && uris.size > 0) {
				void unsubscribeFromResources(connection, Array.from(uris)).catch(error => {
					logger.debug("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
				});
			}
		}
		this.#subscribedResources.clear();
	}

	setAuthStorage(authStorage: AuthStorage): void {
		this.#authStorage = authStorage;
	}

	setAuthHandler(handler: MCPAuthHandler | undefined): void {
		this.#authHandler = handler;
	}

	async discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		let loadedConfigs: LoadMCPConfigsResult;
		try {
			loadedConfigs = await loadAllMCPConfigs(this.cwd, {
				enableProjectConfig: options?.enableProjectConfig,
				filterExa: options?.filterExa,
				filterBrowser: options?.filterBrowser,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options?.onStatus?.({ type: "failed", serverName: ".mcp.json", error: message });
			throw error;
		}
		const { configs, exaApiKeys, sources } = loadedConfigs;
		const result = await this.connectServers(configs, sources, options?.onStatus);
		result.exaApiKeys = exaApiKeys;
		return result;
	}

	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<MCPLoadResult> {
		type ConnectionTask = {
			name: string;
			config: MCPServerConfig;
			tracked: TrackedPromise<ToolLoadResult>;
			toolsPromise: Promise<ToolLoadResult>;
		};

		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];
		const reportedErrors = new Set<string>();
		let allowBackgroundLogging = false;
		const statusServerNames: string[] = [];
		const validationFailures: Array<{ name: string; message: string }> = [];

		const connectionTasks: ConnectionTask[] = [];

		for (const [name, config] of Object.entries(configs)) {
			if (sources[name]) {
				this.#sources.set(name, sources[name]);
				const existing = this.#connections.get(name);
				if (existing) {
					existing._source = sources[name];
				}
			}

			if (this.#connections.has(name)) {
				connectedServers.add(name);
				continue;
			}

			if (
				this.#pendingConnections.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				continue;
			}

			statusServerNames.push(name);

			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				const message = validationErrors.join("; ");
				errors.set(name, message);
				validationFailures.push({ name, message });
				reportedErrors.add(name);
				continue;
			}

			this.#serverConfigs.set(name, config);
			const connectionEpoch = this.#epoch;

			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				return connectToServer(name, resolvedConfig, {
					onNotification: (method, params) => {
						this.#handleServerNotification(name, method, params);
					},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
				});
			})().then(
				async connection => {
					connection.config = config;
					if (sources[name]) {
						connection._source = sources[name];
					}

					if (this.#epoch !== connectionEpoch || this.#pendingConnections.get(name) !== connectionPromise) {
						this.#detachConnection(name, connection);
						void disconnectServer(connection).catch(() => {});
						throw new Error(`Server "${name}" was disconnected during initial connection`);
					}

					this.#pendingConnections.delete(name);
					this.#connections.set(name, connection);
					this.#serverConfigs.set(name, config);

					if (
						isAuthRefreshableMCPTransport(connection.transport) &&
						lookupMcpOAuthCredential(this.#authStorage, config)
					) {
						connection.transport.onAuthError = async () => {
							const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true });
							if (refreshed.type === "http" || refreshed.type === "sse") {
								return refreshed.headers ?? null;
							}
							return null;
						};
					}

					connection.transport.onClose = () => {
						logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
						void this.reconnectServer(name);
					};

					return connection;
				},
				error => {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
					}
					throw error;
				},
			);
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				try {
					const serverTools = await listTools(connection);
					return { connection, serverTools };
				} catch (error) {
					this.#detachConnection(name, connection);
					void disconnectServer(connection).catch(() => {});
					throw error;
				}
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({ name, config, tracked, toolsPromise });

			void toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const reconnect = (options?: { authChallenge?: MCPAuthChallenge }) =>
						this.reconnectServer(name, options);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
					this.#replaceServerTools(name, customTools);
					void this.#onToolsChanged?.(this.#tools);
					void this.toolCache?.set(name, config, serverTools);

					onStatus?.({ type: "connected", serverName: name });
					await this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const message = error instanceof Error ? error.message : String(error);
					onStatus?.(createMcpStartupFailure(name, message, sources[name]));
					if (!allowBackgroundLogging || reportedErrors.has(name)) return;
					logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
				});
		}

		if (statusServerNames.length > 0 && onStatus) {
			onStatus({ type: "connecting", serverNames: statusServerNames });
			for (const { name, message } of validationFailures) {
				onStatus(createMcpStartupFailure(name, message, sources[name]));
			}
		}

		if (connectionTasks.length > 0) {
			await Promise.race([
				Promise.allSettled(connectionTasks.map(task => task.tracked.promise)),
				delay(STARTUP_TIMEOUT_MS),
			]);

			const cachedTools = new Map<string, MCPToolDefinition[]>();
			const pendingTasks = connectionTasks.filter(task => task.tracked.status === "pending");

			if (pendingTasks.length > 0 && this.toolCache) {
				await Promise.all(
					pendingTasks.map(async task => {
						const cached = await this.toolCache?.get(task.name, task.config);
						if (cached) {
							cachedTools.set(task.name, cached);
						}
					}),
				);
			}

			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const value = task.tracked.value;
					if (!value) continue;
					const { connection, serverTools } = value;
					connectedServers.add(name);
					const reconnect = () => this.reconnectServer(name);
					allTools.push(...MCPTool.fromTools(connection, serverTools, reconnect));
				} else if (task.tracked.status === "rejected") {
					const message =
						task.tracked.reason instanceof Error ? task.tracked.reason.message : String(task.tracked.reason);
					errors.set(name, message);
					reportedErrors.add(name);
				} else {
					const cached = cachedTools.get(name);
					if (cached) {
						const source = this.#sources.get(name);
						const reconnect = () => this.reconnectServer(name);
						allTools.push(
							...DeferredMCPTool.fromTools(name, cached, () => this.waitForConnection(name), source, reconnect),
						);
					}
				}
			}
		}

		sortMCPToolsByName(allTools);

		this.#tools = allTools;
		allowBackgroundLogging = true;

		return {
			tools: allTools,
			errors,
			connectedServers: Array.from(connectedServers),
			exaApiKeys: [],
		};
	}

	#replaceServerTools(name: string, tools: CustomTool<TSchema, MCPToolDetails>[]): void {
		this.#tools = this.#tools.filter(t => t.mcpServerName !== name);
		this.#tools.push(...tools);

		sortMCPToolsByName(this.#tools);
	}

	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): Promise<void> {
		const refresh = (() => {
			switch (kind) {
				case "tools":
					return this.refreshServerTools(serverName);
				case "resources":
					return this.refreshServerResources(serverName);
				case "prompts":
					return this.refreshServerPrompts(serverName);
			}
		})();
		return refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	async #handleServerNotification(serverName: string, method: string, params: unknown): Promise<void> {
		if (this.#disposed) return;
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });

		const connectionKnown = this.#connections.has(serverName);
		let refreshPromise: Promise<void> | undefined;
		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "tools");
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "resources");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri =
					params && typeof params === "object" && "uri" in params && typeof params.uri === "string"
						? params.uri
						: undefined;
				const subscribed = this.#subscribedResources.get(serverName);
				if (uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "prompts");
				break;
			default:
				break;
		}

		if (refreshPromise) {
			await refreshPromise;
		}
		if (this.#disposed) return;

		if (this.#notificationListeners.size === 0) {
			this.#pendingNotifications.push({ server: serverName, method, params });
			if (this.#pendingNotifications.length > NOTIFICATION_BUFFER_CAP) {
				this.#pendingNotifications.shift();
			}
			return;
		}

		for (const listener of this.#notificationListeners) {
			try {
				listener(serverName, method, params);
			} catch (error) {
				logger.debug("MCP notification listener threw", {
					path: `mcp:${serverName}`,
					method,
					error,
				});
			}
		}
	}

	async #handleServerRequest(method: string, _params: unknown): Promise<unknown> {
		switch (method) {
			case "ping":
				return {};
			case "roots/list":
				return this.#getRoots();
			default:
				throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		}
	}

	#getRoots(): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(this.cwd).href,
					name: path.basename(this.cwd),
				},
			],
		};
	}

	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.#tools;
	}

	getConnection(name: string): MCPServerConnection | undefined {
		return this.#connections.get(name);
	}

	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		if (this.#connections.has(name)) return "connected";
		if (
			this.#pendingConnections.has(name) ||
			this.#pendingToolLoads.has(name) ||
			this.#pendingReconnections.has(name)
		)
			return "connecting";
		return "disconnected";
	}

	getSource(name: string): SourceMeta | undefined {
		return this.#sources.get(name) ?? this.#connections.get(name)?._source;
	}

	getServerConfig(name: string): MCPServerConfig | undefined {
		return this.#connections.get(name)?.config ?? this.#serverConfigs.get(name);
	}

	async waitForConnection(name: string): Promise<MCPServerConnection> {
		const connection = this.#connections.get(name);
		if (connection) return connection;
		const pending = this.#pendingConnections.get(name);
		if (pending) return pending;

		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			const result = await reconnecting;
			if (result) return result;
		}
		throw new Error(`MCP server not connected: ${name}`);
	}

	async prepareConfig(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<MCPServerConfig> {
		return this.#resolveAuthConfig(config, options);
	}

	getConnectedServers(): string[] {
		return Array.from(this.#connections.keys());
	}

	getAllServerNames(): string[] {
		return Array.from(
			new Set([...this.#sources.keys(), ...this.#connections.keys(), ...this.#pendingConnections.keys()]),
		);
	}

	#detachConnection(name: string, connection: MCPServerConnection): void {
		connection.transport.onClose = undefined;
		if (this.#connections.get(name) === connection) {
			this.#connections.delete(name);
		}
	}

	async #discardConnection(name: string, connection: MCPServerConnection): Promise<void> {
		this.#detachConnection(name, connection);
		await disconnectServer(connection);
	}

	async disconnectServer(name: string): Promise<void> {
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		this.#reconnectHistory.delete(name);

		const connection = this.#connections.get(name);

		const subscribedUris = this.#subscribedResources.get(name);
		if (subscribedUris && subscribedUris.size > 0 && connection) {
			void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
		}
		this.#subscribedResources.delete(name);

		if (connection) {
			await this.#discardConnection(name, connection);
		}

		const hadTools = this.#tools.some(t => t.mcpServerName === name);
		this.#tools = this.#tools.filter(t => t.mcpServerName !== name);
		if (hadTools) void this.#onToolsChanged?.(this.#tools);

		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
	}

	async disconnectAll(): Promise<void> {
		this.#epoch++;
		const connections = new Map(this.#connections);
		const pendingConnections = new Map(this.#pendingConnections);
		const pendingToolLoads = new Map(this.#pendingToolLoads);
		const pendingReconnections = new Map(this.#pendingReconnections);
		const pendingResourceRefresh = new Map(this.#pendingResourceRefresh);
		const sources = new Map(this.#sources);
		const serverConfigs = new Map(this.#serverConfigs);
		const subscribedResources = new Map(this.#subscribedResources);
		const reconnectHistory = new Map(this.#reconnectHistory);
		const tools = new Set(this.#tools);
		const discardedServerNames = new Set([
			...connections.keys(),
			...pendingConnections.keys(),
			...pendingToolLoads.keys(),
			...pendingReconnections.keys(),
			...pendingResourceRefresh.keys(),
			...sources.keys(),
			...serverConfigs.keys(),
			...subscribedResources.keys(),
			...reconnectHistory.keys(),
		]);

		// Invalidate pending work for discarded servers immediately: completion
		// handlers are identity-guarded and bail once their entry is removed, so
		// a hung listTools/reconnect backoff must not block later reconnects.
		deleteUnchangedMapEntries(this.#pendingConnections, pendingConnections);
		deleteUnchangedMapEntries(this.#pendingToolLoads, pendingToolLoads);
		deleteUnchangedMapEntries(this.#pendingReconnections, pendingReconnections);
		deleteUnchangedMapEntries(this.#pendingResourceRefresh, pendingResourceRefresh);

		const promises = Array.from(connections, ([name, connection]) => this.#discardConnection(name, connection));
		await Promise.allSettled(promises);

		deleteUnchangedMapEntries(this.#connections, connections);
		deleteUnchangedMapEntries(this.#sources, sources);
		deleteUnchangedMapEntries(this.#serverConfigs, serverConfigs);
		deleteUnchangedMapEntries(this.#subscribedResources, subscribedResources);
		deleteUnchangedMapEntries(this.#reconnectHistory, reconnectHistory);
		this.#tools = this.#tools.filter(tool => {
			if (tools.has(tool)) return false;
			const serverName = tool.mcpServerName;
			return serverName === undefined || !discardedServerNames.has(serverName) || this.#connections.has(serverName);
		});
	}

	async dispose(): Promise<void> {
		if (this.#disposeCall) return this.#disposeCall;

		this.#disposed = true;
		this.#onToolsChanged = undefined;
		this.#onResourcesChanged = undefined;
		this.#onPromptsChanged = undefined;
		this.#notificationListeners.clear();
		this.#pendingNotifications = [];
		this.#authHandler = undefined;
		this.#authStorage = null;
		this.#notificationsEnabled = false;
		if (MCPManager.instance() === this) MCPManager.setInstance(undefined);

		this.#disposeCall = this.disconnectAll().finally(() => {
			this.#pendingNotifications = [];
		});
		return this.#disposeCall;
	}

	async reconnectServer(
		name: string,
		options?: { manual?: boolean; authChallenge?: MCPAuthChallenge },
	): Promise<MCPServerConnection | null> {
		if (options?.manual) {
			this.#reconnectHistory.delete(name);
		}

		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		if (this.#tripReconnectBreaker(name)) {
			return null;
		}

		const attempt = this.#doReconnect(name, options?.authChallenge);
		this.#pendingReconnections.set(name, attempt);
		return attempt.finally(() => this.#pendingReconnections.delete(name));
	}

	#tripReconnectBreaker(name: string): boolean {
		const now = Date.now();
		const previous = this.#reconnectHistory.get(name) ?? [];
		const recent = previous.filter(ts => now - ts < RECONNECT_BURST_WINDOW_MS);
		recent.push(now);
		this.#reconnectHistory.set(name, recent);

		if (recent.length > RECONNECT_BURST_LIMIT) {
			logger.error("MCP server crashed too many times; suspending automatic reconnects", {
				path: `mcp:${name}`,
				crashes: recent.length,
				windowMs: RECONNECT_BURST_WINDOW_MS,
			});

			const stale = this.#connections.get(name);
			if (stale) {
				void this.#discardConnection(name, stale).catch(() => {});
			}
			this.#pendingConnections.delete(name);
			this.#pendingToolLoads.delete(name);
			return true;
		}
		return false;
	}

	async #doReconnect(name: string, authChallenge?: MCPAuthChallenge): Promise<MCPServerConnection | null> {
		const oldConnection = this.#connections.get(name);
		let config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;

		if (authChallenge) {
			if (!this.#authHandler) {
				logger.error("MCP auth challenge cannot be handled; no auth handler is configured", {
					path: `mcp:${name}`,
				});
				return null;
			}
			try {
				const refreshedConfig = await this.#authHandler(name, authChallenge);
				if (!refreshedConfig) return null;
				config = refreshedConfig;
				this.#serverConfigs.set(name, config);
			} catch (error) {
				logger.error("MCP auth challenge handling failed", { path: `mcp:${name}`, error });
				return null;
			}
		}

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		const reconnectEpoch = this.#epoch;
		if (oldConnection) {
			void this.#discardConnection(name, oldConnection).catch(() => {});
		}
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);

		const delays = [500, 1000, 2000, 4000];
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			if (this.#epoch !== reconnectEpoch) {
				logger.debug("MCP reconnect aborted before attempt after configuration changed", {
					path: `mcp:${name}`,
					storedEpoch: reconnectEpoch,
					currentEpoch: this.#epoch,
				});
				return null;
			}
			try {
				const connection = await this.#connectAndWireServer(name, config, source, reconnectEpoch);
				logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: connection.tools?.length ?? 0 });
				return connection;
			} catch (error) {
				if (this.#epoch !== reconnectEpoch) {
					logger.debug("MCP reconnect aborted after configuration changed", {
						path: `mcp:${name}`,
						storedEpoch: reconnectEpoch,
						currentEpoch: this.#epoch,
					});
					return null;
				}

				const msg = error instanceof Error ? error.message : String(error);
				if (attempt < delays.length) {
					logger.debug("MCP reconnect attempt failed, retrying", {
						path: `mcp:${name}`,
						attempt: attempt + 1,
						error: msg,
					});
					await Bun.sleep(delays[attempt]);
				} else {
					logger.error("MCP reconnect failed after retries", { path: `mcp:${name}`, error: msg });
				}
			}
		}
		return null;
	}

	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		reconnectEpoch: number,
	): Promise<MCPServerConnection> {
		const resolvedConfig = await this.#resolveAuthConfig(config);
		const connection = await connectToServer(name, resolvedConfig, {
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params);
			},
			onRequest: (method, params) => {
				return this.#handleServerRequest(method, params);
			},
		});

		connection.config = config;
		if (source) connection._source = source;

		if (!this.#serverConfigs.has(name) || this.#epoch !== reconnectEpoch) {
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw new Error(`Server "${name}" was disconnected during reconnection`);
		}

		this.#connections.set(name, connection);

		if (isAuthRefreshableMCPTransport(connection.transport) && lookupMcpOAuthCredential(this.#authStorage, config)) {
			connection.transport.onAuthError = async () => {
				const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true });
				if (refreshed.type === "http" || refreshed.type === "sse") {
					return refreshed.headers ?? null;
				}
				return null;
			};
		}
		connection.transport.onClose = () => {
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection);
			const reconnect = (options?: { authChallenge?: MCPAuthChallenge }) => this.reconnectServer(name, options);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
			void this.toolCache?.set(name, config, serverTools);
			this.#replaceServerTools(name, customTools);
			void this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw error;
		}
	}

	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (serverSupportsResources(connection.capabilities)) {
			try {
				await this.refreshServerResources(name);
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await listPrompts(connection);
				this.#onPromptsChanged?.(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}
	}

	async refreshServerTools(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;

		connection.tools = undefined;

		const serverTools = await listTools(connection);
		if (this.#connections.get(name) !== connection) return;

		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
		void this.toolCache?.set(name, connection.config, serverTools);

		this.#replaceServerTools(name, customTools);
		await this.#onToolsChanged?.(this.#tools);
	}

	async refreshAllTools(): Promise<void> {
		const promises = Array.from(this.#connections.keys()).map(name => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}

	async refreshServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;

		const existing = this.#pendingResourceRefresh.get(name);
		if (existing && existing.connection === connection) return existing.promise;

		const doRefresh = async (): Promise<void> => {
			connection.resources = undefined;
			connection.resourceTemplates = undefined;

			const [resourcesResult, templatesResult] = await Promise.allSettled([
				listResources(connection),
				listResourceTemplates(connection),
			]);
			if (templatesResult.status === "rejected") {
				logger.debug("Failed to list MCP resource templates", {
					path: `mcp:${name}`,
					error: templatesResult.reason,
				});
			}
			if (resourcesResult.status === "rejected") throw resourcesResult.reason;
			if (this.#connections.get(name) !== connection) return;
			const resources = resourcesResult.value;
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const newUris = new Set(resources.map(r => r.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

				if (oldUris) {
					const removed = [...oldUris].filter(uri => !newUris.has(uri));
					if (removed.length > 0) {
						try {
							await unsubscribeFromResources(connection, removed);
						} catch (error) {
							logger.debug("Failed to unsubscribe stale MCP resources", { path: `mcp:${name}`, error });
						}
					}
				}

				if (this.#connections.get(name) !== connection) return;

				try {
					const allUris = [...newUris];
					await subscribeToResources(connection, allUris);
					if (this.#connections.get(name) !== connection) {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					const action = resolveSubscriptionPostAction(
						this.#notificationsEnabled,
						this.#notificationsEpoch,
						notificationEpoch,
					);
					if (action === "rollback") {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					if (action === "ignore") {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
			}
		};

		const promise = doRefresh().finally(() => {
			const pending = this.#pendingResourceRefresh.get(name);
			if (pending?.promise === promise) {
				this.#pendingResourceRefresh.delete(name);
			}
		});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	async ensureServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;
		if (connection.resources !== undefined && connection.resourceTemplates !== undefined) return;
		await this.refreshServerResources(name);
	}

	async refreshServerPrompts(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsPrompts(connection.capabilities)) return;

		connection.prompts = undefined;
		await listPrompts(connection);

		this.#onPromptsChanged?.(name);
	}

	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return {
			resources: connection.resources ?? [],
			templates: connection.resourceTemplates ?? [],
		};
	}

	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return readResource(connection, uri, options);
	}

	getServerPrompts(name: string): MCPPrompt[] | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return connection.prompts ?? [];
	}

	async executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<MCPGetPromptResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return getPrompt(connection, promptName, args, options);
	}

	getServerInstructions(): Map<string, string> {
		const instructions = new Map<string, string>();
		for (const [name, connection] of this.#connections) {
			if (connection.instructions) {
				instructions.set(name, connection.instructions);
			}
		}
		return instructions;
	}

	getNotificationState(): { enabled: boolean; subscriptions: Map<string, ReadonlySet<string>> } {
		return {
			enabled: this.#notificationsEnabled,
			subscriptions: this.#subscribedResources as Map<string, ReadonlySet<string>>,
		};
	}

	async #refreshBrokeredMcpCredential(credentialId: string, signal?: AbortSignal): Promise<OAuthCredentials> {
		const storage = this.#authStorage;
		if (!storage) throw new Error("MCP OAuth broker refresh requires an auth storage");
		const row = storage.listStoredCredentials(credentialId).find(entry => entry.credential.type === "oauth");
		if (!row) throw new Error(`No broker credential row for ${credentialId}`);
		const entry = await storage.forceRefreshCredentialById(row.id, signal);
		if (entry.credential.type !== "oauth") {
			throw new Error(`Broker returned non-OAuth credential for ${credentialId}`);
		}
		const refreshed = entry.credential;
		return {
			access: refreshed.access,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: refreshed.expires,
			accountId: refreshed.accountId,
			email: refreshed.email,
			projectId: refreshed.projectId,
			enterpriseUrl: refreshed.enterpriseUrl,
		};
	}

	async #resolveAuthConfig(
		config: MCPServerConfig,
		opts?: { forceRefresh?: boolean; oauth?: boolean },
	): Promise<MCPServerConfig> {
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		const lookup: MCPOAuthCredentialLookup | undefined =
			opts?.oauth !== false ? lookupMcpOAuthCredential(this.#authStorage, config) : undefined;
		if (lookup && this.#authStorage) {
			const { credentialId } = lookup;
			try {
				let credential: MCPStoredOAuthCredential | undefined = lookup.credential;
				const REFRESH_BUFFER_MS = 5 * 60_000;
				const refreshResult = await this.#authStorage.refreshStoredOAuthCredential<MCPStoredOAuthCredential>(
					credentialId,
					{
						observedCredential: credential,
						credentialFromRow: row => row,
						forceRefresh: opts?.forceRefresh,
						refreshSkewMs: REFRESH_BUFFER_MS,
						canRefresh: current => {
							const material = selectMcpOAuthRefreshMaterial(current, auth);
							return Boolean(current.refresh && material?.tokenUrl);
						},
						refresh: (current, signal) => {
							if (current.refresh === REMOTE_REFRESH_SENTINEL) {
								return this.#refreshBrokeredMcpCredential(credentialId, signal);
							}
							return refreshManagedMcpOAuthCredential(current, {
								serverUrl: config.type === "http" || config.type === "sse" ? config.url : undefined,
								auth,
								signal,
							});
						},
						mergeRefreshedCredential: (current, refreshed) => {
							const material = selectMcpOAuthRefreshMaterial(current, auth);
							const tokenUrl = material?.tokenUrl;
							const clientId = material?.clientId;
							const clientSecret = material?.clientSecret;
							const authorizationUrl =
								material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
							const resourceIsFallback =
								!material?.resource && (config.type === "http" || config.type === "sse") && Boolean(config.url);
							const resource = material?.resource ?? (resourceIsFallback ? config.url : undefined);
							return {
								...current,
								...refreshed,
								tokenUrl,
								clientId,
								clientSecret,
								resource: resourceIsFallback ? undefined : resource,
								authorizationUrl,
							};
						},
						isDefinitiveFailure: error =>
							isDefinitiveOAuthFailure(error instanceof Error ? error.message : String(error)),
						disabledCause: error =>
							`oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
						keepCredentialOnRefreshFailure: true,
						onRefreshFailure: refreshError => {
							logger.warn("MCP OAuth refresh failed, using existing token", {
								credentialId,
								error: refreshError,
							});
						},
					},
				);
				if (refreshResult.removed) {
					logger.warn("MCP OAuth refresh failed definitively; cleared credential", { credentialId });
				}
				credential = refreshResult.credential;

				if (credential) {
					if (resolved.type === "http" || resolved.type === "sse") {
						const headers = { ...resolved.headers };
						setGeneratedHeader(headers, "Authorization", `Bearer ${credential.access}`);
						resolved = { ...resolved, headers };
					} else {
						resolved = {
							...resolved,
							env: {
								...resolved.env,
								OAUTH_ACCESS_TOKEN: credential.access,
							},
						};
					}
				}
			} catch (error) {
				logger.warn("Failed to resolve OAuth credential", { credentialId, error });
			}
		}

		if (resolved.type !== "http" && resolved.type !== "sse") {
			if (resolved.env && resolved.envPolicy !== "literal") {
				const nextEnv: Record<string, string> = Object.create(null);
				for (const [key, value] of Object.entries(resolved.env)) {
					const resolvedValue = await resolveConfigValue(value);
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			if (resolved.headers && resolved.headerPolicy !== "origin-locked") {
				const nextHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.headers)) {
					const resolvedValue = await resolveConfigValue(value);
					if (resolvedValue) nextHeaders[key] = resolvedValue;
				}
				resolved = { ...resolved, headers: nextHeaders };
			}
		}

		return resolved;
	}
}
