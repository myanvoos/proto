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
