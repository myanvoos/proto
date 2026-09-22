import { expect, test } from "bun:test";
import { emptyUsageStatistics } from "../../../session/session-entries";
import { initThemeSync } from "../../theme/theme";
import { SEGMENTS } from "./segments";

initThemeSync();

type UsageOverrides = Partial<Omit<ReturnType<typeof emptyUsageStatistics>, "subagent">> & {
	subagent?: Partial<ReturnType<typeof emptyUsageStatistics>["subagent"]>;
};

function renderSpendSegment(id: "cost" | "token_total", usage: UsageOverrides): string {
	const base = emptyUsageStatistics();
	const usageStats = {
		...base,
		...usage,
		subagent: { ...base.subagent, ...usage.subagent },
		tokensPerSecond: null,
	};
	const rendered = SEGMENTS[id].render({
		session: { state: {}, modelRegistry: { isUsingOAuth: () => false } },
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
