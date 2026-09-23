import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as utils from "@oh-my-pi/pi-utils";
import { Effort } from "../effort";
import { resolveProviderModels } from "../model-manager";
import type { FetchImpl } from "../types";
import {
	alibabaTokenPlanModelManagerOptions,
	kimiCodeModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
	openrouterModelManagerOptions,
	veniceModelManagerOptions,
	xaiOAuthModelManagerOptions,
	xiaomiModelManagerOptions,
} from "./openai-compat";

describe("Alibaba Token Plan discovery", () => {
	it("resolves Qwen3.8 Flash limits and multimodal reasoning capabilities", async () => {
		const fetchModels: FetchImpl = async () =>
			Response.json({
				data: [{ id: "qwen3.8-flash", owned_by: "qwencloud" }],
			});
		const options = alibabaTokenPlanModelManagerOptions({ apiKey: "sk-test", fetch: fetchModels });
		const models = await options.fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "qwen3.8-flash",
			provider: "alibaba-token-plan",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			},
		});
	});
});

describe("OpenRouter discovery", () => {
	it("reads vision from input modalities, not from output modalities in the summary string", async () => {
		const row = (id: string, architecture: Record<string, unknown>) => ({
			id,
			supported_parameters: ["tools"],
			architecture,
			pricing: { prompt: "0.000001", completion: "0.000002" },
		});
		const fetchModels: FetchImpl = async () =>
			Response.json({
				data: [
					row("acme/image-writer", { modality: "text->text+image", input_modalities: ["text"] }),
					row("acme/vision-chat", { modality: "text+image->text", input_modalities: ["text", "image"] }),
					row("acme/legacy-vision", { modality: "text+image->text" }),
				],
			});
		const models = await openrouterModelManagerOptions({
			apiKey: "sk-test",
			fetch: fetchModels,
		}).fetchDynamicModels?.();
		const inputOf = (id: string) => models?.find(model => model.id === id)?.input;

		expect(inputOf("acme/image-writer")).toEqual(["text"]);
		expect(inputOf("acme/vision-chat")).toEqual(["text", "image"]);
		expect(inputOf("acme/legacy-vision")).toEqual(["text", "image"]);
	});
});

describe("Venice discovery", () => {
	it("normalizes squished GPT wire versions before deriving version-gated efforts", async () => {
		const fetchModels: FetchImpl = async () =>
			Response.json({
				data: [{ id: "openai-gpt-54-pro" }, { id: "openai-gpt-55-pro" }, { id: "openai-gpt-56-sol" }],
			});
		const options = veniceModelManagerOptions({ apiKey: "sk-test", fetch: fetchModels });
		const result = await resolveProviderModels({ ...options, staticModels: [], cacheDbPath: ":memory:" }, "online");
		const byWireId = new Map(result.models.map(model => [model.requestModelId ?? model.id, model]));

		const assertEfforts = (wireId: string, canonicalId: string, efforts: readonly Effort[]): void => {
			const model = byWireId.get(wireId);
			expect(model).toBeDefined();
			if (!model) return;
			expect(model.id).toBe(canonicalId);
			expect(model.requestModelId).toBe(wireId);
			expect(model.thinking?.efforts).toEqual(efforts);
		};

		assertEfforts("openai-gpt-54-pro", "openai-gpt-5.4-pro", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		assertEfforts("openai-gpt-55-pro", "openai-gpt-5.5-pro", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		assertEfforts("openai-gpt-56-sol", "openai-gpt-5.6-sol", [
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
	});
});

describe("xai-oauth discovery", () => {
	// xAI's OAuth /v1/models returns bare `{id}` rows; without the curated seed
	// grok-4.7 resolves to reasoning:false and a thinking picker offering only off.
	it("curates sparse grok-4.7 rows with limits, vision, and the xhigh effort ladder", async () => {
		const fetchModels: FetchImpl = async () =>
			Response.json({ object: "list", data: [{ id: "grok-4.7" }, { id: "grok-4.6" }] });
		const options = xaiOAuthModelManagerOptions({ apiKey: "xai-oauth-test", fetch: fetchModels });
		const result = await resolveProviderModels({ ...options, staticModels: [], cacheDbPath: ":memory:" }, "online");

		expect(result.models.find(model => model.id === "grok-4.7")).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 500_000,
			maxTokens: 500_000,
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: { minimal: "low" },
			},
		});
	});
});

describe("OpenCode gateway discovery", () => {
	afterEach(() => vi.restoreAllMocks());

	it("attributes live model discovery with the client and install session", async () => {
		spyOn(utils, "getInstallId").mockReturnValue("test-install-id");
		for (const makeOptions of [opencodeGoModelManagerOptions, opencodeZenModelManagerOptions]) {
			let requestHeaders = new Headers();
			const fetchModels: FetchImpl = async (_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return Response.json({ data: [{ id: "kimi-k3" }] });
			};
			await makeOptions({ apiKey: "sk-test", fetch: fetchModels }).fetchDynamicModels?.();

			expect(requestHeaders.get("User-Agent")).toBe(utils.USER_AGENT);
			expect(requestHeaders.get("x-opencode-session")).toBe("test-install-id");
		}
	});

	it("routes gateway-listed Union Alpha to Messages on Go and Zen", async () => {
		const fetchModels: FetchImpl = async () => Response.json({ data: [{ id: "union-alpha" }] });
		for (const [makeOptions, baseUrl] of [
			[opencodeGoModelManagerOptions, "https://opencode.ai/zen/go"],
			[opencodeZenModelManagerOptions, "https://opencode.ai/zen"],
		] as const) {
			const options = makeOptions({ apiKey: "sk-test", fetch: fetchModels });
			const models = await options.fetchDynamicModels?.();

			expect(models?.find(model => model.id === "union-alpha")).toMatchObject({
				api: "anthropic-messages",
				baseUrl,
			});
			expect(options.dropCachedModelIdsOnStaticMismatch).toContain("union-alpha");
		}
	});

	it("routes models.dev-omitted Muse Spark 1.3 lanes to Responses (#10610)", () => {
		// Both gateways serve these ids only at /v1/responses; the completions default 500s every turn.
		for (const [providerId, modelId, baseUrl] of [
			["opencode-go", "muse-spark-1.3", "https://opencode.ai/zen/go/v1"],
			["opencode-go", "muse-spark-1.3-contributor", "https://opencode.ai/zen/go/v1"],
			["opencode-zen", "muse-spark-1.3-contributor-free", "https://opencode.ai/zen/v1"],
		] as const) {
			const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.resolveApi?.(modelId, { tool_call: true })).toEqual({ api: "openai-responses", baseUrl });
		}
	});

	it("declares image input on Go's DeepSeek Flash lanes that discovery seeds text-only", async () => {
		const fetchModels: FetchImpl = async () =>
			Response.json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
		const models = await opencodeGoModelManagerOptions({
			apiKey: "sk-test",
			fetch: fetchModels,
		}).fetchDynamicModels?.();

		expect(models?.find(model => model.id === "deepseek-flash")?.input).toEqual(["text", "image"]);
		expect(models?.find(model => model.id === "deepseek-v4-pro")?.input).toEqual(["text"]);
	});
});

describe("Xiaomi CN Token Plan discovery", () => {
	it("enriches bare roster ids with the documented V2.6 subscription metadata", async () => {
		const fetchModels: FetchImpl = async () => Response.json({ data: [{ id: "mimo-v2.6-pro-ultraspeed" }] });
		const options = xiaomiModelManagerOptions({
			apiKey: "tp-test",
			providerId: "xiaomi-token-plan-cn",
			tokenPlanRegion: "cn",
			fetch: fetchModels,
		});
		const models = await options.fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "mimo-v2.6-pro-ultraspeed",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
});

describe("Kimi Code discovery", () => {
	it("prices rows the unpriced /coding/v1/models envelope reports at $0", async () => {
		const fetchModels: FetchImpl = async () =>
			Response.json({ data: [{ id: "k3" }, { id: "kimi-k2" }, { id: "kimi-unlisted" }] });
		const models = await kimiCodeModelManagerOptions({
			apiKey: "sk-test",
			fetch: fetchModels,
		}).fetchDynamicModels?.();
		const costOf = (id: string) => models?.find(model => model.id === id)?.cost;

		expect(costOf("k3")).toMatchObject({ input: 3, output: 15, cacheRead: 0.3 });
		expect(costOf("kimi-k2")).toMatchObject({ input: 0.6, output: 2.5, cacheRead: 0.15 });
		expect(costOf("kimi-unlisted")).toMatchObject({ input: 0, output: 0 });
	});
});
