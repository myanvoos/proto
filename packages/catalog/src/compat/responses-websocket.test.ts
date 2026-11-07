import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import type { Api, ModelSpec } from "../types";
import { resolveResponsesWebSocketPreference } from "./responses-websocket";

function responsesModel(overrides: Partial<ModelSpec<Api>> = {}) {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		...overrides,
	} as ModelSpec<Api>);
}

describe("standard Responses WebSocket catalog policy", () => {
	test("keeps supported official models on SSE until explicitly opted in", () => {
		const model = responsesModel();
		expect(resolveResponsesWebSocketPreference(model)).toBe(false);
		expect(resolveResponsesWebSocketPreference(model, true)).toBe(true);
	});

	test("allows model opt-in but neither preference can override an explicit false", () => {
		const optedIn = responsesModel({ preferWebsockets: true });
		expect(resolveResponsesWebSocketPreference(optedIn)).toBe(true);
		expect(resolveResponsesWebSocketPreference(optedIn, false)).toBe(false);
		expect(resolveResponsesWebSocketPreference(responsesModel({ preferWebsockets: false }), true)).toBe(false);
	});

	test("cannot opt providers or APIs without an enabling rule into WebSockets", () => {
		for (const overrides of [
			{ provider: "unknown-gateway", baseUrl: "https://gateway.example/v1" },
			{ provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" },
			{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
			{ provider: "openrouter", api: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
			{ api: "openai-completions" },
			{ api: "openai-codex-responses" },
			{ api: "azure-openai-responses", provider: "azure", baseUrl: "https://example.openai.azure.com" },
		] satisfies Partial<ModelSpec<Api>>[]) {
			const model = responsesModel({ ...overrides, preferWebsockets: true });
			expect(resolveResponsesWebSocketPreference(model, false)).toBe(false);
			expect(resolveResponsesWebSocketPreference(model)).toBe(false);
			expect(resolveResponsesWebSocketPreference(model, true)).toBe(false);
		}
	});

	test("inherits the rule for custom providers pointed at the official Responses host", () => {
		const gateway = responsesModel({ provider: "custom-openai" });
		expect(resolveResponsesWebSocketPreference(gateway)).toBe(false);
		expect(resolveResponsesWebSocketPreference(gateway, true)).toBe(true);
		expect(resolveResponsesWebSocketPreference({ ...gateway, preferWebsockets: true })).toBe(true);
	});
});
