import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { usageResponseSchema } from "../auth-broker/wire-schemas";
import type { FetchImpl } from "../types";
import { type UsageFetchParams, usageReportSchema } from "../usage";
import { zaiRankingStrategy, zaiUsageProvider } from "./zai";

const params: UsageFetchParams = { provider: "zai", credential: { type: "api_key", apiKey: "zai-key" } };

function quotaFetch(data: unknown): FetchImpl {
	return async input =>
		String(input).includes("/quota/limit")
			? Response.json({ success: true, data })
			: new Response("not found", { status: 404 });
}

describe("Z.AI GLM Coding Plan credit quotas", () => {
	it("parses CREDIT_LIMIT windows with the exact ratio, plan tier, and broker-valid unit", async () => {
		const report = await zaiUsageProvider.fetchUsage(params, {
			fetch: quotaFetch({
				level: "pro",
				limits: [
					{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 1438, percentage: 11 },
					{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 2254, percentage: 3 },
				],
			}),
		});

		expect(report?.limits.map(limit => limit.id)).toEqual(["zai:credits:5h", "zai:credits:1w"]);
		expect(report?.limits[0]?.amount).toMatchObject({ used: 1438, limit: 12000, unit: "credits" });
		// The server-rounded integer percentage (11) loses precision; absolutes win.
		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(1438 / 12000, 6);
		expect(report?.metadata?.planType).toBe("pro");
		const windows = zaiRankingStrategy.findWindowLimits(report!);
		expect(windows.primary?.id).toBe("zai:credits:5h");
		expect(windows.secondary?.id).toBe("zai:credits:1w");

		const { raw: _raw, ...rest } = report!;
		const wireReport: unknown = JSON.parse(JSON.stringify(rest));
		expect(usageReportSchema(wireReport)).not.toBeInstanceOf(type.errors);
		expect(usageResponseSchema({ generatedAt: 0, reports: [wireReport] })).not.toBeInstanceOf(type.errors);
	});

	it("falls back to the percentage when the credit meter omits absolutes", async () => {
		const report = await zaiUsageProvider.fetchUsage(params, {
			fetch: quotaFetch({ limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 97 }] }),
		});

		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.97, 6);
		expect(report?.limits[0]?.status).toBe("warning");
	});

	it("ranks the most-binding meter per window when tokens and credits coexist", async () => {
		const report = await zaiUsageProvider.fetchUsage(params, {
			fetch: quotaFetch({
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 82 },
					{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 1438 },
					{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 38 },
					{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 2254 },
				],
			}),
		});

		const windows = zaiRankingStrategy.findWindowLimits(report!);
		expect(windows.primary?.id).toBe("zai:tokens:5h");
		expect(windows.secondary?.id).toBe("zai:tokens:1w");
	});
});
