import { describe, expect, it } from "bun:test";
import { retryTransientCompletion } from "./oneshot-retry";
import type { AssistantMessage } from "./types";

function errorStop(errorStatus: number, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openrouter",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorStatus,
		errorMessage,
		timestamp: 0,
	};
}

describe("retryTransientCompletion", () => {
	it("does not resend a fixed oversized prompt when a gateway wraps the 413 in transient wording", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(errorStop(413, "Provider returned error: 413 Payload Too Large"));
			},
			{ baseDelayMs: 1, maxAttempts: 5 },
		);

		expect(calls).toBe(1);
		expect(final.errorMessage).toContain("413");
	});

	it("still retries a transient provider failure", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(errorStop(503, "Provider returned error: 503 Service Unavailable"));
			},
			{ baseDelayMs: 1, maxAttempts: 3 },
		);

		expect(calls).toBe(3);
		expect(final.stopReason).toBe("error");
	});
});
