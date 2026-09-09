import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage } from "../types";
import { transformMessages } from "./transform-messages";

const OPAQUE_TOOL_CALL_ID = `call_abc123/thoughtSignature=CiQBxY9z${"a".repeat(80)}==`;
const ANTHROPIC_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function makeModel(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-gemini",
		id: "gemini-3-pro",
		name: "Gemini through an Anthropic-compatible proxy",
		baseUrl: "https://proxy.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 1_000_000,
		reasoning: true,
	} satisfies ModelSpec<"anthropic-messages">);
}

function assistantWithCall(source: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: OPAQUE_TOOL_CALL_ID, name: "get_weather", arguments: { location: "Paris" } }],
		api: "anthropic-messages",
		provider: "custom-gemini",
		model: "gemini-3-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...source,
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: OPAQUE_TOOL_CALL_ID,
		toolName: "get_weather",
		content: [{ type: "text", text: "15C" }],
		isError: false,
		timestamp: 0,
	};
}

function transformedIds(messages: Message[]): { callId: string | undefined; resultId: string | undefined } {
	const transformed = transformMessages(messages, makeModel());
	const assistant = transformed.find(message => message.role === "assistant");
	const callId =
		assistant?.role === "assistant" ? assistant.content.find(block => block.type === "toolCall")?.id : undefined;
	const result = transformed.find(message => message.role === "toolResult");
	return { callId, resultId: result?.role === "toolResult" ? result.toolCallId : undefined };
}

describe("Anthropic-compatible tool-call id replay", () => {
	it("preserves a custom endpoint's same-model opaque call/result pair", () => {
		const ids = transformedIds([
			{ role: "user", content: "weather?", timestamp: 0 },
			assistantWithCall({}),
			toolResult(),
		]);

		expect(ids).toEqual({ callId: OPAQUE_TOOL_CALL_ID, resultId: OPAQUE_TOOL_CALL_ID });
	});

	it("normalizes a foreign opaque id for an Anthropic-compatible target", () => {
		const ids = transformedIds([
			{ role: "user", content: "weather?", timestamp: 0 },
			assistantWithCall({ provider: "openai", model: "gpt-4" }),
			toolResult(),
		]);

		expect(ids.callId).not.toBe(OPAQUE_TOOL_CALL_ID);
		expect(ids.callId).toMatch(ANTHROPIC_TOOL_CALL_ID_PATTERN);
		expect(ids.resultId).toBe(ids.callId);
	});
});
