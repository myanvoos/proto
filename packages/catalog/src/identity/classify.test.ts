import { describe, expect, it } from "bun:test";
import { buildModel } from "../build";
import { Effort } from "../effort";
import { getSupportedEfforts } from "../model-thinking";
import { resolveModelTokenizer } from "../model-tokenizer";
import type { ModelSpec, Provider } from "../types";
import { parseAnthropicModel, parseGeminiModel, parseGlmModel, parseKnownModel, parseOpenAIModel } from "./classify";
import {
	anthropicModelSupportsThinking,
	isGlm52ReasoningEffortModelId,
	supportsAdaptiveThinkingDisplay,
} from "./family";

function reasoningSpec(id: string, provider: Provider): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	};
}

describe("model identity classification", () => {
	it("parses Venice's dashed Gemini 3.1 Pro preview id without consuming its suffix", () => {
		const id = "gemini-3-1-pro-preview";

		expect(parseGeminiModel(id)).toEqual({
			family: "gemini",
			kind: "pro",
			version: { major: 3, minor: 1, patch: 0 },
		});
		expect(parseGeminiModel("gemini-3-1-prototype-preview")).toBeNull();
		expect(getSupportedEfforts(buildModel(reasoningSpec(id, "venice")))).toEqual([Effort.Low, Effort.High]);
	});

	it("recognizes the real unhyphenated GLM 5.2 Fast id without matching embedded text", () => {
		const id = "glm5.2-fast";

		expect(parseGlmModel(id)).toEqual({
			family: "glm",
			variant: "base",
			vision: false,
			version: { major: 5, minor: 2, patch: 0 },
		});
		expect(parseGlmModel("notglm5.2-fast")).toBeNull();
		expect(isGlm52ReasoningEffortModelId(id)).toBe(true);
		expect(resolveModelTokenizer(id)).toBe("glm5");
		expect(getSupportedEfforts(buildModel(reasoningSpec(id, "wafer-serverless")))).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.Max,
		]);
	});

	it("parses Haiku in both Anthropic layouts, including Bedrock prefixes and revisions", () => {
		const cases = [
			["claude-haiku-4-5", 4, 5],
			["claude-3-5-haiku", 3, 5],
			["us.anthropic.claude-haiku-4-5-20251001-v1:0", 4, 5],
			["anthropic.claude-3-5-haiku-20241022-v1:0", 3, 5],
		] as const;

		for (const [id, major, minor] of cases) {
			expect(parseAnthropicModel(id)).toEqual({
				family: "anthropic",
				kind: "haiku",
				version: { major, minor, patch: 0 },
			});
		}
	});

	it("gates Haiku thinking at 4.5 without enabling adaptive-thinking capabilities", () => {
		expect(anthropicModelSupportsThinking("claude-3-5-haiku")).toBe(false);
		expect(anthropicModelSupportsThinking("claude-haiku-4-5")).toBe(true);
		expect(anthropicModelSupportsThinking("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-haiku-4-5")).toBe(false);
	});

	it("keeps neighbouring canonical ids classified exactly as before", () => {
		expect(parseKnownModel("gpt-5.6-sol")).toEqual({
			family: "openai",
			variant: "base",
			version: { major: 5, minor: 6, patch: 0 },
		});
		expect(parseKnownModel("claude-opus-4-1")).toEqual({
			family: "anthropic",
			kind: "opus",
			version: { major: 4, minor: 1, patch: 0 },
		});
		expect(parseKnownModel("claude-sonnet-4-5")).toEqual({
			family: "anthropic",
			kind: "sonnet",
			version: { major: 4, minor: 5, patch: 0 },
		});
		expect(parseKnownModel("gemini-2.5-pro")).toEqual({
			family: "gemini",
			kind: "pro",
			version: { major: 2, minor: 5, patch: 0 },
		});
		expect(parseGlmModel("glm-4.6")).toEqual({
			family: "glm",
			variant: "base",
			vision: false,
			version: { major: 4, minor: 6, patch: 0 },
		});
	});

	it("does not reinterpret a generic GPT-54 id as a squished provider version", () => {
		expect(parseOpenAIModel("openai-gpt-54-pro")).toEqual({
			family: "openai",
			variant: "base",
			version: { major: 54, minor: 0, patch: 0 },
		});
	});
});
