import { describe, expect, test } from "bun:test";
import { planAdvisorUsageLimitWait } from "./reviewer-transport";

// A regression here either bricks an advisor on a transient 429 until the session resets, or makes it sleep through a
// genuine multi-hour quota window instead of pausing.
const NOW = 1_000_000;
const RETRY = { enabled: true, baseDelayMs: 500, maxDelayMs: 5 * 60 * 1000, maxRetries: 10 };

describe("planAdvisorUsageLimitWait", () => {
	test("waits out a provider-timed block inside retry.maxDelayMs", () => {
		expect(planAdvisorUsageLimitWait({ blockedUntilMs: NOW + 50_000, retryAfterMs: 50_000 }, RETRY, 0, NOW)).toBe(
			50_000,
		);
	});

	test("floors an already-expired provider wait with the configured backoff", () => {
		const waitMs = planAdvisorUsageLimitWait(
			{ blockedUntilMs: NOW, retryAfterMs: 0 },
			{ ...RETRY, baseDelayMs: 1_000 },
			0,
			NOW,
		);
		// The shared backoff applies up to 25% downward jitter.
		expect(waitMs).toBeGreaterThanOrEqual(750);
		expect(waitMs).toBeLessThanOrEqual(1_000);
	});

	test("a complete usage report replaces a longer hintless heuristic block", () => {
		const timing = {
			blockedUntilMs: NOW + 60_000,
			requestedBlockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
		};
		expect(planAdvisorUsageLimitWait(timing, { ...RETRY, maxDelayMs: 30_000 }, 0, NOW)).toBe(10_000);
	});

	test("never wakes before a merged shared block longer than this call's own", () => {
		const timing = {
			blockedUntilMs: NOW + 90_000,
			requestedBlockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
		};
		expect(planAdvisorUsageLimitWait(timing, { ...RETRY, maxDelayMs: 120_000 }, 0, NOW)).toBe(90_000);
	});

	test("a prior provider-timed block outlasting the cap wins over a shorter report reset", () => {
		const timing = {
			blockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
			priorBlockedUntilMs: NOW + 40_000,
			priorBlockedUntilTimed: true,
		};
		expect(planAdvisorUsageLimitWait(timing, { ...RETRY, maxDelayMs: 30_000 }, 0, NOW)).toBeUndefined();
	});

	test("latches when the block outlasts retry.maxDelayMs", () => {
		const timing = { retryAfterMs: 30 * 60 * 1000, blockedUntilMs: NOW + 30 * 60 * 1000 };
		expect(planAdvisorUsageLimitWait(timing, RETRY, 0, NOW)).toBeUndefined();
	});

	test("maxRetries 0 latches immediately", () => {
		const timing = { blockedUntilMs: NOW + 50_000, retryAfterMs: 50_000 };
		expect(planAdvisorUsageLimitWait(timing, { ...RETRY, maxRetries: 0 }, 0, NOW)).toBeUndefined();
	});

	test("disabled retries latch immediately", () => {
		const timing = { blockedUntilMs: NOW + 50_000, retryAfterMs: 50_000 };
		expect(planAdvisorUsageLimitWait(timing, { ...RETRY, enabled: false }, 0, NOW)).toBeUndefined();
	});

	test("retries once a sibling frees, before the current credential unblocks", () => {
		const timing = { retryAtMs: NOW + 10_000, retryAfterMs: 40_000, blockedUntilMs: NOW + 40_000 };
		expect(planAdvisorUsageLimitWait(timing, RETRY, 0, NOW)).toBe(11_000);
	});

	test("a bare heuristic block with no sibling latches instead of retrying a dead credential", () => {
		expect(planAdvisorUsageLimitWait({ blockedUntilMs: NOW + 60_000 }, RETRY, 0, NOW)).toBeUndefined();
	});

	test("a sibling that frees soon still authorizes a wait over a bare heuristic block", () => {
		const timing = { blockedUntilMs: NOW + 60_000, retryAtMs: NOW + 5_000 };
		expect(planAdvisorUsageLimitWait(timing, RETRY, 0, NOW)).toBe(6_000);
	});
});
