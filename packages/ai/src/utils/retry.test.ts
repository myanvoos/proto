import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { callWithCopilotModelRetry } from "./retry";

afterEach(() => vi.restoreAllMocks());

function transientModelError(): Error {
	return Object.assign(new Error("model_not_supported"), {
		status: 400,
		code: "model_not_supported",
	});
}

function retryableErrorWithRetryAfter(retryAfterMs: number): Error {
	return Object.assign(new Error("service unavailable"), {
		status: 503,
		headers: new Headers({ "retry-after-ms": String(retryAfterMs) }),
	});
}

describe("callWithCopilotModelRetry", () => {
	it("uses an injectable jitter source instead of a fixed retry cadence", async () => {
		const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const randomValues = [0.25, 0.75];
		let calls = 0;

		const result = await callWithCopilotModelRetry(
			async () => {
				if (calls++ < 2) throw transientModelError();
				return "ok";
			},
			{
				provider: "github-copilot",
				retryBaseDelayMs: 100,
				rng: () => randomValues.shift() ?? 0,
			},
		);

		expect(result).toBe("ok");
		expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([25, 75]);
	});

	it("never jitters a Retry-After delay below the provider's minimum", async () => {
		const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let calls = 0;

		const result = await callWithCopilotModelRetry(
			async () => {
				if (calls++ === 0) throw retryableErrorWithRetryAfter(800);
				return "ok";
			},
			{ provider: "github-copilot", retryBaseDelayMs: 100, rng: () => 0 },
		);

		expect(result).toBe("ok");
		expect(wait).toHaveBeenCalledTimes(1);
		expect(wait.mock.calls[0]?.[0]).toBe(800);
	});
});
