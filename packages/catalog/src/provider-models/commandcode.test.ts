import { describe, expect, test } from "bun:test";
import { buildModel } from "../build";
import { getBundledModel } from "../models";
import type { FetchImpl } from "../types";
import { commandCodeModelManagerOptions } from "./openai-compat";

function catalogFetch(): { requests: { url: string; authorization: string | null }[]; fetch: FetchImpl } {
	const requests: { url: string; authorization: string | null }[] = [];
	const fetch: FetchImpl = async (input, init) => {
		requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return Response.json({
			object: "list",
			data: [
				{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1_000_000 },
				{ id: "gpt-5.5", name: "GPT-5.5", context_length: 400_000 },
				{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1_000_000 },
				{ id: "gpt-6-sol", name: "GPT-6 Sol" },
			],
		});
	};
	return { requests, fetch };
}

async function discover(options: { apiKey?: string; baseUrl?: string } = {}) {
	const { requests, fetch } = catalogFetch();
	const specs = (await commandCodeModelManagerOptions({ ...options, fetch }).fetchDynamicModels?.()) ?? [];
	const byId = new Map(specs.map(spec => [spec.id, buildModel(spec)] as const));
	return { requests, byId };
}

describe("Command Code provider discovery", () => {
	test("routes Claude ids to the Messages root and everything else to chat completions", async () => {
		const { requests, byId } = await discover({ baseUrl: "https://proxy.example/provider/v1/" });
		expect(requests.map(request => request.url)).toEqual(["https://proxy.example/provider/v1/models"]);
		expect(byId.get("claude-sonnet-5")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://proxy.example/provider",
			thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		});
		expect(byId.get("gpt-5.5")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://proxy.example/provider/v1",
			compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
		});
	});

	test("never lends another host's reasoning, image support, rates, or window to an id without reviewed policy", async () => {
		const reference = getBundledModel("openai", "gpt-6-sol");
		expect(reference.reasoning).toBe(true);

		const { byId } = await discover();
		expect(byId.get("gpt-6-sol")).toMatchObject({
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: 65_536,
			compat: { supportsReasoningEffort: false },
		});
	});

	test("serves DeepSeek V4.1 Flash with its documented ladder and image input", async () => {
		const { byId } = await discover();
		expect(byId.get("deepseek/deepseek-v4.1-flash")).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			thinking: { efforts: ["low", "high", "max"] },
			compat: { stripImageInput: false },
		});
	});

	test("forwards the key to the public catalog only when one is configured", async () => {
		expect((await discover({ apiKey: "user_test" })).requests[0]?.authorization).toBe("Bearer user_test");
		expect((await discover()).requests[0]?.authorization).toBeNull();
	});
});
