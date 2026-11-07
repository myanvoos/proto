/**
 * `/mcp reauth` persistence contracts. A reauthorization must bind the fresh credential to the definition the next
 * session actually loads: a client-supplied `Authorization` header makes the manager skip the url-keyed fallback, so
 * a definition-only entry that is not written back keeps serving the stale bearer despite the reported success. On a
 * project/user name collision the project entry wins, matching runtime discovery's first-wins enumeration.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import * as mcpClient from "../../mcp/client";
import * as mcpConfigWriter from "../../mcp/config-writer";
import * as oauthFlow from "../../mcp/oauth-flow";
import { mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import type { MCPServerConfig } from "../../mcp/types";
import { AuthStorage } from "../../session/auth-storage";
import { OAuthManualInputManager } from "../oauth-manual-input";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { MCPCommandController } from "./mcp-command-controller";

initThemeSync();

const SERVER_URL = "https://mcp.example.com/mcp";
const USER_SHADOW_URL = "https://user-shadow.example.com/mcp";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);

let authStorage: AuthStorage | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	authStorage?.close();
	authStorage = undefined;
});

type Harness = {
	controller: MCPCommandController;
	persisted: () => MCPServerConfig | undefined;
	connectedUrls: () => string[];
};

async function makeHarness(serverConfig: MCPServerConfig): Promise<Harness> {
	authStorage = await AuthStorage.create(":memory:");
	const ctx = {
		oauthManualInput: new OAuthManualInputManager(),
		mcpManager: {
			getServerConfig: vi.fn(),
			getSource: vi.fn(),
			prepareConfig: async (config: MCPServerConfig) => config,
		},
		session: { modelRegistry: { authStorage } },
		editor: { onEscape: undefined },
		present: vi.fn(),
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		showMessage: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	const userPath = getMCPConfigPath("user", getProjectDir());
	const projectPath = getMCPConfigPath("project", getProjectDir());
	vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockImplementation(async filePath => {
		if (filePath === projectPath) return { mcpServers: { envserver: serverConfig } };
		if (filePath === userPath) {
			return { mcpServers: { envserver: { type: "http", url: USER_SHADOW_URL } } };
		}
		return { mcpServers: {} };
	});
	const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
	const updateSpy = vi.spyOn(mcpConfigWriter, "updateMCPServer").mockResolvedValue();
	vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
		access: "fresh-access",
		refresh: "fresh-refresh",
		expires: Date.now() + 3_600_000,
	});

	return {
		controller: new MCPCommandController(ctx),
		persisted: () => updateSpy.mock.calls.at(-1)?.[2],
		connectedUrls: () =>
			connectSpy.mock.calls.map(call => {
				const config = call[1];
				return config.type === "http" || config.type === "sse" ? config.url : "";
			}),
	};
}

async function reauth(controller: MCPCommandController): Promise<MCPServerConfig | undefined> {
	return await controller.handleMCPAuthChallenge("envserver", { wwwAuthenticate: [] });
}

describe("/mcp reauth persistence", () => {
	it("writes the fresh credential binding when the definition carries a client bearer header", async () => {
		const harness = await makeHarness({
			type: "http",
			url: SERVER_URL,
			headers: { Authorization: "Bearer stale" },
		});

		await reauth(harness.controller);

		// The definition gains an auth block pointing at the fresh url-keyed row,
		// so the next process resolves the new credential despite the header.
		expect(harness.persisted()?.auth).toMatchObject({
			type: "oauth",
			credentialId: mcpOAuthCredentialId(SERVER_URL),
			tokenUrl: "https://auth.example.com/token",
		});
		expect(harness.persisted()?.headers).toEqual({ Authorization: "Bearer stale" });
	});

	it("leaves a definition-only entry untouched when no client bearer shadows the url-keyed credential", async () => {
		const harness = await makeHarness({ type: "http", url: SERVER_URL });

		await reauth(harness.controller);

		expect(harness.persisted()).toBeUndefined();
	});

	it("reauths the project entry when a user config shadows the same name", async () => {
		const harness = await makeHarness({ type: "http", url: SERVER_URL });

		await reauth(harness.controller);

		// Refreshing the user shadow would report success while the project entry
		// that runtime discovery actually invokes keeps its stale credential.
		expect(harness.connectedUrls()).toEqual([SERVER_URL]);
	});
});
