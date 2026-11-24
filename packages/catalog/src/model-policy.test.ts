import { describe, expect, it } from "bun:test";
import { buildModel, modelAcceptsSamplingParams } from "./build";
import { Effort } from "./effort";
import { isPromptCachePersistent, resolvePromptCacheLookback } from "./model-policy";
import { clampThinkingLevelForModel, getSupportedEfforts } from "./model-thinking";
import { calculateUncachedInputCost, getBundledModel } from "./models";
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

	it("bounds warm-cache pruning to Claude's 20-position lookback on every host", () => {
		// Regression: without a bound, a rewrite behind a long run of small turns left no reachable
		// cache entry and the next request re-wrote the whole conversation.
		expect(resolvePromptCacheLookback(buildModel(spec("claude-sonnet-4-5", "anthropic", "anthropic-messages")))).toBe(
			20,
		);
		expect(
			resolvePromptCacheLookback(
				buildModel({
					...spec("anthropic.claude-sonnet-4-5-20250929-v1:0", "amazon-bedrock", "bedrock-converse-stream"),
					requestModelId: undefined,
				}),
			),
		).toBe(20);
		expect(resolvePromptCacheLookback(buildModel(spec("gpt-5", "openai", "openai-responses")))).toBeUndefined();
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

	it("caps Antigravity Claude 4.x output tokens and discovered per-SKU caps at 64K", () => {
		const capped = buildModel({
			...spec("claude-sonnet-4-6", "google-antigravity", "google-gemini-cli"),
			maxTokens: 65_536,
			antigravityWireProfiles: {
				"claude-sonnet-4-6": { modelEnum: "MODEL_TEST", maxOutputTokens: 65_536 },
			},
		});
		expect(capped.maxTokens).toBe(64_000);
		expect(capped.antigravityWireProfiles?.["claude-sonnet-4-6"]).toEqual({
			modelEnum: "MODEL_TEST",
			maxOutputTokens: 64_000,
		});

		// Claude 5.x accepts the roster's larger cap.
		const claude5 = buildModel({
			...spec("claude-sonnet-5-5", "google-antigravity", "google-gemini-cli"),
			maxTokens: 128_000,
			antigravityWireProfiles: { "claude-sonnet-5-5": { maxOutputTokens: 128_000 } },
		});
		expect(claude5.maxTokens).toBe(128_000);
		expect(claude5.antigravityWireProfiles?.["claude-sonnet-5-5"]).toEqual({ maxOutputTokens: 128_000 });

		// An unknown cap stays unknown.
		const unknown = buildModel({
			...spec("claude-opus-4-6", "google-antigravity", "google-gemini-cli"),
			maxTokens: null,
		});
		expect(unknown.maxTokens).toBeNull();
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

describe("upstream catalog correctness ports", () => {
	it("disables GPT-6.1 Terra reasoning with `none` while Sol keeps its lowest-effort fallback", () => {
		for (const [id, mode] of [
			["gpt-6.1-terra", "none-effort"],
			["gpt-6.1-sol", "lowest-effort"],
		] as const) {
			const discovered = buildModel({
				...spec(id, "openai", "openai-responses"),
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
			});
			expect(discovered.compat.reasoningDisableMode).toBe(mode);
			expect(getBundledModel<"openai-responses">("openai", id).compat.reasoningDisableMode).toBe(mode);
		}
	});

	it("offers Mistral's documented effort ladders for dashed GLM 5.3 ids and Large 4", () => {
		for (const [id, efforts] of [
			["zai-glm-5-3", [Effort.Low, Effort.High, Effort.Max]],
			["zai-glm-5-3-flash", [Effort.Low, Effort.High, Effort.Max]],
			["mistral-large-4", [Effort.Low, Effort.Medium, Effort.High]],
			["mistral-large-4-0", [Effort.Low, Effort.Medium, Effort.High]],
			["mistral-large-4-0-8", [Effort.Low, Effort.Medium, Effort.High]],
		] as const) {
			const discovered = buildModel({
				...spec(id, "mistral"),
				baseUrl: "https://api.mistral.ai/v1",
				reasoning: true,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				},
			});
			expect(getSupportedEfforts(discovered)).toEqual([...efforts]);
			expect(getSupportedEfforts(getBundledModel("mistral", id))).toEqual([...efforts]);
		}
		expect(getBundledModel("mistral", "zai-glm-5-3").thinking).toMatchObject({
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
	});
});

describe("Cursor GPT-5.1 pricing", () => {
	it("prices the GPT-5.1 base lanes at the published card", () => {
		for (const id of ["gpt-5.1", "gpt-5.1-high", "gpt-5.1-low"]) {
			const card = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
			expect(
				buildModel({ ...spec(id, "cursor"), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }).cost,
			).toMatchObject(card);
			expect(getBundledModel("cursor", id).cost).toMatchObject(card);
		}
	});
});
