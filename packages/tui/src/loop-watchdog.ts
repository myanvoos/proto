import { performance } from "node:perf_hooks";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { takeRecentLoopPhase } from "@oh-my-pi/pi-utils/loop-phase";

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
	// When the most recent late tick ran: the moment a detected block ended.
	#stallEndedAt = Number.NEGATIVE_INFINITY;
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
		this.#stallEndedAt = Number.NEGATIVE_INFINITY;
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#stallEndedAt = Number.NEGATIVE_INFINITY;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	/**
	 * Whether the loop is blocked right now (the armed tick is more than
	 * `thresholdMs` overdue) or a detected block ended within the last
	 * `thresholdMs`. Input read at such a moment may be keystrokes the block
	 * batched into one read. Covers both orders in which a resumed loop can run
	 * the late tick and the queued stdin read. A suspended-process gap is not a
	 * stall, and a stopped watchdog never reports one.
	 */
	isStalled(): boolean {
		if (!this.#running) return false;
		const now = this.#now();
		if (now - this.#stallEndedAt <= this.#thresholdMs) return true;
		const overdueMs = now - this.#expected;
		return overdueMs > this.#thresholdMs && !this.#isSuspension(overdueMs, this.#cpuNow() - this.#expectedCpu);
	}

	/** A long gap the process spent negligible CPU on: it was suspended, not blocked. */
	#isSuspension(blockedMs: number, cpuMs: number): boolean {
		return blockedMs > this.#sleepMs && cpuMs < blockedMs * CPU_BUSY_RATIO;
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
		const now = this.#now();
		const blockedMs = now - this.#expected;
		const cpuMs = this.#cpuNow() - this.#expectedCpu;

		const phase = takeRecentLoopPhase();
		if (blockedMs > this.#thresholdMs) {
			if (this.#isSuspension(blockedMs, cpuMs)) {
				this.#wasBlocked = false;
			} else {
				this.#stallEndedAt = now;
				if (!this.#wasBlocked) {
					this.#wasBlocked = true;
					logger.warn("ui.loop-blocked", {
						blockedMs: Math.round(blockedMs),
						cpuMs: Math.round(cpuMs),
						phase: phase ?? "unknown",
					});
				}
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
