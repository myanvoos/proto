import { afterEach, describe, expect, it, vi } from "bun:test";
import * as mcpConfigWriter from "../../mcp/config-writer";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { MCPCommandController } from "./mcp-command-controller";

initThemeSync();

describe("interactive /mcp test", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("cancels on Esc while the config lookup is still pending", async () => {
		const { promise: lookup } = Promise.withResolvers<never>();
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockReturnValue(lookup);
		const presentCommandOutput = vi.fn();
		const showStatus = vi.fn();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const ctx = {
			mcpTestEscapeHandlers,
			presentCommandOutput,
			showStatus,
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
			mcpManager: { getServerConfig: vi.fn(), getSource: vi.fn() },
		} as unknown as InteractiveModeContext;

		const pending = new MCPCommandController(ctx).handle("/mcp test github");
		expect(mcpTestEscapeHandlers.size).toBe(1);
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}

		await pending;

		expect(presentCommandOutput).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(mcpTestEscapeHandlers.size).toBe(0);
	});

	it("addresses a server whose name contains spaces", async () => {
		const showError = vi.fn();
		const getServerConfig = vi.fn();
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockResolvedValue({});
		const ctx = {
			mcpTestEscapeHandlers: new Set<() => void>(),
			presentCommandOutput: vi.fn(),
			showStatus: vi.fn(),
			showError,
			ui: { requestRender: vi.fn() },
			mcpManager: { getServerConfig, getSource: vi.fn() },
		} as unknown as InteractiveModeContext;

		await new MCPCommandController(ctx).handle("/mcp test MaaS Slack");

		expect(getServerConfig).toHaveBeenCalledWith("MaaS Slack");
	});
});
