import { expect, spyOn, test } from "bun:test";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import { emptyUsageStatistics } from "../../../session/session-entries";
import { initThemeSync } from "../../theme/theme";
import { SEGMENTS } from "./segments";

initThemeSync();

type UsageOverrides = Partial<Omit<ReturnType<typeof emptyUsageStatistics>, "subagent">> & {
	subagent?: Partial<ReturnType<typeof emptyUsageStatistics>["subagent"]>;
};

function renderSpendSegment(id: "cost" | "token_total", usage: UsageOverrides, modelCost?: ModelCost): string {
	const base = emptyUsageStatistics();
	const usageStats = {
		...base,
		...usage,
		subagent: { ...base.subagent, ...usage.subagent },
		tokensPerSecond: null,
	};
	const rendered = SEGMENTS[id].render({
		session: {
			state: modelCost ? { model: { cost: modelCost } } : {},
			modelRegistry: { isUsingOAuth: () => false },
		},
		usageStats,
		width: 120,
		options: {},
		compactThinkingLevel: false,
		prewalk: null,
		activeRepo: null,
	} as never);
	return Bun.stripANSI(rendered.content);
}

test("session cost includes the spend of the subagents the session owns", () => {
	const ownOnly = renderSpendSegment("cost", { cost: 0.2 });
	expect(ownOnly).toBe("$0.20");

	const withWorkers = renderSpendSegment("cost", { cost: 0.2, subagent: { cost: 0.16, runs: 2, agents: 2 } });
	expect(withWorkers).toBe("$0.36");
});

test("subagent spend alone still reports a cost", () => {
	const content = renderSpendSegment("cost", { subagent: { cost: 0.08, runs: 1, agents: 1 } });
	expect(content).toBe("$0.08");
});

test("token total counts subagent tokens", () => {
	const content = renderSpendSegment("token_total", {
		input: 1000,
		output: 200,
		subagent: { input: 2000, output: 400, runs: 2, agents: 2 },
	});
	expect(content).toContain("3.6K");
});

test("scheduled pricing marks the active model's current tariff, even before any spend", () => {
	const scheduled: ModelCost = {
		input: 0.3,
		output: 1.2,
		cacheRead: 0,
		cacheWrite: 0,
		timeBased: {
			offPeakMultiplier: 0.5,
			peakWindows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 }],
		},
	};
	const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-10T02:00:00Z"));
	try {
		expect(renderSpendSegment("cost", {}, scheduled)).toBe("$0.00 ↑");
		clock.mockReturnValue(Date.parse("2026-09-10T05:00:00Z"));
		expect(renderSpendSegment("cost", { cost: 0.2 }, scheduled)).toBe("$0.20 ↓");
		const { timeBased: _schedule, ...flat } = scheduled;
		expect(renderSpendSegment("cost", { cost: 0.2 }, flat)).toBe("$0.20");
	} finally {
		clock.mockRestore();
	}
});
