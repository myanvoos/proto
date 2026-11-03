import { expect, test } from "bun:test";
import type { ModelSpec } from "../types";
import { buildOpenAICompat } from "./openai";

test("Mistral's DeepSeek gateway never requires native DeepSeek reasoning replay fields", () => {
	const spec: ModelSpec<"openai-completions"> = {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
	const mistral = buildOpenAICompat(spec);
	expect(mistral.requiresThinkingAsText).toBe(true);
	expect(mistral.requiresReasoningContentForToolCalls).toBe(false);
	expect(mistral.requiresReasoningContentForAllAssistantTurns).toBe(false);
	const direct = buildOpenAICompat({ ...spec, provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" });
	expect(direct.requiresReasoningContentForToolCalls).toBe(true);
	expect(direct.requiresReasoningContentForAllAssistantTurns).toBe(true);
});
