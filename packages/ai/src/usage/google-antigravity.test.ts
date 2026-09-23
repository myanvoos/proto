import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../types";
import type { UsageFetchParams } from "../usage";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./google-antigravity";

const HOUR_MS = 60 * 60 * 1000;
const params: UsageFetchParams = {
	provider: "google-antigravity",
	credential: { type: "oauth", accessToken: "token", projectId: "project-1", accountId: "acct" },
};

function routedFetch(routes: Record<string, () => Response>, requested: string[]): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			requested.push(url.slice(url.lastIndexOf(":") + 1));
			const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
			return route ? route[1]() : new Response("not found", { status: 404 });
		},
		{ preconnect: fetch.preconnect },
	);
}

describe("Antigravity usage", () => {
	it("reads the quota summary and shares the third-party quota across Claude and GPT", async () => {
		const requested: string[] = [];
		const resetTime = new Date(Date.now() + 2 * HOUR_MS).toISOString();
		const report = await antigravityUsageProvider.fetchUsage(params, {
			fetch: routedFetch(
				{
					retrieveUserQuotaSummary: () =>
						Response.json({
							groups: [
								{
									displayName: "Gemini Models",
									buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75, resetTime }],
								},
								{
									displayName: "Claude and GPT models",
									buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.4 }],
								},
							],
						}),
				},
				requested,
			),
		});
		if (!report) throw new Error("expected a usage report");

		expect(requested).toEqual(["retrieveUserQuotaSummary"]);
		const gemini = antigravityRankingStrategy.scopeLimits?.(report, { modelId: "gemini-3.7-flash" }) ?? [];
		expect(gemini.map(limit => [limit.label, limit.window?.id, limit.window?.durationMs])).toEqual([
			["Gemini", "5h", 5 * HOUR_MS],
		]);
		const claude = antigravityRankingStrategy.scopeLimits?.(report, { modelId: "claude-opus-4-6" }) ?? [];
		const gpt = antigravityRankingStrategy.scopeLimits?.(report, { modelId: "gpt-oss-120b" }) ?? [];
		expect(claude).toHaveLength(1);
		expect(claude[0]?.amount.usedFraction).toBeCloseTo(0.6);
		expect(gpt.map(limit => limit.scope.sharedGroup)).toEqual(claude.map(limit => limit.scope.sharedGroup));
		expect(claude[0]?.label).toBe("Claude & GPT (shared)");
	});

	it("falls back to the model catalog without surfacing unmetered autocomplete entries", async () => {
		const requested: string[] = [];
		const weeklyReset = new Date(Date.now() + 3 * 24 * HOUR_MS).toISOString();
		const report = await antigravityUsageProvider.fetchUsage(params, {
			fetch: routedFetch(
				{
					fetchAvailableModels: () =>
						Response.json({
							models: {
								"gemini-3-pro": {
									modelProvider: "MODEL_PROVIDER_GOOGLE",
									quotaInfo: { resetTime: weeklyReset },
								},
								tab_flash_lite_preview: {
									modelProvider: "MODEL_PROVIDER_GOOGLE",
									quotaInfo: { remainingFraction: 1 },
								},
							},
						}),
				},
				requested,
			),
		});
		if (!report) throw new Error("expected a usage report");

		expect(requested).toEqual(["retrieveUserQuotaSummary", "fetchAvailableModels"]);
		expect(report.limits.map(limit => [limit.id, limit.status])).toEqual([
			["google-antigravity:google:default:weekly", "exhausted"],
		]);
		expect(antigravityRankingStrategy.blockScope?.({ modelId: "tab_flash_lite_preview" })).toBe("counter:google");
	});
});
