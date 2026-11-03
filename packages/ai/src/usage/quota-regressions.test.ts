import { describe, expect, test } from "bun:test";
import { ProviderHttpError } from "../error";
import type { FetchImpl } from "../types";
import type { UsageReport } from "../usage";
import { claudeUsageProvider } from "./claude";
import { clinePassUsageProvider } from "./cline-pass";
import { githubCopilotUsageProvider } from "./github-copilot";
import { kimiUsageProvider } from "./kimi";
import { minimaxCodeUsageProvider } from "./minimax-code";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { isUsageLimitExhausted } from "./shared";
import { zaiUsageProvider } from "./zai";

async function codexReport(payload: unknown): Promise<UsageReport> {
	const report = await openaiCodexUsageProvider.fetchUsage(
		{ provider: "openai-codex", credential: { type: "oauth", accessToken: "token" } },
		{ fetch: async () => Response.json(payload) },
	);
	if (!report) throw new Error("Expected Codex report");
	return report;
}

describe("Codex spend caps", () => {
	test("credit-billed seats expose precise credit spend and gate chat without gating Spark", async () => {
		const report = await codexReport({
			spend_control: {
				reached: true,
				individual_limit: { used: "81.5", limit: "100", remaining: "18.5", used_percent: 82 },
			},
		});
		expect(report.limits[0]?.amount).toMatchObject({
			used: 81.5,
			limit: 100,
			remaining: 18.5,
			usedFraction: 0.815,
			unit: "credits",
		});
		expect(codexRankingStrategy.scopeLimits?.(report, { modelId: "gpt-5-codex" }).some(isUsageLimitExhausted)).toBe(
			true,
		);
		expect(codexRankingStrategy.scopeLimits?.(report, { modelId: "gpt-5-codex-spark" })).toEqual([]);
	});

	test("an explicit unreached verdict overrides a rounded exhausted percentage", async () => {
		const report = await codexReport({ spend_control: { reached: false, individual_limit: { used_percent: 100 } } });
		expect(report.limits[0]?.status).not.toBe("exhausted");
		expect(report.metadata).toMatchObject({ allowed: true, limitReached: false });
	});

	test("bare zero remaining exhausts a credit-billed seat without inventing an allow verdict", async () => {
		const report = await codexReport({ spend_control: { individual_limit: { remaining: 0 } } });
		expect(report.limits[0]?.status).toBe("exhausted");
		expect(report.metadata?.allowed).not.toBe(true);
	});

	test("a spent overage cap cannot block included plan requests or fund exhausted plan requests", async () => {
		const available = await codexReport({
			rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10 } },
			spend_control: { reached: true, individual_limit: { used_percent: 100 } },
		});
		expect(
			codexRankingStrategy.scopeLimits?.(available, { modelId: "gpt-5-codex" }).some(isUsageLimitExhausted),
		).toBe(false);
		expect(
			codexRankingStrategy
				.healableBlockScopes?.(available)
				.find(scope => scope.blockScope === "shared")
				?.limits.map(limit => limit.id),
		).not.toContain("openai-codex:spend-cap");
		const exhausted = await codexReport({
			rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } },
			credits: { has_credits: true },
			spend_control: { individual_limit: { remaining: 0 } },
		});
		expect(
			codexRankingStrategy.scopeLimits?.(exhausted, { modelId: "gpt-5-codex" }).some(isUsageLimitExhausted),
		).toBe(true);
	});

	test.each([401, 403])(
		"auth rejection %s is surfaced instead of treated as a transient empty report",
		async status => {
			await expect(
				openaiCodexUsageProvider.fetchUsage(
					{ provider: "openai-codex", credential: { type: "oauth", accessToken: "token" } },
					{ fetch: async () => new Response(null, { status }) },
				),
			).rejects.toBeInstanceOf(ProviderHttpError);
		},
	);
});

describe("Copilot billing and rejected credentials", () => {
	test("credit and request meters retain their reported units in the same billing response", async () => {
		const report = await githubCopilotUsageProvider.fetchUsage(
			{ provider: "github-copilot", credential: { type: "api_key", apiKey: "gh-key", accountId: "octocat" } },
			{
				fetch: async () =>
					Response.json({
						user: "octocat",
						timePeriod: { year: 2026, month: 10 },
						usageItems: [
							{ sku: "Copilot Premium Request", unitType: "AI_CREDITS", grossQuantity: 1125, limit: 1500 },
							{ sku: "Other", model: "credit-model", unitType: "CREDIT", grossQuantity: 5 },
							{ sku: "Other", model: "legacy-model", grossQuantity: 2 },
						],
					}),
			},
		);
		expect(report?.limits.find(limit => limit.id === "copilot:premium")).toMatchObject({
			label: "AI Credits",
			amount: { unit: "credits", used: 1125, remaining: 375 },
			window: { id: "monthly" },
		});
		expect(report?.limits.find(limit => limit.id === "copilot:model:credit-model")?.amount.unit).toBe("credits");
		expect(report?.limits.find(limit => limit.id === "copilot:model:legacy-model")?.amount.unit).toBe("requests");
	});

	test("unanimous auth rejection throws, but malformed or unavailable username lookup stays transient", async () => {
		const params = { provider: "github-copilot", credential: { type: "api_key" as const, apiKey: "gh-key" } };
		await expect(
			githubCopilotUsageProvider.fetchUsage(params, { fetch: async () => new Response(null, { status: 401 }) }),
		).rejects.toBeInstanceOf(ProviderHttpError);
		for (const response of [Response.json({}), new Response(null, { status: 503 })]) {
			const fetch: FetchImpl = async input =>
				String(input).endsWith("/user") ? response : new Response(null, { status: 401 });
			expect(await githubCopilotUsageProvider.fetchUsage(params, { fetch })).toBeNull();
		}
	});
});

describe("Provider usage endpoint routing", () => {
	test("MiniMax Anthropic inference routes request quota from the API host root", async () => {
		const urls: string[] = [];
		await minimaxCodeUsageProvider.fetchUsage(
			{
				provider: "minimax-code",
				baseUrl: "https://quota.example/anthropic/v1/",
				credential: { type: "api_key", apiKey: "key" },
			},
			{
				fetch: async input => {
					urls.push(String(input));
					return Response.json({});
				},
			},
		);
		expect(urls).toEqual(["https://quota.example/v1/token_plan/remains"]);
	});

	test("Claude accepts OAuth environment tokens, but never treats ordinary API keys as OAuth", async () => {
		const oauth = { provider: "anthropic", credential: { type: "api_key" as const, apiKey: "sk-ant-oat01-test" } };
		expect(claudeUsageProvider.supports?.(oauth)).toBe(true);
		expect(
			claudeUsageProvider.supports?.({ ...oauth, credential: { type: "api_key", apiKey: "sk-ant-api03-test" } }),
		).toBe(false);
		let authorization = "";
		const report = await claudeUsageProvider.fetchUsage(oauth, {
			fetch: async (input, init) => {
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				if (String(input).endsWith("/usage"))
					return Response.json({
						five_hour: { utilization: 25 },
						account_id: "account",
						email: "dev@example.com",
					});
				return new Response(null, { status: 404 });
			},
		});
		expect(authorization).toBe("Bearer sk-ant-oat01-test");
		expect(report?.limits.find(limit => limit.id === "anthropic:5h")?.amount.usedFraction).toBe(0.25);
	});
});

test("planless accounts do not produce warnings while malformed quota responses still do", async () => {
	for (const [provider, payload, status] of [
		[clinePassUsageProvider, "no plan history found for user", 404],
		[kimiUsageProvider, {}, 200],
		[zaiUsageProvider, { success: false, code: 500, msg: "当前用户不存在coding plan" }, 200],
	] as const) {
		const warnings: string[] = [];
		const debug: string[] = [];
		const params = {
			provider: provider.id,
			credential: { type: "oauth" as const, accessToken: "token", apiKey: "key" },
		};
		const logger = {
			debug: (message: string) => {
				debug.push(message);
			},
			warn: (message: string) => {
				warnings.push(message);
			},
		};
		const credential =
			provider === clinePassUsageProvider ? { type: "api_key" as const, apiKey: "key" } : params.credential;
		expect(
			await provider.fetchUsage(
				{ ...params, credential },
				{
					logger,
					fetch: async () =>
						typeof payload === "string" ? new Response(payload, { status }) : Response.json(payload, { status }),
				},
			),
		).toBeNull();
		expect(warnings).toEqual([]);
		expect(debug.some(message => /no .*plan|no plan/i.test(message))).toBe(true);
		await provider.fetchUsage(
			{ ...params, credential },
			{
				logger,
				fetch: async () =>
					Response.json({ unexpected: true }, { status: provider === clinePassUsageProvider ? 404 : 200 }),
			},
		);
		expect(warnings.length).toBeGreaterThan(0);
	}
});
