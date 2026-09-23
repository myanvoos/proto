import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage, Usage } from "../types";
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

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const RESPONSES_SOURCE = { api: "openai-responses", provider: "openai", model: "gpt-5-codex" } as const;
const COMPLETIONS_SOURCE = { api: "openai-completions", provider: "openai", model: "gpt-4o" } as const;

function responsesModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		provider: "openai",
		id: "gpt-5-codex",
		name: "GPT-5 Codex",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} satisfies ModelSpec<"openai-responses">);
}

function completionsModel(): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		provider: "openai",
		id: "gpt-4o",
		name: "GPT-4o",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 128_000,
		reasoning: false,
	} satisfies ModelSpec<"openai-completions">);
}

function assistantCalling(
	source: Pick<AssistantMessage, "api" | "provider" | "model">,
	ids: string[],
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		...source,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp,
	};
}

function resultFor(id: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function callIds(messages: Message[]): string[] {
	return messages.flatMap(message =>
		message.role === "assistant"
			? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
			: [],
	);
}

function resultTexts(messages: Message[]): Record<string, string> {
	const texts: Record<string, string> = {};
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		texts[message.toolCallId] = message.content.map(part => (part.type === "text" ? part.text : "")).join("");
	}
	return texts;
}

describe("Responses composite tool-call id pairing", () => {
	it("pairs composite results with their call_ component instead of stubbing them", () => {
		const transformed = transformMessages(
			[
				{ role: "user", content: "read both", timestamp: 1 },
				assistantCalling(RESPONSES_SOURCE, ["call_AAA", "call_BBB"], 2),
				resultFor("call_AAA|fc_SHARED", "result A", 3),
				resultFor("call_BBB|fc_SHARED", "result B", 4),
			],
			responsesModel(),
		);

		expect(resultTexts(transformed)).toEqual({ "call_AAA|fc_SHARED": "result A", "call_BBB|fc_SHARED": "result B" });
	});

	it("keeps both real results when a Responses call_id is reused across turns", () => {
		const transformed = transformMessages(
			[
				{ role: "user", content: "read", timestamp: 1 },
				assistantCalling(RESPONSES_SOURCE, ["call_REUSE"], 2),
				resultFor("call_REUSE|fc_T1", "result one", 3),
				assistantCalling(RESPONSES_SOURCE, ["call_REUSE"], 4),
				resultFor("call_REUSE|fc_T2", "result two", 5),
			],
			responsesModel(),
		);

		expect(callIds(transformed)).toEqual(["call_REUSE", "call_REUSE_dup1"]);
		expect(resultTexts(transformed)).toEqual({ "call_REUSE|fc_T1": "result one", call_REUSE_dup1: "result two" });
	});

	it.each([
		{ callId: "call_A", emittedId: "call_A" },
		{ callId: "call_A|fc_CALL", emittedId: "call_A_fc_CALL" },
	])("moves a composite result onto the emitted Anthropic id for Responses call $callId", ({ callId, emittedId }) => {
		const transformed = transformMessages(
			[
				{ role: "user", content: "read", timestamp: 1 },
				assistantCalling(RESPONSES_SOURCE, [callId], 2),
				resultFor("call_A|fc_RESULT", "found", 3),
			],
			makeModel(),
		);

		expect(callIds(transformed)).toEqual([emittedId]);
		expect(resultTexts(transformed)).toEqual({ [emittedId]: "found" });
	});

	it("pairs pipe-bearing Chat Completions ids by exact id even when a Responses call shares their prefix", () => {
		const transformed = transformMessages(
			[
				{ role: "user", content: "read", timestamp: 1 },
				assistantCalling(RESPONSES_SOURCE, ["call_A"], 2),
				resultFor("call_A|fc_R", "responses output", 3),
				{ role: "user", content: "read twice", timestamp: 4 },
				assistantCalling(COMPLETIONS_SOURCE, ["call_A|first", "call_A|second"], 5),
				resultFor("call_A|second", "second output", 6),
			],
			completionsModel(),
		);

		expect(callIds(transformed)).toEqual(["call_A", "call_A|first", "call_A|second"]);
		expect(resultTexts(transformed)).toEqual({
			"call_A|fc_R": "responses output",
			"call_A|first": "No result provided",
			"call_A|second": "second output",
		});
	});
});
