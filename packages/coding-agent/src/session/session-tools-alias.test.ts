import { expect, test } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../config/settings";
import { SessionManager } from "./session-manager";
import { SessionTools, type SessionToolsHost } from "./session-tools";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: "",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
	};
}

test("kernel aliases resolve enabled canonical tools without exposing disabled MCP devices", () => {
	const enabled = tool("mcp__server_query");
	const disabled = tool("mcp__server_hidden");
	const host = {
		agent: { state: { tools: [enabled], messages: [] } },
		settings: Settings.isolated({}),
		model: () => undefined,
	} as unknown as SessionToolsHost;
	const tools = new SessionTools(host, {
		toolRegistry: new Map([
			[enabled.name, enabled],
			[disabled.name, disabled],
		]),
		baseSystemPrompt: [],
	});
	expect(tools.getToolForEvalBridge("protolens://mcp__server_query")).toBe(enabled);
	expect(tools.getToolForEvalBridge("mcp__server__query")).toBe(enabled);
	expect(tools.getToolForEvalBridge("mcp__server__hidden")).toBeUndefined();
	expect(tools.getToolByName("mcp__server__hidden")).toBe(disabled);
});

test.each(["catalog", "inline"] as const)(
	"suppresses visible mount notices independently of %s model guidance",
	async docsMode => {
		const read = tool("read");
		const bash = tool("bash");
		const query = Object.assign(tool("mcp__server_query"), {
			loadMode: "discoverable" as const,
			mcpServerName: "server",
			mcpToolName: "query",
		});
		const registry = new Map([
			[read.name, read],
			[bash.name, bash],
			[query.name, query],
		]);
		const agent = new Agent({ initialState: { tools: [read, bash], messages: [] } });
		const sessionManager = SessionManager.inMemory();
		const notices: string[] = [];
		const settings = Settings.isolated({ "tools.xdevNotices": false, "tools.xdevDocs": docsMode });
		const host = {
			agent,
			sessionManager,
			settings,
			model: () => undefined,
			isDisposed: () => false,
			extensionRunner: () => undefined,
			emitNotice: (_level: string, message: string) => {
				notices.push(message);
			},
			clearInheritedProviderPromptCacheKey: () => {},
			localProtocolOptions: () => ({}),
		} as unknown as SessionToolsHost;
		const tools = new SessionTools(host, {
			toolRegistry: registry,
			builtInToolNames: ["read", "bash"],
			baseSystemPrompt: [],
			xdev: {
				tools: registry,
				mountedNames: new Set(),
				builtInNames: new Set(["read", "bash"]),
				isActive: () => true,
			},
		});
		try {
			await tools.applyActiveToolsByName(["read", "bash"]);
			await tools.applyActiveToolsByName(["read", "bash", query.name]);
			expect(notices).toEqual([]);
			const pending = tools.takePendingXdevMountNotice(true);
			if (docsMode === "catalog") expect(pending).toBeUndefined();
			else expect(pending?.details?.added).toEqual([query.name]);
		} finally {
			await sessionManager.close();
		}
	},
);
