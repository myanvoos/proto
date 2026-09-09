import { describe, expect, it } from "bun:test";
import { Effort } from "../effort";
import type { FetchImpl } from "../types";
import { alibabaTokenPlanModelManagerOptions } from "./openai-compat";

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
