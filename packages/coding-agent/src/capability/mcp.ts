import type { MCPRequestIdFormat } from "../mcp/types";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface MCPServer {
	name: string;

	enabled?: boolean;

	timeout?: number;

	requestIdFormat?: MCPRequestIdFormat;

	command?: string;

	args?: string[];

	env?: Record<string, string>;

	envPolicy?: "literal";

	envLiteralKeys?: string[];

	cwd?: string;

	url?: string;

	headers?: Record<string, string>;

	headerPolicy?: "origin-locked";

	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		resource?: string;
	};

	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};

	transport?: "stdio" | "sse" | "http";

	_source: SourceMeta;
}

// Literal env keys reach the subprocess verbatim while the rest are resolved at
// connect time, so they change what the server receives. `envPolicy: "literal"`
// covers every key; order is irrelevant.
function effectiveEnvLiteralKeys(server: MCPServer): string[] {
	if (server.envPolicy === "literal") return Object.keys(server.env ?? {}).sort();
	return [...(server.envLiteralKeys ?? [])].sort();
}

function isSameMCPConnection(left: MCPServer, right: MCPServer): boolean {
	if (!Bun.deepEquals(left.auth, right.auth) || !Bun.deepEquals(left.oauth, right.oauth)) return false;

	if ((left.requestIdFormat ?? "number") !== (right.requestIdFormat ?? "number")) return false;

	const leftTransport = left.transport ?? (left.command ? "stdio" : left.url ? "http" : "stdio");
	const rightTransport = right.transport ?? (right.command ? "stdio" : right.url ? "http" : "stdio");
	if (leftTransport !== rightTransport) return false;

	if (leftTransport === "stdio") {
		return (
			left.command === right.command &&
			Bun.deepEquals(left.args, right.args) &&
			Bun.deepEquals(left.env, right.env) &&
			Bun.deepEquals(effectiveEnvLiteralKeys(left), effectiveEnvLiteralKeys(right)) &&
			left.cwd === right.cwd
		);
	}

	return left.url === right.url && Bun.deepEquals(left.headers, right.headers);
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	equivalent: isSameMCPConnection,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "Missing server name";
		if (!server.command && !server.url) return "Must have command or url";

		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		return undefined;
	},
});
