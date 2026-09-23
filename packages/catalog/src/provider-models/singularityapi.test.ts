import { describe, expect, it } from "bun:test";
import { buildModel } from "../build";
import { Effort } from "../effort";
import type { FetchImpl, Model } from "../types";
import {
	normalizeSingularityApiBaseUrl,
	SINGULARITYAPI_DEV_API_BASE_URL,
	SINGULARITYAPI_TECH_API_BASE_URL,
} from "../wire/singularityapi";
import { isCredentialScopedModelCacheProvider, resolveModelCacheProviderId } from "./cache-provider-id";
import { isCatalogDescriptor } from "./descriptor-types";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "./descriptors";
import { singularityApiDevModelManagerOptions, singularityApiTechModelManagerOptions } from "./openai-compat";

function modelsFetch(data: unknown[]): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return Response.json({ object: "list", data });
	};
	return { calls, authorizations, fetch };
}

function chatCapability(context: number, output: number, input: string, outputRate: string) {
	return {
		endpoint: "/v1/chat/completions",
		context_window_tokens: context,
		maximum_output_tokens: output,
		default_output_tokens: 8192,
		pricing: { input_per_million_usd: input, output_per_million_usd: outputRate },
	};
}

const DEV_ROWS = [
	{ id: "deepseek-v4-flash", capabilities: [chatCapability(1_000_000, 384_000, "0.081000000000", "0.162000000000")] },
	{ id: "deepseek-v4-pro", capabilities: [chatCapability(1_000_000, 384_000, "0.5", "1")] },
	{ id: "gpt-5.6-sol", capabilities: [chatCapability(400_000, 128_000, "1.25", "10")] },
	{ id: "kimi-k2.7-code", capabilities: [chatCapability(262_144, 32_768, "0.6", "2.5")] },
	{ id: "gpt-image-2", capabilities: [{ endpoint: "/v1/images/generations", pricing: {} }] },
	{ id: "flux-pro-1.1" },
];

async function discoverDev(): Promise<Map<string, Model<"openai-completions">>> {
	const { fetch } = modelsFetch(DEV_ROWS);
	const specs = await singularityApiDevModelManagerOptions({ apiKey: "sk-sapi-test", fetch }).fetchDynamicModels?.();
	return new Map((specs ?? []).map(spec => [spec.id, buildModel(spec) as Model<"openai-completions">]));
}

async function discoverTech(ids: string[]): Promise<Map<string, Model<"openai-completions">>> {
	const { fetch } = modelsFetch(ids.map(id => ({ id, object: "model" })));
	const specs = await singularityApiTechModelManagerOptions({ apiKey: "sk-lane", fetch }).fetchDynamicModels?.();
	return new Map((specs ?? []).map(spec => [spec.id, buildModel(spec) as Model<"openai-completions">]));
}

describe("SingularityAPI universal gateway (singularityapi-dev)", () => {
	it("discovers chat rows with live limits and tariffs and requires a key", async () => {
		const { calls, authorizations, fetch } = modelsFetch(DEV_ROWS);
		await singularityApiDevModelManagerOptions({ apiKey: "sk-sapi-test", fetch }).fetchDynamicModels?.();
		expect(calls).toEqual([`${SINGULARITYAPI_DEV_API_BASE_URL}/models`]);
		expect(authorizations).toEqual(["Bearer sk-sapi-test"]);

		const flash = (await discoverDev()).get("deepseek-v4-flash");
		expect(flash).toMatchObject({
			provider: "singularityapi-dev",
			api: "openai-completions",
			baseUrl: SINGULARITYAPI_DEV_API_BASE_URL,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			cost: { input: 0.081, output: 0.162, cacheRead: 0, cacheWrite: 0 },
		});
		expect(singularityApiDevModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	it("keeps image-generation rows out of chat", async () => {
		const models = await discoverDev();
		expect(models.has("gpt-image-2")).toBe(false);
		expect(models.has("flux-pro-1.1")).toBe(false);
	});

	it("gives DeepSeek rows the gateway's measured ladder without max", async () => {
		const models = await discoverDev();
		for (const id of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
			const model = models.get(id)!;
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toMatchObject({ mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] });
			expect(model.compat).toMatchObject({
				maxTokensField: "max_tokens",
				reasoningContentField: "reasoning_content",
				reasoningDisableMode: "none-effort",
				supportsToolChoice: false,
			});
		}
	});

	it("materializes the GPT-5.6 ladder so an effort is always sent", async () => {
		const model = (await discoverDev()).get("gpt-5.6-sol")!;
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toMatchObject({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});
		expect(model.compat).toMatchObject({ maxTokensField: "max_tokens", reasoningDisableMode: "none-effort" });
	});

	it("leaves unreviewed rows on the gateway-wide wire shape", async () => {
		const model = (await discoverDev()).get("kimi-k2.7-code")!;
		expect(model.compat.maxTokensField).toBe("max_tokens");
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});
});

describe("SingularityAPI reserved lanes (singularityapi-tech)", () => {
	it("applies the lane model-guide contract to every lane spelling", async () => {
		const models = await discoverTech([
			"deepseek-ai/DeepSeek-V4.1-Flash",
			"deepseek-v4.1-flash",
			"deepseek-ai/DeepSeek-V4-Flash-0731",
		]);
		for (const model of models.values()) {
			expect(model).toMatchObject({
				provider: "singularityapi-tech",
				baseUrl: SINGULARITYAPI_TECH_API_BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 262_144,
			});
			expect(model.thinking).toMatchObject({
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.XHigh, Effort.Max],
			});
			expect(model.compat).toMatchObject({
				maxTokensField: "max_tokens",
				reasoningContentField: "reasoning_content",
				reasoningDisableMode: "none-effort",
			});
		}
		expect(models.size).toBe(3);
	});

	it("keeps unreviewed lanes on the provider-wide wire shape", async () => {
		const model = (await discoverTech(["some-future-lane"])).get("some-future-lane")!;
		expect(model.reasoning).toBe(false);
		expect(model.compat).toMatchObject({ maxTokensField: "max_tokens", reasoningContentField: "reasoning_content" });
	});
});

describe("SingularityAPI registration", () => {
	it("registers both products as runtime-only authoritative providers", () => {
		for (const [providerId, defaultModel] of [
			["singularityapi-dev", "deepseek-v4-flash"],
			["singularityapi-tech", "deepseek-ai/DeepSeek-V4.1-Flash"],
		] as const) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId)!;
			expect(descriptor).toMatchObject({ defaultModel, dynamicModelsAuthoritative: true });
			expect(isCatalogDescriptor(descriptor)).toBe(false);
			expect(DEFAULT_MODEL_PER_PROVIDER[providerId]).toBe(defaultModel);
			expect(isCredentialScopedModelCacheProvider(providerId)).toBe(true);
		}
	});

	it("scopes the model cache to credential, endpoint, and product across both call paths", () => {
		const keyed = { apiKey: "sk-sapi-a", baseUrl: SINGULARITYAPI_DEV_API_BASE_URL };
		const dev = resolveModelCacheProviderId("singularityapi-dev", keyed);
		expect(singularityApiDevModelManagerOptions(keyed).cacheProviderId).toBe(dev);
		expect(resolveModelCacheProviderId("singularityapi-dev", { apiKey: "sk-sapi-a" })).toBe(dev);
		expect(resolveModelCacheProviderId("singularityapi-dev", { apiKey: "sk-sapi-a", baseUrl: "   " })).toBe(dev);
		expect(
			resolveModelCacheProviderId("singularityapi-dev", {
				apiKey: "sk-sapi-a",
				baseUrl: "https://api.singularityapi.dev/",
			}),
		).toBe(dev);
		expect(resolveModelCacheProviderId("singularityapi-dev", { ...keyed, apiKey: "sk-sapi-b" })).not.toBe(dev);
		expect(resolveModelCacheProviderId("singularityapi-tech", keyed)).not.toBe(dev);
		expect(singularityApiTechModelManagerOptions({ apiKey: "sk-lane" }).cacheProviderId).toBe(
			resolveModelCacheProviderId("singularityapi-tech", { apiKey: "sk-lane" }),
		);
	});

	it("normalizes configured base URLs onto the product's /v1 surface", () => {
		expect(normalizeSingularityApiBaseUrl(undefined, SINGULARITYAPI_TECH_API_BASE_URL)).toBe(
			SINGULARITYAPI_TECH_API_BASE_URL,
		);
		expect(normalizeSingularityApiBaseUrl("https://proxy.example//", SINGULARITYAPI_DEV_API_BASE_URL)).toBe(
			"https://proxy.example/v1",
		);
	});
});
