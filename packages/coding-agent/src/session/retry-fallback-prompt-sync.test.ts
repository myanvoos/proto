import { afterEach, expect, it } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";
import { TurnRecovery, type TurnRecoveryHost } from "./turn-recovery";

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
	expect(session.servingModel?.contextWindow).toBe(primaryModel.contextWindow);

	await session.prompt("Force a fallback");
	await session.waitForIdle();

	expect(session.model?.id).toBe(fallbackModel.id);
	expect(session.agent.state.systemPrompt).toEqual([`model:${fallbackModel.id}`]);
	expect(session.servingModel?.contextWindow).toBe(fallbackModel.contextWindow);
});

it("does not reset the retry budget for a fallback whose effort clamps to the failing request", async () => {
	const primary = getBundledModel("openrouter", "z-ai/glm-4.7");
	if (!primary) throw new Error("Expected bundled test model");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openrouter", "test-key");
	const mock = createMockModel();
	let requests = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requests++;
			// A success fuse bounds the old infinite retry path without a wall-clock timeout.
			mock.push(requests < 4 ? { throw: "overloaded_error: provider returned error 503" } : { content: ["fuse"] });
			return mock.stream(model, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": 1,
		"retry.fallbackChains": { "openrouter/z-ai/glm-4.7": ["openrouter/glm-4.7:high"] },
	});
	settings.setModelRole("default", "openrouter/z-ai/glm-4.7");
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		thinkingLevel: ThinkingLevel.Low,
		thinkingLevelCeiling: ThinkingLevel.Low,
	});
	await session.prompt("Exercise bounded retries");
	await session.waitForIdle();
	expect(requests).toBe(2);
	expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
});

it.each([
	{
		name: "retries a progressed socket drop on the same model once",
		progress: true,
		drops: 1,
		maxRetries: 1,
		routes: ["primary", "primary"],
	},
	{
		name: "falls back after the same-model socket retry also drops",
		progress: true,
		drops: 2,
		maxRetries: 2,
		routes: ["primary", "primary", "fallback"],
	},
	{
		name: "still falls back when no same-model retry budget remains",
		progress: true,
		drops: 1,
		maxRetries: 0,
		routes: ["primary", "fallback"],
	},
	{
		name: "immediately falls back when a socket drops before any progress",
		progress: false,
		drops: 1,
		maxRetries: 1,
		routes: ["primary", "fallback"],
	},
])("$name", async ({ progress, drops, maxRetries, routes }) => {
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallback = getBundledModel("openai", "gpt-4o-mini");
	if (!primary || !fallback) throw new Error("Expected bundled test models");
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	authStorage.setRuntimeApiKey("openai", "test-key");
	const responses: MockResponse[] = Array.from({ length: drops }, () => ({
		content: progress ? [{ type: "thinking", thinking: "partial plan" }] : [],
		stopReason: "error",
		errorMessage: "The socket connection was closed unexpectedly.",
	}));
	responses.push({ content: ["Recovered"] });
	const mock = createMockModel({ responses });
	const requested: string[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requested.push(model.provider === primary.provider ? "primary" : "fallback");
			return mock.stream(model, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": maxRetries,
		"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
	});
	settings.setModelRole("default", `${primary.provider}/${primary.id}`);
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	await session.prompt("Recover the stream");
	await session.waitForIdle();
	expect(requested).toEqual([...routes]);
	expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
});

it("continues a Cursor stream missing turnEnded only after all tool calls have results", async () => {
	const model = createMockModel();
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file" } }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "Cursor stream ended before turnEnded",
		errorId: AIError.create(AIError.Flag.Transient),
		timestamp: 1,
	};
	const agent = new Agent({ initialState: { model, messages: [message] } });
	authStorage = await AuthStorage.create(":memory:");
	const host = {
		agent,
		settings: Settings.isolated({}),
		modelRegistry: new ModelRegistry(authStorage),
		configWarnings: [],
		model: () => model,
		abortInProgress: () => false,
		isDisposed: () => false,
		deadlineExceeded: () => false,
		toolCallLoopStopped: () => false,
	} as unknown as TurnRecoveryHost;
	const recovery = new TurnRecovery(host);
	expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
	agent.appendMessage({
		role: "toolResult",
		toolName: "read",
		toolCallId: "read-1",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 2,
	});
	expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
});
