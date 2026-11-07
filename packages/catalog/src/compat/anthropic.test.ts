import { describe, expect, it } from "bun:test";
import type { ModelSpec } from "../types";
import { buildAnthropicCompat } from "./anthropic";

function spec(
	id: string,
	provider = "anthropic",
	baseUrl = "https://api.anthropic.com",
): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

describe("buildAnthropicCompat message threads", () => {
	it("enables message threads from Claude 4.5 on the first-party provider", () => {
		expect(buildAnthropicCompat(spec("claude-sonnet-4-6")).supportsMessageThreads).toBe(true);
		expect(buildAnthropicCompat(spec("claude-opus-4-5")).supportsMessageThreads).toBe(true);
		// Separator-collapsed ids parse their revision as a whole number; 45 is Opus 4.5.
		expect(buildAnthropicCompat(spec("claude-opus-45")).supportsMessageThreads).toBe(true);
		// A preview id without a numeric revision is pinned explicitly.
		expect(buildAnthropicCompat(spec("claude-mythos-preview")).supportsMessageThreads).toBe(true);
	});

	it("leaves pre-4.5 models and non-first-party hosts unthreaded", () => {
		expect(buildAnthropicCompat(spec("claude-sonnet-4")).supportsMessageThreads).toBe(false);
		expect(buildAnthropicCompat(spec("claude-3-5-haiku")).supportsMessageThreads).toBe(false);
		// Vertex and Bedrock serve the same ids but do not support threads.
		expect(buildAnthropicCompat(spec("claude-sonnet-4-6", "google-vertex")).supportsMessageThreads).toBe(false);
		expect(buildAnthropicCompat(spec("claude-sonnet-4-6", "amazon-bedrock")).supportsMessageThreads).toBe(false);
	});
});
