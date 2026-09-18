import { describe, expect, it } from "bun:test";
import { resolveProviderModels } from "./model-manager";
import type { ModelCost, ModelSpec } from "./types";

function modelSpec(cost: ModelCost): ModelSpec<"openai-completions"> {
	return {
		id: "discovered-free-model",
		name: "Discovered Free Model",
		api: "openai-completions",
		provider: "venice",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("model source pricing merge", () => {
	it("lets discovered zero prices replace stale nonzero prices in every token lane", async () => {
		const stale = modelSpec({ input: 2, output: 8, cacheRead: 1, cacheWrite: 4 });
		const discovered = modelSpec({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const result = await resolveProviderModels(
			{
				providerId: "venice",
				staticModels: [stale],
				cacheDbPath: ":memory:",
				fetchDynamicModels: async () => [discovered],
			},
			"online",
		);

		expect(result.models).toHaveLength(1);
		expect(result.models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("keeps static pricing when discovered pricing is unknown rather than zero", async () => {
		const stale = modelSpec({ input: 2, output: 8, cacheRead: 1, cacheWrite: 4 });
		const unknown = modelSpec({
			input: Number.NaN,
			output: Number.NaN,
			cacheRead: Number.NaN,
			cacheWrite: Number.NaN,
		});
		const result = await resolveProviderModels(
			{
				providerId: "venice",
				staticModels: [stale],
				cacheDbPath: ":memory:",
				fetchDynamicModels: async () => [unknown],
			},
			"online",
		);

		expect(result.models).toHaveLength(1);
		expect(result.models[0]?.cost).toEqual(stale.cost);
	});
});
