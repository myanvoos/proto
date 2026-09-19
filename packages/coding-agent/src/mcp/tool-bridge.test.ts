import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { callTool, connectToServer, disconnectServer } from "./client";
import { createMCPToolName, deduplicateMCPToolsByName, MCPTool, parseMCPToolName } from "./tool-bridge";
import { HttpTransport } from "./transports/http";
import type { MCPServerConnection, MCPTransport } from "./types";

const FIXTURE_PATH = path.resolve(import.meta.dir, "../../test/fixtures/mcp-stdio-server.ts");

function unconnectedTransport(): MCPTransport {
	return new HttpTransport({ type: "http", url: "http://127.0.0.1:9/mcp" });
}

function namedConnection(name: string): MCPServerConnection {
	return {
		name,
		config: { type: "stdio", command: name },
		transport: unconnectedTransport(),
		serverInfo: { name, version: "1" },
		capabilities: {},
	};
}

describe("MCP wire tool names", () => {
	test("the wire name stays the plain shape a user can pin, even when parts need sanitizing", () => {
		// These deliberately collide with each other; disambiguation is registration's
		// job, not the name's, because this string is what allowlists refer to.
		expect(createMCPToolName("github-mcp", "search")).toBe("mcp__github_mcp_search");
		expect(createMCPToolName("github.mcp", "search")).toBe("mcp__github_mcp_search");
		expect(createMCPToolName("Foo", "Bar")).toBe("mcp__foo_bar");
		expect(createMCPToolName("foo", "foo_bar")).toBe("mcp__foo_bar");
	});

	test("unambiguous names keep the plain mcp__<server>_<tool> shape and round-trip", () => {
		expect(createMCPToolName("github", "create_issue")).toBe("mcp__github_create_issue");
		expect(parseMCPToolName("mcp__github_create_issue")).toEqual({
			serverName: "github",
			toolName: "create_issue",
		});
	});
});

describe("MCP tool registration", () => {
	test("boundary-colliding tools from different servers all survive deduplication", () => {
		const connectionA = namedConnection("a");
		const connectionAB = namedConnection("a_b");
		const tools = [
			...MCPTool.fromTools(connectionAB, [{ name: "c", inputSchema: { type: "object" } }]),
			...MCPTool.fromTools(connectionA, [{ name: "b_c", inputSchema: { type: "object" } }]),
		];
		const kept = deduplicateMCPToolsByName(tools);
		expect(kept).toHaveLength(2);
		const origins = kept.map(tool => `${tool.mcpServerName}\u0000${tool.mcpToolName}`).sort();
		expect(origins).toEqual(["a\u0000b_c", "a_b\u0000c"]);
	});

	test("a renamed collision keeps the plain name for the stable winner", () => {
		const connectionA = namedConnection("a");
		const connectionAB = namedConnection("a_b");
		const tools = [
			...MCPTool.fromTools(connectionAB, [{ name: "c", inputSchema: { type: "object" } }]),
			...MCPTool.fromTools(connectionA, [{ name: "b_c", inputSchema: { type: "object" } }]),
		];
		const kept = deduplicateMCPToolsByName(tools);
		const names = kept.map(tool => tool.name);
		// ("a", "b_c") sorts before ("a_b", "c"), so it owns the unsuffixed name
		// regardless of the order discovery returned them in.
		expect(names).toContain("mcp__a_b_c");
		const renamed = names.find(name => name !== "mcp__a_b_c");
		expect(renamed).toMatch(/^mcp__a_b_c_[a-z0-9]+$/);
		expect(kept.find(tool => tool.name === "mcp__a_b_c")?.mcpServerName).toBe("a");
	});

	test("prefix-colliding tools from the same server all survive deduplication", () => {
		const connection = namedConnection("foo");
		const tools = MCPTool.fromTools(connection, [
			{ name: "foo_bar", inputSchema: { type: "object" } },
			{ name: "bar", inputSchema: { type: "object" } },
		]);
		const kept = deduplicateMCPToolsByName(tools);
		expect(kept).toHaveLength(2);
		expect(new Set(kept.map(tool => tool.name)).size).toBe(2);
	});
});

describe("MCP tool execution across a wedged server", () => {
	test("a timed-out call reconnects and retries instead of surfacing the timeout", async () => {
		const wedged = await connectToServer("wedged", {
			type: "stdio",
			command: process.execPath,
			args: ["--smol", FIXTURE_PATH, "ignore-calls"],
			timeout: 400,
		});
		const healthy = await connectToServer("healthy", {
			type: "stdio",
			command: process.execPath,
			args: ["--smol", FIXTURE_PATH],
			timeout: 5000,
		});
		let reconnects = 0;
		try {
			const tool = MCPTool.fromTools(wedged, [{ name: "echo", inputSchema: { type: "object" } }], async () => {
				reconnects += 1;
				return healthy;
			})[0];
			if (!tool) throw new Error("fixture tool missing");
			const result = await tool.execute(
				"call-1",
				{ text: "hi" },
				undefined,
				{} as Parameters<MCPTool["execute"]>[3],
			);
			expect(result.isError ?? false).toBe(false);
			const text = result.content.find(block => block.type === "text");
			expect(text && "text" in text ? text.text : "").toContain("echo:");
			expect(reconnects).toBe(1);
			expect(wedged.transport.connected).toBe(false);
		} finally {
			await disconnectServer(wedged);
			await disconnectServer(healthy);
		}
	});

	test("an unanswered tools/call fails through the normal error result path", async () => {
		const wedged = await connectToServer("wedged", {
			type: "stdio",
			command: process.execPath,
			args: ["--smol", FIXTURE_PATH, "ignore-calls"],
			timeout: 300,
		});
		try {
			await expect(callTool(wedged, "echo", {})).rejects.toThrow("Request timeout after 300ms");
		} finally {
			await disconnectServer(wedged);
		}
	});
});
