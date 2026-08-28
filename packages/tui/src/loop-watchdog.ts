import { performance } from "node:perf_hooks";
import { logger, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";

export interface LoopWatchdogOptions {
	intervalMs?: number;

	thresholdMs?: number;

	sleepMs?: number;

	now?: () => number;

	cpuNow?: () => number;

	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
}

interface LoopWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

const CPU_BUSY_RATIO = 0.01;

export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#sleepMs: number;
	#now: () => number;
	#cpuNow: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#expected = 0;
	#expectedCpu = 0;
	#wasBlocked = false;
	#running = false;

	#generation = 0;
	#handle: LoopWatchdogTimer | undefined;

	constructor(options: LoopWatchdogOptions = {}) {
		this.#intervalMs = options.intervalMs ?? 250;
		this.#thresholdMs = options.thresholdMs ?? 250;
		this.#sleepMs = options.sleepMs ?? 60_000;
		this.#now = options.now ?? (() => performance.now());
		this.#cpuNow =
			options.cpuNow ??
			(() => {
				const usage = process.cpuUsage();
				return (usage.user + usage.system) / 1000;
			});
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return { unref: () => timer.unref?.(), cancel: () => clearTimeout(timer) };
			});
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#wasBlocked = false;
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	#armTick(): void {
		const generation = this.#generation;
		this.#expected = this.#now() + this.#intervalMs;
		this.#expectedCpu = this.#cpuNow();
		this.#handle = this.#schedule(() => this.#tick(generation), this.#intervalMs);
		this.#handle.unref?.();
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const blockedMs = this.#now() - this.#expected;
		const cpuMs = this.#cpuNow() - this.#expectedCpu;

		const phase = takeRecentLoopPhase();
		if (blockedMs > this.#thresholdMs) {
			if (blockedMs > this.#sleepMs && cpuMs < blockedMs * CPU_BUSY_RATIO) {
				this.#wasBlocked = false;
			} else if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				logger.warn("ui.loop-blocked", {
					blockedMs: Math.round(blockedMs),
					cpuMs: Math.round(cpuMs),
					phase: phase ?? "unknown",
				});
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
