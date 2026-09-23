import { describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as AIError from "../error";
import type { Context, FetchImpl, Model, ModelSpec, ToolCall, Usage } from "../types";
import { streamGoogle } from "./google";
import { buildRequest } from "./google-gemini-cli";
import { convertMessages } from "./google-shared";

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

type GoogleWireApi = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const VALID_SIGNATURE = "QUJDRA==";
const SKIP_SIGNATURE = "skip_thought_signature_validator";

function wireModel(api: GoogleWireApi, provider: string, id: string): Model<GoogleWireApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://google.example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});
}

function toolTurn(model: Model<GoogleWireApi>, calls: ToolCall[], withResult = false): Context {
	return {
		messages: [
			{ role: "user", content: "go", timestamp: 1 },
			{
				role: "assistant",
				provider: model.provider,
				api: model.api,
				model: model.id,
				content: calls,
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 2,
			},
			...(withResult
				? [
						{
							role: "toolResult" as const,
							toolCallId: calls[0]!.id,
							toolName: calls[0]!.name,
							content: [{ type: "text" as const, text: "ok" }],
							isError: false,
							timestamp: 3,
						},
					]
				: []),
		],
	};
}

const signedFirstParallel: ToolCall[] = [
	{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" }, thoughtSignature: VALID_SIGNATURE },
	{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b" } },
];
const unsignedFirst: ToolCall[] = [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }];

function callSignatures(model: Model<GoogleWireApi>, calls: ToolCall[]): (string | undefined)[] {
	const modelTurn = convertMessages(model, toolTurn(model, calls)).find(content => content.role === "model");
	return (modelTurn?.parts ?? []).filter(part => part.functionCall).map(part => part.thoughtSignature);
}

describe("Gemini 3 unsigned tool-call signature fallback", () => {
	it("sends the bypass sentinel on every unsigned call to the public Gemini API", () => {
		const model = wireModel("google-generative-ai", "custom-gemini", "gemini-3.7-flash");
		expect(callSignatures(model, unsignedFirst)).toEqual([SKIP_SIGNATURE]);
		expect(callSignatures(model, signedFirstParallel)).toEqual([VALID_SIGNATURE, SKIP_SIGNATURE]);
	});

	it("sends the sentinel on Cloud Code Assist only when the turn's first call is unsigned", () => {
		const model = wireModel("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		expect(callSignatures(model, unsignedFirst)).toEqual([SKIP_SIGNATURE]);
		expect(callSignatures(model, signedFirstParallel)).toEqual([VALID_SIGNATURE, undefined]);
	});

	it("never sends the sentinel to Vertex, which rejects it", () => {
		const model = wireModel("google-vertex", "google-vertex", "gemini-3-flash");
		expect(callSignatures(model, unsignedFirst)).toEqual([undefined]);
		expect(callSignatures(model, signedFirstParallel)).toEqual([VALID_SIGNATURE, undefined]);
	});
});

describe("Google request shaping", () => {
	it("keeps tool-call ids for gpt-oss on Cloud Code Assist, which replays them as OpenAI tool_calls", () => {
		const model = wireModel("google-gemini-cli", "google-antigravity", "gpt-oss-120b");
		const contents = convertMessages(model, toolTurn(model, unsignedFirst, true));
		const call = contents.find(content => content.role === "model")?.parts?.[0]?.functionCall;
		const response = contents.at(-1)?.parts?.[0]?.functionResponse;
		expect(call?.id).toBe("call_1");
		expect(response?.id).toBe("call_1");
	});

	it("drops minP/repetitionPenalty, which every Gemini surface rejects as unknown fields", async () => {
		const sampling = { temperature: 1, topP: 0.9, minP: 0.05, presencePenalty: 0.1, repetitionPenalty: 1.05 };
		let publicBody: { generationConfig?: Record<string, unknown> } = {};
		await streamGoogle(model, context, {
			apiKey: "test-key",
			...sampling,
			fetch: Object.assign(
				async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					publicBody = JSON.parse(String(init?.body));
					return new Response(sseChunk(completeGoogleChunk()));
				},
				{ preconnect: fetch.preconnect },
			),
		}).result();
		const cca = buildRequest(
			wireModel("google-gemini-cli", "google-gemini-cli", "gemini-3-flash") as Model<"google-gemini-cli">,
			context,
			"project",
			sampling,
		);

		for (const generationConfig of [publicBody.generationConfig, cca.request.generationConfig]) {
			expect(generationConfig).toMatchObject({ temperature: 1, topP: 0.9, presencePenalty: 0.1 });
			expect(generationConfig).not.toHaveProperty("minP");
			expect(generationConfig).not.toHaveProperty("repetitionPenalty");
		}
	});
});
