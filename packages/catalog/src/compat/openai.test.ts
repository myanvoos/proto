import { describe, expect, test } from "bun:test";
import type { ModelSpec } from "../types";
import { buildOpenAIResponsesCompat, buildOpenRouterCompat } from "./openai";

function responsesSpec(provider: string, id: string, baseUrl: string): ModelSpec<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	};
}

function openRouterSpec(id: string): ModelSpec<"openrouter"> {
	return {
		id,
		name: id,
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 64_000,
	};
}

describe("Muse Spark replay policy", () => {
	test("drops replayed reasoning and synthetic stand-ins for Muse Spark on OpenRouter only", () => {
		// Meta validates echoed reasoning-item ids and 400s expired ones, which wedges every later turn.
		const muse = buildOpenRouterCompat(openRouterSpec("meta/muse-spark-1.3"));
		expect(muse.filterReasoningHistory).toBe(true);
		expect(muse.allowsSyntheticReasoningContentForToolCalls).toBe(false);

		const llama = buildOpenRouterCompat(openRouterSpec("meta/llama-4-maverick"));
		expect(llama.filterReasoningHistory).toBe(false);
		expect(llama.allowsSyntheticReasoningContentForToolCalls).toBe(true);
	});

	test("stops requesting encrypted reasoning for Muse Spark on OpenCode gateways (#11928)", () => {
		// The gateway cannot round-trip `encrypted_content` Meta bound to its own caller.
		for (const [provider, id, baseUrl] of [
			["opencode-zen", "muse-spark-1.3-contributor-free", "https://opencode.ai/zen/v1"],
			["opencode-go", "muse-spark-1.3-contributor", "https://opencode.ai/zen/go/v1"],
		] as const) {
			const compat = buildOpenAIResponsesCompat(responsesSpec(provider, id, baseUrl));
			expect(compat.includeEncryptedReasoning).toBe(false);
			expect(compat.filterReasoningHistory).toBe(true);
		}
		const sibling = buildOpenAIResponsesCompat(
			responsesSpec("opencode-zen", "big-pickle", "https://opencode.ai/zen/v1"),
		);
		expect(sibling.includeEncryptedReasoning).toBe(true);
		expect(sibling.filterReasoningHistory).toBe(false);
	});
});
