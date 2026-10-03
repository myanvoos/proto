import { describe, expect, it } from "bun:test";
import { fetchDevinModels } from "./devin";
import {
	type ClientModelConfig,
	ClientModelConfigSchema,
	GetCliModelConfigsResponseSchema,
	ModelFeaturesSchema,
	ModelInfoSchema,
} from "./devin-proto";
import { create, toBinary } from "./protobuf";

function config(
	uid: string,
	init: { disabled?: boolean; contextWindow?: number; pairing?: boolean; images?: boolean } = {},
): ClientModelConfig {
	return create(ClientModelConfigSchema, {
		modelUid: uid,
		label: uid,
		disabled: init.disabled ?? false,
		maxTokens: init.contextWindow ?? 0,
		modelInfo: create(ModelInfoSchema, {
			isModelRouter: init.pairing ?? false,
			harnessUids: init.pairing ? ["fusion"] : [],
			modelFeatures: create(ModelFeaturesSchema, { supportsToolCalls: true, supportsImages: init.images ?? false }),
		}),
	});
}

describe("Devin Fusion pairings", () => {
	it("route through an available lead uid and drop pairings without one", async () => {
		const configs = [
			config("alpha-lead", { contextWindow: 400_000, images: true }),
			config("alpha-lead-priority"),
			config("beta-lead"),
			config("beta-lead-priority", { disabled: true }),
			config("gamma-fast"),
			config("gamma-priority"),
			config("delta-lead", { disabled: true }),
			config("fusion-alpha-lead-sidekick-side", { pairing: true, contextWindow: 1_000_000 }),
			config("fusion-alpha-lead-fast-sidekick-side", { pairing: true }),
			config("fusion-beta-lead-fast-sidekick-side", { pairing: true }),
			config("fusion-gamma-fast-sidekick-side", { pairing: true }),
			config("fusion-delta-lead-sidekick-side", { pairing: true }),
			config("fusion", { pairing: true }),
		];
		const payload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, { clientModelConfigs: configs }),
		);
		const fetched = await fetchDevinModels({
			apiKey: "fixture-token",
			fetch: async () => new Response(payload, { status: 200, headers: { "content-type": "application/proto" } }),
		});
		const find = (id: string) => fetched?.find(entry => entry.id === id);
		const wireId = (id: string) => find(id)?.requestModelId;

		expect(wireId("fusion-alpha-lead-sidekick-side")).toBe("alpha-lead");
		expect(wireId("fusion-alpha-lead-fast-sidekick-side")).toBe("alpha-lead-priority");
		expect(wireId("fusion-beta-lead-fast-sidekick-side")).toBe("beta-lead");
		// A lead whose own uid ends in `-fast` routes as written, not to a `-priority` lane.
		expect(wireId("fusion-gamma-fast-sidekick-side")).toBe("gamma-fast");
		expect(find("fusion-delta-lead-sidekick-side")).toBeUndefined();
		expect(find("fusion")).toBeDefined();
		expect(wireId("fusion")).toBeUndefined();
		// Only the lead runs, so its limits and modalities apply.
		const routed = find("fusion-alpha-lead-sidekick-side");
		expect(routed?.contextWindow).toBe(400_000);
		expect(routed?.input).toEqual(["text", "image"]);
	});
});
