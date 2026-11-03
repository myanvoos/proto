import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../types";
import { cursorRankingStrategy, cursorUsageProvider, parseCursorIndividualUsage } from "./cursor";
import { isUsageLimitExhausted } from "./shared";

function cursorAccessToken(sub: string): string {
	const payload = btoa(JSON.stringify({ sub })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `header.${payload}.signature`;
}

describe("Cursor credential ranking", () => {
	it("scopes split billing pools to the requested model", () => {
		const report = parseCursorIndividualUsage({
			individualUsage: { plan: { enabled: true, limit: 2000, autoPercentUsed: 11, apiPercentUsed: 100 } },
		});
		if (!report) throw new Error("expected Cursor usage report");
		const scope = (modelId: string) => cursorRankingStrategy.scopeLimits?.(report, { modelId }) ?? [];

		const grok = scope("grok-4.7-xhigh");
		const composer = scope("composer-2.5");
		const other = scope("claude-opus-5-high");
		expect(grok.map(limit => limit.id)).toEqual(["cursor:usd:individual-auto"]);
		expect(composer.map(limit => limit.id)).toEqual(["cursor:usd:individual-auto"]);
		expect(other.map(limit => limit.id)).toEqual(["cursor:usd:individual-api"]);
		expect(grok.some(isUsageLimitExhausted)).toBe(false);
		expect(other.some(isUsageLimitExhausted)).toBe(true);
		expect(cursorRankingStrategy.blockScope?.({ modelId: "grok-4.7-xhigh" })).not.toBe(
			cursorRankingStrategy.blockScope?.({ modelId: "claude-opus-5-high" }),
		);
	});

	it("uses the combined pool when Cursor reports no split rails", () => {
		const report = parseCursorIndividualUsage({
			individualUsage: { plan: { enabled: true, limit: 2000, totalPercentUsed: 100 } },
		});
		if (!report) throw new Error("expected Cursor usage report");
		const limits = cursorRankingStrategy.scopeLimits?.(report, { modelId: "grok-4.7-xhigh" }) ?? [];
		expect(limits.map(limit => limit.id)).toEqual(["cursor:usd:individual-plan"]);
		expect(limits.some(isUsageLimitExhausted)).toBe(true);
	});
});

describe("Cursor subscription pools", () => {
	it("keeps legacy Other Models as a percentage when the plan dollar limit belongs to another pool", () => {
		const report = parseCursorIndividualUsage({ individualUsage: { plan: { limit: 40000, apiPercentUsed: 48.44 } } });
		expect(report?.limits[0]?.amount).toEqual({ used: 48.44, usedFraction: 0.4844, unit: "percent" });
	});

	it("separates X Subscription weekly usage from exhausted, non-resetting prepaid credit", () => {
		const report = parseCursorIndividualUsage(
			{
				membershipType: "unified_pro",
				billingCycleEnd: "2030-01-01T00:00:00Z",
				individualUsage: { plan: { limit: 2000, used: 400, totalPercentUsed: 20 }, onDemand: { enabled: false } },
			},
			1,
			2_000_000_000_000,
		);
		if (!report) throw new Error("Expected subscription report");
		const native = cursorRankingStrategy.scopeLimits?.(report, { modelId: "grok-4.7" }) ?? [];
		const other = cursorRankingStrategy.scopeLimits?.(report, { modelId: "claude-opus-5" }) ?? [];
		expect(native[0]?.window).toMatchObject({ id: "weekly", resetsAt: 2_000_000_000_000 });
		expect(native[0]?.amount.usedFraction).toBe(0.2);
		expect(other[0]?.window).toEqual({ id: "prepaid", label: "Prepaid credit" });
		expect(other.some(isUsageLimitExhausted)).toBe(true);
		expect(cursorRankingStrategy.healableBlockScopes?.(report).map(scope => scope.blockScope)).toEqual([
			"pool:auto",
			"pool:api",
		]);
		const legacy = parseCursorIndividualUsage({ individualUsage: { plan: { autoPercentUsed: 0 } } });
		if (!legacy) throw new Error("Expected legacy report");
		expect(cursorRankingStrategy.healableBlockScopes?.(legacy)).toEqual([]);
	});

	it("reads GitHub login identity and the weekly reset using authenticated Connect RPC", async () => {
		const calls: string[] = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("aiserver.v1.DashboardService/")) {
				expect(init?.method).toBe("POST");
				expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${cursorAccessToken("github|42")}`);
				return Response.json(
					url.endsWith("/GetMe")
						? { authId: "github|42", email: "github@example.com" }
						: { planInfo: { includedUsageResetsAt: 2_000_000_000_000 } },
				);
			}
			if (url.endsWith("/auth/usage")) return Response.json({});
			return Response.json({ membershipType: "unified_pro", individualUsage: { plan: { totalPercentUsed: 50 } } });
		};
		const report = await cursorUsageProvider.fetchUsage(
			{ provider: "cursor", credential: { type: "oauth", accessToken: cursorAccessToken("github|42") } },
			{ fetch },
		);
		expect(report?.metadata?.email).toBe("github@example.com");
		expect(report?.limits[0]?.window?.resetsAt).toBe(2_000_000_000_000);
		expect(calls.some(url => url.endsWith("/GetPlanInfo"))).toBe(true);
	});
});

describe("Cursor usage report", () => {
	it("drops uncapped, unused legacy buckets beside the dashboard summary", async () => {
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url === "https://api2.cursor.sh/auth/usage") {
				return Response.json({
					"gpt-4": { numRequests: 0, maxRequestUsage: null },
					"claude-3-5-sonnet": { numRequests: 80, maxRequestUsage: 500 },
					"gpt-4-32k": { numRequests: 12, maxRequestUsage: null },
				});
			}
			if (url === "https://cursor.com/api/auth/me") return Response.json({ email: "a@example.com", sub: "user_1" });
			return Response.json({
				individualUsage: { overall: { enabled: true, used: 2000, limit: 10000, remaining: 8000 } },
			});
		};
		const report = await cursorUsageProvider.fetchUsage(
			{ provider: "cursor", credential: { type: "oauth", accessToken: cursorAccessToken("auth0|user_1") } },
			{ fetch },
		);
		expect(report?.limits.map(limit => limit.id)).toEqual([
			"cursor:requests:claude-3-5-sonnet",
			"cursor:requests:gpt-4-32k",
			"cursor:usd:individual-overall",
		]);
	});
});
