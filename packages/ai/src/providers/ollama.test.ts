import { describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as AIError from "../error";
import type { AssistantMessage, Context, FetchImpl, ModelSpec } from "../types";
import { streamOllama } from "./ollama";

const model = buildModel({
	id: "ollama-stream-test",
	name: "Ollama Stream Test",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "https://ollama.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} satisfies ModelSpec<"ollama-chat">);

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function fetchForBody(body: string | Uint8Array | ReadableStream<Uint8Array>): FetchImpl {
	return Object.assign(async (): Promise<Response> => new Response(body), { preconnect: fetch.preconnect });
}

function fetchForChunks(chunks: readonly unknown[]): FetchImpl {
	const jsonl = `${chunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`;
	return fetchForBody(jsonl);
}

function streamChunks(chunks: readonly unknown[]) {
	return streamOllama(model, context, { apiKey: "test-key", fetch: fetchForChunks(chunks) });
}

async function runChunks(chunks: readonly unknown[]): Promise<AssistantMessage> {
	return streamChunks(chunks).result();
}

describe("Ollama stream termination", () => {
	it("rejects socket EOF without a done record", async () => {
		const result = await runChunks([{ message: { content: "partial" } }]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("done: true");
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("accepts a complete stream ending in done: true", async () => {
		const result = await runChunks([
			{ message: { content: "Hel" } },
			{ message: { content: "lo" } },
			{ done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage).toMatchObject({ input: 3, output: 2, totalTokens: 5 });
	});
});

describe("Ollama streamed tool calls", () => {
	it("coalesces argument fragments by the wire tool-call index", async () => {
		const stream = streamChunks([
			{
				message: {
					tool_calls: [
						{ function: { index: 0, name: "weather", arguments: '{"city":"' } },
						{ function: { index: 1, name: "search", arguments: { query: "proto" } } },
					],
				},
			},
			{
				message: {
					tool_calls: [
						{ function: { index: 0, name: "weather", arguments: 'Paris"}' } },
						{ function: { index: 1, name: "search", arguments: { limit: 5 } } },
					],
				},
			},
			{ done: true, done_reason: "tool_calls" },
		]);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const calls = result.content.filter(block => block.type === "toolCall");

		expect(result.stopReason).toBe("toolUse");
		expect(calls).toHaveLength(2);
		expect(calls.map(call => ({ name: call.name, arguments: call.arguments }))).toEqual([
			{ name: "weather", arguments: { city: "Paris" } },
			{ name: "search", arguments: { query: "proto", limit: 5 } },
		]);
		expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(2);
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(2);
	});
});

function delayedJsonlBody(
	initialChunks: readonly unknown[],
	delayedChunks: readonly unknown[],
): { body: ReadableStream<Uint8Array>; stalled: Promise<void> } {
	const { promise: stalled, resolve: resolveStalled } = Promise.withResolvers<void>();
	let timer: NodeJS.Timeout | undefined;
	const encode = (chunks: readonly unknown[]): Uint8Array =>
		new TextEncoder().encode(`${chunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`);
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				if (initialChunks.length > 0) controller.enqueue(encode(initialChunks));
			},
			pull(controller) {
				resolveStalled();
				timer ??= setTimeout(() => {
					controller.enqueue(encode(delayedChunks));
					controller.close();
				}, 80);
			},
			cancel() {
				if (timer !== undefined) clearTimeout(timer);
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, stalled };
}

describe("Ollama stream timeouts", () => {
	it("times out and aborts a response that sends headers but no JSONL record", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | null | undefined;
			const delayed = delayedJsonlBody([], [{ message: { content: "late" } }, { done: true, done_reason: "stop" }]);
			const fetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					requestSignal = init?.signal;
					return new Response(delayed.body);
				},
				{ preconnect: fetch.preconnect },
			);
			const resultPromise = streamOllama(model, context, {
				apiKey: "test-key",
				fetch: fetchImpl,
				streamFirstEventTimeoutMs: 10,
				streamIdleTimeoutMs: 10,
			}).result();
			await delayed.stalled;
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			const result = await resultPromise;

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("first JSONL record");
			expect(requestSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out and aborts after the first JSONL record stalls", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | null | undefined;
			const delayed = delayedJsonlBody([{ message: { content: "partial" } }], [{ done: true, done_reason: "stop" }]);
			const fetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					requestSignal = init?.signal;
					return new Response(delayed.body);
				},
				{ preconnect: fetch.preconnect },
			);
			const stream = streamOllama(model, context, {
				apiKey: "test-key",
				fetch: fetchImpl,
				streamFirstEventTimeoutMs: 10,
				streamIdleTimeoutMs: 10,
			});
			const resultPromise = stream.result();
			for (let attempt = 0; attempt < 20 && !stream.queue.some(event => event.type === "text_delta"); attempt++) {
				await Promise.resolve();
			}
			expect(stream.queue.some(event => event.type === "text_delta")).toBe(true);
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			const result = await resultPromise;

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("waiting for the next JSONL record");
			expect(requestSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
