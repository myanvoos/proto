import { describe, expect, test } from "bun:test";
import { MCPTool } from "./tool-bridge";
import { HttpTransport } from "./transports/http";
import type { MCPHttpServerConfig, MCPServerConnection, MCPToolDefinition } from "./types";

const TOOL: MCPToolDefinition = {
	name: "echo",
	inputSchema: { type: "object" },
};

async function surfaceHttpError(body: string): Promise<string> {
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response(body, { status: 400, headers: { "Content-Type": "application/json" } });
		},
	});
	const config: MCPHttpServerConfig = {
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
	};
	const transport = new HttpTransport(config);
	await transport.connect();
	const connection: MCPServerConnection = {
		name: "echo-server",
		config,
		transport,
		serverInfo: { name: "fixture", version: "1" },
		capabilities: {},
	};

	try {
		const tool = new MCPTool(connection, TOOL);
		const result = await tool.execute("call-1", {}, undefined, {} as Parameters<MCPTool["execute"]>[3]);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected an MCP text error");
		return content.text;
	} finally {
		await transport.close();
		server.stop(true);
	}
}

describe("MCP error diagnostics", () => {
	test("redacts compound credential values while preserving useful HTTP error details", async () => {
		const surfaced = await surfaceHttpError(
			JSON.stringify({
				api_key: "sk-live-abc123",
				clientSecret: "client-secret-value",
				private_key: "private-key-value",
				signingSecret: "signing-secret-value",
				access_token: "access-token-value",
				detail: "bad request",
			}),
		);

		for (const secret of [
			"sk-live-abc123",
			"client-secret-value",
			"private-key-value",
			"signing-secret-value",
			"access-token-value",
		]) {
			expect(surfaced).not.toContain(secret);
		}
		expect(surfaced).toContain("HTTP 400");
		expect(surfaced).toContain('"api_key":"[redacted]"');
		expect(surfaced).toContain('"detail":"bad request"');
	});

	test("preserves an HTTP error body without credential data", async () => {
		const body = '{"detail":"bad request"}';
		await expect(surfaceHttpError(body)).resolves.toBe(`MCP error: HTTP 400: ${body}`);
	});
});
