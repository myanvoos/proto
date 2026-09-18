import { describe, expect, it } from "bun:test";
import { Effort } from "../effort";
import { resolveProviderModels } from "../model-manager";
import type { FetchImpl } from "../types";
import { alibabaTokenPlanModelManagerOptions, veniceModelManagerOptions } from "./openai-compat";

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
