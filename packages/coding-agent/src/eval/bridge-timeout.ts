import type { JsStatusEvent } from "./js/shared/types";

export const EVAL_TIMEOUT_PAUSE_OP = "timeout-pause";

export const EVAL_TIMEOUT_RESUME_OP = "timeout-resume";

export function isEvalTimeoutControlEvent(event: JsStatusEvent): boolean {
	return event.op === EVAL_TIMEOUT_PAUSE_OP || event.op === EVAL_TIMEOUT_RESUME_OP;
}

interface BridgeTimeoutPauseOptions {
	deferExternalAbort?: boolean;
}

export async function withBridgeTimeoutPause<T>(
	emitStatus: ((event: JsStatusEvent) => void) | undefined,
	operation: () => Promise<T>,
	options?: BridgeTimeoutPauseOptions,
): Promise<T> {
	if (!emitStatus) return operation();
	emitStatus(
		options?.deferExternalAbort
			? { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true }
			: { op: EVAL_TIMEOUT_PAUSE_OP },
	);
	try {
		return await operation();
	} finally {
		emitStatus(
			options?.deferExternalAbort
				? { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true }
				: { op: EVAL_TIMEOUT_RESUME_OP },
		);
	}
}
