import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../types";
import type { UsageFetchParams, UsageReport } from "../usage";
import { isUsageLimitExhausted } from "./shared";
import { xaiOauthRankingStrategy, xaiOauthUsageProvider } from "./xai-oauth";

const DAY = 24 * 60 * 60 * 1000;

const params: UsageFetchParams = {
	provider: "xai-oauth",
	credential: {
		type: "oauth",
		accessToken: "xai-token",
		refreshToken: "refresh",
		expiresAt: Date.now() + 3_600_000,
		email: "user@example.com",
	},
};

function billingFetch(credits: unknown, monthly: unknown): FetchImpl {
	return async input => Response.json(String(input).includes("format=credits") ? credits : monthly);
}

function inferredWeeklyCredits(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		config: {
			currentPeriod: {
				start: new Date(now - DAY).toISOString(),
				end: new Date(now + 6 * DAY).toISOString(),
				type: "USAGE_PERIOD_TYPE_WEEKLY",
			},
			onDemandCap: { val: 0 },
			onDemandUsed: { val: 0 },
			isUnifiedBillingUser: true,
			...overrides,
		},
	};
}

function monthlyPayload(overrides: Record<string, unknown> = {}) {
	const now = Date.now();
	return {
		config: {
			monthlyLimit: { val: 9516 },
			used: { val: 9624 },
			onDemandCap: { val: 0 },
			billingPeriodStart: new Date(now - 27 * DAY).toISOString(),
			billingPeriodEnd: new Date(now + 3 * DAY).toISOString(),
			history: [],
			...overrides,
		},
	};
}

async function fetchReport(credits: unknown, monthly: unknown): Promise<UsageReport> {
	const report = await xaiOauthUsageProvider.fetchUsage(params, { fetch: billingFetch(credits, monthly) });
	if (!report) throw new Error("expected an xai-oauth usage report");
	return report;
}

const gates = (report: UsageReport) =>
	(xaiOauthRankingStrategy.scopeLimits?.(report) ?? []).some(isUsageLimitExhausted);

describe("xai-oauth credential ranking", () => {
	it("keeps an over-limit monthly counter advisory while inferred weekly credits are active", async () => {
		const report = await fetchReport(inferredWeeklyCredits(), monthlyPayload());

		expect(report.limits[0]?.amount.used).toBe(9624);
		expect(report.limits[0]?.notes?.[0]).toContain("enforcement uncertain");
		expect(xaiOauthRankingStrategy.scopeLimits?.(report)).toEqual([]);
		expect(xaiOauthRankingStrategy.findWindowLimits(report).secondary).toBeUndefined();
	});

	it("gates on exhausted monthly-only and explicit weekly quotas", async () => {
		const monthlyOnly = await fetchReport({ config: { isUnifiedBillingUser: true } }, monthlyPayload());
		expect(gates(monthlyOnly)).toBe(true);
		expect(xaiOauthRankingStrategy.findWindowLimits(monthlyOnly).secondary?.id).toBe("xai-oauth:included:1mo");

		const explicitWeekly = await fetchReport(inferredWeeklyCredits({ creditUsagePercent: 2 }), monthlyPayload());
		expect(gates(explicitWeekly)).toBe(true);
	});

	it("does not gate spent quota while on-demand headroom remains", async () => {
		const report = await fetchReport(
			{ config: { isUnifiedBillingUser: true } },
			monthlyPayload({ onDemandCap: { val: 100 }, onDemandUsed: { val: 40 } }),
		);
		expect(report.limits.some(limit => limit.id === "xai-oauth:on-demand")).toBe(true);
		expect(xaiOauthRankingStrategy.scopeLimits?.(report)).toEqual([]);

		const drained = await fetchReport(
			{ config: { isUnifiedBillingUser: true } },
			monthlyPayload({ onDemandCap: { val: 100 }, onDemandUsed: { val: 100 } }),
		);
		expect(gates(drained)).toBe(true);
	});
});
