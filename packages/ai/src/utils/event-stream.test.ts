import { afterEach, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { registerCustomApi, unregisterCustomApis } from "../api-registry";
import { complete } from "../stream";
import type { AssistantMessage, Usage } from "../types";
import { AssistantMessageEventStream, EventStream } from "./event-stream";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const CUSTOM_API = "event-stream-result-only-test";
const CUSTOM_API_SOURCE = "event-stream.test";
const MODEL: Model = {
	id: "test-model",
	name: "Test model",
	api: CUSTOM_API,
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
	compat: undefined,
};

function finalMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "finished" }],
		api: CUSTOM_API,
		provider: "openai",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

afterEach(() => unregisterCustomApis(CUSTOM_API_SOURCE));

describe("EventStream", () => {
	it("keeps every event in order when result() observes completion before iteration", async () => {
		const expected = Array.from({ length: 4_097 }, (_, index) => index);
		const stream = new EventStream<number, number>(
			event => event === 4_096,
			event => event,
		);
		const resultPromise = stream.result();

		for (const event of expected) stream.push(event);

		expect(await resultPromise).toBe(4_096);
		const received: number[] = [];
		for await (const event of stream) received.push(event);
		expect(received).toEqual(expected);
	});

	it("delivers live events to an active iterator without reordering or loss", async () => {
		const expected = Array.from({ length: 100 }, (_, index) => index);
		const stream = new EventStream<number, number>(
			event => event === 99,
			event => event,
		);
		const receivedPromise = (async () => {
			const received: number[] = [];
			for await (const event of stream) received.push(event);
			return received;
		})();
		await Promise.resolve();

		for (const event of expected) stream.push(event);

		expect(await stream.result()).toBe(99);
		expect(await receivedPromise).toEqual(expected);
	});

	it("does not retain events when only the terminal result is requested", async () => {
		const stream = new EventStream<number, number>(
			event => event === 20_000,
			event => event,
		);
		for (let event = 0; event < 100; event++) stream.push(event);
		const resultPromise = stream.resultOnly();

		for (let event = 100; event <= 20_000; event++) stream.push(event);

		expect(await resultPromise).toBe(20_000);
		expect(stream.queue).toHaveLength(0);
	});

	it("complete() returns the custom provider's identical terminal message", async () => {
		const terminal = finalMessage();
		registerCustomApi(
			CUSTOM_API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: terminal });
					stream.push({ type: "text_start", contentIndex: 0, partial: terminal });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "finished", partial: terminal });
					stream.push({ type: "text_end", contentIndex: 0, content: "finished", partial: terminal });
					stream.push({ type: "done", reason: "stop", message: terminal });
				});
				return stream;
			},
			CUSTOM_API_SOURCE,
		);

		expect(await complete(MODEL, { messages: [] })).toEqual(terminal);
	});
});
