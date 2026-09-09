import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "../types";
import { streamPiNative } from "./pi-native-client";

function baseAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function fakeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://llm-gateway.internal:4000",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		transport: "pi-native",
	} as ModelSpec<"anthropic-messages">);
}

const context: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

describe("streamPiNative terminal events", () => {
	it("rejects a stream that closes before a terminal event instead of returning a truncated success", async () => {
		const startEvent: AssistantMessageEvent = { type: "start", partial: baseAssistant() };
		const bytes = new TextEncoder().encode(`data: ${JSON.stringify(startEvent)}\n\n`);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
		const fetchImpl = (async () =>
			new Response(body, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			})) as FetchImpl;

		const error = await streamPiNative(fakeModel(), context, { apiKey: "gateway-key", fetch: fetchImpl })
			.result()
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(error).toBeInstanceOf(AIError.ProviderResponseError);
		expect(error).toMatchObject({
			message: "pi-native stream read error: stream closed before a terminal response event",
			provider: "anthropic",
			kind: "incomplete-stream",
		});
		const id = AIError.classify(error);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});
});
