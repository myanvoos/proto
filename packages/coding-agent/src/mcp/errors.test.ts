import { describe, expect, test } from "bun:test";
import { MCPTool } from "./tool-bridge";
import { HttpTransport } from "./transports/http";
import type { MCPHttpServerConfig, MCPServerConnection, MCPToolDefinition } from "./types";

const TOOL: MCPToolDefinition = {
	name: "echo",
	inputSchema: { type: "object" },
};

async function surfaceHttpError(body: string, status = 400, headers: Record<string, string> = {}): Promise<string> {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const request = (await req.json()) as { id: string | number };
			return new Response(status === 200 ? JSON.stringify({ ...JSON.parse(body), id: request.id }) : body, {
				status,
				headers: { "Content-Type": "application/json", ...headers },
			});
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
		await expect(surfaceHttpError(body)).resolves.toContain(`HTTP 400: ${body}`);
	});
});

test("JSON-RPC tool diagnostics keep bounded redacted data and a safe trace without runtime advice", async () => {
	const data = {
		client_secret: "private-value",
		detail: "Bearer secret-value",
		traceId: "data-trace",
		large: Array.from({ length: 100 }, () => "x".repeat(400)),
	};
	const surfaced = await surfaceHttpError(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32042,
				message: "rejected. For more information, pass `verbose: true` in the second argument to fetch().",
				data,
			},
		}),
		200,
		{ "X-Request-Id": "request-abc123" },
	);
	expect(surfaced).toContain("failure: json_rpc");
	expect(surfaced).toContain("code: -32042");
	expect(surfaced).toContain("trace_id: request-abc123");
	expect(surfaced).toContain("retryable: no");
	expect(surfaced).not.toContain("private-value");
	expect(surfaced).not.toContain("secret-value");
	expect(surfaced).not.toContain("verbose");
	const serialized = surfaced
		.split("\n")
		.find(line => line.startsWith("data: "))
		?.slice(6);
	if (!serialized) throw new Error("Expected bounded server data");
	expect(serialized.length).toBeLessThanOrEqual(2000);
	expect(JSON.parse(serialized).truncated).toBe(true);
	expect(surfaced.match(/^next: /gm)).toHaveLength(1);
});

test("unsafe header trace IDs are discarded in favor of safe nested JSON-RPC IDs", async () => {
	const surfaced = await surfaceHttpError(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "rejected",
				data: { nested: { request_id: "safe-id" }, access_token: "hidden-value" },
			},
		}),
		200,
		{ "X-Request-Id": "Bearer unsafe-secret" },
	);
	expect(surfaced).toContain("trace_id: safe-id");
	expect(surfaced).not.toContain("unsafe-secret");
	expect(surfaced).not.toContain("hidden-value");
});
