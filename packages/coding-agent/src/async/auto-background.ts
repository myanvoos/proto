export const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;

export function formatBackgroundNotice(jobId: string): string {
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}

export function resolveAutoBackgroundWaitMs(thresholdMs: number, timeoutMs: number | undefined): number {
	if (thresholdMs <= 0) return 0;
	if (timeoutMs === undefined) return thresholdMs;
	const timeoutBufferMs = 1_000;
	return Math.max(0, Math.min(thresholdMs, timeoutMs - timeoutBufferMs));
}

type JobWaitInterrupt = { kind: "running" } | { kind: "steer" } | { kind: "aborted" };

export async function raceJobSettlement<C>(
	completion: Promise<C>,
	thresholdMs: number,
	signal?: AbortSignal,
	steeringSignal?: AbortSignal,
): Promise<C | JobWaitInterrupt> {
	if (signal?.aborted) {
		return { kind: "aborted" };
	}
	if (steeringSignal?.aborted) {
		return { kind: "steer" };
	}

	const { promise: thresholdPromise, resolve: resolveThreshold } = Promise.withResolvers<{ kind: "running" }>();
	const thresholdTimer = setTimeout(() => resolveThreshold({ kind: "running" }), thresholdMs);
	const waiters: Array<Promise<C | JobWaitInterrupt>> = [completion, thresholdPromise];

	const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
	const onAbort = () => resolveAborted({ kind: "aborted" });
	const { promise: steerPromise, resolve: resolveSteer } = Promise.withResolvers<{ kind: "steer" }>();
	const onSteer = () => resolveSteer({ kind: "steer" });
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
		waiters.push(abortedPromise);
	}
	if (steeringSignal) {
		steeringSignal.addEventListener("abort", onSteer, { once: true });
		waiters.push(steerPromise);
	}
	try {
		return await Promise.race(waiters);
	} finally {
		clearTimeout(thresholdTimer);
		signal?.removeEventListener("abort", onAbort);
		steeringSignal?.removeEventListener("abort", onSteer);
	}
}
