import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
});

// Retry fallbacks swap the model without going through setModel(), so model-dependent
// base-prompt policy stayed pinned to the chain-head model for the rest of the session.
it("re-syncs the model-dependent base prompt after a retry-fallback swap", async () => {
	const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
	if (!primaryModel || !fallbackModel) throw new Error("Expected bundled test models to exist");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	authStorage.setRuntimeApiKey("openai", "openai-test-key");

	const mock = createMockModel();
	const agent = new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			if (model.provider === primaryModel.provider) {
				mock.push({ throw: "overloaded_error: provider returned error 503" });
			} else {
				mock.push({ content: ["Recovered on the fallback"] });
			}
			return mock.stream(model, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		includeModelInPrompt: true,
		"retry.baseDelayMs": 5,
		"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
	});
	settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(),
		rebuildSystemPrompt: async () => ({ systemPrompt: [`model:${session?.model?.id}`] }),
	});

	await session.refreshBaseSystemPrompt();
	expect(session.agent.state.systemPrompt).toEqual([`model:${primaryModel.id}`]);

	await session.prompt("Force a fallback");
	await session.waitForIdle();

	expect(session.model?.id).toBe(fallbackModel.id);
	expect(session.agent.state.systemPrompt).toEqual([`model:${fallbackModel.id}`]);
});
