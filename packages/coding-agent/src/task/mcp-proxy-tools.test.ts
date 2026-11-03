import { afterEach, expect, test, vi } from "bun:test";
import type { MCPManager } from "../mcp/manager";
import { ToolAbortError } from "../tools/tool-errors";
import { createMCPProxyTools, followMCPTools } from "./executor";

type ProxyResult = { content: Array<{ type: string; text?: string }> };

afterEach(() => {
	vi.useRealTimers();
});

/** A parent-session MCP tool whose call stays pending until the test settles it. */
function pendingSourceTool() {
	const call = Promise.withResolvers<ProxyResult>();
	const source = {
		name: "mcp_slow_run",
		label: "run",
		description: "slow server tool",
		parameters: { type: "object", properties: {} },
		mcpServerName: "slow",
		mcpToolName: "run",
		execute: () => call.promise,
	};
	const manager = { getTools: () => [source] } as unknown as MCPManager;
	const [proxy] = createMCPProxyTools(manager);
	return { proxy: proxy!, call };
}

test("a subagent MCP call runs past 60s when the server's configured timeout allows it", async () => {
	vi.useFakeTimers();
	const { proxy, call } = pendingSourceTool();

	const result = proxy.execute("call-1", {}, undefined, undefined as never, new AbortController().signal);
	vi.advanceTimersByTime(10 * 60_000);
	call.resolve({ content: [{ type: "text", text: "finished after ten minutes" }] });

	expect(await result).toEqual({ content: [{ type: "text", text: "finished after ten minutes" }] });
});

test("a subagent MCP call ends with an abort as soon as its caller aborts", async () => {
	const { proxy } = pendingSourceTool();
	const controller = new AbortController();

	const result = proxy.execute("call-2", {}, undefined, undefined as never, controller.signal);
	controller.abort();

	await expect(result).rejects.toBeInstanceOf(ToolAbortError);
});

test("subagent MCP reload catches startup changes, preserves explicit tools, and stops after disposal", async () => {
	const listeners = new Set<() => void>();
	let names = ["mcp_old"];
	const manager = {
		getTools: () =>
			names.map(name => ({
				name,
				label: name,
				description: "test",
				parameters: { type: "object" },
				mcpServerName: "server",
				mcpToolName: name,
			})),
		addToolsChangedListener: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as MCPManager;
	const follower = followMCPTools(manager, new Set(["mcp_reserved"]));
	const refreshes: string[][] = [];
	let dispose = () => {};
	names = ["mcp_new", "mcp_reserved"];
	for (const listener of listeners) listener();
	follower.bind({
		refreshMCPTools: async tools => {
			refreshes.push(tools.map(tool => tool.name));
		},
		addDisposer: callback => {
			dispose = callback;
		},
	});
	await Promise.resolve();
	expect(refreshes).toEqual([["mcp_new"]]);
	names = ["mcp_latest"];
	for (const listener of listeners) {
		listener();
		listener();
	}
	await Promise.resolve();
	expect(refreshes).toEqual([["mcp_new"], ["mcp_latest"]]);
	dispose();
	names = ["mcp_after_disposal"];
	for (const listener of listeners) listener();
	await Promise.resolve();
	expect(refreshes).toEqual([["mcp_new"], ["mcp_latest"]]);
});
