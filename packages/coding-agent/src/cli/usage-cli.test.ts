import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	annotateUsagePolicy,
	collectUnreportedAccounts,
	computeProviderWindowStats,
	formatUsageBreakdown,
} from "./usage-cli";

const HOUR_MS = 60 * 60 * 1000;

function report(email: string, usedFraction: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: 0,
		metadata: { email },
		limits: [
			{
				id: "anthropic:7d",
				label: "Weekly",
				scope: { provider: "anthropic", windowId: "7d" },
				window: { id: "7d", label: "Weekly", durationMs: 168 * HOUR_MS },
				amount: { unit: "percent", usedFraction, remainingFraction: 1 - usedFraction },
				status: "ok",
			},
		],
	};
}

describe("formatUsageBreakdown account policy diagnostics", () => {
	it("shows each policy-routed account's priority, reserve source, and reserve state", () => {
		const text = Bun.stripANSI(
			formatUsageBreakdown(
				[report("work@example.com", 0.8), report("home@example.com", 0.2)],
				[],
				0,
				undefined,
				[],
				{
					globalReservePct: 10,
					getAccountPolicy: (_provider, identity) =>
						identity.email === "work@example.com"
							? { provider: "anthropic", account: { email: "work@example.com" }, priority: 5, reservePct: 25 }
							: undefined,
				},
			),
		);
		expect(text).toContain("policy: priority 5 · reserve 25% (override) · inside reserve · 20.0% left");
		expect(text).toContain("policy: priority 0 · reserve 10% (global) · eligible · 80.0% left");
	});
});

it("provider exhausted flags win over positive remaining fractions in text and JSON policy state", () => {
	const exhausted = report("flagged@example.test", 0.2);
	exhausted.limits[0]!.status = "exhausted";
	const options = {
		globalReservePct: 10,
		getAccountPolicy: () => ({ provider: "anthropic", account: { email: "flagged@example.test" }, priority: 1 }),
	};
	const text = Bun.stripANSI(formatUsageBreakdown([exhausted], [], 0, undefined, [], options));
	expect(text).toContain("exhausted · 80.0% left");
	const json = annotateUsagePolicy([exhausted], [], [], options);
	expect(json.reports[0]?.policy?.state).toBe("exhausted");
});

describe("computeProviderWindowStats meters", () => {
	const SEVEN_DAYS = 168 * HOUR_MS;

	function limit(provider: string, id: string, usedFraction: number, tier?: string): UsageReport["limits"][number] {
		return {
			id,
			label: id,
			scope: { provider, windowId: "7d", ...(tier ? { tier } : {}) },
			window: { id: "7d", label: "7d", durationMs: SEVEN_DAYS },
			amount: { unit: "percent", usedFraction },
		};
	}

	function providerReport(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
		return { provider, fetchedAt: 0, metadata: { email }, limits };
	}

	it("keeps a spent model-scoped cap separate from the shared window it caps", () => {
		const stats = computeProviderWindowStats([
			providerReport("anthropic", "scoped@example.test", [
				limit("anthropic", "anthropic:7d", 0.51),
				limit("anthropic", "anthropic:7d:fable", 1, "fable"),
			]),
		]);

		expect(stats.map(stat => [stat.meter, stat.usedAccounts, stat.remainingAccounts])).toEqual([
			[undefined, 0.51, 0.49],
			["fable", 1, 0],
		]);
	});

	it("does not split one window by subscription plan", () => {
		const stats = computeProviderWindowStats([
			providerReport("github-copilot", "individual@example.test", [
				limit("github-copilot", "copilot:premium", 0.3, "individual"),
			]),
			providerReport("github-copilot", "business@example.test", [
				limit("github-copilot", "copilot:premium", 0.5, "business"),
			]),
		]);

		expect(stats.map(stat => [stat.meter, stat.accounts])).toEqual([[undefined, 2]]);
		expect(stats[0].usedAccounts).toBeCloseTo(0.8);
	});
});

describe("formatUsageBreakdown Codex plan", () => {
	function codexReport(metadata: Record<string, string>): UsageReport {
		return { ...report(metadata.email, 0.2), provider: "openai-codex", metadata };
	}

	it("shows the live Codex plan without the login-token plan or a workspace id for one account", () => {
		const codex = codexReport({
			email: "user@example.test",
			orgId: "workspace-id",
			orgName: "free",
			planType: "prolite",
		});

		const text = stripVTControlCharacters(formatUsageBreakdown([codex], [], 0));

		expect(text).toContain("user@example.test · plan: prolite");
		expect(text).not.toContain("workspace-id");
		expect(text).not.toContain(" · free");
	});

	it("qualifies Codex accounts sharing an email by workspace", () => {
		const reports = [
			codexReport({ email: "shared@example.test", orgId: "workspace-one", orgName: "free", planType: "prolite" }),
			codexReport({ email: "shared@example.test", orgId: "workspace-two", orgName: "free" }),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], 0));

		expect(text).toContain("shared@example.test · workspace-one · plan: prolite");
		expect(text).toContain("shared@example.test · workspace-two");
		expect(text).not.toContain(" · free");
	});
});

it("JSON policy diagnostics distinguish reserve, exhaustion and unknown usage without changing unconfigured providers", () => {
	const options = {
		globalReservePct: 10,
		getAccountPolicy: (provider: string) =>
			provider === "anthropic"
				? { provider, account: { email: "policy@example.test" }, priority: 3, reservePct: 20 }
				: undefined,
	};
	const annotated = annotateUsagePolicy(
		[
			report("reserve@example.test", 0.91),
			report("spent@example.test", 1),
			{ ...report("other@example.test", 0.5), provider: "other" },
		],
		[{ provider: "anthropic", type: "oauth", email: "unknown@example.test" }],
		[],
		options,
	);
	expect(annotated.reports[0]?.policy).toEqual({
		priority: 3,
		reservePct: 20,
		reserveSource: "override",
		state: "inside-reserve",
		remainingPct: 9,
	});
	expect(annotated.reports[1]?.policy?.state).toBe("exhausted");
	expect(annotated.reports[2]).not.toHaveProperty("policy");
	expect(annotated.accountsWithoutUsage[0]?.policy).toEqual({
		priority: 3,
		reservePct: 20,
		reserveSource: "override",
		state: "unknown",
	});
});

it("identity-less OAuth credentials are not reported missing beside org-scoped usage", () => {
	const orgReport = {
		...report("known@example.test", 0.4),
		metadata: { orgId: "org-1", email: "known@example.test" },
	};
	expect(
		collectUnreportedAccounts(
			[orgReport],
			[
				{ provider: "anthropic", type: "oauth" },
				{ provider: "anthropic", type: "oauth", email: "missing@example.test" },
			],
		),
	).toEqual([{ provider: "anthropic", type: "oauth", email: "missing@example.test" }]);
});
