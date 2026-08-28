import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS = 300_000;

const RACER_REMINT_INTERVAL = 1024;

function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

export function getStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS, fallbackMs);
}

export function getOpenAIStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_STREAM_IDLE_TIMEOUT_MS, fallbackMs);
}

export function getStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const fallback = idleTimeoutMs === undefined ? fallbackMs : Math.max(fallbackMs, idleTimeoutMs);
	return normalizeIdleTimeoutMs($env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS, fallback);
}

export function getOpenAIStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const openAIFirstEventRaw = $env.PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS;
	if (openAIFirstEventRaw !== undefined) {
		return normalizeIdleTimeoutMs(openAIFirstEventRaw, fallbackMs) ?? 0;
	}
	const base = normalizeIdleTimeoutMs($env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS, fallbackMs);
	if (base === undefined || base <= 0) return 0;
	if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return base;
	return Math.max(base, idleTimeoutMs);
}

export function armPreResponseTimeout(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
	if (timeoutMs === undefined || timeoutMs <= 0) return { signal: callerSignal, clear: () => {} };
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	}, timeoutMs);
	timer.unref?.();
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	return { signal, clear: () => clearTimeout(timer) };
}

export interface IdleTimeoutIteratorOptions {
	idleTimeoutMs?: number;
	firstItemTimeoutMs?: number;
	errorMessage: string;
	firstItemErrorMessage?: string;
	onIdle?: () => void;
	onFirstItemTimeout?: () => void;

	isProgressItem?: (item: unknown) => boolean;

	hasPendingLocalWork?: () => boolean;

	abortSignal?: AbortSignal;
}

export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
	const firstItemTimeoutMs = options.firstItemTimeoutMs ?? options.idleTimeoutMs;
	let firstItemDeadlineMs =
		firstItemTimeoutMs !== undefined && firstItemTimeoutMs > 0 ? Date.now() + firstItemTimeoutMs : undefined;
	const abortSignal = options.abortSignal;
	const iterator = iterable[Symbol.asyncIterator]();
	let iteratorClosed = false;

	const closeIterator = (): void => {
		if (iteratorClosed) return;
		iteratorClosed = true;
		const returnPromise = iterator.return?.();
		if (returnPromise) {
			void returnPromise.catch(() => {});
		}
	};

	if (abortSignal?.aborted) {
		closeIterator();
		throw abortReason(abortSignal);
	}

	const withRacy = <T>(promise: Promise<T>) =>
		promise.then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

	let awaitingFirstItem = true;
	const markFirstItemReceived = () => {
		awaitingFirstItem = false;
	};
	const isProgressItem = (item: T): boolean => {
		if (!options.isProgressItem) return true;
		try {
			return options.isProgressItem(item);
		} catch {
			return true;
		}
	};
	let lastProgressAt = Date.now();

	const hasPendingLocalWork = (): boolean => {
		if (!options.hasPendingLocalWork) return false;
		try {
			return options.hasPendingLocalWork();
		} catch {
			return false;
		}
	};

	const extendDeadlineForLocalWork = (): void => {
		if (awaitingFirstItem) {
			if (firstItemDeadlineMs !== undefined && firstItemTimeoutMs !== undefined) {
				firstItemDeadlineMs = Date.now() + firstItemTimeoutMs;
			}
		} else {
			lastProgressAt = Date.now();
		}
	};

	const noTimeoutEnforced =
		(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
		(options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0);

	let abortPromise: Promise<{ kind: "abort" }> | undefined;
	let abortListener: (() => void) | undefined;
	let resolveAbort: ((value: { kind: "abort" }) => void) | undefined;
	if (abortSignal) {
		const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
		resolveAbort = resolve;
		abortListener = () => resolveAbort?.({ kind: "abort" });
		abortSignal.addEventListener("abort", abortListener, { once: true });
		abortPromise = promise;
	}

	let timeoutPromise: Promise<{ kind: "timeout" }> | undefined;
	let resolveTimeout: ((value: { kind: "timeout" }) => void) | undefined;
	let timeoutFired = false;
	let timer: NodeJS.Timeout | undefined;
	let timerFireAtMs = Infinity;

	const currentDeadlineMs = (): number | undefined => {
		if (awaitingFirstItem) return firstItemDeadlineMs;
		if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
			return lastProgressAt + options.idleTimeoutMs;
		}
		return undefined;
	};
	const onTimerFire = (): void => {
		timer = undefined;
		timerFireAtMs = Infinity;
		const deadlineMs = currentDeadlineMs();
		if (deadlineMs === undefined) return;
		const remainingMs = deadlineMs - Date.now();
		if (remainingMs > 0) {
			timerFireAtMs = deadlineMs;
			timer = setTimeout(onTimerFire, remainingMs);
			return;
		}
		timeoutFired = true;
		resolveTimeout?.({ kind: "timeout" });
	};
	const armTimer = (deadlineMs: number): void => {
		if (timeoutPromise === undefined || timeoutFired) {
			const { promise, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
			timeoutPromise = promise;
			resolveTimeout = resolve;
			timeoutFired = false;
		}
		if (timer !== undefined) {
			if (timerFireAtMs <= deadlineMs) return;
			clearTimeout(timer);
		}
		timerFireAtMs = deadlineMs;
		timer = setTimeout(onTimerFire, Math.max(0, deadlineMs - Date.now()));
	};

	let pendingNext:
		| Promise<{ kind: "next"; result: IteratorResult<T> } | { kind: "error"; error: unknown }>
		| undefined;
	try {
		let raceCount = 0;
		while (true) {
			if (++raceCount % RACER_REMINT_INTERVAL === 0) {
				if (abortPromise !== undefined && !abortSignal!.aborted) {
					const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
					resolveAbort = resolve;
					abortPromise = promise;
				}
				if (timeoutPromise !== undefined && !timeoutFired) {
					const { promise, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
					resolveTimeout = resolve;
					timeoutPromise = promise;
				}
			}
			let activeTimeoutMs: number | undefined;
			if (awaitingFirstItem) {
				if (firstItemDeadlineMs !== undefined) {
					activeTimeoutMs = firstItemDeadlineMs - Date.now();
					if (activeTimeoutMs <= 0) {
						if (!hasPendingLocalWork()) {
							options.onFirstItemTimeout?.();
							closeIterator();
							throw new AIError.StreamTimeoutError(options.firstItemErrorMessage ?? options.errorMessage);
						}
						extendDeadlineForLocalWork();
						activeTimeoutMs = firstItemDeadlineMs! - Date.now();
					}
				}
			} else if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
				activeTimeoutMs = options.idleTimeoutMs - (Date.now() - lastProgressAt);
				if (activeTimeoutMs <= 0) {
					if (!hasPendingLocalWork()) {
						options.onIdle?.();
						closeIterator();
						throw new AIError.StreamTimeoutError(options.errorMessage);
					}
					extendDeadlineForLocalWork();
					activeTimeoutMs = options.idleTimeoutMs;
				}
			}

			pendingNext ??= withRacy(iterator.next());

			const racers: Array<
				Promise<
					| { kind: "next"; result: IteratorResult<T> }
					| { kind: "error"; error: unknown }
					| { kind: "timeout" }
					| { kind: "abort" }
				>
			> = [pendingNext];

			const enforceTimeout = !noTimeoutEnforced && activeTimeoutMs !== undefined && activeTimeoutMs > 0;
			if (enforceTimeout) {
				armTimer(Date.now() + activeTimeoutMs!);
				racers.push(timeoutPromise!);
			}
			if (abortPromise) {
				racers.push(abortPromise);
			}

			let continuing = false;
			try {
				const outcome = await Promise.race(racers);
				if (outcome.kind === "next" || outcome.kind === "error") {
					pendingNext = undefined;
				}
				if (outcome.kind === "abort") {
					closeIterator();
					throw abortReason(abortSignal!);
				}
				if (outcome.kind === "timeout") {
					if (hasPendingLocalWork()) {
						extendDeadlineForLocalWork();
						continuing = true;
						continue;
					}
					if (!awaitingFirstItem) {
						options.onIdle?.();
					} else {
						options.onFirstItemTimeout?.();
					}
					closeIterator();
					throw new AIError.StreamTimeoutError(
						!awaitingFirstItem ? options.errorMessage : (options.firstItemErrorMessage ?? options.errorMessage),
					);
				}
				if (outcome.kind === "error") {
					throw outcome.error;
				}
				if (outcome.result.done) {
					markFirstItemReceived();
					return;
				}
				const item = outcome.result.value;

				if (isProgressItem(item)) {
					markFirstItemReceived();
					lastProgressAt = Date.now();
				}
				yield item;
				continuing = true;
			} finally {
				if (!continuing) closeIterator();
			}
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);

		resolveTimeout?.({ kind: "timeout" });
		if (abortListener && abortSignal) {
			abortSignal.removeEventListener("abort", abortListener);
		}
		resolveAbort?.({ kind: "abort" });
	}
}

export interface TerminalGraceIteratorOptions {
	finishedAtMs: () => number | undefined;

	graceMs: number;

	onGraceEnd?: () => void;
}

export async function* iterateWithTerminalGrace<T>(
	iterable: AsyncIterable<T>,
	options: TerminalGraceIteratorOptions,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	try {
		while (true) {
			const finishedAtMs = options.finishedAtMs();
			if (finishedAtMs === undefined) {
				const result = await iterator.next();
				if (result.done) return;
				yield result.value;
				continue;
			}
			const remainingMs = finishedAtMs + options.graceMs - Date.now();
			if (remainingMs <= 0) {
				options.onGraceEnd?.();
				return;
			}
			const nextPromise = iterator.next();
			let timer: NodeJS.Timeout | undefined;
			const timeoutPromise = new Promise<"timeout">(resolve => {
				timer = setTimeout(() => resolve("timeout"), remainingMs);
			});
			try {
				const outcome = await Promise.race([nextPromise, timeoutPromise]);
				if (outcome === "timeout") {
					nextPromise.catch(() => {});
					options.onGraceEnd?.();
					return;
				}
				if (outcome.done) return;
				yield outcome.value;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}
	} finally {
		const returnPromise = iterator.return?.();
		if (returnPromise) {
			void Promise.resolve(returnPromise).catch(() => {});
		}
	}
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new AIError.AbortError(reason);
	return new AIError.AbortError();
}
