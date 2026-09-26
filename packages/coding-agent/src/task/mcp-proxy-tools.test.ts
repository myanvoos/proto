import { afterEach, expect, test, vi } from "bun:test";
import type { MCPManager } from "../mcp/manager";
import { ToolAbortError } from "../tools/tool-errors";
import { createMCPProxyTools } from "./executor";

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
