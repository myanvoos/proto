import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../types";
import type { UsageFetchParams } from "../usage";
import { kimiUsageProvider } from "./kimi";

const params: UsageFetchParams = {
	provider: "kimi-code",
	credential: { type: "oauth", accessToken: "kimi-token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 },
};

function usageFetch(payload: unknown): FetchImpl {
	return async () => Response.json(payload);
}

describe("Kimi Code usage quotas", () => {
	it("labels the aggregate as the weekly limit and parses purchased totalQuota on its own window", async () => {
		const report = await kimiUsageProvider.fetchUsage(params, {
			fetch: usageFetch({
				usage: { limit: "100", used: "28", remaining: "72", resetTime: "2026-07-21T07:43:35Z" },
				totalQuota: {
					limit: "500",
					used: "100",
					remaining: "400",
					window: { duration: 30, timeUnit: "TIME_UNIT_DAY", resetTime: "2026-08-20T00:00:00Z" },
				},
			}),
		});

		expect(report?.limits.map(limit => [limit.label, limit.window?.id])).toEqual([
			["Weekly limit", "7d"],
			["Total quota", "30d"],
		]);
		expect(report?.limits[1]?.amount).toMatchObject({ limit: 500, remaining: 400, usedFraction: 0.2 });
		expect(report?.limits[1]?.window?.resetsAt).toBe(Date.parse("2026-08-20T00:00:00Z"));
	});

	it("surfaces monthly aggregate usages as percent rows without duplicating the 5h limit", async () => {
		const monthlyReset = "2026-10-22T00:00:00Z";
		const report = await kimiUsageProvider.fetchUsage(params, {
			fetch: usageFetch({
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { limit: "100", used: "100", resetTime: "2026-09-22T12:22:15Z" },
					},
				],
				usages: {
					limit_5h: { used_ratio: 0, reset_time: "2026-09-22T12:22:15Z" },
					limit_month_total: { used_ratio: 0.0795, reset_time: monthlyReset },
					limit_month_code: { used_ratio: 0, reset_time: monthlyReset },
				},
			}),
		});

		expect(report?.limits.map(limit => limit.label)).toEqual(["5h limit", "Monthly total", "Monthly code"]);
		const monthlyTotal = report!.limits[1]!;
		expect(monthlyTotal.amount.unit).toBe("percent");
		expect(monthlyTotal.amount.used).toBeCloseTo(7.95, 6);
		expect(monthlyTotal.amount.usedFraction).toBeCloseTo(0.0795, 6);
		expect(monthlyTotal.window?.resetsAt).toBe(Date.parse(monthlyReset));
	});
});
