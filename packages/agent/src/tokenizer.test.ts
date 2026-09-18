import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	DeveloperMessage,
	ProviderPayload,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import type { CompactionSummaryMessage, CustomMessage } from "./compaction/messages";
import { Tokenizer } from "./tokenizer";
import type { AgentMessage } from "./types";

const tokenizer = new Tokenizer();
const timestamp = 1;

function assistantWithImage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function nativeHistory(text: string): ProviderPayload {
	return {
		type: "openaiResponsesHistory",
		provider: "openai",
		items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
	};
}

describe("Tokenizer.countMessage context accounting", () => {
	test("developer instructions cannot disappear from context-usage accounting", () => {
		const short: DeveloperMessage = {
			role: "developer",
			content: [{ type: "text", text: "x".repeat(10) }],
			timestamp,
		};
		const long: DeveloperMessage = {
			role: "developer",
			content: [{ type: "text", text: "x".repeat(1_000) }],
			timestamp,
		};

		const shortCount = tokenizer.countMessage(short);
		const longCount = tokenizer.countMessage(long);

		expect(shortCount).toBeGreaterThan(0);
		expect(longCount).toBeGreaterThan(shortCount * 50);
	});

	test("custom string context cannot silently count as zero", () => {
		const short: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "x".repeat(10),
			display: false,
			timestamp,
		};
		const long: CustomMessage = { ...short, content: "x".repeat(1_000) };

		const shortCount = tokenizer.countMessage(short);
		const longCount = tokenizer.countMessage(long);

		expect(shortCount).toBeGreaterThan(0);
		expect(longCount).toBeGreaterThan(shortCount * 50);
	});

	test("images cost the same tokens in user, assistant, custom, and tool-result context", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const user: UserMessage = { role: "user", content: [image], timestamp };
		const custom: CustomMessage = {
			role: "custom",
			customType: "test",
			content: [image],
			display: false,
			timestamp,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [image],
			isError: false,
			timestamp,
		};

		const establishedImageCost = tokenizer.countMessage(toolResult);

		expect(establishedImageCost).toBeGreaterThan(100);
		expect(tokenizer.countMessage(user)).toBe(establishedImageCost);
		expect(tokenizer.countMessage(custom)).toBe(establishedImageCost);
		expect(tokenizer.countMessage(assistantWithImage())).toBe(establishedImageCost);
	});

	test("native compaction history cannot be reduced to the tiny display summary", () => {
		const payloadText = "x".repeat(40_000);
		const withoutPayload: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "tiny",
			tokensBefore: 20_000,
			timestamp,
		};
		const withPayload: CompactionSummaryMessage = {
			...withoutPayload,
			providerPayload: nativeHistory(payloadText),
		};

		const summaryCount = tokenizer.countMessage(withoutPayload);
		const payloadCount = tokenizer.countMessage(withPayload);
		const textCount = tokenizer.countTokens(payloadText);

		expect(payloadCount).toBeGreaterThan(summaryCount * 1_000);
		expect(payloadCount).toBeGreaterThanOrEqual(textCount);
		expect(payloadCount).toBeLessThan(textCount * 1.1);
	});

	test("native-history images use media accounting instead of base64 text inflation", () => {
		const payload: ProviderPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(40_000)}` }],
				},
			],
		};
		const summary: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "tiny",
			tokensBefore: 20_000,
			providerPayload: payload,
			timestamp,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			isError: false,
			timestamp,
		};

		expect(tokenizer.countMessage(summary)).toBe(tokenizer.countMessage(toolResult));
	});

	test("future roles receive a conservative estimate instead of silent zero", () => {
		const shortUnknown = {
			role: "futureRole",
			content: "x".repeat(10),
			timestamp,
		} as unknown as AgentMessage;
		const longUnknown = {
			role: "futureRole",
			content: "x".repeat(1_000),
			timestamp,
		} as unknown as AgentMessage;

		const shortCount = tokenizer.countMessage(shortUnknown);
		const longCount = tokenizer.countMessage(longUnknown);

		expect(shortCount).toBeGreaterThan(0);
		expect(longCount).toBeGreaterThan(shortCount * 50);
	});

	test("future content blocks receive a conservative estimate instead of silent zero", () => {
		const shortUnknown = {
			role: "user",
			content: [{ type: "futureText", value: "x".repeat(10) }],
			timestamp,
		} as unknown as AgentMessage;
		const longUnknown = {
			role: "user",
			content: [{ type: "futureText", value: "x".repeat(1_000) }],
			timestamp,
		} as unknown as AgentMessage;
		const opaqueUnknown = {
			role: "user",
			content: [{ type: "futureBinary", bytes: 42 }],
			timestamp,
		} as unknown as AgentMessage;

		const shortCount = tokenizer.countMessage(shortUnknown);
		const longCount = tokenizer.countMessage(longUnknown);

		expect(shortCount).toBeGreaterThan(0);
		expect(longCount).toBeGreaterThan(shortCount * 50);
		expect(tokenizer.countMessage(opaqueUnknown)).toBeGreaterThan(0);
	});
});
