import { expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyLlamaCppQwenThinking, discoverModelsByProviderType } from "./model-discovery";

function llamaCppModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 8_192,
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
	} as ModelSpec<Api>);
}

test("PrismML Bonsai GGUFs route through the Qwen chat template of their lineage", () => {
	const bonsai2 = applyLlamaCppQwenThinking(llamaCppModel("Bonsai-2-27B-Q4_K_M.gguf"));
	expect(bonsai2.api).toBe("openai-completions");
	expect(bonsai2.compat).toMatchObject({ thinkingFormat: "qwen-chat-template", qwenTemplateReasoningEffort: true });
	expect(bonsai2.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.XHigh]);

	// The original Bonsai 27B is Qwen3.6-based: template thinking toggle, no template effort.
	const bonsai = applyLlamaCppQwenThinking(llamaCppModel("Ternary-Bonsai-27B.gguf"));
	expect(bonsai.compat).toMatchObject({ thinkingFormat: "qwen-chat-template", qwenTemplateReasoningEffort: false });
});

test("OpenAI model-list discovery reads nested token limits", async () => {
	const models = await discoverModelsByProviderType(
		{
			provider: "nested-limits-test",
			api: "openai-completions",
			baseUrl: "https://models.example.test/v1",
			discovery: { type: "openai-models-list" },
		},
		{
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "nested-limits-model",
							limits: { max_input_tokens: 196_000, max_output_tokens: 24_000 },
						},
					],
				}),
			getBearerApiKeyResolver: async () => undefined,
		},
	);

	expect(models[0]?.contextWindow).toBe(220_000);
	expect(models[0]?.maxTokens).toBe(24_000);
});

async function discoverRows(rows: Record<string, unknown>[], advertisedReasoning = true): Promise<Model<Api>[]> {
	return discoverModelsByProviderType(
		{
			provider: "gateway-test",
			api: "openai-completions",
			baseUrl: "https://gateway.example/v1",
			discovery: { type: "openai-models-list", advertisedReasoning },
		},
		{ fetch: async () => Response.json({ data: rows }), getBearerApiKeyResolver: async () => undefined },
	);
}

test("malformed output caps cannot mask a usable sibling and advertised caps outrank catalog defaults", async () => {
	const models = await discoverRows([
		{ id: "nested", limits: { max_output_tokens: 1200 }, max_output_tokens: 2200 },
		{ id: "top-provider", limits: { max_output_tokens: 1.5 }, top_provider: { max_completion_tokens: "2400" } },
		{ id: "flat-output", top_provider: { max_completion_tokens: -1 }, max_output_tokens: 3200 },
		{ id: "flat-completion", max_output_tokens: 1e30, max_completion_tokens: "4200" },
		{ id: "flat-generic", limits: { max_output_tokens: 1.5 }, max_tokens: 5200 },
		{ id: "capped", context_length: 1000, max_tokens: 8000 },
	]);
	expect(models.map(model => model.maxTokens)).toEqual([1200, 2400, 3200, 4200, 5200, 1000]);
});

test("nested model-list metadata supplies route identity, vision and service tiers", async () => {
	const [model] = await discoverRows([
		{
			id: "opaque-gateway-route",
			metadata: {
				display_name: "Team Route",
				context_window: 64000,
				input_modalities: ["text", "image"],
				service_tiers: ["fast", { id: "standard" }],
			},
		},
	]);
	expect(model?.name).toBe("Team Route");
	expect(model?.contextWindow).toBe(64000);
	expect(model?.input).toEqual(["text", "image"]);
	expect(model?.serviceTiers).toEqual(["fast", "standard"]);
});

test("advertised reasoning ladders retain aliases, defaults and explicit optional reasoning", async () => {
	const [model] = await discoverRows([
		{
			id: "gateway/team-route",
			metadata: {
				supported_reasoning_levels: ["none", "max", { effort: "low" }, "high", "ultra"],
				default_reasoning_level: "high",
				reasoning_effort_map: { minimal: "low", medium: "high", ultra: "max" },
				reasoning_required: false,
			},
		},
	]);
	expect(model?.reasoning).toBe(true);
	expect(model?.thinking).toMatchObject({
		efforts: [Effort.Low, Effort.High, Effort.Max],
		defaultLevel: Effort.High,
		effortMap: { minimal: "low", medium: "high" },
		requiresEffort: false,
	});
	expect(model?.compat).toMatchObject({ supportsReasoningEffort: true, reasoningDisableMode: "none-effort" });
});

test("an explicit nested reasoning denial suppresses a bundled model's effort dial", async () => {
	const [model] = await discoverRows([
		{ id: "gpt-5.2", metadata: { reasoning: false, supported_reasoning_levels: ["high"] } },
	]);
	expect(model?.reasoning).toBe(false);
	expect(model?.thinking).toBeUndefined();
	expect(model?.compat).toMatchObject({ supportsReasoningEffort: false });
});

test("advertised reasoning can be opted out without accepting a contradictory ladder", async () => {
	const [model] = await discoverRows(
		[{ id: "gateway-unknown", supported_reasoning_levels: ["high"], reasoning_required: true }],
		false,
	);
	expect(model?.thinking?.requiresEffort).not.toBe(true);
	expect(model?.thinking?.efforts).not.toEqual([Effort.High]);
});

test("discovery bearers authenticate the probe without becoming model header credentials", async () => {
	let authorization: string | null = null;
	const models = await discoverModelsByProviderType(
		{
			provider: "gateway-test",
			api: "openai-completions",
			baseUrl: "https://gateway.example/v1",
			headers: { "x-deployment": "team" },
			discovery: { type: "openai-models-list" },
		},
		{
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return Response.json({ data: [{ id: "route" }] });
			},
			getBearerApiKeyResolver: async () => "secret-bearer",
		},
	);
	expect<string | null>(authorization).toBe("Bearer secret-bearer");
	expect(models[0]?.headers).toEqual({ "x-deployment": "team" });
});

test("llama.cpp fallback discovers the current default port but never masks an answering server", async () => {
	const config = {
		provider: "llama.cpp",
		api: "openai-responses",
		baseUrl: "http://127.0.0.1:8080",
		fallbackBaseUrls: ["http://127.0.0.1:9931"],
		discovery: { type: "llama.cpp" as const },
	};
	const urls: string[] = [];
	const models = await discoverModelsByProviderType(config, {
		fetch: async input => {
			const url = String(input);
			urls.push(url);
			if (url.includes(":8080")) throw new Error("connection refused");
			return url.endsWith("/models") ? Response.json({ data: [{ id: "local-route" }] }) : Response.json({});
		},
		getBearerApiKeyResolver: async () => undefined,
	});
	expect(models[0]?.baseUrl).toBe("http://127.0.0.1:9931/v1");
	urls.length = 0;
	await expect(
		discoverModelsByProviderType(config, {
			fetch: async input => {
				urls.push(String(input));
				return new Response("unavailable", { status: 500 });
			},
			getBearerApiKeyResolver: async () => undefined,
		}),
	).rejects.toThrow("HTTP 500");
	expect(urls.some(url => url.includes(":9931"))).toBe(false);
});
