import { expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { initThemeSync, theme } from "../theme/theme";
import { renderUsageReports } from "./command-controller";

initThemeSync();

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const report: UsageReport = {
	provider: "anthropic",
	fetchedAt: 1_000,
	limits: [
		{
			id: "five-hour",
			label: "5-hour",
			scope: { provider: "anthropic", windowId: "five-hour" },
			window: { id: "five-hour", label: "5h" },
			amount: { unit: "requests", usedFraction: 0.25 },
		},
	],
};

// The per-model list used to print one row per selector (40+ rows for anthropic) and
// pushed the quota bars off screen; /usage now summarises them on one line.
test("usage report summarises reporting models on a single line", () => {
	const selectors = Array.from({ length: 6 }, (_value, index) => `anthropic/claude-model-${index}`);
	const output = renderUsageReports([report], theme, 2_000, 80, undefined, selectors);
	const lines = output.split("\n").map(strip);
	const modelLines = lines.filter(line => line.includes("Models with usage data"));
	expect(modelLines).toHaveLength(1);
	expect(modelLines[0]).toBe("  Models with usage data: 6 claude-model-0, claude-model-1, claude-model-2, …");
	expect(lines.some(line => line.includes("anthropic/"))).toBe(false);
	expect(lines.some(line => line.includes("5-hour"))).toBe(true);
});

test("usage report lists every reporting model without an ellipsis when there are three or fewer", () => {
	const output = renderUsageReports([report], theme, 2_000, 80, undefined, [
		"anthropic/claude-a",
		"anthropic/claude-b",
		"openai/gpt-x",
	]);
	const line = output
		.split("\n")
		.map(strip)
		.find(text => text.includes("Models with usage data"));
	expect(line).toBe("  Models with usage data: 2 claude-a, claude-b");
});

test("usage report model summary is truncated to the available width", () => {
	const selectors = Array.from({ length: 3 }, (_value, index) => `anthropic/${"long-model-id-".repeat(4)}${index}`);
	const output = renderUsageReports([report], theme, 2_000, 48, undefined, selectors);
	const line = output.split("\n").find(text => strip(text).includes("Models with usage data"));
	expect(line).toBeDefined();
	expect(Bun.stringWidth(strip(line!))).toBeLessThanOrEqual(48);
	expect(strip(line!)).toContain("…");
});

function creditBalanceReport(balance: number, shared: boolean): UsageReport {
	return {
		provider: "charm-hyper",
		fetchedAt: 1_000,
		limits: [
			{
				id: "charm-hyper:credits",
				label: "Credit balance",
				scope: { provider: "charm-hyper", windowId: "balance", shared },
				amount: { remaining: balance, unit: "credits" },
			},
		],
	};
}

// An account-wide balance is observed once per stored key; the two probes race a moving balance,
// so both orders must collapse to the same pool instead of summing it.
test("usage report collapses a shared prepaid balance seen through several keys", () => {
	for (const reports of [
		[creditBalanceReport(95, true), creditBalanceReport(94.5, true)],
		[creditBalanceReport(94.5, true), creditBalanceReport(95, true)],
	]) {
		const output = strip(renderUsageReports(reports, theme, 2_000, 100));
		expect(output).toContain("95 credits left");
		expect(output).not.toContain("189.5");
	}
});

test("usage report sums distinct prepaid balances", () => {
	const output = strip(
		renderUsageReports([creditBalanceReport(95, false), creditBalanceReport(94.5, false)], theme, 2_000, 100),
	);
	expect(output).toContain("189.5 credits left");
});

test("usage report shows one row for a quota shared by several model-family counters", () => {
	const shared = (counterKey: string) => ({
		id: `google-antigravity:${counterKey}:default:3p-weekly`,
		label: "Claude & GPT (shared)",
		scope: { provider: "google-antigravity", windowId: "7d", shared: true, sharedGroup: "3p-weekly:7d" },
		window: { id: "7d", label: "7d" },
		amount: { unit: "percent" as const, usedFraction: 0.4 },
	});
	const output = renderUsageReports(
		[{ provider: "google-antigravity", fetchedAt: 1_000, limits: [shared("anthropic"), shared("openai")] }],
		theme,
		2_000,
		80,
	);
	// Without collapsing, the second routing copy renders as a phantom "account 2".
	const text = strip(output);
	expect(text).toContain("account 1");
	expect(text).not.toContain("account 2");
});
