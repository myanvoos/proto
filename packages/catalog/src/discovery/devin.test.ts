import { describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "../build";
import { calculateUncachedInputCost, getTimeBasedPricingPeriod } from "../models";
import type { Api, Model, ModelSpec } from "../types";
import { devinCliMetadata } from "../wire/devin";
import { fetchDevinModels } from "./devin";
import {
	type ClientModelConfig,
	ClientModelConfigSchema,
	DefaultOverrideModelConfigSchema,
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

describe("Devin account discovery", () => {
	it("uses the account startup lane and ModelInfo context instead of the stale 200K fallback", async () => {
		const model = config("account-lane");
		if (model.modelInfo) model.modelInfo.maxTokens = 1_000_000;
		const payload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, {
				clientModelConfigs: [model],
				defaultOverrideModelConfig: create(DefaultOverrideModelConfigSchema, { modelUid: "account-lane" }),
			}),
		);
		const discovered = await fetchDevinModels({ apiKey: "fixture", fetch: async () => new Response(payload) });
		expect(discovered?.[0]).toMatchObject({ id: "account-lane", isProviderDefault: true, contextWindow: 1_000_000 });
	});

	it("does not retry an empty native roster under the obsolete Windsurf identity", async () => {
		let calls = 0;
		const payload = toBinary(GetCliModelConfigsResponseSchema, create(GetCliModelConfigsResponseSchema, {}));
		const models = await fetchDevinModels({
			apiKey: "fixture",
			fetch: async () => {
				calls++;
				return new Response(payload);
			},
		});
		expect(models).toBeNull();
		expect(calls).toBe(1);
	});

	it("encodes stored credentials by shape rather than by API-key versus OAuth storage", () => {
		expect(devinCliMetadata("  eyJ.payload.signature  ").apiKey).toBe("devin-session-token$eyJ.payload.signature");
		expect(devinCliMetadata("devin-session-token$eyJ.payload.signature").apiKey).toBe(
			"devin-session-token$eyJ.payload.signature",
		);
		expect(devinCliMetadata("sk-ws-enterprise").apiKey).toBe("sk-ws-enterprise");
	});
});

describe("Devin catalog pricing", () => {
	async function discover(ids: readonly string[]): Promise<Map<string, ModelSpec<"devin-agent">>> {
		const payload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, { clientModelConfigs: ids.map(id => config(id)) }),
		);
		const specs = await fetchDevinModels({
			apiKey: "fixture",
			fetch: async () => new Response(payload, { status: 200, headers: { "content-type": "application/proto" } }),
		});
		if (!specs) throw new Error("Devin discovery returned no catalog");
		return new Map(specs.map(spec => [spec.id, spec]));
	}

	const SWE_2_PROMO_ENDS = Date.parse("2027-01-01T08:00:00Z");
	const inputRateAt = (model: Model<Api>, timestamp: number) =>
		calculateUncachedInputCost(model.cost, 1_000_000, timestamp);

	it("prices SWE-2 Flash separately from SWE-2 across its own promo cutoff", async () => {
		// SWE-2 Flash was billed at SWE-2's enterprise rates, about 7.5x its real price.
		const now = Date.parse("2026-11-06T00:00:00Z");
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			const specs = await discover(["swe-2", "swe-2-flash"]);

			const flash = buildModel(specs.get("swe-2-flash")!);
			expect(flash.cost).toMatchObject({ input: 0.075, output: 0.375, cacheRead: 0.0075, cacheWrite: 0.09375 });
			expect(inputRateAt(flash, now)).toBeCloseTo(0.075, 10);
			expect(inputRateAt(flash, SWE_2_PROMO_ENDS)).toBeCloseTo(0.1, 10);

			const swe2 = buildModel(specs.get("swe-2")!);
			expect(swe2.cost).toMatchObject({ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 });
			expect(inputRateAt(swe2, now)).toBeCloseTo(0.5, 10);
			expect(inputRateAt(swe2, SWE_2_PROMO_ENDS)).toBeCloseTo(3, 10);
			// A dated card is not a peak/off-peak tariff.
			expect(getTimeBasedPricingPeriod(swe2.cost, SWE_2_PROMO_ENDS)).toBeUndefined();
		} finally {
			clock.mockRestore();
		}
	});

	it("prices SWE-2 Fast at its reported rate and covers raw effort uids", async () => {
		const now = Date.parse("2026-11-06T00:00:00Z");
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			// Each family's logical id and a raw effort uid that arrives without family metadata.
			for (const [ids, promoEnds, promo, list] of [
				[
					["swe-2-flash", "swe-2-flash-max"],
					Date.parse("2026-11-18T18:00:00Z"),
					{ input: 0.075, output: 0.375, cacheRead: 0.0075, cacheWrite: 0.09375 },
					{ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
				],
				[
					["swe-2", "swe-2-high"],
					SWE_2_PROMO_ENDS,
					{ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 },
					{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
				],
				[
					// No dated card: Devin publishes no end date or list price for SWE-2 Fast.
					["swe-2-fast", "swe-2-high-lightning"],
					SWE_2_PROMO_ENDS,
					{ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
					{ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
				],
			] as const) {
				const specs = await discover(ids);
				for (const id of ids) {
					const model = buildModel(specs.get(id)!);
					expect(model.cost).toMatchObject(promo);
					expect(inputRateAt(model, now)).toBeCloseTo(promo.input, 10);
					expect(inputRateAt(model, promoEnds - 1)).toBeCloseTo(promo.input, 10);
					expect(inputRateAt(model, promoEnds)).toBeCloseTo(list.input, 10);
				}
			}
		} finally {
			clock.mockRestore();
		}
	});
});
