import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

export const EVAL_CONCURRENCY_BRIDGE_NAME = "__concurrency__";

interface EvalConcurrencyBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalConcurrencyResult {
	limit: number;
}

export function runEvalConcurrency(_args: unknown, options: EvalConcurrencyBridgeOptions): EvalConcurrencyResult {
	const raw = options.session.settings.get("orchestrator.maxConcurrency");
	const limit = Number.isFinite(raw) ? Math.trunc(raw) : 0;
	return { limit: limit > 0 ? limit : 0 };
}
