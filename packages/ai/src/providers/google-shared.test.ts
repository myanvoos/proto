import { describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as AIError from "../error";
import type { Context, FetchImpl, ModelSpec } from "../types";
import { streamGoogle } from "./google";

const model = buildModel({
	id: "gemini-test",
	name: "Google Stream Test",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://google.example.test/v1beta",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} satisfies ModelSpec<"google-generative-ai">);

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const encoder = new TextEncoder();

function sseChunk(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function completeGoogleChunk(text = "Hello"): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
	};
}

function fetchForBody(body: Uint8Array): FetchImpl {
	return Object.assign(async (): Promise<Response> => new Response(body), { preconnect: fetch.preconnect });
}

function stallingSseBody(initialChunks: readonly unknown[]): {
	body: ReadableStream<Uint8Array>;
	stalled: Promise<void>;
	abort: (reason: unknown) => void;
} {
	const { promise: stalled, resolve: resolveStalled } = Promise.withResolvers<void>();
	const { promise: releasePull, resolve: resolvePull } = Promise.withResolvers<void>();
	let abortStream: (reason: unknown) => void = () => {};
	const encodeChunks = (chunks: readonly unknown[]): Uint8Array =>
		encoder.encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abortStream = reason => controller.error(reason);
				if (initialChunks.length > 0) controller.enqueue(encodeChunks(initialChunks));
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

describe("Google shared streaming", () => {
	it("accepts a well-formed complete SSE stream", async () => {
		const result = await streamGoogle(model, context, {
			apiKey: "test-key",
			fetch: fetchForBody(sseChunk(completeGoogleChunk())),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage).toMatchObject({ input: 3, output: 2, totalTokens: 5 });
	});
});

describe("Google shared stream timeouts", () => {
	it("times out and aborts after headers when no first SSE event arrives", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | null | undefined;
			const caller = new AbortController();
			const stalled = stallingSseBody([]);
			const fetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					requestSignal = init?.signal;
					requestSignal?.addEventListener("abort", () => stalled.abort(requestSignal?.reason), { once: true });
					return new Response(stalled.body);
				},
				{ preconnect: fetch.preconnect },
			);
			const resultPromise = streamGoogle(model, context, {
				apiKey: "test-key",
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
			expect(result.errorMessage).toMatch(/timed out|first SSE event/i);
			expect(AIError.retriable(result.errorId)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out and aborts when SSE stalls after its first event", async () => {
		vi.useFakeTimers();
		try {
			let requestSignal: AbortSignal | null | undefined;
			const caller = new AbortController();
			const stalled = stallingSseBody([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]);
			const fetchImpl = Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					requestSignal = init?.signal;
					requestSignal?.addEventListener("abort", () => stalled.abort(requestSignal?.reason), { once: true });
					return new Response(stalled.body);
				},
				{ preconnect: fetch.preconnect },
			);
			const resultPromise = streamGoogle(model, context, {
				apiKey: "test-key",
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
			expect(result.errorMessage).toMatch(/stalled|next SSE event/i);
			expect(AIError.retriable(result.errorId)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
