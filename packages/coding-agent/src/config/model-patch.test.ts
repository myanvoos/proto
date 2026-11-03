import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyModelPatch } from "./model-patch";

test("thinking overrides retain required prefix binding unless explicitly disabled", () => {
	const base = buildModel({
		id: "claude-fable-5-1",
		name: "Fable",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	});
	const thinking = { ...base.thinking! };
	delete thinking.prefixBinding;
	expect(applyModelPatch(base, { thinking }, "merge").thinking?.prefixBinding).toBe(true);
	expect(
		applyModelPatch(base, { thinking: { ...thinking, prefixBinding: false } }, "merge").thinking?.prefixBinding,
	).toBe(false);
});
