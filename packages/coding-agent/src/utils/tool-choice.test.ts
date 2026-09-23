import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildNamedToolChoice } from "./tool-choice";

const spec = {
	id: "vendor/model",
	name: "Model",
	provider: "openrouter",
	api: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
} as const;

test("OpenRouter models get a named function tool choice", () => {
	expect(buildNamedToolChoice("yield", buildModel(spec as never))).toEqual({ type: "function", name: "yield" });
});

test("a named choice the OpenAI transports would drop or downgrade is not reported as forced", () => {
	for (const compat of [{ supportsToolChoice: false }, { supportsForcedToolChoice: false }]) {
		for (const api of ["openrouter", "openai-completions"] as const) {
			expect(buildNamedToolChoice("yield", buildModel({ ...spec, api, compat } as never))).toBeUndefined();
		}
	}
});
