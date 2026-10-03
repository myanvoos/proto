import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { connectToServer, disconnectServer } from "./client";
import {
	canonicalMCPToolNameCandidates,
	createMCPToolName,
	deduplicateMCPToolsByName,
	MCPTool,
	parseMCPToolName,
	resolveMCPToolAlias,
} from "./tool-bridge";
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

	test("an unanswered tools/call fails through the error result, naming the server and how to raise the timeout", async () => {
		const wedged = await connectToServer("wedged", {
			type: "stdio",
			command: process.execPath,
			args: ["--smol", FIXTURE_PATH, "ignore-calls"],
			timeout: 300,
		});
		try {
			const tool = MCPTool.fromTools(wedged, [{ name: "echo", inputSchema: { type: "object" } }])[0];
			if (!tool) throw new Error("fixture tool missing");
			const result = await tool.execute("call-1", {}, undefined, {} as Parameters<MCPTool["execute"]>[3]);
			expect(result.isError).toBe(true);
			const text = result.content.find(block => block.type === "text");
			const message = text && "text" in text ? text.text : "";
			expect(message).toContain("Request timeout after 300ms");
			expect(message).toContain('"wedged"');
			expect(message).toContain("`timeout`");
			expect(message).toContain("PROTO_MCP_TIMEOUT_MS");
		} finally {
			await disconnectServer(wedged);
		}
	});

	test("failures other than the request timeout carry no timeout hint", async () => {
		const tool = MCPTool.fromTools(namedConnection("down"), [{ name: "echo", inputSchema: { type: "object" } }])[0];
		if (!tool) throw new Error("fixture tool missing");
		const result = await tool.execute("call-1", {}, undefined, {} as Parameters<MCPTool["execute"]>[3]);
		expect(result.isError).toBe(true);
		const text = result.content.find(block => block.type === "text");
		const message = text && "text" in text ? text.text : "";
		expect(message).toContain("Transport not connected");
		expect(message).not.toContain("PROTO_MCP_TIMEOUT_MS");
	});
});

describe("HTTP tool replay safety", () => {
	test.each(["auth", "unavailable", "eof", "timeout"] as const)(
		"an accepted POST is not replayed after SSE %s failure",
		async failure => {
			let posts = 0;
			let gets = 0;
			let refreshes = 0;
			let reconnects = 0;
			const server = Bun.serve({
				port: 0,
				fetch(req) {
					if (req.method === "POST") {
						posts++;
						if (failure === "timeout") {
							return new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(new TextEncoder().encode(": accepted\n\n"));
									},
								}),
								{ headers: { "Content-Type": "text/event-stream" } },
							);
						}
						return new Response(failure === "eof" ? "" : "id: stream-1\nretry: 1\ndata:\n\n", {
							headers: { "Content-Type": "text/event-stream" },
						});
					}
					gets++;
					return new Response("resume failed", { status: failure === "auth" ? 401 : 503 });
				},
			});
			const config = {
				type: "http" as const,
				url: `http://127.0.0.1:${server.port}/mcp`,
				timeout: failure === "timeout" ? 100 : 2000,
			};
			const transport = new HttpTransport(config);
			transport.onAuthError = async () => {
				refreshes++;
				return { Authorization: "Bearer fresh" };
			};
			await transport.connect();
			const connection: MCPServerConnection = { ...namedConnection("replay"), config, transport };
			try {
				const tool = new MCPTool(connection, { name: "mutate", inputSchema: { type: "object" } }, async () => {
					reconnects++;
					return connection;
				});
				const result = await tool.execute("call-1", {}, undefined, {} as Parameters<MCPTool["execute"]>[3]);
				expect(result.isError).toBe(true);
				expect(posts).toBe(1);
				expect(reconnects).toBe(0);
				expect(gets).toBe(failure === "auth" ? 2 : failure === "unavailable" ? 1 : 0);
				expect(refreshes).toBe(failure === "auth" ? 1 : 0);
				const text = result.content[0];
				if (text?.type !== "text") throw new Error("Expected diagnostic");
				expect(text.text).toContain("retryable: no");
			} finally {
				await transport.close();
				server.stop(true);
			}
		},
	);
});

describe("Claude Code-spelled MCP tool names", () => {
	const over =
		(names: readonly string[]) =>
		(candidate: string): { name: string } | undefined =>
			names.includes(candidate) ? { name: candidate } : undefined;

	test("resolves the doubled separator and raw server spelling to the minted key", () => {
		const bank = createMCPToolName("seedpatch-client", "bank");
		expect(bank).toBe("mcp__seedpatch_client_bank");
		for (const emitted of [
			"mcp__seedpatch-client__bank",
			"mcp__seedpatch_client__bank",
			"mcp__seedpatch-client_bank",
		]) {
			expect(resolveMCPToolAlias(emitted, over(["read", bank]))?.name).toBe(bank);
		}
	});

	test("re-mints prefix stripping, placeholder servers, and the length cap", () => {
		const screenshot = createMCPToolName("puppeteer", "puppeteer_screenshot");
		expect(resolveMCPToolAlias("mcp__puppeteer__puppeteer_screenshot", over([screenshot]))?.name).toBe(screenshot);
		expect(resolveMCPToolAlias("mcp__...__bank", over([createMCPToolName("...", "bank")]))?.name).toBe(
			"mcp__server_bank",
		);
		const longTool = "a_very_long_tool_name_that_definitely_overflows_the_sixty_four_char_cap";
		const capped = createMCPToolName("srv", longTool);
		expect(capped.length).toBe(64);
		expect(resolveMCPToolAlias(`mcp__srv__${longTool}`, over([capped]))?.name).toBe(capped);
		const hyphenated = createMCPToolName("seedpatch-client", longTool);
		expect(resolveMCPToolAlias(`mcp__seedpatch-client_${longTool}`, over([hyphenated]))?.name).toBe(hyphenated);
	});

	test("splits at every doubled separator so raw server names containing one still resolve", () => {
		const registered = createMCPToolName("foo__bar", "baz");
		expect(resolveMCPToolAlias("mcp__foo__bar__baz", over([registered]))?.name).toBe(registered);
	});

	test("never resolves canonical, non-MCP, or unoffered names", () => {
		const bank = createMCPToolName("seedpatch-client", "bank");
		expect(canonicalMCPToolNameCandidates(bank)).toEqual([]);
		expect(canonicalMCPToolNameCandidates("read")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("mcp__")).toEqual([]);
		expect(canonicalMCPToolNameCandidates("mcp____bank")).not.toContain("mcp__server_bank");
		expect(resolveMCPToolAlias("read", over(["read"]))).toBeUndefined();
		expect(resolveMCPToolAlias("mcp__seedpatch-client__bank", over(["learn", "manage_skill"]))).toBeUndefined();
	});

	test("refuses an alias two registered tools both answer", () => {
		const viaFirst = createMCPToolName("foo", "bar__foo_bar_baz");
		const viaSecond = createMCPToolName("foo__bar", "foo_bar_baz");
		expect(viaFirst).not.toBe(viaSecond);
		const emitted = "mcp__foo__bar__foo_bar_baz";
		expect(resolveMCPToolAlias(emitted, over([viaFirst, viaSecond]))).toBeUndefined();
		expect(resolveMCPToolAlias(emitted, over([viaFirst]))?.name).toBe(viaFirst);
		expect(resolveMCPToolAlias(emitted, over([viaSecond]))?.name).toBe(viaSecond);
	});
});

describe("MCP structured tool results", () => {
	function connectionReturning(result: unknown): MCPServerConnection {
		const transport: MCPTransport = {
			connected: true,
			connect: async () => {},
			request: async <T>() => result as T,
			notify: async () => {},
			close: async () => {},
		};
		return { ...namedConnection("data"), transport };
	}

	async function callText(result: unknown): Promise<string[]> {
		const tool = MCPTool.fromTools(connectionReturning(result), [
			{ name: "query", inputSchema: { type: "object" } },
		])[0];
		if (!tool) throw new Error("fixture tool missing");
		const output = await tool.execute("call-1", {}, undefined, {} as Parameters<MCPTool["execute"]>[3]);
		return output.content.flatMap(block => (block.type === "text" ? [block.text] : []));
	}

	test("structuredContent reaches the model when the text content is only an acknowledgement", async () => {
		const texts = await callText({ content: [{ type: "text", text: "ok" }], structuredContent: { rows: [1, 2] } });
		expect(texts).toHaveLength(2);
		expect(texts[1]).toContain('"rows"');
	});

	test("structuredContent already echoed as text is not repeated", async () => {
		const structuredContent = { rows: [1, 2] };
		const texts = await callText({
			content: [{ type: "text", text: JSON.stringify(structuredContent) }],
			structuredContent,
		});
		expect(texts).toEqual([JSON.stringify(structuredContent)]);
	});
});
