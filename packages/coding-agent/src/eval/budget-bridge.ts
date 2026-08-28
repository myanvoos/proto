import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

export const EVAL_BUDGET_BRIDGE_NAME = "__budget__";

interface EvalBudgetBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalBudgetResult {
	total: number | null;
	spent: number;

	hard: boolean;
}

export async function runEvalBudget(_args: unknown, options: EvalBudgetBridgeOptions): Promise<EvalBudgetResult> {
	const turn = options.session.getTurnBudget?.();
	if (turn && turn.total !== null) {
		return { total: turn.total, spent: turn.spent, hard: turn.hard };
	}
	const goal = options.session.getGoalModeState?.();
	if (goal?.enabled && goal.goal) {
		return {
			total: goal.goal.tokenBudget ?? null,
			spent: goal.goal.tokensUsed ?? 0,
			hard: goal.goal.tokenBudget != null,
		};
	}
	const spent = turn?.spent ?? options.session.getUsageStatistics?.()?.output ?? 0;
	return { total: null, spent, hard: false };
}
