import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyChatCompletionsCompatPolicy,
	applyOpenAIExtraBody,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "../build";
import { Effort } from "../effort";
import { resolveProviderModels } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import {
	applyNewProviderPolicy,
	coralbricksModelManagerOptions,
	inceptionModelManagerOptions,
	sambanovaModelManagerOptions,
	scalewayModelManagerOptions,
} from "./new-providers";

function roster(data: unknown[], requests?: { url: string; authorization: string | null }[]): FetchImpl {
	return async (input, init) => {
		requests?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return Response.json({ data });
	};
}

function chatSpec(provider: string, id: string): ModelSpec<"openai-completions"> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://api.${provider}.ai/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

function requestReasoning(provider: string, id: string, effort: Effort | "off"): Record<string, unknown> {
	const model = buildModel(applyNewProviderPolicy(chatSpec(provider, id)));
	const params: OpenAICompletionsParams = { model: id, messages: [], stream: true };
	const policy = resolveOpenAICompatPolicy(
		model,
		effort === "off"
			? { endpoint: "chat-completions", disableReasoning: true }
			: { endpoint: "chat-completions", reasoning: effort },
	);
	applyChatCompletionsCompatPolicy(params, policy);
	applyOpenAIExtraBody(params, policy.compat.extraBody);
	const { model: _model, messages: _messages, stream: _stream, ...body } = params;
	return body;
}

describe("CoralBricks live deployment metadata", () => {
	test("authenticates discovery, filters non-chat rows, preserves zero tariffs and does not invent unknown model caps", async () => {
		const models = await coralbricksModelManagerOptions({
			apiKey: "test",
			baseUrl: "https://proxy.example/v1/",
			fetch: roster([
				{
					id: "deepseek-v4.1-flash-fast",
					context_length: "4096",
					pricing: { input_per_m: 0, output_per_m: 0, cached_input_per_m: 0, cache_write_per_m: 0 },
					supports_image_input: false,
					supports_reasoning: false,
				},
				{
					id: "coral-new",
					supports_tools: false,
					context_length: 8192,
					pricing: { input_per_m: 0.7, output_per_m: -1 },
				},
				{ id: "embedding", supports_chat: false },
			]),
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["coral-new", "deepseek-v4.1-flash-fast"]);
		expect(models?.find(model => model.id === "deepseek-v4.1-flash-fast")).toMatchObject({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			input: ["text"],
			reasoning: false,
			contextWindow: 4096,
			maxTokens: 131072,
		});
		expect(models?.find(model => model.id === "coral-new")).toMatchObject({
			reasoning: false,
			supportsTools: false,
			maxTokens: null,
			cost: { input: 0.7, output: 0 },
		});
		const requests: { url: string; authorization: string | null }[] = [];
		const authenticated = coralbricksModelManagerOptions({
			apiKey: "secret",
			baseUrl: "https://proxy.example/v1/",
			fetch: roster([], requests),
		});
		await authenticated.fetchDynamicModels?.();
		expect(requests).toEqual([{ url: "https://proxy.example/v1/models", authorization: "Bearer secret" }]);
	});

	test("normalizes live effort vocabularies and keeps explicit false and empty ladders through cache reload", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-coral-metadata-"));
		let fail = false;
		const options = {
			...coralbricksModelManagerOptions({
				apiKey: "test",
				fetch: async () =>
					fail
						? new Response("down", { status: 503 })
						: Response.json({
								data: [
									{
										id: "glm-5.3-fast",
										supports_reasoning: true,
										reasoning: {
											supported_efforts: ["max", "none", "low", "max", "unknown"],
											default_effort: "max",
											mandatory: false,
											disable: { reasoning_effort: "none" },
										},
									},
									{
										id: "deepseek-v4.1-flash-fast",
										supports_reasoning: false,
										supports_image_input: false,
										pricing: { cache_write_per_m: 0 },
									},
									{ id: "coral-empty", supports_reasoning: true, reasoning: { supported_efforts: [] } },
									{
										id: "coral-unknown",
										supports_reasoning: true,
										reasoning: { supported_efforts: ["turbo"] },
									},
								],
							}),
			}),
			cacheDbPath: path.join(dir, "models.db"),
		};
		try {
			for (const refresh of ["online", "offline", "online"] as const) {
				const { models } = await resolveProviderModels(options, refresh);
				expect(models.map(model => model.id).sort()).toEqual([
					"coral-empty",
					"coral-unknown",
					"deepseek-v4.1-flash-fast",
					"glm-5.3-fast",
				]);
				const glm = models.find(model => model.id === "glm-5.3-fast");
				expect(glm?.thinking).toMatchObject({
					efforts: [Effort.Low, Effort.Max],
					defaultLevel: Effort.Max,
					requiresEffort: false,
				});
				expect(glm?.compat?.reasoningDisableMode).toBe("none-effort");
				const deepseek = models.find(model => model.id === "deepseek-v4.1-flash-fast");
				expect(deepseek?.reasoning).toBe(false);
				expect(deepseek?.input).toEqual(["text"]);
				expect(deepseek?.cost.cacheWrite).toBe(0);
				expect(deepseek?.thinking).toBeUndefined();
				expect(models.find(model => model.id === "coral-empty")?.thinking).toBeUndefined();
				expect(models.find(model => model.id === "coral-unknown")?.thinking).toBeUndefined();
				fail = true;
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("SambaNova discovery and reasoning dialect", () => {
	test("converts per-token pricing without dropping cache rates and rejects embedding or audio SKUs", async () => {
		const models = await sambanovaModelManagerOptions({
			apiKey: "test",
			fetch: roster([
				{
					id: "MiniMax-M3",
					pricing: {
						prompt: "0.00000060",
						completion: "0.00000240",
						input_cache_read: "0.00000006",
						input_cache_write: "0",
					},
					context_length: "1048576",
					max_completion_tokens: "8192",
				},
				{ id: "gpt-oss-120b", pricing: { prompt: "0", completion: "0" } },
				{ id: "E5-Mistral-7B-Instruct" },
				{ id: "Whisper-large-v3" },
			]),
		}).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["gpt-oss-120b", "MiniMax-M3"]);
		expect(models?.find(model => model.id === "MiniMax-M3")).toMatchObject({
			cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 8192,
		});
		expect(models?.find(model => model.id === "gpt-oss-120b")?.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	test("uses one on-rung for template thinking, limits vision to Gemma 4+, and does not upgrade MiniMax M2", () => {
		const gemma = buildModel(applyNewProviderPolicy(chatSpec("sambanova", "Gemma-4-31B-it")));
		expect(gemma.input).toEqual(["text", "image"]);
		expect(gemma.thinking?.efforts).toEqual([Effort.High]);
		expect(requestReasoning("sambanova", "DeepSeek-V3.1", Effort.High)).toEqual({
			chat_template_kwargs: { enable_thinking: true },
		});
		expect(requestReasoning("sambanova", "DeepSeek-V3.1", "off")).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
		expect(requestReasoning("sambanova", "MiniMax-M3", Effort.Medium)).toEqual({ reasoning_effort: "medium" });
		expect(buildModel(applyNewProviderPolicy(chatSpec("sambanova", "MiniMax-M2"))).thinking).toBeUndefined();
		expect(buildModel(applyNewProviderPolicy(chatSpec("sambanova", "Gemma-3-27B-it"))).input).toEqual(["text"]);
	});
});

describe("Inception Mercury discovery", () => {
	test("filters the mixed endpoint roster and gives published tariffs precedence over the Mercury 3 launch fallback", async () => {
		const models = await inceptionModelManagerOptions({
			apiKey: "test",
			fetch: roster([
				{
					id: "mercury-3",
					supported_endpoints: ["chat.completions"],
					pricing: { prompt: "0.00000042", completion: "0.0000015", input_cache_reads: "0.000000025" },
					context_length: 999999,
					max_output_length: 60000,
					input_modalities: ["text", "image"],
					supported_features: [],
				},
				{ id: "mercury-edit", supported_endpoints: ["fim.completions"] },
				{ id: "undocumented-endpoints" },
			]),
		}).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["mercury-3"]);
		expect(models?.[0]).toMatchObject({
			cost: { input: 0.42, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
			contextWindow: 999999,
			maxTokens: 60000,
			input: ["text", "image"],
			supportsTools: false,
		});
		const zero = await inceptionModelManagerOptions({
			apiKey: "test",
			fetch: roster([
				{
					id: "mercury-3",
					supported_endpoints: ["chat.completions"],
					pricing: { prompt: "0", completion: "0", input_cache_read: "0" },
				},
			]),
		}).fetchDynamicModels?.();
		expect(zero?.[0]?.cost).toEqual({ input: 0.1, output: 0.35, cacheRead: 0.01, cacheWrite: 0 });
		expect(requestReasoning("inception", "mercury-3", Effort.Minimal)).toEqual({ reasoning_effort: "instant" });
	});
});

describe("Modular model-specific reasoning encoding", () => {
	test("switches Gemma and M3 by enabled while other models keep nested efforts", () => {
		for (const id of ["minimax/minimax-m3", "google/gemma-4-31b-it"]) {
			expect(requestReasoning("modular", id, Effort.High)).toEqual({ reasoning: { enabled: true } });
			expect(requestReasoning("modular", id, "off")).toEqual({ reasoning: { enabled: false } });
		}
		expect(requestReasoning("modular", "MiniMaxAI/MiniMax-M3.1-Flash", Effort.High)).toEqual({
			reasoning: { effort: "high" },
		});
		const mandatory = buildModel(applyNewProviderPolicy(chatSpec("modular", "MiniMaxAI/MiniMax-M3.1-Flash")));
		expect(mandatory.thinking).toMatchObject({
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			requiresEffort: true,
		});
		const future = { ...chatSpec("modular", "deepseek/deepseek-v4.1-flash-1017"), reasoning: true };
		const model = buildModel(applyNewProviderPolicy(future));
		const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
		applyChatCompletionsCompatPolicy(
			params,
			resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		expect(params.reasoning).toEqual({ effort: "high" });
	});
});

describe("Scaleway authoritative serverless catalog", () => {
	test("uses deployment limits for bare ids, drops unsupported tools/media models and prunes retired seeds", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-scaleway-catalog-"));
		try {
			const { models } = await resolveProviderModels(
				{
					...scalewayModelManagerOptions({
						apiKey: "test",
						fetch: roster([
							{ id: "glm-5.3" },
							{ id: "qwen3.8-27b" },
							{ id: "whisper-large-v3" },
							{ id: "qwen3-embedding-8b" },
							{ id: "bge-reranker" },
							{ id: "lightonocr-2" },
							{ id: "gpt-oss-120b" },
						]),
					}),
					cacheDbPath: path.join(dir, "models.db"),
				},
				"online",
			);
			expect(models.map(model => model.id)).toEqual(["glm-5.3", "qwen3.8-27b"]);
			expect(models.find(model => model.id === "glm-5.3")).toMatchObject({
				contextWindow: 256000,
				maxTokens: 16000,
				input: ["text"],
				thinking: { efforts: [Effort.Low, Effort.High, Effort.Max], requiresEffort: false },
			});
			expect(models.find(model => model.id === "qwen3.8-27b")?.thinking?.efforts).toEqual([
				Effort.Low,
				Effort.Medium,
				Effort.XHigh,
			]);
			expect(requestReasoning("scaleway", "qwen3.8-27b", "off")).toEqual({ reasoning_effort: "none" });
			expect(requestReasoning("scaleway", "qwen3.8-27b", Effort.XHigh)).toEqual({ reasoning_effort: "xhigh" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
