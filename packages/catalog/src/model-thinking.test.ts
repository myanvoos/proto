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
	it("drops minimal for Gemini 3.7 Flash only on direct google-level hosts", () => {
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
		expect(getSupportedEfforts(nextRevision)).toContain(Effort.Minimal);
	});

	it("uses effort control for OpenAI-family models served by Bedrock Converse", () => {
		const model = createReasoningModel("global.openai.gpt-5.6-luna", "bedrock-converse-stream", "amazon-bedrock");

		expect(model.thinking?.mode).toBe("effort");
	});
});
