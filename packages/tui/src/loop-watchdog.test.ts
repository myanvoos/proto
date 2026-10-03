import { afterEach, expect, spyOn, test } from "bun:test";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { LoopWatchdog } from "./loop-watchdog";

function harness() {
	let now = 0;
	let cpu = 0;
	let tick: (() => void) | undefined;
	const watchdog = new LoopWatchdog({
		intervalMs: 250,
		thresholdMs: 250,
		sleepMs: 60_000,
		now: () => now,
		cpuNow: () => cpu,
		schedule: cb => {
			tick = cb;
			return {};
		},
	});
	return {
		watchdog,
		set(ms: number, cpuMs = ms) {
			now = ms;
			cpu = cpuMs;
		},
		fireTick() {
			tick?.();
		},
	};
}

let warn: { mockRestore(): void } | undefined;
afterEach(() => {
	warn?.mockRestore();
	warn = undefined;
});

test("isStalled reports a block while the tick is overdue and for thresholdMs after it runs late", () => {
	warn = spyOn(logger, "warn").mockImplementation(() => {});
	const { watchdog, set, fireTick } = harness();
	watchdog.start(); // deadline 250
	set(400); // 150 ms overdue: a busy frame, not a stall
	expect(watchdog.isStalled()).toBe(false);
	set(560); // 310 ms overdue and the tick has not run: blocked now
	expect(watchdog.isStalled()).toBe(true);

	fireTick(); // the late tick ends the block at 560 and re-arms for 810
	set(800);
	expect(watchdog.isStalled()).toBe(true);
	set(811);
	expect(watchdog.isStalled()).toBe(false);

	watchdog.stop();
	set(5_000);
	expect(watchdog.isStalled()).toBe(false);
});

test("isStalled does not report a suspend/resume gap as a stall", () => {
	const { watchdog, set, fireTick } = harness();
	watchdog.start();
	set(82_641, 3); // a wedge-sized gap with no CPU consumed
	expect(watchdog.isStalled()).toBe(false);
	fireTick();
	expect(watchdog.isStalled()).toBe(false);
	watchdog.stop();
});
