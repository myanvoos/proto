import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { detectServedModelMismatch, ServedModelTracker } from "./served-model-marker";

function turn(parts: { model: string; served?: string; provider?: string }): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: parts.provider ?? "openrouter",
		model: parts.model,
		...(parts.served ? { upstreamModel: parts.served } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("detectServedModelMismatch", () => {
	it("flags a different family or revision served under the requested id", () => {
		expect(detectServedModelMismatch(turn({ model: "anthropic/claude-opus-5", served: "claude-haiku-4-5" }))).toEqual(
			{ requested: "anthropic/claude-opus-5", served: "claude-haiku-4-5", provider: "openrouter" },
		);
		expect(detectServedModelMismatch(turn({ model: "claude-opus-4-6", served: "claude-opus-4-7" }))?.served).toBe(
			"claude-opus-4-7",
		);
	});

	it("treats a dated snapshot or gateway prefix of the requested model as the same model", () => {
		expect(
			detectServedModelMismatch(turn({ model: "anthropic/claude-haiku-4.5", served: "claude-haiku-4-5-20251001" })),
		).toBeUndefined();
	});

	it("treats an unclassifiable served id (first-party codename) as unverifiable", () => {
		expect(
			detectServedModelMismatch(
				turn({ model: "claude-opus-4-6", served: "numbat-v6-efforts-20-40-80-ab-prod", provider: "anthropic" }),
			),
		).toBeUndefined();
	});
});

it("ServedModelTracker reports each substitution pair once per transcript", () => {
	const tracker = new ServedModelTracker();
	const swapped = turn({ model: "claude-opus-5", served: "claude-haiku-4-5" });
	expect(tracker.check(swapped)).toBeDefined();
	expect(tracker.check(swapped)).toBeUndefined();
	expect(tracker.check(turn({ model: "claude-sonnet-5", served: "claude-haiku-4-5" }))?.requested).toBe(
		"claude-sonnet-5",
	);
});
