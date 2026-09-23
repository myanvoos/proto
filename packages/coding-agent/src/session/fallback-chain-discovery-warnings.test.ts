import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession, type AgentSessionEvent } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const model: Model<"openai-completions"> = buildModel({
	id: "primary",
	name: "Primary",
	api: "openai-completions",
	provider: "primary-test",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: string | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

it("defers unknown-model fallback warnings for a cold discovery provider until its first refresh settles", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-fallback-discovery-"));
	const modelsPath = path.join(tempDir, "models.yml");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				litellm: {
					baseUrl: "https://litellm.example.net/v1",
					api: "openai-completions",
					apiKey: "test-key",
					discovery: { type: "litellm" },
				},
			},
		}),
	);
	authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, modelsPath, {
		cacheDbPath: path.join(tempDir, "models.db"),
		fetch: () => Promise.reject(new Error("network disabled in test")),
	});
	expect(registry.isProviderDiscoveryPending("litellm")).toBe(true);

	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { "litellm/qwen-27b": ["litellm/qwen-27b-hetzner"] },
		}),
		modelRegistry: registry,
	});
	const events: AgentSessionEvent["type"][] = [];
	session.subscribe(event => events.push(event.type));
	expect(session.configWarnings.filter(warning => warning.includes("litellm"))).toEqual([]);

	// The CLI starts background discovery after the session exists; the provider never supplies the models.
	registry.refreshInBackground("online");
	await registry.awaitInitialBackgroundRefresh();
	await Bun.sleep(0);

	expect(session.configWarnings).toEqual([
		"retry.fallbackChains key references unknown model: litellm/qwen-27b",
		"Fallback chain for model 'litellm/qwen-27b' references unknown model: litellm/qwen-27b-hetzner",
	]);
	expect(events).toContain("config_warnings_changed");
});
