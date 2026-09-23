import { describe, expect, it } from "bun:test";
import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from "../types";
import { withReplaySafeStreamRetry } from "./empty-completion-retry";
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
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason: "stop",
		timestamp: 0,
	};
}

const EMPTY_CONTEXT: Context = { messages: [] };
const SOCKET_CLOSED = "The socket connection was closed unexpectedly";

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

function textAttempt(text: string): AssistantMessageEventStream {
	const message = emptyMessage();
	message.content = [{ type: "text", text }];
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: text, partial: message },
		{ type: "text_end", contentIndex: 0, content: text, partial: message },
		{ type: "done", reason: "stop", message },
	]);
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("withReplaySafeStreamRetry", () => {
	it("surfaces an abort during retry backoff instead of replaying the superseded empty completion", async () => {
		const controller = new AbortController();
		const message = emptyMessage();
		const stream = withReplaySafeStreamRetry(
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
			{ retryEmptyCompletion: true },
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

	it("settles the outer stream when the attempt factory throws synchronously", async () => {
		const configError = new Error("explicit prompt caching is unsupported");
		const stream = withReplaySafeStreamRetry(
			"test-model",
			EMPTY_CONTEXT,
			{ providerRetryWait: async () => {} },
			() => {
				throw configError;
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		await expect(stream.result()).rejects.toBe(configError);
	});

	it("retries a transient provider error before output commits, without leaking the failed attempt", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			"test-model",
			EMPTY_CONTEXT,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				if (attempts > 1) return textAttempt("hello");
				const message = emptyMessage();
				message.stopReason = "error";
				message.errorMessage = SOCKET_CLOSED;
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "toolcall_start", contentIndex: 0, partial: message },
					{ type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
					{
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
						partial: message,
					},
					{ type: "error", reason: "error", error: message },
				]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(events.some(event => event.type === "toolcall_start" || event.type === "toolcall_end")).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("does not retry a provider error once a tool-call argument delta committed the attempt", async () => {
		let attempts = 0;
		const message = emptyMessage();
		message.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }];
		message.stopReason = "error";
		message.errorMessage = SOCKET_CLOSED;
		const stream = withReplaySafeStreamRetry(
			"test-model",
			EMPTY_CONTEXT,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "toolcall_start", contentIndex: 0, partial: message },
					{ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message },
					{
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
						partial: message,
					},
					{ type: "error", reason: "error", error: message },
				]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);

		expect(attempts).toBe(1);
		expect(events.some(event => event.type === "toolcall_end")).toBe(true);
		expect(events.at(-1)?.type).toBe("error");
	});
});
