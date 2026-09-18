import { describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as AIError from "../error";
import type { AssistantMessage, Context, FetchImpl, ModelSpec } from "../types";
import { streamBedrock } from "./amazon-bedrock";
import { crc32 } from "./aws-eventstream";

const model = buildModel({
	id: "anthropic.claude-test",
	name: "Bedrock Stream Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} satisfies ModelSpec<"bedrock-converse-stream">);

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const encoder = new TextEncoder();

function stringHeader(name: string, value: string): Buffer {
	const nameBytes = encoder.encode(name);
	const valueBytes = encoder.encode(value);
	const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	header[0] = nameBytes.length;
	header.set(nameBytes, 1);
	header[1 + nameBytes.length] = 7;
	header.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
	header.set(valueBytes, 4 + nameBytes.length);
	return header;
}

function eventFrame(eventType: string, payload: unknown = {}): Buffer {
	const payloadBytes =
		payload instanceof Uint8Array
			? payload
			: encoder.encode(typeof payload === "string" ? payload : JSON.stringify(payload));
	const headers = Buffer.concat([stringHeader(":message-type", "event"), stringHeader(":event-type", eventType)]);
	const totalLength = 16 + headers.length + payloadBytes.length;
	const frame = Buffer.alloc(totalLength);
	frame.writeUInt32BE(totalLength, 0);
	frame.writeUInt32BE(headers.length, 4);
	frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
	frame.set(headers, 12);
	frame.set(payloadBytes, 12 + headers.length);
	frame.writeUInt32BE(crc32(frame.subarray(0, totalLength - 4)), totalLength - 4);
	return frame;
}

function fetchForBody(body: Uint8Array): FetchImpl {
	return Object.assign(async (): Promise<Response> => new Response(body), { preconnect: fetch.preconnect });
}

async function runFrames(frames: readonly Uint8Array[]): Promise<AssistantMessage> {
	return streamBedrock(model, context, {
		bearerToken: "test-token",
		fetch: fetchForBody(Buffer.concat(frames)),
	}).result();
}

function completeFrames(text = "Hello"): Buffer[] {
	return [
		eventFrame("messageStart", { role: "assistant" }),
		eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }),
		eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
		eventFrame("messageStop", { stopReason: "end_turn" }),
	];
}

function stallingEventBody(initialFrames: readonly Uint8Array[]): {
	body: ReadableStream<Uint8Array>;
	stalled: Promise<void>;
	abort: (reason: unknown) => void;
} {
	const { promise: stalled, resolve: resolveStalled } = Promise.withResolvers<void>();
	const { promise: releasePull, resolve: resolvePull } = Promise.withResolvers<void>();
	let abortStream: (reason: unknown) => void = () => {};
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abortStream = reason => controller.error(reason);
				if (initialFrames.length > 0) controller.enqueue(Buffer.concat(initialFrames));
			},
			pull() {
				resolveStalled();
				return releasePull;
			},
			cancel() {
				resolvePull();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		body,
		stalled,
		abort: reason => {
			resolvePull();
			try {
				abortStream(reason);
			} catch {}
		},
	};
}

describe("Bedrock stream integrity", () => {
	it("rejects EOF without messageStop instead of returning truncated content", async () => {
		const result = await runFrames([
			eventFrame("messageStart", { role: "assistant" }),
			eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }),
		]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("messageStop");
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("rejects EOF without messageStart", async () => {
		const result = await runFrames([eventFrame("messageStop", { stopReason: "end_turn" })]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("messageStart");
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("rejects malformed nonempty JSON payloads and names the event type", async () => {
		const result = await runFrames([
			eventFrame("messageStart", { role: "assistant" }),
			eventFrame("contentBlockDelta", encoder.encode('{"contentBlockIndex":0,"delta":{"text":"lost"}')),
			eventFrame("messageStop", { stopReason: "end_turn" }),
		]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("contentBlockDelta");
		expect(result.errorMessage).toMatch(/JSON|payload/i);
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("accepts a complete stream and includes cache tokens in fallback totals", async () => {
		const result = await runFrames([
			...completeFrames(),
			eventFrame("metadata", {
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 3,
					cacheWriteInputTokens: 2,
				},
			}),
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "Hello" }]);
		expect(result.usage).toMatchObject({
			input: 10,
			output: 5,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 20,
		});
	});

	it("preserves an explicit zero total token count", async () => {
		const result = await runFrames([
			...completeFrames(),
			eventFrame("metadata", {
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 3,
					cacheWriteInputTokens: 2,
					totalTokens: 0,
				},
			}),
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(0);
	});
});

describe("Bedrock stream timeouts", () => {
	it("times out and aborts after headers when no first event arrives", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | null | undefined;
			const caller = new AbortController();
			const stalled = stallingEventBody([]);
			const fetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					requestSignal = init?.signal;
					requestSignal?.addEventListener("abort", () => stalled.abort(requestSignal?.reason), { once: true });
					return new Response(stalled.body);
				},
				{ preconnect: fetch.preconnect },
			);
			const resultPromise = streamBedrock(model, context, {
				bearerToken: "test-token",
				fetch: fetchImpl,
				streamFirstEventTimeoutMs: 10,
				streamIdleTimeoutMs: 10,
				signal: caller.signal,
			}).result();
			await stalled.stalled;
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			const timedOut = requestSignal?.aborted === true;
			if (!timedOut) caller.abort();
			const result = await resultPromise;
			caller.abort();

			expect(timedOut).toBe(true);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/timed out|first event/i);
			expect(AIError.retriable(result.errorId)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out and aborts when the stream stalls after its first event", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | null | undefined;
			const caller = new AbortController();
			const stalled = stallingEventBody([
				eventFrame("messageStart", { role: "assistant" }),
				eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }),
			]);
			const fetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					requestSignal = init?.signal;
					requestSignal?.addEventListener("abort", () => stalled.abort(requestSignal?.reason), { once: true });
					return new Response(stalled.body);
				},
				{ preconnect: fetch.preconnect },
			);
			const resultPromise = streamBedrock(model, context, {
				bearerToken: "test-token",
				fetch: fetchImpl,
				streamFirstEventTimeoutMs: 50,
				streamIdleTimeoutMs: 10,
				signal: caller.signal,
			}).result();
			await stalled.stalled;
			await Promise.resolve();
			vi.advanceTimersByTime(100);
			const timedOut = requestSignal?.aborted === true;
			if (!timedOut) caller.abort();
			const result = await resultPromise;
			caller.abort();

			expect(timedOut).toBe(true);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/stalled|next event/i);
			expect(AIError.retriable(result.errorId)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
