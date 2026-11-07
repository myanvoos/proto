import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Model, ToolCall } from "../types";
import { convertMessages } from "./openai-completions";

const model: Model<"openai-completions"> = buildModel({
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
});

interface AssistantWireMessage {
	role: "assistant";
	content?: unknown;
	reasoning_content?: unknown;
}

function findAssistant(messages: readonly unknown[]): AssistantWireMessage | undefined {
	return messages.find(
		(message): message is AssistantWireMessage =>
			typeof message === "object" && message !== null && Reflect.get(message, "role") === "assistant",
	);
}

/** A turn another API produced: unsigned reasoning plus a tool call replayed to DeepSeek. */
function crossApiToolCallTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Need to preserve cross-api reasoning.",
				thinkingSignature: "sig_from_anthropic",
			},
			{
				type: "toolCall",
				id: "toolu_cross_api",
				name: "read",
				arguments: { path: "README.md" },
			} as ToolCall,
		],
		api: "anthropic-messages",
		provider: "zai",
		model: "claude-compatible",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("DeepSeek reasoning_content replay", () => {
	it("hoists demoted cross-API thinking out of content instead of sending an empty reasoning_content", () => {
		const compat = model.compat;
		// The branch only exists for exact-replay providers that reject placeholders.
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);

		const assistant = findAssistant(convertMessages(model, { messages: [crossApiToolCallTurn()] }, compat));
		expect(assistant?.reasoning_content).toBe("Need to preserve cross-api reasoning.");
		const content = typeof assistant?.content === "string" ? assistant.content : "";
		expect(content).not.toContain(" thinking");
	});
});
