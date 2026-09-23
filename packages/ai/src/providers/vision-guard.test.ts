import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "../types";
import { isOpenAICompletionsVisionSupported } from "./vision-guard";

function deepseekModel(id: string, name = id): Model<"openai-completions"> {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "custom-proxy",
		baseUrl: "https://llm-proxy.example.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 8_192,
	});
}

describe("DeepSeek image_url guard", () => {
	it("forwards images to multimodal DeepSeek SKUs", () => {
		for (const id of [
			"deepseek-v4-flash-vision-exp",
			"deepseek_vision",
			"deepseek-ocr",
			"deepseek-v4.1-flash",
			"deepseek/deepseek-v4.1-flash-0731",
		]) {
			expect({ id, supported: isOpenAICompletionsVisionSupported(deepseekModel(id)) }).toEqual({
				id,
				supported: true,
			});
		}
	});

	it("strips images for text-only DeepSeek ids that merely contain vision as a substring", () => {
		for (const id of [
			"deepseek-r1-revision-0528",
			"deepseek-v4-provisioned",
			"deepseek-v4.1-pro",
			"deepseek-v4-flash",
		]) {
			expect({ id, supported: isOpenAICompletionsVisionSupported(deepseekModel(id)) }).toEqual({
				id,
				supported: false,
			});
		}
	});
});
