import { describe, expect, it } from "bun:test";
import { buildModel, modelAcceptsSamplingParams } from "./build";
import { Effort } from "./effort";
import { isPromptCachePersistent } from "./model-policy";
import { clampThinkingLevelForModel } from "./model-thinking";
import { calculateUncachedInputCost } from "./models";
import type { Api, ModelSpec } from "./types";

function spec<TApi extends Api = "openai-completions">(
	id: string,
	provider: string,
	api: TApi = "openai-completions" as TApi,
): ModelSpec<TApi> {
	return {
		id,
		name: id,
		provider,
		api,
		baseUrl: "https://fixture.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("reviewed catalog policies", () => {
	it("keeps native Codex prefixes warm without treating relays or API keys as permanent caches", () => {
		expect(
			isPromptCachePersistent({ provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" }),
		).toBe(true);
		expect(isPromptCachePersistent({ provider: "openai-codex", baseUrl: "https://relay.example/backend-api" })).toBe(
			false,
		);
		expect(
			isPromptCachePersistent({ provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api-impostor" }),
		).toBe(false);
		expect(isPromptCachePersistent({ provider: "openai", baseUrl: "https://chatgpt.com/backend-api" })).toBe(false);
	});

	it("prices Haiku's whole request above 100K without imposing that tier on Copilot's split rows", () => {
		const direct = buildModel(spec("claude-haiku-5-5", "anthropic", "anthropic-messages"));
		expect(calculateUncachedInputCost(direct.cost, 100_000)).toBeCloseTo(0.01);
		expect(calculateUncachedInputCost(direct.cost, 100_001)).toBeCloseTo(0.0500005);
		expect(direct.thinking?.mode).toBe("anthropic-adaptive");
		expect(direct.compat?.disabledThinking).toBe("disabled");
		const copilot = buildModel(spec("claude-haiku-5.5", "github-copilot", "anthropic-messages"));
		expect(copilot.cost.longContext).toBeUndefined();
		expect(modelAcceptsSamplingParams(direct)).toBe(false);
	});

	it("changes Argon's price at the scheduled billing instant even when a model was built earlier", () => {
		const model = buildModel(spec("gemini-4-argon", "google", "google-generative-ai"));
		const change = Date.UTC(2026, 11, 1, 8);
		expect(calculateUncachedInputCost(model.cost, 1_000_000, change - 1)).toBe(2);
		expect(calculateUncachedInputCost(model.cost, 1_000_000, change)).toBe(4);
		expect(model.thinking).toMatchObject({
			mode: "google-level",
			efforts: ["low", "medium", "high"],
			requiresEffort: true,
		});
	});

	it("uses the lead's rates for Fusion writes and bounded long context rather than the opaque composite identity", () => {
		const model = buildModel({
			...spec("fusion-gpt-6-sol-sidekick-fixture", "devin", "devin-agent"),
			requestModelId: "gpt-6-sol",
		});
		expect(model.cost.cacheWrite).toBe(2.5);
		expect(model.cost.longContext).toMatchObject({ inputThreshold: 272_000, input: 4, output: 15, cacheWrite: 5 });
	});

	it("does not convert DeepSeek Pro into the cheaper Flash card after September", () => {
		const model = buildModel(spec("deepseek-v4-pro", "deepseek"));
		expect(calculateUncachedInputCost(model.cost, 1_000_000, Date.UTC(2026, 10, 2, 1))).toBe(1.32);
	});

	it("honors a wire-stable advertised effort alias without following a second remap", () => {
		const model = {
			...spec("fixture", "custom"),
			reasoning: true,
			thinking: {
				mode: "effort" as const,
				efforts: [Effort.Low, Effort.High] as const,
				effortMap: { medium: Effort.High },
			},
		};
		expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(Effort.High);
		expect(
			clampThinkingLevelForModel(
				{ ...model, thinking: { ...model.thinking, effortMap: { medium: Effort.High, high: Effort.Max } } },
				Effort.Medium,
			),
		).toBe(Effort.Low);
	});
});
