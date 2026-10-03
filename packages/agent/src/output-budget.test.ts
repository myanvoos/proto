import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { fitOutputTokensToContextWindow, MIN_FITTED_OUTPUT_TOKENS, OUTPUT_FIT_HEADWAY_TOKENS } from "./output-budget";
import { Tokenizer } from "./tokenizer";

// Prompt plus requested output must never exceed the model's context window, which Chat Completions-style providers
// enforce with a 400. Test-env token counts are bytes/4, so `tokens * 4` ASCII bytes is exactly `tokens`.
function userOf(tokens: number, timestamp = 0): Message {
	return { role: "user", content: "x".repeat(tokens * 4), timestamp };
}

function promptOf(tokens: number): Context {
	return { messages: [userOf(tokens)] };
}

/** Settled assistant turn whose provider-reported prompt was `promptTokens`. */
function reported(promptTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: promptTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const bundled = getBundledModel("deepseek", "deepseek-v4-pro");
if (!bundled) throw new Error("Expected bundled deepseek/deepseek-v4-pro");
const deepseek: Model = { ...bundled, contextWindow: 1_000_000, maxTokens: 384_000 };

describe("fitOutputTokensToContextWindow", () => {
	const tokenizer = new Tokenizer();

	test("leaves the cap alone while prompt plus requested output fits", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(100_000), undefined, tokenizer)).toBeUndefined();
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(100_000), 2_048, tokenizer)).toBe(2_048);
		expect(
			fitOutputTokensToContextWindow({ ...deepseek, contextWindow: 0 }, promptOf(900_000), undefined, tokenizer),
		).toBeUndefined();
	});

	test("lowers the model default cap to the room the prompt leaves", () => {
		const cap = fitOutputTokensToContextWindow(deepseek, promptOf(666_387), undefined, tokenizer);
		expect(cap).toBe(1_000_000 - (666_387 + Math.ceil(666_387 / 10)) - OUTPUT_FIT_HEADWAY_TOKENS);
	});

	test("lowers an explicit caller cap that no longer fits", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(800_000), 200_000, tokenizer)).toBe(
			120_000 - OUTPUT_FIT_HEADWAY_TOKENS,
		);
	});

	test("counts system prompt and tool definitions, not just messages", () => {
		const context: Context = {
			systemPrompt: ["s".repeat(200_000 * 4)],
			tools: [{ name: "t", description: "d".repeat(100_000 * 4), parameters: {} as never }],
			messages: promptOf(300_000).messages,
		};
		expect(fitOutputTokensToContextWindow(deepseek, context, undefined, tokenizer) ?? 0).toBeLessThanOrEqual(
			1_000_000 - 600_000,
		);
	});

	test("keeps an OpenRouter default cap omitted, but still fits an explicit one", () => {
		const openrouter = { ...deepseek, compat: { isOpenRouterHost: true, alwaysSendMaxTokens: false } } as never;
		expect(fitOutputTokensToContextWindow(openrouter, promptOf(800_000), undefined, tokenizer)).toBeUndefined();
		expect(fitOutputTokensToContextWindow(openrouter, promptOf(800_000), 200_000, tokenizer)).toBe(
			120_000 - OUTPUT_FIT_HEADWAY_TOKENS,
		);
	});

	test("sizes the prompt from the provider's last report plus only the unreported tail", () => {
		// Counting the reported prefix locally would read 900k and floor the cap; the provider measured 500k.
		const context: Context = { messages: [userOf(900_000, 1), reported(500_000, 2), userOf(200_000, 3)] };
		expect(fitOutputTokensToContextWindow(deepseek, context, undefined, tokenizer)).toBe(
			1_000_000 - (500_000 + 220_000) - OUTPUT_FIT_HEADWAY_TOKENS,
		);
	});

	test("ignores reports made before a history rewrite", () => {
		for (const historyRewriteAt of [10, 4]) {
			const summary: Message = { role: "user", content: "summary", historyRewriteAt, timestamp: 10 };
			const stale: Context = { messages: [summary, reported(950_000, 5), userOf(1_000, 11)] };
			expect(fitOutputTokensToContextWindow(deepseek, stale, undefined, tokenizer)).toBeUndefined();
		}
	});

	test("never requests less than the floor, leaving a full window to compaction", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(990_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});

	test("applies the absolute headway when room lands between requested and requested + headway", () => {
		const context: Context = { messages: [reported(799_950, 1)] };
		expect(fitOutputTokensToContextWindow(deepseek, context, 200_000, tokenizer)).toBe(199_986);
	});
});
