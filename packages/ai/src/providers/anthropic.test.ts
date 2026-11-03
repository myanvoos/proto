import { describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as utils from "@oh-my-pi/pi-utils";
import { NO_AUTH_SENTINEL } from "../auth-retry";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec, ProviderSessionState } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type AnthropicOptions,
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	clearAnthropicFastModeFallback,
	convertAnthropicMessages,
	isInvalidThinkingSignatureError,
	normalizeAnthropicToolSchema,
	streamAnthropicMessages,
} from "./anthropic";
import { AnthropicMessagesClient, type AnthropicMessagesClientLike } from "./anthropic-client";
import { encodeResponse, encodeStream } from "./anthropic-messages-server";
import type { MessageCreateParamsStreaming } from "./anthropic-wire";

describe("isInvalidThinkingSignatureError", () => {
	it("recognizes Anthropic's invalid-signature rejection", () => {
		expect(isInvalidThinkingSignatureError("messages.1.content.0: Invalid `signature` in `thinking` block")).toBe(
			true,
		);
	});

	it("recognizes both Bedrock missing-signature phrasings", () => {
		expect(
			isInvalidThinkingSignatureError(
				"ValidationException: messages.369.content.0.thinking.signature: Field required",
			),
		).toBe(true);
		expect(isInvalidThinkingSignatureError("content.2.thinking.signature is required")).toBe(true);
	});

	it("does not classify another required thinking field as a signature rejection", () => {
		expect(isInvalidThinkingSignatureError("messages.1.content.0.thinking.thinking: Field required")).toBe(false);
	});
});

const streamModel = buildModel({
	id: "anthropic-stream-test",
	name: "Anthropic Stream Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} satisfies ModelSpec<"anthropic-messages">);

const streamContext: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function rawSseFrame(event: string, data: string): string {
	return `event: ${event}\ndata: ${data}\n\n`;
}

function completeAnthropicSse(text: string, beforeBlock: readonly string[] = []): string {
	return [
		sseFrame("message_start", {
			type: "message_start",
			message: { id: "message-1", usage: { input_tokens: 3, output_tokens: 0 } },
		}),
		...beforeBlock,
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		}),
		sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		}),
		sseFrame("message_stop", { type: "message_stop" }),
	].join("");
}

function sseFetchSequence(payloads: readonly string[]): { fetch: FetchImpl; calls: () => number } {
	let calls = 0;
	const fetchImpl = Object.assign(
		async (): Promise<Response> => {
			const payload = payloads[Math.min(calls, payloads.length - 1)];
			calls++;
			return new Response(payload, { headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: fetchImpl, calls: () => calls };
}

async function runAnthropicSse(transport: { fetch: FetchImpl }) {
	return streamAnthropicMessages(streamModel, streamContext, {
		apiKey: "test-key",
		fetch: transport.fetch,
		providerRetryWait: async () => {},
	}).result();
}

function textContent(result: AssistantMessage): Array<{ type: "text"; text: string }> {
	return result.content.filter(block => block.type === "text").map(block => ({ type: "text", text: block.text }));
}

describe("Anthropic recognized SSE frames", () => {
	it("retries a malformed recognized frame before replay-unsafe output", async () => {
		const malformedAttempt = completeAnthropicSse("after-corruption", [
			rawSseFrame("content_block_delta", '{"type":"content_block_delta"'),
		]);
		const transport = sseFetchSequence([malformedAttempt, completeAnthropicSse("retried")]);
		const result = await runAnthropicSse(transport);

		expect(result.stopReason).toBe("stop");
		expect(textContent(result)).toEqual([{ type: "text", text: "retried" }]);
		expect(transport.calls()).toBe(2);
	});

	it("fails without retry when malformed JSON follows replay-unsafe output", async () => {
		const payload = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "message-1", usage: { input_tokens: 3, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "partial" },
			}),
			rawSseFrame("content_block_delta", "not-json"),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		const transport = sseFetchSequence([payload, completeAnthropicSse("must-not-retry")]);
		const result = await runAnthropicSse(transport);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("could not parse recognized SSE event content_block_delta");
		expect(transport.calls()).toBe(1);
	});

	it("fails on a recognized frame whose JSON type disagrees with its SSE type", async () => {
		const payload = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "message-1", usage: { input_tokens: 3, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "partial" },
			}),
			sseFrame("content_block_delta", { type: "message_stop" }),
		].join("");
		const transport = sseFetchSequence([payload, completeAnthropicSse("must-not-retry")]);
		const result = await runAnthropicSse(transport);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("does not match SSE event content_block_delta");
		expect(transport.calls()).toBe(1);
	});

	it("does not complete a prefix even when content_block_stop arrives", async () => {
		const payload = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "message-prefix", usage: { input_tokens: 3, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call-prefix", name: "bash", input: {} },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"command": "' },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		const stream = streamAnthropicMessages(streamModel, streamContext, {
			apiKey: "test-key",
			fetch: sseFetchSequence([payload]).fetch,
			providerRetryWait: async () => {},
		});
		const endEvents: string[] = [];
		for await (const event of stream) {
			if (event.type === "toolcall_end") endEvents.push(event.toolCall.id);
		}
		const result = await stream.result();

		expect(endEvents).toEqual([]);
		expect(result.stopReason).toBe("error");
	});

	it("ignores unknown event types while preserving a complete response", async () => {
		const transport = sseFetchSequence([
			completeAnthropicSse("Hello", [rawSseFrame("future_anthropic_event", "not-json")]),
		]);
		const result = await runAnthropicSse(transport);

		expect(result.stopReason).toBe("stop");
		expect(textContent(result)).toEqual([{ type: "text", text: "Hello" }]);
		expect(transport.calls()).toBe(1);
	});
});

describe("Anthropic context management compatibility", () => {
	function makeModel(supportsContextManagement?: boolean) {
		return buildModel({
			id: "claude-haiku-4-5",
			name: "Claude Haiku 4.5",
			api: "anthropic-messages",
			provider: "custom-anthropic-proxy",
			baseUrl: "https://models.example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
			...(supportsContextManagement === undefined ? {} : { compat: { supportsContextManagement } }),
		} satisfies ModelSpec<"anthropic-messages">);
	}

	type CapturedPayload = { context_management?: unknown; thinking?: { type?: string } };

	async function captureRequest(model: Model<"anthropic-messages">, apiKey: string) {
		let beta = "";
		const fetchMock: FetchImpl = async (_input, init) => {
			beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		};
		const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
		await streamAnthropicMessages(
			model,
			{ messages: [{ role: "user", content: "continue", timestamp: 0 }] },
			{ apiKey, thinkingEnabled: true, fetch: fetchMock, onPayload: payload => resolve(payload as CapturedPayload) },
		).result();
		return { beta, payload: await promise };
	}

	it("sends context management when compatibility is omitted", async () => {
		const request = await captureRequest(makeModel(), "test-key");

		expect(request.payload.context_management).toBeDefined();
		expect(request.beta).toContain("context-management-2025-06-27");
	});

	it.each([
		["API-key", "test-key"],
		["OAuth", "sk-ant-oat-test"],
	])("omits context management from %s proxy requests without disabling thinking", async (_auth, apiKey) => {
		const request = await captureRequest(makeModel(false), apiKey);

		expect(request.payload.thinking?.type).toBe("enabled");
		expect(request.payload.context_management).toBeUndefined();
		expect(request.beta).not.toContain("context-management-2025-06-27");
	});
});

describe("Anthropic keyless endpoints", () => {
	it("sends no Authorization or X-Api-Key for the keyless sentinel on non-official endpoints", () => {
		const headers = buildAnthropicHeaders({
			apiKey: NO_AUTH_SENTINEL,
			baseUrl: "https://proxy.example.test",
			stream: true,
		});

		expect(headers.Authorization).toBeUndefined();
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("suppresses the client X-Api-Key for the keyless sentinel", () => {
		const options = buildAnthropicClientOptions({
			model: buildModel({
				id: "claude-haiku-4-5",
				name: "Claude Haiku 4.5",
				api: "anthropic-messages",
				provider: "custom-anthropic",
				baseUrl: "https://proxy.example.test/anthropic",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			} satisfies ModelSpec<"anthropic-messages">),
			apiKey: NO_AUTH_SENTINEL,
			stream: true,
		});

		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.apiKey).toBeNull();
	});
});

describe("Anthropic output ceiling", () => {
	it("requests the model's full output ceiling for OAuth credentials", async () => {
		const model = buildModel({
			id: "claude-opus-5-5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "custom-anthropic",
			baseUrl: "https://claude-gateway.example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"anthropic-messages">);
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<{ max_tokens?: number }>();
		streamAnthropicMessages(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "sk-ant-oat-test",
				isOAuth: true,
				signal: controller.signal,
				onPayload: payload => resolve(payload as { max_tokens?: number }),
			},
		);

		expect((await promise).max_tokens).toBe(128_000);
	});
});

const reasoningModel = buildModel({
	id: "claude-fable-5-1",
	name: "Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} satisfies ModelSpec<"anthropic-messages">);

function captureRequests(respond: (body: MessageCreateParamsStreaming, call: number) => Response) {
	const bodies: MessageCreateParamsStreaming[] = [];
	const headers: Headers[] = [];
	const transport = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = (await new Response(init?.body).json()) as MessageCreateParamsStreaming;
			bodies.push(body);
			headers.push(new Headers(init?.headers));
			return respond(body, bodies.length);
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: transport, bodies, headers };
}

function successResponse(): Response {
	return new Response(completeAnthropicSse("ok"), { headers: { "content-type": "text/event-stream" } });
}

function invalidRequest(message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});
}

async function capturedRequest(context: Context, options: AnthropicOptions = {}, model = reasoningModel) {
	const transport = captureRequests(() => successResponse());
	const result = await streamAnthropicMessages(model, context, {
		apiKey: "test-key",
		...options,
		fetch: transport.fetch,
	}).result();
	expect(result.stopReason).toBe("stop");
	return { body: transport.bodies[0], headers: transport.headers[0] };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: reasoningModel.id,
		content,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function responseWithBlocks(blocks: Array<Record<string, unknown>>, signatureDeltas: string[] = []): string {
	const frames = [
		sseFrame("message_start", {
			type: "message_start",
			message: { id: "message-blocks", usage: { input_tokens: 3, output_tokens: 0 } },
		}),
	];
	for (const [index, block] of blocks.entries()) {
		frames.push(sseFrame("content_block_start", { type: "content_block_start", index, content_block: block }));
		if (block.type === "thinking")
			for (const signature of signatureDeltas)
				frames.push(
					sseFrame("content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "signature_delta", signature },
					}),
				);
		frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index }));
	}
	frames.push(
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		}),
		sseFrame("message_stop", { type: "message_stop" }),
	);
	return frames.join("");
}

describe("Anthropic prompt-cache refusal recovery", () => {
	it("removes OAuth identity breakpoints and caller cache betas on replay and later turns", async () => {
		const transport = captureRequests((_body, call) =>
			call === 1 ? invalidRequest('json: unknown field "cache_control"') : successResponse(),
		);
		const state = new Map<string, ProviderSessionState>();
		const options: AnthropicOptions = {
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			fetch: transport.fetch,
			providerSessionState: state,
			betas: ["extended-cache-ttl-2025-04-11"],
			headers: { "Anthropic-Beta": "prompt-caching-scope-2026-01-05,other-beta" },
		};
		const first = await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(first.stopReason).toBe("stop");
		expect(first.disabledFeatures).toContain("prompt-cache");
		expect(JSON.stringify(transport.bodies[0])).toContain("cache_control");
		expect(JSON.stringify(transport.bodies[1])).not.toContain("cache_control");
		expect(transport.headers[1].get("anthropic-beta")).not.toMatch(/extended-cache-ttl|prompt-caching-scope/);
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(JSON.stringify(transport.bodies[2])).not.toContain("cache_control");
	});

	it("does not suppress future caching when the breakpoint-free replay fails", async () => {
		const transport = captureRequests((_body, call) =>
			call === 1
				? invalidRequest('unknown field "cache_control"')
				: call === 2
					? invalidRequest("unrelated failure")
					: successResponse(),
		);
		const options: AnthropicOptions = { apiKey: "key", fetch: transport.fetch, providerSessionState: new Map() };
		expect((await streamAnthropicMessages(streamModel, streamContext, options).result()).stopReason).toBe("error");
		expect((await streamAnthropicMessages(streamModel, streamContext, options).result()).stopReason).toBe("stop");
		expect(JSON.stringify(transport.bodies[2])).toContain("cache_control");
	});

	it("isolates opaque client learning by session, preserves re-arm quirks, and clears on close", async () => {
		const transport = captureRequests((_body, call) =>
			call === 1 ? invalidRequest('unknown field "cache_control"') : successResponse(),
		);
		const native = new AnthropicMessagesClient({ baseURL: "https://proxy.test", fetch: transport.fetch });
		const client: AnthropicMessagesClientLike = { messages: native.messages };
		const state = new Map<string, ProviderSessionState>();
		const options: AnthropicOptions = { client, providerSessionState: state };
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		clearAnthropicFastModeFallback(state);
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(JSON.stringify(transport.bodies[2])).not.toContain("cache_control");
		await streamAnthropicMessages(streamModel, streamContext, { client, providerSessionState: new Map() }).result();
		expect(JSON.stringify(transport.bodies[3])).toContain("cache_control");
		for (const entry of state.values()) await entry.close();
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(JSON.stringify(transport.bodies[4])).toContain("cache_control");
	});

	it("does not let an injected proxy disable caching at another published endpoint", async () => {
		const rejected = captureRequests((_body, call) =>
			call === 1 ? invalidRequest('unknown field "cache_control"') : successResponse(),
		);
		const accepted = captureRequests(() => successResponse());
		const state = new Map<string, ProviderSessionState>();
		await streamAnthropicMessages(streamModel, streamContext, {
			providerSessionState: state,
			client: new AnthropicMessagesClient({ baseURL: "https://reject.test", fetch: rejected.fetch }),
		}).result();
		await streamAnthropicMessages(streamModel, streamContext, {
			providerSessionState: state,
			client: new AnthropicMessagesClient({ baseURL: "https://accept.test", fetch: accepted.fetch }),
		}).result();
		expect(JSON.stringify(accepted.bodies[0])).toContain("cache_control");
	});
});

describe("Anthropic finalized request contracts", () => {
	it("adds binding and context-management betas from hook-produced fields", async () => {
		const { headers } = await capturedRequest(streamContext, {
			thinkingEnabled: false,
			onPayload: value => {
				const body = value as MessageCreateParamsStreaming;
				body.thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
				body.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
			},
		});
		expect(headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
		expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
	});

	it("does not advertise binding when middleware removes the binding field", async () => {
		const { headers } = await capturedRequest(streamContext, {
			thinkingEnabled: true,
			onPayload: value => {
				const body = value as MessageCreateParamsStreaming;
				if (body.thinking && "block_binding" in body.thinking) body.thinking.block_binding = undefined;
			},
		});
		expect(headers.get("anthropic-beta") ?? "").not.toContain("thinking-binding-controls");
	});

	it("keeps structured yield inputs buffered and enforces repeated strict-schema budgets", async () => {
		const shared = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
			additionalProperties: false,
		};
		const { body } = await capturedRequest({
			...streamContext,
			tools: [
				{
					name: "yield",
					description: "Result",
					parameters: {
						type: "object",
						properties: { result: { type: "string" } },
						required: ["result"],
						additionalProperties: false,
					},
				},
				{
					name: "python",
					description: "Run",
					parameters: {
						type: "object",
						properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`p${index}`, shared])),
						required: Array.from({ length: 12 }, (_, index) => `p${index}`),
						additionalProperties: false,
					},
				},
			],
		});
		expect(body.tools?.[0].strict).toBe(true);
		expect(body.tools?.[0].eager_input_streaming).toBe(false);
		expect(body.tools?.[1].strict).toBe(true);
		const schema = body.tools?.[1].input_schema as { properties: Record<string, { required: string[] }> };
		const optional = Object.values(schema.properties).reduce(
			(sum, property) => sum + 3 - property.required.length,
			0,
		);
		expect(optional).toBe(24);
	});

	it("folds root object unions so valid tool arguments are not reduced to an empty object", () => {
		const schema = normalizeAnthropicToolSchema({
			type: "object",
			anyOf: [
				{ type: "object", properties: { kind: { const: "a" }, a: { type: "string" } }, required: ["kind", "a"] },
				{ type: "object", properties: { kind: { const: "b" }, b: { type: "number" } }, required: ["kind", "b"] },
			],
		}) as { properties: Record<string, unknown>; required: string[]; anyOf?: unknown };
		expect(Object.keys(schema.properties).sort()).toEqual(["a", "b", "kind"]);
		expect(schema.required).toEqual(["kind"]);
		expect(schema.anyOf).toBeUndefined();
	});

	it("rejects unreadable current media but preserves historical stubs and user-attributed authority", () => {
		const media = [{ type: "image" as const, mimeType: "image/heic", data: "invalid" }];
		expect(() =>
			convertAnthropicMessages(
				[{ role: "developer", attribution: "user", synthetic: true, content: media, timestamp: 0 }],
				reasoningModel,
				false,
			),
		).toThrow(/image\/heic/);
		const converted = convertAnthropicMessages(
			[
				{ role: "user", content: media, timestamp: 0 },
				assistant([{ type: "text", text: "Earlier" }]),
				{ role: "user", content: "Next", timestamp: 2 },
				{ role: "developer", attribution: "user", content: "Untrusted mention", timestamp: 3 },
			],
			reasoningModel,
			false,
		);
		expect(converted[0].content).toEqual([{ type: "text", text: "[unsupported image: image/heic]" }]);
		expect(converted.at(-1)?.role).toBe("user");
	});
});

describe("Anthropic stream progress and fallback safety", () => {
	it("keeps a start-only signature but replaces it when native signature deltas arrive", async () => {
		for (const deltas of [[], ["native-", "signature"]]) {
			const payload = responseWithBlocks(
				[
					{ type: "thinking", thinking: "Reasoning", signature: "start-signature" },
					{ type: "text", text: "Answer" },
				],
				deltas,
			);
			const result = await runAnthropicSse(sseFetchSequence([payload]));
			const thinking = result.content.find(block => block.type === "thinking");
			expect(thinking?.type === "thinking" && thinking.thinkingSignature).toBe(
				deltas.length ? "native-signature" : "start-signature",
			);
		}
	});

	it("times out repeated empty deltas rather than treating them as progress", async () => {
		let timer: NodeJS.Timeout | undefined;
		const transport = Object.assign(
			async (): Promise<Response> =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							const encoder = new TextEncoder();
							controller.enqueue(
								encoder.encode(
									sseFrame("message_start", { type: "message_start", message: { id: "stalled", usage: {} } }) +
										sseFrame("content_block_start", {
											type: "content_block_start",
											index: 0,
											content_block: { type: "text", text: "" },
										}),
								),
							);
							timer = setInterval(
								() =>
									controller.enqueue(
										encoder.encode(
											sseFrame("content_block_delta", {
												type: "content_block_delta",
												index: 0,
												delta: { type: "text_delta", text: "" },
											}),
										),
									),
								5,
							);
						},
						cancel() {
							clearInterval(timer);
						},
					}),
				),
			{ preconnect: fetch.preconnect },
		);
		try {
			const result = await streamAnthropicMessages(streamModel, streamContext, {
				apiKey: "key",
				fetch: transport,
				streamIdleTimeoutMs: 30,
				streamFirstEventTimeoutMs: 30,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("stalled");
		} finally {
			clearInterval(timer);
		}
	});

	it("drains the terminal HTTP chunk without cancelling a completed response", async () => {
		let cancelled = false;
		let drained = false;
		const transport = Object.assign(
			async (): Promise<Response> =>
				new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(new TextEncoder().encode(completeAnthropicSse("complete")));
							await Bun.sleep(10);
							drained = true;
							controller.close();
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
			{ preconnect: fetch.preconnect },
		);
		const result = await streamAnthropicMessages(streamModel, streamContext, {
			apiKey: "key",
			fetch: transport,
			waitForTerminalDrain: true,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(drained).toBe(true);
		expect(cancelled).toBe(false);
	});

	it("never releases declined fallback tool calls and retains only the serving model reasoning", async () => {
		const payload = responseWithBlocks([
			{ type: "thinking", thinking: "Declined", signature: "declined" },
			{ type: "tool_use", id: "declined-tool", name: "must_not_run", input: {} },
			{ type: "fallback", from: { model: "primary" }, to: { model: "serving" } },
			{ type: "thinking", thinking: "Serving", signature: "serving" },
			{ type: "tool_use", id: "serving-tool", name: "run_this", input: {} },
		]);
		const transport = sseFetchSequence([payload]);
		const stream = streamAnthropicMessages(streamModel, streamContext, {
			apiKey: "key",
			fetch: transport.fetch,
			fallbacks: [{ model: "serving" }],
		});
		const tools: string[] = [];
		for await (const event of stream) if (event.type === "toolcall_end") tools.push(event.toolCall.id);
		const result = await stream.result();
		expect(tools).toEqual(["serving-tool"]);
		expect(result.content.filter(block => block.type === "thinking").map(block => block.thinking)).toEqual([
			"Serving",
		]);
		expect(result.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual([
			"serving-tool",
		]);
	});

	it("bridges fallback reasoning as one signed chain with dense stream indices", async () => {
		const message = assistant([
			{ type: "thinking", thinking: "First", thinkingSignature: "first" },
			{ type: "fallback", from: { model: "first" }, to: { model: "second" } },
			{ type: "thinking", thinking: "Second", thinkingSignature: "second" },
			{ type: "text", text: "Answer" },
		]);
		const encoded = encodeResponse(message, "claude") as { content: Array<{ type: string; thinking?: string }> };
		expect(encoded.content.filter(block => block.type === "thinking").map(block => block.thinking)).toEqual([
			"First",
		]);
		const events = new AssistantMessageEventStream();
		for (const contentIndex of [0, 2]) {
			events.push({ type: "thinking_start", contentIndex, partial: message });
			events.push({
				type: "thinking_delta",
				contentIndex,
				delta: contentIndex === 0 ? "First" : "Second",
				partial: message,
			});
			events.push({
				type: "thinking_end",
				contentIndex,
				content: contentIndex === 0 ? "First" : "Second",
				partial: message,
			});
		}
		events.push({ type: "text_start", contentIndex: 3, partial: message });
		events.push({ type: "text_delta", contentIndex: 3, delta: "Answer", partial: message });
		events.push({ type: "text_end", contentIndex: 3, content: "Answer", partial: message });
		events.push({ type: "done", reason: "stop", message });
		events.end();
		const wire = await new Response(encodeStream(events, "claude")).text();
		const frames = wire
			.split("\n")
			.filter(line => line.startsWith("data: "))
			.map(
				line =>
					JSON.parse(line.slice(6)) as {
						type: string;
						index: number;
						content_block?: { type: string };
						delta?: { thinking?: string };
					},
			);
		expect(frames.filter(frame => frame.type === "content_block_start").map(frame => frame.index)).toEqual([0, 1]);
		expect(frames.some(frame => frame.delta?.thinking === "Second")).toBe(false);
	});
});

describe("Anthropic gateway controls", () => {
	it("withholds experimental fields and caller betas even when payload middleware restores them", async () => {
		const original = utils.$flag;
		const flag = spyOn(utils, "$flag").mockImplementation((name, fallback) =>
			name === "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS" ? true : original(name, fallback),
		);
		try {
			const { body, headers } = await capturedRequest(streamContext, {
				betas: ["thinking-binding-controls-2026-08-01", "context-management-2025-06-27"],
				headers: { "Anthropic-Beta": "structured-outputs-2025-12-15,task-budgets-2026-03-13" },
				onPayload: value => {
					const body = value as MessageCreateParamsStreaming;
					const controls = {
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						output_config: {
							effort: "high",
							task_budget: { type: "tokens", budget: 100 },
							format: { type: "json_schema" },
						},
					};
					Object.assign(body, controls, {
						context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
						tools: [
							{
								name: "yield",
								input_schema: { type: "object" },
								strict: true,
								eager_input_streaming: true,
								defer_loading: true,
							},
						],
						fallbacks: [{ model: "fallback", ...structuredClone(controls) }],
					});
					Object.assign(body.messages[0], { output_config: { ...controls.output_config } });
				},
			});
			expect(body.context_management).toBeUndefined();
			expect(body.thinking && "block_binding" in body.thinking).toBe(false);
			expect(body.output_config).toEqual({ effort: "high" });
			expect(body.fallbacks?.[0].output_config).toEqual({ effort: "high" });
			expect(body.messages[0].output_config).toEqual({ effort: "high" });
			expect(body.tools?.[0].strict).toBeUndefined();
			expect(body.tools?.[0].eager_input_streaming).toBeUndefined();
			expect(body.tools?.[0].defer_loading).toBeUndefined();
			expect(headers.get("anthropic-beta") ?? "").not.toMatch(
				/thinking-binding-controls|context-management|structured-outputs|task-budgets/,
			);
		} finally {
			flag.mockRestore();
		}
	});

	it("does not apply a pending roster or effort change to an interior compaction request", async () => {
		const state = new Map<string, ProviderSessionState>();
		const options: AnthropicOptions = {
			sessionId: "compaction",
			providerSessionState: state,
			thinkingEnabled: true,
			effort: "high",
		};
		const read = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
		const grep = { name: "grep", description: "Search", parameters: { type: "object", properties: {} } };
		await capturedRequest({ ...streamContext, tools: [read] }, options);
		const history = [...streamContext.messages, assistant([{ type: "text", text: "Earlier" }])];
		const { body: compact } = await capturedRequest(
			{ messages: history, tools: [read, grep] },
			{
				...options,
				effort: "low",
				anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
			},
		);
		expect(compact.output_config?.effort).toBe("high");
		expect(compact.messages.filter(message => message.role === "system")).toEqual([]);
		expect(compact.tools?.map(tool => tool.name)).toEqual(["read"]);
		const { body: live } = await capturedRequest(
			{ messages: [...history, { role: "user", content: "Next", timestamp: 2 }], tools: [read, grep] },
			{ ...options, effort: "low" },
		);
		expect(
			live.messages.some(
				message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_addition"),
			),
		).toBe(true);
	});

	it("suppresses request-wide fine-grained streaming when yield needs buffering", async () => {
		const model = { ...reasoningModel, compat: { ...reasoningModel.compat, supportsEagerToolInputStreaming: false } };
		const { body, headers } = await capturedRequest(
			{
				...streamContext,
				tools: [
					{
						name: "yield",
						description: "Return",
						parameters: {
							type: "object",
							properties: { result: { type: "string" } },
							required: ["result"],
							additionalProperties: false,
						},
					},
				],
			},
			{},
			model,
		);
		expect(body.tools?.[0].eager_input_streaming).toBeUndefined();
		expect(headers.get("anthropic-beta") ?? "").not.toContain("fine-grained-tool-streaming");
	});
});

describe("Anthropic opaque-client fast mode", () => {
	it("honors a fast-mode re-arm without sharing state with the model endpoint", async () => {
		const transport = captureRequests((_body, call) =>
			call === 1
				? invalidRequest("invalid_request_error: speed is not supported for this model")
				: successResponse(),
		);
		const native = new AnthropicMessagesClient({ baseURL: "https://fast-proxy.test", fetch: transport.fetch });
		const state = new Map<string, ProviderSessionState>();
		const options: AnthropicOptions = {
			client: { messages: native.messages },
			providerSessionState: state,
			serviceTier: "priority",
		};
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(transport.bodies[0].speed).toBe("fast");
		expect(transport.bodies[1].speed).toBeUndefined();
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(transport.bodies[2].speed).toBeUndefined();
		clearAnthropicFastModeFallback(state);
		await streamAnthropicMessages(streamModel, streamContext, options).result();
		expect(transport.bodies[3].speed).toBe("fast");
	});
});

it("sends explicit thinking-off for Haiku 5.5 instead of low adaptive thinking", async () => {
	const model = buildModel({
		id: "claude-haiku-5-5",
		name: "Haiku",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
	const { body, headers } = await capturedRequest(streamContext, { thinkingEnabled: false }, model);
	expect(body.thinking).toEqual({ type: "disabled" });
	expect(headers.get("anthropic-beta") ?? "").not.toContain("thinking-binding-controls");
});

describe("Anthropic provider recovery dependencies", () => {
	it("preserves short-lived caching when only ttl or scope is refused", async () => {
		const transport = captureRequests(body =>
			JSON.stringify(body).includes('"ttl"')
				? invalidRequest("unsupported_parameter: cache_control.ttl")
				: successResponse(),
		);
		const options: AnthropicOptions = {
			apiKey: "key",
			cacheRetention: "long",
			fetch: transport.fetch,
			providerSessionState: new Map(),
		};
		const first = await streamAnthropicMessages(reasoningModel, streamContext, options).result();
		expect(first.stopReason).toBe("stop");
		expect(first.disabledFeatures).toEqual(["prompt-cache-retention"]);
		expect(JSON.stringify(transport.bodies[1])).toContain("cache_control");
		expect(JSON.stringify(transport.bodies[1])).not.toContain('"ttl"');
		expect(transport.headers[1].get("anthropic-beta") ?? "").not.toMatch(/extended-cache-ttl|prompt-caching-scope/);
		await streamAnthropicMessages(reasoningModel, streamContext, options).result();
		expect(JSON.stringify(transport.bodies[2])).toContain("cache_control");
		expect(JSON.stringify(transport.bodies[2])).not.toContain('"ttl"');
	});

	it("escalates from option-free to breakpoint-free only when the endpoint rejects both", async () => {
		const transport = captureRequests(body =>
			JSON.stringify(body).includes("cache_control")
				? invalidRequest('unknown field "cache_control"')
				: successResponse(),
		);
		const result = await streamAnthropicMessages(reasoningModel, streamContext, {
			apiKey: "key",
			cacheRetention: "long",
			fetch: transport.fetch,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(transport.bodies).toHaveLength(3);
		expect(JSON.stringify(transport.bodies[0])).toContain('"ttl"');
		expect(JSON.stringify(transport.bodies[1])).toContain("cache_control");
		expect(JSON.stringify(transport.bodies[1])).not.toContain('"ttl"');
		expect(JSON.stringify(transport.bodies[2])).not.toContain("cache_control");
	});

	it("replays server-dropped thinking verbatim rather than changing the cached conversation prefix", async () => {
		const payload = completeAnthropicSse("ok").replace(
			'"id":"message-1"',
			'"id":"message-1","input_transformations":[{"type":"dropped","reason":"prefix_binding_mismatch","path":"messages.1.content.0"}]',
		);
		const transport = captureRequests(() => new Response(payload));
		const history: Context = {
			messages: [
				...streamContext.messages,
				assistant([
					{ type: "thinking", thinking: "Bound", thinkingSignature: "bound-signature" },
					{ type: "text", text: "Earlier" },
				]),
				{ role: "user", content: "Next", timestamp: 2 },
			],
		};
		const options: AnthropicOptions = {
			apiKey: "key",
			fetch: transport.fetch,
			providerSessionState: new Map(),
			thinkingEnabled: true,
		};
		await streamAnthropicMessages(reasoningModel, history, options).result();
		await streamAnthropicMessages(reasoningModel, history, options).result();
		const assistantTurn = transport.bodies[1].messages.find(message => message.role === "assistant");
		expect(
			Array.isArray(assistantTurn?.content) &&
				assistantTurn.content.some(block => block.type === "thinking" && block.signature === "bound-signature"),
		).toBe(true);
	});

	it("retries a refused latest assistant tool loop without mutating its stored thinking", async () => {
		const transport = captureRequests(body =>
			body.messages.some(
				message => Array.isArray(message.content) && message.content.some(block => block.type === "thinking"),
			)
				? invalidRequest("messages.1.content.0: thinking blocks in the latest assistant message cannot be modified")
				: successResponse(),
		);
		const prior = assistant([
			{ type: "thinking", thinking: "Refused", thinkingSignature: "refused-signature" },
			{ type: "toolCall", id: "call", name: "read", arguments: {} },
		]);
		const context: Context = {
			messages: [
				...streamContext.messages,
				prior,
				{
					role: "toolResult",
					toolCallId: "call",
					isError: false,
					toolName: "read",
					content: [{ type: "text", text: "Result" }],
					timestamp: 2,
				},
			],
		};
		const options: AnthropicOptions = {
			apiKey: "key",
			fetch: transport.fetch,
			providerSessionState: new Map(),
			thinkingEnabled: true,
		};
		expect((await streamAnthropicMessages(reasoningModel, context, options).result()).stopReason).toBe("stop");
		expect(transport.bodies).toHaveLength(2);
		expect(prior.content[0]).toEqual({
			type: "thinking",
			thinking: "Refused",
			thinkingSignature: "refused-signature",
		});
		expect((await streamAnthropicMessages(reasoningModel, context, options).result()).stopReason).toBe("stop");
		expect(transport.bodies).toHaveLength(3);
	});
});
