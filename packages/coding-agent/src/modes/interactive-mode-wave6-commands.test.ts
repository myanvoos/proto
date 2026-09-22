import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands/types";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../mcp/startup-events";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { EventBus } from "../utils/event-bus";
import { InteractiveMode } from "./interactive-mode";
import { initTheme } from "./theme/theme";

function mcpPromptCommand(name: string, description: string): LoadedCustomCommand {
	return {
		path: `mcp:${name}`,
		resolvedPath: `mcp:${name}`,
		source: "project",
		command: { name, description, execute: () => undefined },
	};
}

describe("InteractiveMode composer commands and affordances", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let providers: AutocompleteProvider[];
	let eventBus: EventBus;

	beforeEach(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@omp-wave6-commands-");
		await Settings.init({ inMemory: true });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		providers = [];
		mode.editor.setAutocompleteProvider = (provider: AutocompleteProvider) => {
			providers.push(provider);
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose().catch(() => {});
		authStorage.close();
		tempDir.removeSync();
	});

	async function completionsFor(text: string): Promise<string[]> {
		const provider = providers.at(-1);
		expect(provider).toBeDefined();
		const result = await provider?.getSuggestions([text], 0, text.length);
		return (result?.items ?? []).map(item => item.value);
	}

	async function completionDescriptions(text: string): Promise<string[]> {
		const provider = providers.at(-1);
		const result = await provider?.getSuggestions([text], 0, text.length);
		return (result?.items ?? []).map(item => item.description ?? "");
	}

	it("adds MCP prompt commands to slash completion when the server connects", async () => {
		await mode.refreshSlashCommandState(tempDir.path());
		expect(await completionsFor("/wave6")).toEqual([]);

		session.setMCPPromptCommands([mcpPromptCommand("wave6:wave6_prompt", "Prompt exposed over MCP")]);

		expect(await completionsFor("/wave6")).toContain("wave6:wave6_prompt");
		expect(await completionDescriptions("/wave6")).toEqual(["Prompt exposed over MCP (mcp)"]);
	});

	it("drops MCP prompt commands from slash completion when the server goes away", async () => {
		await mode.refreshSlashCommandState(tempDir.path());
		session.setMCPPromptCommands([mcpPromptCommand("wave6:wave6_prompt", "Prompt exposed over MCP")]);
		expect(await completionsFor("/wave6")).toContain("wave6:wave6_prompt");

		session.setMCPPromptCommands([]);

		expect(await completionsFor("/wave6")).toEqual([]);
	});

	it("reports an MCP config error and forgets it once the next connect round starts", () => {
		const statuses: string[] = [];
		mode.showStatus = (message: string) => {
			statuses.push(Bun.stripANSI(message));
		};

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "config-error",
			error: "[mcp.json] Failed to parse JSON in /tmp/wave6/.mcp.json",
		});
		expect(statuses.at(-1)).toContain("/tmp/wave6/.mcp.json");

		// A reload re-announces whatever is still broken; the previous round must not linger.
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, { type: "connecting", serverNames: ["wave6"] });
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, { type: "connected", serverName: "wave6" });

		expect(statuses.at(-1)).not.toContain(".mcp.json");
		expect(statuses.at(-1)).toContain("wave6");
	});

	it("announces hand-edited config problems in the TUI, where stderr is invisible", async () => {
		const warnings: string[] = [];
		mode.showWarning = (message: string) => {
			warnings.push(Bun.stripANSI(message));
		};
		const issues = [
			{
				kind: "quarantined-config" as const,
				source: path.join(tempDir.path(), "config.yml"),
				message: `Quarantined unparseable ${path.join(tempDir.path(), "config.yml")}; using defaults`,
			},
		];
		session.settings.getConfigIssues = () => issues;

		await mode.init();

		expect(warnings.some(warning => warning.includes("Quarantined unparseable"))).toBe(true);
	});

	it("stays silent at startup when the config is healthy", async () => {
		const warnings: string[] = [];
		mode.showWarning = (message: string) => {
			warnings.push(Bun.stripANSI(message));
		};

		await mode.init();

		expect(warnings.filter(warning => warning.startsWith("Config:"))).toEqual([]);
	});

	it("marks python composer mode with the REPL prompt without reflowing the draft", () => {
		const gutters: string[] = [];
		mode.editor.setPromptGutter = (gutter: string | undefined) => {
			gutters.push(gutter ?? "");
		};

		mode.updateEditorBorderColor();
		const chat = gutters.at(-1) ?? "";

		mode.isBashMode = true;
		mode.updateEditorBorderColor();
		const bash = gutters.at(-1) ?? "";

		mode.isBashMode = false;
		mode.isPythonMode = true;
		mode.updateEditorBorderColor();
		const python = gutters.at(-1) ?? "";

		expect(Bun.stripANSI(chat)).toBe("  › ");
		expect(Bun.stripANSI(bash)).toBe("  $ ");
		expect(Bun.stripANSI(python)).toBe(">>> ");
		// Same width in every mode: toggling modes must not shift the draft text.
		expect(new Set([chat, bash, python].map(g => Bun.stripANSI(g).length))).toEqual(new Set([4]));
	});
});
