import { afterEach, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { AsyncDrain, MAX_TIMER_DELAY_MS, sleepLong } from "./async";

function mockMonotonicScheduler(elapsedForWait: (delayMs: number) => number = delayMs => delayMs) {
	let now = 10_000;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		now += elapsedForWait(delayMs);
		options?.signal?.throwIfAborted();
	});
	return { elapsed: () => now - 10_000, wait };
}

afterEach(() => {
	vi.restoreAllMocks();
});

test("sleepLong waits past the native timer ceiling without arming an overflowing timer", async () => {
	const clock = mockMonotonicScheduler(delayMs => {
		if (delayMs > MAX_TIMER_DELAY_MS) throw new RangeError("timer overflow");
		return delayMs;
	});
	await sleepLong(MAX_TIMER_DELAY_MS + 1_000);
	expect(clock.elapsed()).toBe(MAX_TIMER_DELAY_MS + 1_000);
});

test("sleepLong re-arms after early wakes until the deadline", async () => {
	const clock = mockMonotonicScheduler(delayMs => Math.max(1, delayMs / 2));
	await sleepLong(60_000);
	expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
});

test("sleepLong propagates an abort during a chunked wait", async () => {
	const controller = new AbortController();
	mockMonotonicScheduler(delayMs => {
		controller.abort(new Error("cancelled"));
		return delayMs;
	});
	await expect(sleepLong(MAX_TIMER_DELAY_MS + 1_000, controller.signal)).rejects.toThrow("cancelled");
});

test("sleepLong rejects a pre-aborted sleep without arming a timer", async () => {
	const clock = mockMonotonicScheduler();
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	await expect(sleepLong(0, controller.signal)).rejects.toThrow("cancelled");
	expect(clock.wait).not.toHaveBeenCalled();
});

test("AsyncDrain flush persists the pending batch immediately and only once", async () => {
	vi.useFakeTimers();
	try {
		const batches: number[][] = [];
		const drain = new AsyncDrain<number>(100);
		const first = drain.push(1, values => {
			batches.push([...values]);
		});
		const second = drain.push(2, () => {
			throw new Error("a joined push must not replace the batch handler");
		});

		await Promise.all([first, second, drain.flush()]);
		expect(batches).toEqual([[1, 2]]);

		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(batches).toEqual([[1, 2]]);
	} finally {
		vi.useRealTimers();
	}
});
