import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";
import { buildModel } from "./build";
import { resolveProviderModels } from "./model-manager";
import {
	calculateCost,
	calculateUncachedInputCost,
	calculateUsageCost,
	getNextTimeBasedPricingTransition,
	getTimeBasedPricingPeriod,
} from "./models";
import { isTimeBasedCost } from "./pricing";
import type { ModelCost, ModelSpec, TimeBasedCost, Usage } from "./types";

const WEEKDAY_WINDOWS: TimeBasedCost = {
	offPeakMultiplier: 0.5,
	peakWindows: [
		{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
		{ weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
	],
};
const FLASH: ModelCost = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, timeBased: WEEKDAY_WINDOWS };

function spec(id = "deepseek-v4-flash", provider = "deepseek"): ModelSpec<"openai-completions"> {
	return {
		id,
		provider,
		name: id,
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 },
	};
}

function usage(input = 1_000_000, output = 1_000_000, cacheRead = 1_000_000, cacheWrite = 1_000_000): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const monday = Date.parse("2026-09-07T00:00:00Z");
const peak = Date.parse("2026-09-10T02:00:00Z");
const offPeak = Date.parse("2026-09-10T05:00:00Z");

describe("time-based token pricing", () => {
	it("uses half-open intervals at every UTC window edge", () => {
		for (const [minute, before, at] of [
			[60, 0.15, 0.3],
			[240, 0.3, 0.15],
			[360, 0.15, 0.3],
			[600, 0.3, 0.15],
		] as const) {
			const timestamp = monday + minute * 60_000;
			expect(calculateUncachedInputCost(FLASH, 1_000_000, timestamp - 1)).toBeCloseTo(before, 12);
			expect(calculateUncachedInputCost(FLASH, 1_000_000, timestamp)).toBeCloseTo(at, 12);
		}
	});

	it("charges peak on every weekday and off-peak all weekend, independent of local date", () => {
		for (let day = 0; day < 7; day++) {
			for (const minute of [120, 420]) {
				expect(
					calculateUncachedInputCost(FLASH, 1_000_000, monday + day * 86_400_000 + minute * 60_000),
				).toBeCloseTo(day < 5 ? 0.3 : 0.15, 12);
			}
		}
		// Both describe Monday 01:00 UTC, despite different local weekdays/hours.
		for (const instant of ["2026-09-06T18:00:00-07:00", "2026-09-07T10:00:00+09:00"]) {
			expect(calculateUncachedInputCost(FLASH, 1_000_000, Date.parse(instant))).toBeCloseTo(0.3, 12);
		}
	});

	it("selects effective rates before context tiers and discounts all billable token dimensions", () => {
		const cost: ModelCost = {
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			longContext: { inputThreshold: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [],
				effectiveRates: [
					{ effectiveFrom: 2000, input: 5, output: 6, cacheRead: 0.5, cacheWrite: 6.25 },
					{
						effectiveFrom: 1000,
						input: 3,
						output: 4,
						cacheRead: 0.3,
						cacheWrite: 3.75,
						longContext: {
							inputThreshold: 100,
							inputThresholdInclusive: true,
							input: 4,
							output: 8,
							cacheRead: 0.4,
							cacheWrite: 5,
						},
					},
				],
			},
		};
		const atThreshold = usage(40, 10, 20, 20);
		atThreshold.orchestration = { input: 10, output: 5, cacheRead: 10 };
		atThreshold.cttl = { ephemeral5m: 10, ephemeral1h: 5 };
		const charged = calculateUsageCost(cost, atThreshold, 1000);
		expect(charged.input).toBeCloseTo(((50 * 4) / 1e6) * 0.5, 12);
		expect(charged.output).toBeCloseTo(((15 * 8) / 1e6) * 0.5, 12);
		expect(charged.cacheRead).toBeCloseTo(((30 * 0.4) / 1e6) * 0.5, 12);
		expect(charged.cacheWrite).toBeCloseTo(((15 * 5 + 5 * 8) / 1e6) * 0.5, 12);
		expect(calculateUncachedInputCost(cost, 100, 999)).toBeCloseTo(((100 * 1) / 1e6) * 0.5, 12);
		expect(calculateUncachedInputCost(cost, 101, 999)).toBeCloseTo(((101 * 2) / 1e6) * 0.5, 12);
		expect(calculateUncachedInputCost(cost, 99, 1000)).toBeCloseTo(((99 * 3) / 1e6) * 0.5, 12);
		// A later full replacement without a tier must not inherit the base/previous tier.
		expect(calculateUncachedInputCost(cost, 101, 2000)).toBeCloseTo(((101 * 5) / 1e6) * 0.5, 12);
	});

	it("defaults scheduled pricing to now but never consults the clock for flat cards", () => {
		const clock = spyOn(Date, "now").mockReturnValue(offPeak);
		try {
			const flat = spec().cost;
			expect(calculateUsageCost(flat, usage()).total).toBeCloseTo(30, 12);
			expect(calculateUncachedInputCost(flat, 1_000_000)).toBeCloseTo(9, 12);
			expect(clock).not.toHaveBeenCalled();
			expect(calculateUsageCost(FLASH, usage()).total).toBeCloseTo(0.753, 12);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("recurring tariff period and transitions", () => {
	it("classifies window boundaries even when both periods have the same price", () => {
		const cost: ModelCost = {
			...spec().cost,
			timeBased: { offPeakMultiplier: 1, peakWindows: [{ weekdays: [1], startMinute: 60, endMinute: 120 }] },
		};
		const start = monday + 60 * 60_000;
		const end = monday + 120 * 60_000;
		expect(getTimeBasedPricingPeriod(cost, start - 1)).toBe("off-peak");
		expect(getTimeBasedPricingPeriod(cost, start)).toBe("peak");
		expect(getTimeBasedPricingPeriod(cost, end)).toBe("off-peak");
		expect(getNextTimeBasedPricingTransition(cost, start - 1)).toBe(start);
		expect(getNextTimeBasedPricingTransition(cost, start)).toBe(end);
		expect(getNextTimeBasedPricingTransition(cost, end)).toBe(start + 7 * 86_400_000);
	});

	it("skips overlapping and touching edges rather than waking before the period changes", () => {
		const cost: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [
					{ weekdays: [1], startMinute: 180, endMinute: 240 },
					{ weekdays: [1], startMinute: 60, endMinute: 120 },
					{ weekdays: [1], startMinute: 90, endMinute: 180 },
				],
			},
		};
		const start = monday + 60 * 60_000;
		const end = monday + 240 * 60_000;
		expect(getNextTimeBasedPricingTransition(cost, monday)).toBe(start);
		expect(getNextTimeBasedPricingTransition(cost, start)).toBe(end);
		expect(getNextTimeBasedPricingTransition(cost, monday + 120 * 60_000)).toBe(end);
	});

	it("crosses the weekend and merges touching windows across the UTC week rollover", () => {
		const fridayEnd = monday + 4 * 86_400_000 + 600 * 60_000;
		const nextMondayStart = monday + 7 * 86_400_000 + 60 * 60_000;
		expect(getTimeBasedPricingPeriod(FLASH, fridayEnd)).toBe("off-peak");
		expect(getNextTimeBasedPricingTransition(FLASH, fridayEnd)).toBe(nextMondayStart);

		const midnight: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [
					{ weekdays: [6], startMinute: 1380, endMinute: 1440 },
					{ weekdays: [0], startMinute: 0, endMinute: 60 },
				],
			},
		};
		const sunday = monday + 6 * 86_400_000;
		expect(getTimeBasedPricingPeriod(midnight, sunday)).toBe("peak");
		expect(getNextTimeBasedPricingTransition(midnight, sunday - 60_000)).toBe(sunday + 60 * 60_000);
	});

	it("reports no transition when the weekly period never changes", () => {
		const always: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
			},
		};
		expect(getTimeBasedPricingPeriod(always, monday)).toBe("peak");
		expect(getNextTimeBasedPricingTransition(always, monday + 1)).toBeUndefined();
		const never: ModelCost = { ...spec().cost, timeBased: { offPeakMultiplier: 0.5, peakWindows: [] } };
		expect(getTimeBasedPricingPeriod(never, monday)).toBe("off-peak");
		expect(getNextTimeBasedPricingTransition(never, monday)).toBeUndefined();
		expect(getTimeBasedPricingPeriod(spec().cost, monday)).toBeUndefined();
	});
});

describe("DeepSeek generated pricing policy", () => {
	function generated(candidate: ModelSpec<"openai-completions">) {
		const specs = [candidate];
		applyGeneratedModelPolicies(specs);
		return buildModel(specs[0]!);
	}

	it("puts first-party Flash ids on the scheduled peak card, leaving resellers and other SKUs flat", () => {
		for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
			const model = generated(spec(id));
			expect(calculateCost(model, usage(), peak).total).toBeCloseTo(1.506, 12);
			expect(calculateCost(model, usage(), offPeak).total).toBeCloseTo(0.753, 12);
		}
		for (const candidate of [spec("deepseek-v4-flash", "openrouter"), spec("deepseek-v4.1-flash-expires-on-0910")]) {
			expect(calculateCost(generated(candidate), usage(), offPeak).total).toBeCloseTo(30, 12);
		}
	});

	it("switches Pro to Flash prices exactly at the dated cutoff", () => {
		const model = generated(spec("deepseek-v4-pro"));
		const cutoff = Date.parse("2026-09-14T04:00:00Z");
		expect(calculateCost(model, usage(), cutoff - 1).total).toBeCloseTo(5.324, 12);
		expect(calculateCost(model, usage(), cutoff).total).toBeCloseTo(0.753, 12);
		expect(calculateCost(model, usage(), Date.parse("2026-09-14T06:00:00Z")).total).toBeCloseTo(1.506, 12);
	});
});

describe("scheduled pricing through discovery and cache", () => {
	it("keeps a static schedule on discovered rate cards, online and from the offline cache", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-scheduled-merge-"));
		const base = spec("scheduled-model", "custom-scheduled");
		base.cost = { ...base.cost, timeBased: { offPeakMultiplier: 0.5, peakWindows: [] } };
		const dynamic = { ...base, cost: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1 } };
		const options = { providerId: base.provider, staticModels: [base], cacheDbPath: path.join(tempDir, "models.db") };
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [dynamic] },
				"online",
			);
			expect(calculateCost(online.models[0]!, usage(), offPeak).total).toBeCloseTo(5, 12);
			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(calculateCost(offline.models[0]!, usage(), offPeak).total).toBeCloseTo(5, 12);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects malformed serialized schedules", () => {
		const valid = {
			...WEEKDAY_WINDOWS,
			effectiveRates: [{ effectiveFrom: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
		};
		expect(isTimeBasedCost(valid)).toBe(true);
		for (const invalid of [
			{ ...valid, offPeakMultiplier: -0.5 },
			{ ...valid, peakWindows: [{ weekdays: [7], startMinute: 60, endMinute: 240 }] },
			{ ...valid, peakWindows: [{ weekdays: [1, 1], startMinute: 60, endMinute: 240 }] },
			{ ...valid, peakWindows: [{ weekdays: [1], startMinute: 240, endMinute: 240 }] },
			{ ...valid, effectiveRates: [{ ...valid.effectiveRates[0], effectiveFrom: Infinity }] },
			{ ...valid, effectiveRates: [valid.effectiveRates[0], valid.effectiveRates[0]] },
		]) {
			expect(isTimeBasedCost(invalid)).toBe(false);
		}
	});
});
