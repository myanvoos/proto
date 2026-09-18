import { describe, expect, it } from "bun:test";
import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from "../types";
import { withEmptyCompletionRetry } from "./empty-completion-retry";
import { AssistantMessageEventStream } from "./event-stream";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function emptyMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

const EMPTY_CONTEXT: Context = { messages: [] };

describe("withEmptyCompletionRetry", () => {
	it("surfaces an abort during retry backoff instead of replaying the superseded empty completion", async () => {
		const controller = new AbortController();
		const message = emptyMessage();
		const stream = withEmptyCompletionRetry(
			"test-model",
			EMPTY_CONTEXT,
			{
				signal: controller.signal,
				providerRetryWait: async () => {
					controller.abort();
					controller.signal.throwIfAborted();
				},
			},
			() => {
				const attempt = new AssistantMessageEventStream();
				attempt.push({ type: "start", partial: message });
				attempt.push({ type: "done", reason: "stop", message });
				return attempt;
			},
		);

		const seen: AssistantMessageEvent[] = [];
		const iterationErrorPromise = (async (): Promise<unknown> => {
			try {
				for await (const event of stream) seen.push(event);
				return undefined;
			} catch (error) {
				return error;
			}
		})();
		const resultErrorPromise = stream.result().then(
			() => undefined,
			error => error,
		);

		const [iterationError, resultError] = await Promise.all([iterationErrorPromise, resultErrorPromise]);
		expect(iterationError).toBeInstanceOf(AIError.AbortError);
		expect(resultError).toBeInstanceOf(AIError.AbortError);
		expect(seen.some(event => event.type === "done")).toBe(false);
	});
});
