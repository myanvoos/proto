import { expect, test } from "bun:test";
import type { OAuthAccountSummary, ResetCreditAccountStatus, UsageReport } from "@oh-my-pi/pi-ai";
import { claudeResetStatusesFromReports, planClaudeResetRedemptions } from "./claude-auto-reset";
import { overlayLiveResetCredits, planCodexResetRedemptions } from "./codex-auto-reset";

const now = 1_700_000_040_000;
const hour = 3_600_000;
const state = {
	attemptedKeys: new Set<string>(),
	deferredUntilByKey: new Map<string, number>(),
	lastAttemptAtByAccount: new Map<string, number>(),
};
const settings = { enabled: true, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 0 };
const account: OAuthAccountSummary = { position: 0, credentialId: 1, email: "user@example.com", active: true };
function report(orgId = "org"): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: now,
		metadata: { email: account.email, orgId },
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", shared: true, windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * hour, resetsAt: now + 2 * hour },
				amount: { usedFraction: 1, unit: "percent" },
			},
		],
		resetCredits: {
			eligible: true,
			availableCount: 1,
			redeemableCount: 1,
			nextCreditId: "grant",
			credits: [
				{
					id: "grant",
					program: "juniper_tide",
					usable: true,
					remainingCount: 1,
					requiresLimit: true,
					clears: ["anthropic:5h"],
					blocking: ["anthropic:5h"],
					expiresAt: new Date(now + hour).toISOString(),
				},
			],
		},
	};
}

test("Claude discovery binds a missing stored organization only to one unclaimed matching inventory", () => {
	const statuses = claudeResetStatusesFromReports([account], [report()]);
	expect(statuses[0]?.orgId).toBe("org");
	const plan = planClaudeResetRedemptions({
		...state,
		nowMs: now,
		trigger: "blocked",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		settings,
		reports: [report()],
		statuses,
	});
	expect(plan.actions[0]?.target, JSON.stringify(plan)).toMatchObject({
		credentialId: 1,
		creditId: "grant",
		orgId: "org",
	});
});

test("Claude discovery does not steal another stored account's inventory or guess between organizations", () => {
	const stored = { ...account, credentialId: 2, orgId: "org" };
	expect(claudeResetStatusesFromReports([account, stored], [report()])[0]?.error).toBeDefined();
	expect(claudeResetStatusesFromReports([account], [report("a"), report("b")])[0]?.error).toBeDefined();
});

test("blocked Claude recovery cannot spend a credential the visible pool excludes", () => {
	const statuses = claudeResetStatusesFromReports([account], [report()]);
	const plan = planClaudeResetRedemptions({
		...state,
		nowMs: now,
		trigger: "blocked",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		settings,
		reports: [report()],
		statuses,
		permitsCredential: () => false,
	});
	expect(plan.actions).toEqual([]);
	expect(plan.skipped).toContainEqual({
		accountKey: "anthropic|org|user@example.com",
		rule: "blocked-account",
		reason: "outside-account-pool",
	});
});

test("blocked Codex recovery cannot spend an excluded stored credential even with a fresh exhausted report", () => {
	const report: UsageReport = {
		provider: "openai-codex",
		fetchedAt: now,
		metadata: { accountId: "account", resetCreditCredentialId: 1, limitReached: true },
		resetCredits: { availableCount: 1 },
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * hour, resetsAt: now + 2 * hour },
				amount: { usedFraction: 1, unit: "percent" },
			},
		],
	};
	const input = {
		...state,
		nowMs: now,
		trigger: "blocked" as const,
		provider: "openai-codex",
		modelId: "gpt-4.1",
		settings,
		identity: { accountId: "account" },
		reports: [report],
	};
	expect(planCodexResetRedemptions(input).actions).toHaveLength(1);
	const denied = planCodexResetRedemptions({ ...input, permitsCredential: () => false });
	expect(denied.actions).toEqual([]);
	expect(denied.skipped.some(row => row.reason === "outside-account-pool")).toBe(true);
});

test("Codex salvage pins the exact soonest-expiring live credit instead of authorizing a replacement", () => {
	const report: UsageReport = {
		provider: "openai-codex",
		fetchedAt: now,
		metadata: { accountId: "account" },
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex" },
				window: { id: "5h", label: "5 Hour" },
				amount: { usedFraction: 0.5, unit: "percent" },
			},
		],
	};
	const status: ResetCreditAccountStatus = {
		provider: "openai-codex",
		credentialId: 1,
		accountId: "account",
		active: true,
		availableCount: 2,
		credits: [
			{ id: "later", expiresAt: new Date(now + 5 * hour).toISOString() },
			{ id: "soon", expiresAt: new Date(now + hour).toISOString() },
		],
	};
	const reports = overlayLiveResetCredits([report], [status]);
	const plan = planCodexResetRedemptions({
		...state,
		nowMs: now,
		trigger: "sweep",
		provider: "openai-codex",
		modelId: "gpt-4.1",
		settings: { ...settings, salvageHorizonMs: 2 * hour },
		reports,
		identity: undefined,
	});
	expect(plan.actions.map(action => action.target.creditId)).toEqual(["soon"]);
});
