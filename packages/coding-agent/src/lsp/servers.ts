import { logger } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import {
	getActiveClients,
	getActiveOrPendingClient,
	getOrCreateClient,
	isRustAnalyzerClient,
	type LspServerStatus,
	notifySaved,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	shutdownClientInstance,
	syncContent,
	WARMUP_TIMEOUT_MS,
} from "./client";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import { MUX_RESTART_METHOD } from "./mux/protocol";
import type { LspClient, ServerConfig } from "./types";

export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error" | "available";
	fileTypes: string[];
	error?: string;
}

export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

export interface LspWarmupOptions {
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(
	cwd: string,
	status: LspStartupServerInfo["status"] = "connecting",
): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status,
		fileTypes: serverConfig.fileTypes,
	}));
}

export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}

export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

export async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	createMissing = true,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = createMissing
				? await getOrCreateClient(serverConfig, cwd, undefined, signal)
				: await getActiveOrPendingClient(serverConfig, cwd, signal);
			if (!client) return;
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
	throwIfAborted(signal);
}

export async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	createMissing = true,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = createMissing
				? await getOrCreateClient(serverConfig, cwd, undefined, signal)
				: await getActiveOrPendingClient(serverConfig, cwd, signal);
			if (!client) return;
			await notifySaved(client, absolutePath, signal);
		}),
	);
	throwIfAborted(signal);
}

export const configCache = new Map<string, LspConfig>();

export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		configCache.set(cwd, config);
	}
	setIdleTimeout(config.idleTimeoutMs);
	return config;
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

export function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

export function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

export function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

export function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}

export function reloadConfigurationParams(config: ServerConfig): { settings: Record<string, unknown> } {
	return { settings: config.settings ?? {} };
}

export async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);

	if (isRustAnalyzerClient(client) || serverName === "rust-analyzer") {
		try {
			await sendRequest(client, "rust-analyzer/reloadWorkspace", undefined, signal);
			return `Reloaded ${serverName}`;
		} catch (err) {
			throwIfAborted(signal);
			if (!isMethodNotFoundError(err)) throw err;
		}
	}

	try {
		const params = reloadConfigurationParams(client.config);
		await sendNotification(client, "workspace/didChangeConfiguration", params, signal);
		return `Reloaded ${serverName}`;
	} catch {
		throwIfAborted(signal);

		if (client.proc.sharedMux) {
			await sendNotification(client, MUX_RESTART_METHOD, undefined, AbortSignal.timeout(2_000)).catch(() => {});
		}
		if (!(await shutdownClientInstance(client))) {
			throw new Error(`Failed to restart ${serverName}: server process did not exit after kill`);
		}
		return `Restarted ${serverName}`;
	}
}
