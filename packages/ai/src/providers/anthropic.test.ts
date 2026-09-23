import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec } from "../types";
import { isInvalidThinkingSignatureError, streamAnthropic } from "./anthropic";

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
	return streamAnthropic(streamModel, streamContext, {
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
		const stream = streamAnthropic(streamModel, streamContext, {
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
		await streamAnthropic(
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
