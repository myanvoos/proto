/**
 * inspect_media visibility keys off the active model's image input. Two model-change paths used to leave it stale:
 * the post-discovery metadata rebind (never reconciled tools), and a switch between two image-capable models
 * (the hidden-state hint kept naming the previous model).
 */
import { afterEach, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
const opus = getBundledModel("anthropic", "claude-opus-4-1") as Model;
const inspectMediaTool = {
	name: "inspect_media",
	label: "Inspect media",
	description: "Inspect media",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [] }),
} as unknown as AgentTool;

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

async function createSession(options: { rebind: boolean; registry?: (registry: ModelRegistry) => void }) {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	options.registry?.(modelRegistry);
	session = new AgentSession({
		agent: new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "inspect_media.mode": "auto" }),
		modelRegistry,
		createInspectMediaTool: async () => inspectMediaTool,
		rebindModelAfterDiscovery: options.rebind,
	});
	return session;
}

it("reconciles inspect_media before model_changed when discovery refreshes the startup model's metadata", async () => {
	const refreshed: Model = { ...sonnet, contextWindow: (sonnet.contextWindow ?? 200_000) * 2, input: ["text"] };
	const refresh = Promise.withResolvers<void>();
	const current = await createSession({
		rebind: true,
		registry: registry => {
			vi.spyOn(registry, "awaitInitialBackgroundRefresh").mockReturnValue(refresh.promise);
			vi.spyOn(registry, "find").mockReturnValue(refreshed);
		},
	});
	expect(current.getEnabledToolNames()).not.toContain("inspect_media");
	const changed = Promise.withResolvers<string[]>();
	current.subscribe(event => {
		if (event.type === "model_changed") changed.resolve(current.getEnabledToolNames());
	});

	refresh.resolve();

	expect(await changed.promise).toContain("inspect_media");
	expect(current.model?.contextWindow).toBe(refreshed.contextWindow);
});

it("renames the model in the hidden-state hint when a switch keeps inspect_media hidden", async () => {
	const current = await createSession({ rebind: false });
	const notices: string[] = [];
	current.subscribe(event => {
		if (event.type === "notice" && event.source === "vision") notices.push(event.message);
	});

	await current.setModel(opus);
	await current.setModel(sonnet);

	expect(current.getEnabledToolNames()).not.toContain("inspect_media");
	expect(notices).toEqual([
		expect.stringContaining(`stays hidden: ${formatModelString(opus)}`),
		expect.stringContaining(`stays hidden: ${formatModelString(sonnet)}`),
	]);
});
