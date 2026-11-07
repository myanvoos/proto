/**
 * A stale Responses item error must close the current openai-responses provider state without deleting it: a fresh
 * state would start warm on hosts without connection binding and resend the native items the server just refused.
 */
import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
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

async function runStaleReplay() {
	const model = getBundledModel("openai", "gpt-4o-mini") as Model;
	const staleReplayError = "Item with id 'rs_stale' not found.";
	const requested: string[] = [];
	const mock = createMockModel({
		responses: [{ throw: staleReplayError }, { content: ["Recovered after Responses state reset"] }],
	});
	const agent = new Agent({
		getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestedModel, context, options) => {
			requested.push(`${requestedModel.provider}/${requestedModel.id}`);
			return mock.stream(requestedModel, context, options);
		},
	});
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": 1,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});

	let closeCalls = 0;
	const state: ProviderSessionState = {
		close: () => {
			closeCalls++;
		},
	};
	session.providerSessionState.set("openai-responses:openai", state);

	await session.prompt("Retry stale OpenAI replay");
	await session.waitForIdle();
	return { requested, closeCalls };
}

it("closes but keeps the Responses provider state after a stale item error", async () => {
	const { requested, closeCalls } = await runStaleReplay();

	expect(closeCalls).toBe(1);
	expect(session?.providerSessionState.has("openai-responses:openai")).toBe(true);
	expect(requested).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o-mini"]);
});
