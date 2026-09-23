import { describe, expect, it } from "bun:test";
import { buildModel } from "../build";
import { Effort } from "../effort";
import type { FetchImpl, Model } from "../types";
import { CHARM_HYPER_API_BASE_URL, normalizeCharmHyperBaseUrl } from "../wire/charm-hyper";
import { isCredentialScopedModelCacheProvider, resolveModelCacheProviderId } from "./cache-provider-id";
import { isCatalogDescriptor } from "./descriptor-types";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "./descriptors";
import { charmHyperModelManagerOptions } from "./openai-compat";

// Shapes mirror live `https://hyper.charm.land/v1/models` rows.
const HYPER_ROWS = [
	{
		id: "qwen3.8-flash",
		display_name: "Qwen3.8-Flash",
		context_window: 1_000_000,
		max_output_tokens: 128_000,
		capabilities: { vision: true },
		reasoning: {
			effort_levels: [
				{ value: "none" },
				{ value: "minimal" },
				{ value: "low" },
				{ value: "medium" },
				{ value: "high" },
			],
			default_effort_level: "medium",
		},
		pricing: { input: 0.15, output: 0.47, cache_create: 0, cache_hit: 0.016 },
	},
	{
		id: "deepseek-v4-flash",
		display_name: "DeepSeek V4 Flash",
		context_window: 1_000_000,
		max_output_tokens: 384_000,
		capabilities: { vision: false },
		reasoning: { effort_levels: [{ value: "high" }, { value: "xhigh" }], default_effort_level: "high" },
		pricing: { input: 0.2, output: 0.4, cache_create: 0, cache_hit: 0.04 },
	},
	{
		id: "glm-5.1",
		display_name: "GLM-5.1",
		context_window: 202_750,
		max_output_tokens: 3276,
		capabilities: { vision: false },
		pricing: { input: 1.326, output: 4.22, cache_create: 0, cache_hit: 0.663 },
	},
	{
		id: "minimax-m2.7",
		display_name: "MiniMax M2.7",
		context_window: 262_100,
		max_output_tokens: 6553,
		capabilities: { vision: false },
		pricing: { input: 0.404, output: 1.496, cache_create: 0, cache_hit: 0.202 },
	},
	{
		id: "minimax-m3",
		display_name: "MiniMax M3",
		context_window: 512_000,
		max_output_tokens: 512_000,
		capabilities: { vision: true },
		pricing: { input: 0.32664, output: 1.30656, cache_create: 0, cache_hit: 0.0642392 },
	},
];

function hyperFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return Response.json({ object: "list", data: HYPER_ROWS });
	};
	return { calls, authorizations, fetch };
}

async function discover(apiKey?: string): Promise<Map<string, Model<"openai-completions">>> {
	const { fetch } = hyperFetch();
	const specs = (await charmHyperModelManagerOptions({ apiKey, fetch }).fetchDynamicModels?.()) ?? [];
	return new Map(specs.map(spec => [spec.id, buildModel(spec)]));
}

describe("Charm Hyper discovery", () => {
	it("maps the advertised effort vocabulary, keeping `none` as the off switch rather than a rung", async () => {
		const models = await discover("sk-hyper-test");
		const qwen = models.get("qwen3.8-flash")!;
		expect(qwen).toMatchObject({
			name: "Qwen3.8-Flash",
			provider: "charm-hyper",
			baseUrl: CHARM_HYPER_API_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0 },
		});
		expect(qwen.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(qwen.thinking?.defaultLevel).toBe(Effort.Medium);
		expect(qwen.compat.reasoningDisableMode).toBe("none-effort");

		const deepseek = models.get("deepseek-v4-flash")!;
		expect(deepseek.thinking?.efforts).toEqual([Effort.High, Effort.XHigh]);
		expect(deepseek.compat.reasoningDisableMode).not.toBe("none-effort");
	});

	it("leaves blockless rows non-reasoning instead of fabricating a ladder", async () => {
		const glm = (await discover()).get("glm-5.1")!;
		expect(glm.reasoning).toBe(false);
		expect(glm.thinking).toBeUndefined();
	});

	it("corrects misreported gateway limits", async () => {
		const models = await discover();
		expect(models.get("glm-5.1")?.maxTokens).toBe(20_275);
		expect(models.get("minimax-m2.7")?.maxTokens).toBe(26_214);
		expect(models.get("minimax-m3")).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000 });
	});

	it("speaks the gateway's chat-completions dialect", async () => {
		const compat = (await discover()).get("qwen3.8-flash")!.compat;
		expect(compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
			reasoningContentField: "reasoning_content",
		});
	});

	it("discovers without a key and sends the key when one is configured", async () => {
		const keyless = hyperFetch();
		await charmHyperModelManagerOptions({ fetch: keyless.fetch }).fetchDynamicModels?.();
		expect(keyless.calls).toEqual([`${CHARM_HYPER_API_BASE_URL}/models`]);
		expect(keyless.authorizations).toEqual([null]);

		const keyed = hyperFetch();
		await charmHyperModelManagerOptions({ apiKey: "sk-hyper-test", fetch: keyed.fetch }).fetchDynamicModels?.();
		expect(keyed.authorizations).toEqual(["Bearer sk-hyper-test"]);
	});

	it("routes a host-only proxy override through its /v1 surface", async () => {
		const proxy = hyperFetch();
		const specs = await charmHyperModelManagerOptions({
			baseUrl: "https://proxy.example/",
			fetch: proxy.fetch,
		}).fetchDynamicModels?.();
		expect(proxy.calls).toEqual(["https://proxy.example/v1/models"]);
		expect(specs?.[0]?.baseUrl).toBe("https://proxy.example/v1");
	});
});

describe("Charm Hyper base URL and cache namespace", () => {
	it("treats a blank override as unconfigured", () => {
		expect(normalizeCharmHyperBaseUrl(undefined)).toBe(CHARM_HYPER_API_BASE_URL);
		expect(normalizeCharmHyperBaseUrl("   ")).toBe(CHARM_HYPER_API_BASE_URL);
		expect(normalizeCharmHyperBaseUrl("https://proxy.example")).toBe("https://proxy.example/v1");
		expect(normalizeCharmHyperBaseUrl("https://proxy.example/v1/")).toBe("https://proxy.example/v1");
	});

	it("keys the model cache on the endpoint only, matching the keyless registry lookup", () => {
		const discoveryNamespace = charmHyperModelManagerOptions({ apiKey: "sk-hyper-test" }).cacheProviderId;
		expect(discoveryNamespace).toBe(resolveModelCacheProviderId("charm-hyper"));
		expect(isCredentialScopedModelCacheProvider("charm-hyper")).toBe(false);

		const proxyNamespace = charmHyperModelManagerOptions({ baseUrl: "https://proxy.example/v1" }).cacheProviderId;
		expect(proxyNamespace).not.toBe(discoveryNamespace);
		expect(resolveModelCacheProviderId("charm-hyper", { baseUrl: "https://proxy.example" })).toBe(proxyNamespace!);
	});
});

describe("Charm Hyper descriptor", () => {
	it("allows keyless runtime discovery without enrolling in bundled generation", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "charm-hyper");
		expect(descriptor).toMatchObject({ allowUnauthenticated: true, dynamicModelsAuthoritative: true });
		expect(isCatalogDescriptor(descriptor!)).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER["charm-hyper"]).toBe("glm-5.3");
	});
});
