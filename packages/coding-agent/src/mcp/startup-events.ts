import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

export const MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status";

export type McpConnectionFailure = {
	serverName: string;
	error: string;
	sourcePath?: string;
};

export type McpConnectionStatusEvent =
	| { type: "connecting"; serverNames: string[] }
	| { type: "connected"; serverName: string }
	| ({ type: "failed" } & McpConnectionFailure)
	| { type: "config-error"; error: string };

type McpConnectionStatusSnapshot = {
	pendingServers: readonly string[];
	connectedServers: readonly string[];
	failedServers: readonly McpConnectionFailure[];
	configErrors?: readonly string[];
};

function sanitizeMcpStatusText(value: string, maxWidth: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "(unnamed)", maxWidth);
}

function sanitizeMcpServerName(serverName: string): string {
	return sanitizeMcpStatusText(serverName, TRUNCATE_LENGTHS.SHORT);
}

function formatServerList(serverNames: readonly string[]): string {
	return serverNames.map(sanitizeMcpServerName).join(", ");
}

function formatServerCount(count: number): string {
	return count === 1 ? "server" : "servers";
}
function sanitizeMcpStatusError(error: string): string {
	return sanitizeMcpStatusText(error, TRUNCATE_LENGTHS.CONTENT);
}

function shortenEmbeddedPaths(text: string): string {
	return text
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			return `${leading}${shortenPath(segment.slice(leading.length, end))}${trailing}`;
		})
		.join(" ");
}

export function formatMCPConnectingMessage(serverNames: readonly string[]): string {
	return `Connecting to MCP servers: ${formatServerList(serverNames)}…`;
}

export interface McpMessageFormatOptions {
	untruncated?: boolean;
}

function formatErrorDetail(error: string, options?: McpMessageFormatOptions): string {
	if (!options?.untruncated) return sanitizeMcpStatusError(error);
	return replaceTabs(sanitizeText(error))
		.replace(/[\r\n]+/g, " ")
		.trim();
}

export function formatMcpConfigError(error: string, options?: McpMessageFormatOptions): string {
	return `MCP config: ${formatErrorDetail(error, options)}`;
}

function formatFailedServer({ serverName, error, sourcePath }: McpConnectionFailure): string {
	const source = sourcePath
		? ` [config: ${sanitizeMcpStatusText(shortenPath(sourcePath), TRUNCATE_LENGTHS.CONTENT)}]`
		: "";
	return `${sanitizeMcpServerName(serverName)}${source}: ${sanitizeMcpStatusError(error)}`;
}

export function formatMcpServerFailure(failure: McpConnectionFailure, options?: McpMessageFormatOptions): string {
	if (!options?.untruncated) return `MCP server ${formatFailedServer(failure)}`;
	const source = failure.sourcePath ? ` [config: ${failure.sourcePath}]` : "";
	return `MCP server ${failure.serverName}${source}: ${formatErrorDetail(failure.error, options)}`;
}

export function formatMCPConnectionStatusMessage(snapshot: McpConnectionStatusSnapshot): string {
	const { pendingServers, connectedServers, failedServers } = snapshot;
	const configErrors = (snapshot.configErrors ?? []).map(error => formatMcpConfigError(error));
	const withConfigErrors = (message: string): string =>
		configErrors.length === 0 ? message : [...configErrors, message].filter(Boolean).join(" ");
	if (pendingServers.length > 0) {
		if (connectedServers.length === 0 && failedServers.length === 0) {
			return formatMCPConnectingMessage(pendingServers);
		}
		const parts: string[] = [];
		if (connectedServers.length > 0) {
			parts.push(`Connected: ${formatServerList(connectedServers)}.`);
		}
		if (failedServers.length > 0) {
			parts.push(`Failed: ${failedServers.map(formatFailedServer).join("; ")}.`);
		}
		parts.push(`Still connecting: ${formatServerList(pendingServers)}…`);
		return withConfigErrors(parts.join(" "));
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(formatFailedServer).join("; ");
		if (connectedServers.length === 0) {
			return withConfigErrors(`MCP ${formatServerCount(failedServers.length)} failed to connect: ${failureText}`);
		}
		return withConfigErrors(
			`MCP finished with failures. Connected: ${formatServerList(connectedServers)}. Failed: ${failureText}`,
		);
	}
	if (connectedServers.length > 0) {
		return withConfigErrors(
			`Connected to MCP ${formatServerCount(connectedServers.length)}: ${formatServerList(connectedServers)}.`,
		);
	}
	return withConfigErrors("");
}

function isRecord(data: unknown): data is Record<string, unknown> {
	return typeof data === "object" && data !== null;
}

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every(item => typeof item === "string");
}

export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	if (!isRecord(data) || typeof data.type !== "string") return false;
	switch (data.type) {
		case "connecting":
			return isStringArray(data.serverNames);
		case "connected":
			return typeof data.serverName === "string";
		case "failed":
			return (
				typeof data.serverName === "string" &&
				typeof data.error === "string" &&
				(data.sourcePath === undefined || typeof data.sourcePath === "string")
			);
		case "config-error":
			return typeof data.error === "string";
		default:
			return false;
	}
}
