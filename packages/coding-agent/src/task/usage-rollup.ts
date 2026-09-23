import type { Usage } from "@oh-my-pi/pi-ai";
import type { SubagentUsageTotals } from "../session/session-entries";
import type { ToolSession } from "../tools";
import type { SingleResult } from "./types";

export interface SubagentUsageAttribution {
	agentId: string;

	agent?: string;

	label?: string;

	/** Worker turn this run settled, for persistent workers. */
	turn?: number;

	/** Nested spend already attributed to this agent by earlier runs of the same session. */
	nestedBaseline?: SubagentUsageTotals;
}

interface NestedDelta {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

function nestedDelta(nested: SubagentUsageTotals | undefined, baseline: SubagentUsageTotals | undefined): NestedDelta {
	return {
		input: Math.max(0, (nested?.input ?? 0) - (baseline?.input ?? 0)),
		output: Math.max(0, (nested?.output ?? 0) - (baseline?.output ?? 0)),
		cacheRead: Math.max(0, (nested?.cacheRead ?? 0) - (baseline?.cacheRead ?? 0)),
		cacheWrite: Math.max(0, (nested?.cacheWrite ?? 0) - (baseline?.cacheWrite ?? 0)),
		totalTokens: Math.max(0, (nested?.totalTokens ?? 0) - (baseline?.totalTokens ?? 0)),
		cost: Math.max(0, (nested?.cost ?? 0) - (baseline?.cost ?? 0)),
	};
}

/**
 * Spend an owning session must account for after one subagent run: the run itself, plus whatever the
 * subagent's own subagents spent since the last run was attributed. Without the nested part, spend
 * deeper than one level would be billed to no session at all.
 */
export function subagentRunUsage(result: SingleResult, baseline?: SubagentUsageTotals): Usage | undefined {
	const own = result.usage;
	const nested = nestedDelta(result.subagentUsage, baseline);
	const hasNested = nested.totalTokens > 0 || nested.cost > 0 || nested.input > 0 || nested.output > 0;
	if (!own && !hasNested) return undefined;
	return {
		input: (own?.input ?? 0) + nested.input,
		output: (own?.output ?? 0) + nested.output,
		cacheRead: (own?.cacheRead ?? 0) + nested.cacheRead,
		cacheWrite: (own?.cacheWrite ?? 0) + nested.cacheWrite,
		totalTokens: (own?.totalTokens ?? 0) + nested.totalTokens,
		...(own?.premiumRequests !== undefined ? { premiumRequests: own.premiumRequests } : {}),
		cost: {
			input: own?.cost.input ?? 0,
			output: own?.cost.output ?? 0,
			cacheRead: own?.cost.cacheRead ?? 0,
			cacheWrite: own?.cost.cacheWrite ?? 0,
			total: (own?.cost.total ?? 0) + nested.cost,
		},
	};
}

/**
 * Attributes a settled subagent run to the session that owns it. Returns the nested baseline the
 * caller must carry into the agent's next run, so a long-lived worker never re-bills nested spend.
 */
export function recordSubagentRun(
	session: Pick<ToolSession, "sessionManager">,
	result: SingleResult,
	attribution: SubagentUsageAttribution,
): SubagentUsageTotals | undefined {
	const usage = subagentRunUsage(result, attribution.nestedBaseline);
	if (usage) {
		session.sessionManager?.recordSubagentUsage({
			agentId: attribution.agentId,
			...(attribution.agent ? { agent: attribution.agent } : {}),
			...(attribution.label ? { label: attribution.label } : {}),
			...(attribution.turn !== undefined ? { turn: attribution.turn } : {}),
			usage,
		});
	}
	return result.subagentUsage ?? attribution.nestedBaseline;
}
