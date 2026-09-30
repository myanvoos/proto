import { describe, expect, it } from "bun:test";
import { buildModel } from "./build";
import { Effort } from "./effort";
import { getSupportedEfforts } from "./model-thinking";
import type { Api, Model, Provider } from "./types";

function createReasoningModel<TApi extends Api>(id: string, api: TApi, provider: Provider): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	});
}

describe("model thinking derivation", () => {
	it("drops minimal for Gemini 3.7+ Flash only on direct google-level hosts", () => {
		const directHosts = [
			{ api: "google-generative-ai", provider: "google" },
			{ api: "google-vertex", provider: "google-vertex" },
			{ api: "google-generative-ai", provider: "opencode-zen" },
		] as const;

		for (const host of directHosts) {
			const model = createReasoningModel("gemini-3.7-flash", host.api, host.provider);
			expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		}

		const budgetReseller = createReasoningModel("google/gemini-3.7-flash", "anthropic-messages", "vercel-ai-gateway");
		expect(budgetReseller.thinking?.mode).toBe("budget");
		expect(getSupportedEfforts(budgetReseller)).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);

		const nextRevision = createReasoningModel("gemini-3.8-flash", "google-vertex", "google-vertex");
		expect(getSupportedEfforts(nextRevision)).toEqual([Effort.Low, Effort.Medium, Effort.High]);

		const lite = createReasoningModel("gemini-3.8-flash-lite", "google-vertex", "google-vertex");
		expect(getSupportedEfforts(lite)).toContain(Effort.Minimal);
	});

	it("uses effort control for OpenAI-family models served by Bedrock Converse", () => {
		const model = createReasoningModel("global.openai.gpt-5.6-luna", "bedrock-converse-stream", "amazon-bedrock");

		expect(model.thinking?.mode).toBe("effort");
	});

	it("offers the full effort ladder including max to unknown-family models", () => {
		const fullLadder = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

		const completions = createReasoningModel("mystery-reasoner-9", "openai-completions", "acme-gateway");
		expect(completions.thinking?.mode).toBe("effort");
		expect(getSupportedEfforts(completions)).toEqual(fullLadder);

		const responses = createReasoningModel("mystery-reasoner-9", "openai-responses", "acme-gateway");
		expect(responses.thinking?.mode).toBe("effort");
		expect(getSupportedEfforts(responses)).toEqual(fullLadder);

		const anthropicTransport = createReasoningModel("mystery-reasoner-9", "anthropic-messages", "acme-gateway");
		expect(anthropicTransport.thinking?.mode).toBe("budget");
		expect(getSupportedEfforts(anthropicTransport)).toEqual(fullLadder);
	});

	it("keeps known pre-4.6 Claude rows off the max tier on Anthropic transports", () => {
		const messages = createReasoningModel("claude-opus-4-5", "anthropic-messages", "acme-gateway");
		expect(messages.thinking?.mode).toBe("anthropic-budget-effort");
		expect(getSupportedEfforts(messages)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);

		const bedrock = createReasoningModel("claude-opus-4-5", "bedrock-converse-stream", "amazon-bedrock");
		expect(bedrock.thinking?.mode).toBe("anthropic-budget-effort");
		expect(getSupportedEfforts(bedrock)).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("drives Cerebras Qwen 3.8 through OpenAI reasoning_effort instead of DashScope thinking toggles", () => {
		const model = createReasoningModel("qwen-3.8-27b", "openai-completions", "cerebras");

		expect(model.compat.thinkingFormat).toBe("openai");
		expect(model.compat.reasoningDisableMode).toBe("none-effort");
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
	});
});
