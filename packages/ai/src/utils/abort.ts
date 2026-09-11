import * as AIError from "../error";

export interface AbortSourceTracker {
	requestAbortController: AbortController;
	requestSignal: AbortSignal;
	abortLocally(reason: Error): Error;
	getLocalAbortReason(): Error | undefined;
	wasCallerAbort(): boolean;
}

export function createAbortSourceTracker(callerSignal?: AbortSignal): AbortSourceTracker {
	const requestAbortController = new AbortController();
	const requestSignal = callerSignal
		? AbortSignal.any([callerSignal, requestAbortController.signal])
		: requestAbortController.signal;
	let localAbortReason: Error | undefined;

	return {
		requestAbortController,
		requestSignal,
		abortLocally(reason) {
			localAbortReason = reason;
			requestAbortController.abort(reason);
			return reason;
		},
		getLocalAbortReason() {
			if (!localAbortReason || callerSignal?.aborted) return undefined;
			return requestSignal.reason === localAbortReason ? localAbortReason : undefined;
		},
		wasCallerAbort() {
			return callerSignal?.aborted === true;
		},
	};
}

export function raceWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	createAbortError: () => unknown = () => signal?.reason ?? new AIError.AbortError(),
	onCleanup?: () => void,
): Promise<T> {
	if (!signal) return onCleanup ? promise.finally(onCleanup) : promise;
	if (signal.aborted) {
		onCleanup?.();
		return Promise.reject(createAbortError());
	}
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(createAbortError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted]).finally(() => {
		signal.removeEventListener("abort", onAbort);
		onCleanup?.();
	});
}
