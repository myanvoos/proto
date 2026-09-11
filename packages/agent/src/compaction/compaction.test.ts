import { describe, expect, test } from "bun:test";
import type { ApiKey, AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { generateSummary } from "./compaction";
import { serializeConversationForSummary } from "./utils";

const RESPONSE = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "summary" }],
	api: "openai-completions" as const,
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
	stopReason: "stop" as const,
	timestamp: 0,
} satisfies AssistantMessage;

function testModel(contextWindow: number): Model {
	return {
		id: "test-model",
		name: "Test",
		api: "openai-completions",
		provider: "test",
		contextWindow,
	} as Model;
}

function user(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp };
}

function toolPair(index: number): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `/tmp/${index}` } }],
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
			stopReason: "toolUse",
			timestamp: index,
		},
		{
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text", text: `result-${index}\n\t🦀` }],
			isError: false,
			timestamp: index,
		},
	];
}

function summaryBudget(contextWindow: number): number {
	const min = Math.min(16_384, Math.max(1_024, Math.floor(contextWindow / 8)));
	return Math.max(min, Math.floor(contextWindow * 0.8) - 16_384);
}

function expectedWindows(messages: Message[], model: Model): string[] {
	const dialect = preferredDialect(model.id);
	const tokenizer = new Tokenizer(model);
	const budget = summaryBudget(model.contextWindow ?? 200_000);
	const windows: Message[][] = [];
	let current: Message[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const tokens = tokenizer.countTokens(serializeConversationForSummary([message], dialect));
		if (currentTokens > 0 && currentTokens + tokens > budget) {
			windows.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(message);
		currentTokens += tokens;
	}
	if (current.length > 0) windows.push(current);
	return windows.map(window => {
		const text = serializeConversationForSummary(window, dialect);
		const check = tokenizer.checkTokenBudget(text, budget);
		if (check.fits) return text;
		const keep = Math.max(1024, Math.floor((text.length * budget * 0.95) / check.tokens));
		if (keep >= text.length) return text;
		return `${text.slice(0, keep)}\n\n[... ${text.length - keep} more characters truncated]`;
	});
}

async function capturedConversations(messages: AgentMessage[], model: Model): Promise<string[]> {
	const conversations: string[] = [];
	await generateSummary(messages, model, 0, "" as ApiKey, undefined, undefined, undefined, {
		promptOverride: "summary",
		completeImpl: async (_model, context, _options) => {
			const content = context.messages[0]?.content;
			if (!Array.isArray(content)) throw new Error("summary prompt has no content");
			const text = content.find((block): block is { type: "text"; text: string } => block.type === "text")?.text;
			if (text === undefined) throw new Error("summary prompt has no text");
			const start = text.indexOf("<conversation>\n") + "<conversation>\n".length;
			const end = text.indexOf("\n</conversation>", start);
			if (start < "<conversation>\n".length || end < 0) throw new Error("summary prompt boundaries missing");
			conversations.push(text.slice(start, end));
			return RESPONSE;
		},
	});
	return conversations;
}

describe("summary window serialization", () => {
	test("keeps short conversations byte-identical", async () => {
		const model = testModel(100_000);
		const messages = [user("short transcript", 0), user("unicode 🙂\n\t", 1)];
		const actual = await capturedConversations(messages, model);
		expect(actual).toEqual([serializeConversationForSummary(messages, preferredDialect(model.id))]);
	});

	test("reuses fragments without changing trimmed tool-call windows", async () => {
		const model = testModel(25_000);
		const messages = Array.from({ length: 120 }, (_, index) => user(`${index}: ${"x".repeat(900)}`, index));
		const toolMessages = Array.from({ length: 160 }, (_, index) => toolPair(index)).flat();
		const actual = await capturedConversations([...messages, ...toolMessages], model);
		const expected = expectedWindows([...messages, ...toolMessages], model);
		expect(actual).toEqual(expected);
		expect(actual.length).toBeGreaterThan(1);
	});

	test("preserves escaping when a boundary tag crosses message fragments", async () => {
		const model = testModel(25_000);
		const messages: Message[] = [
			{ role: "developer", content: "<", timestamp: 0 },
			{ role: "developer", content: "/conversation>", timestamp: 1 },
			...Array.from({ length: 120 }, (_, index) => user(`${index}: ${"x".repeat(900)}`, index + 2)),
		];
		const actual = await capturedConversations(messages, model);
		const expected = expectedWindows(messages, model);
		expect(actual).toEqual(expected);
		expect(actual.length).toBeGreaterThan(1);
	});
});
