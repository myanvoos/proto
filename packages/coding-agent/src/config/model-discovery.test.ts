import { expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyLlamaCppQwenThinking } from "./model-discovery";

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
