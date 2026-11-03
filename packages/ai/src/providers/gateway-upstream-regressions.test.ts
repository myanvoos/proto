import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	adoptReplayedGeminiSignatures,
	encodeResponse,
	encodeStream,
	parseRequest as parseChatRequest,
} from "./openai-chat-server";
import { parseRequest as parseResponsesRequest } from "./openai-responses-server";
import { encodeStream as encodeNativeStream } from "./pi-native-server";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-3-pro",
		content: [
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" }, thoughtSignature: "QUJDRA==" },
		],
		stopReason: "toolUse",
		timestamp: 0,
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

describe("gateway nullable Responses controls", () => {
	it("accepts explicit null controls as omissions while preserving numeric overrides", () => {
		const omitted = parseResponsesRequest({
			model: "test",
			input: "hi",
			max_output_tokens: null,
			temperature: null,
			top_p: null,
			reasoning: { summary: null },
		});
		expect(omitted.options.maxOutputTokens).toBeUndefined();
		expect(omitted.options.temperature).toBeUndefined();
		expect(omitted.options.topP).toBeUndefined();
		const explicit = parseResponsesRequest({
			model: "test",
			input: "hi",
			max_output_tokens: 15,
			temperature: 0,
			top_p: 0.5,
		});
		expect(explicit.options).toMatchObject({ maxOutputTokens: 15, temperature: 0, topP: 0.5 });
		expect(parseResponsesRequest({ model: "test", input: "hi", reasoning: null }).modelId).toBe("test");
	});
});

it("chat gateway signatures round-trip in non-streaming and late-signature SSE responses", async () => {
	const message = assistant();
	const encoded = encodeResponse(message, "test") as { choices: { message: unknown }[] };
	const parsed = parseChatRequest({ model: "test", messages: [encoded.choices[0]!.message] });
	adoptReplayedGeminiSignatures(
		parsed.context,
		buildModel({
			id: "gemini-3-pro",
			name: "Gemini",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://google.example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
		}),
	);
	expect(parsed.context.messages[0]).toMatchObject({
		role: "assistant",
		content: [{ type: "toolCall", thoughtSignature: "QUJDRA==" }],
	});
	const stream = new AssistantMessageEventStream();
	const partial = assistant();
	const call = partial.content[0];
	if (call?.type !== "toolCall") throw new Error("Expected a tool call");
	delete call.thoughtSignature;
	stream.push({ type: "toolcall_start", contentIndex: 0, partial });
	const toolCall = message.content[0];
	if (toolCall?.type !== "toolCall") throw new Error("Expected a tool call");
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
	stream.push({ type: "done", reason: "toolUse", message });
	stream.end();
	const body = await new Response(encodeStream(stream, "test")).text();
	expect(body).toContain('"thought_signature":"QUJDRA=="');
	expect(body).toContain("data: [DONE]");
});

it("native gateway flushes a keepalive before a silent model and stops on cancellation", async () => {
	const events = new AssistantMessageEventStream();
	let cancelled = false;
	const stream = encodeNativeStream(events, "test", undefined, {
		onCancel: () => {
			cancelled = true;
			events.end();
		},
	});
	const reader = stream.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
	await reader.cancel();
	expect(cancelled).toBe(true);
});
