import { describe, expect, test } from "bun:test";
import type { ApiKey, AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
	MIN_COMPACTION_CONTEXT_TOKENS,
	resolveThresholdTokens,
	shouldCompact,
} from "./compaction";
import {
	type SummaryMessage,
	serializeConversationForSummary,
	TOOL_RESULT_MIN_CHARS,
	truncateToolResultForSummary,
	upsertSelfSummary,
} from "./utils";

const DIALECTS = [
	"glm",
	"hermes",
	"kimi",
	"xml",
	"anthropic",
	"deepseek",
	"harmony",
	"qwen3",
	"gemini",
	"gemma",
	"minimax",
] as const satisfies readonly Dialect[];

type AssertNever<T extends never> = T;
type AllDialectsCovered = AssertNever<Exclude<Dialect, (typeof DIALECTS)[number]>>;
type AllSummaryRolesCovered = AssertNever<
	Exclude<
		SummaryMessage["role"],
		| "user"
		| "developer"
		| "assistant"
		| "toolResult"
		| "custom"
		| "hookMessage"
		| "branchSummary"
		| "compactionSummary"
	>
>;
// Compile-time coverage guard: AssertNever fails to type-check at this definition if a new
// Dialect or SummaryMessage role is added without extending the lists above, so summary
// serialization can never silently skip one. Exported because its value is the type error.
export type SummarySerializationTypeCoverage = [AllDialectsCovered, AllSummaryRolesCovered];

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
		const headLength = Math.ceil(keep / 2);
		const tailLength = Math.floor(keep / 2);
		return `${text.slice(0, headLength)}\n\n[... ${text.length - keep} characters truncated from middle ...]\n\n${text.slice(-tailLength)}`;
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

describe("content silently dropped from the compaction summary input", () => {
	test("serializes user images, developer instructions, and tool-result images in every dialect", () => {
		const imageData = "RAW_BASE64_IMAGE_DATA_MUST_NOT_APPEAR";
		const cases: Array<{ message: Message; expected: string }> = [
			{
				message: {
					role: "user",
					content: [{ type: "image", data: imageData, mimeType: "image/png" }],
					timestamp: 0,
				},
				expected: "[Image: image/png]",
			},
			{
				message: {
					role: "developer",
					content: [{ type: "text", text: "DO NOT DROP" }],
					timestamp: 0,
				},
				expected: "DO NOT DROP",
			},
			{
				message: {
					role: "toolResult",
					toolCallId: "image-call",
					toolName: "inspect_media",
					content: [{ type: "image", data: imageData, mimeType: "image/jpeg" }],
					isError: false,
					timestamp: 0,
				},
				expected: "[Image: image/jpeg]",
			},
		];

		for (const dialect of [undefined, ...DIALECTS]) {
			for (const { message, expected } of cases) {
				const serialized = serializeConversationForSummary([message], dialect);
				expect(serialized).toContain(expected);
				expect(serialized).not.toContain(imageData);
			}
		}
	});

	test("serializes every user and assistant content block without image bytes", () => {
		const imageData = "RAW_ASSISTANT_IMAGE_DATA_MUST_NOT_APPEAR";
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "user text" },
					{ type: "image", data: imageData, mimeType: "image/webp" },
					{ type: "audio", data: "audio-data", mimeType: "audio/wav" },
					{ type: "video", data: "video-data", mimeType: "video/mp4" },
				],
				timestamp: 0,
			},
			{
				...RESPONSE,
				content: [
					{ type: "text", text: "assistant text" },
					{ type: "thinking", thinking: "assistant thinking" },
					{ type: "redactedThinking", data: "opaque-redacted-data" },
					{ type: "fallback", from: { model: "old-model" }, to: { model: "new-model" } },
					{
						type: "anthropicServerTool",
						block: { type: "server_tool_use", id: "server-call", name: "web_search", input: { query: "needle" } },
					},
					{
						type: "anthropicServerTool",
						block: { type: "web_search_tool_result", tool_use_id: "server-call", content: "search result" },
					},
					{ type: "image", data: imageData, mimeType: "image/gif" },
					{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "needle.txt" } },
				],
			},
		];
		const expected = [
			"user text",
			"[Image: image/webp]",
			"[Audio: audio/wav]",
			"[Video: video/mp4]",
			"assistant text",
			"assistant thinking",
			"[Redacted thinking]",
			"[Model fallback: old-model -> new-model]",
			"server-call",
			"search result",
			"[Image: image/gif]",
			"read",
			"needle.txt",
		];

		for (const dialect of [undefined, ...DIALECTS]) {
			const serialized = serializeConversationForSummary(messages, dialect);
			for (const value of expected) expect(serialized).toContain(value);
			expect(serialized).not.toContain(imageData);
		}
	});

	test("serializes every extended compaction message role", () => {
		const messages: SummaryMessage[] = [
			{ role: "custom", customType: "bus-event", content: "CUSTOM CONTENT", display: false, timestamp: 0 },
			{ role: "hookMessage", customType: "hook-event", content: "HOOK CONTENT", display: false, timestamp: 0 },
			{ role: "branchSummary", summary: "BRANCH CONTENT", fromId: "branch-id", timestamp: 0 },
			{ role: "compactionSummary", summary: "COMPACTION CONTENT", tokensBefore: 42, timestamp: 0 },
		];

		for (const dialect of [undefined, ...DIALECTS]) {
			const serialized = serializeConversationForSummary(messages, dialect);
			for (const value of ["CUSTOM CONTENT", "HOOK CONTENT", "BRANCH CONTENT", "COMPACTION CONTENT"]) {
				expect(serialized).toContain(value);
			}
		}
	});

	test("retains the head and tail while visibly eliding the middle within the summary budget", async () => {
		const model = testModel(25_000);
		const head = "HEAD_SENTINEL";
		const middle = "MIDDLE_SENTINEL";
		const tail = "TAIL_SENTINEL";
		const oversized = `${head}${"a".repeat(25_000)}${middle}${"b".repeat(25_000)}${tail}`;
		const actual = await capturedConversations([user(oversized, 0)], model);
		expect(actual).toHaveLength(1);
		expect(actual[0]).toContain(head);
		expect(actual[0]).not.toContain(middle);
		expect(actual[0]).toContain(tail);
		expect(actual[0]).toContain("[... ");
		expect(actual[0]).toContain(" characters truncated from middle ...]");
		const tokenizer = new Tokenizer(model);
		expect(tokenizer.checkTokenBudget(actual[0]!, summaryBudget(model.contextWindow ?? 200_000)).fits).toBe(true);
	});
});

function bigToolResult(index: number, head: string, tail: string): Message[] {
	const [call, result] = toolPair(index);
	return [
		call,
		{
			...(result as Extract<Message, { role: "toolResult" }>),
			content: [{ type: "text", text: `${head}\n${"filler line\n".repeat(4_000)}${tail}` }],
		},
	];
}

describe("detail-heavy tool results reaching the summarizer", () => {
	test("keeps the tail of a clipped tool result instead of only its head", () => {
		const text = `HEAD-MARKER${"x".repeat(50_000)}TAIL-MARKER`;
		const clipped = truncateToolResultForSummary(text);

		expect(clipped).toStartWith("HEAD-MARKER");
		expect(clipped).toEndWith("TAIL-MARKER");
		expect(clipped).toContain("characters truncated from middle");
		expect(clipped.length).toBeLessThan(text.length);
	});

	test("spends spare input budget on wider tool results instead of leaving it unused", async () => {
		const model = testModel(400_000);
		const messages = [
			user("investigate the failing suite", 0),
			...bigToolResult(1, "SUITE-START", "SUITE-VERDICT 3 failed 118 passed"),
		];
		const atFloor = serializeConversationForSummary(messages, preferredDialect(model.id), {
			toolResultMaxChars: TOOL_RESULT_MIN_CHARS,
		});

		const actual = await capturedConversations(messages as AgentMessage[], model);

		expect(actual).toHaveLength(1);
		expect(actual[0].length).toBeGreaterThan(atFloor.length);
		expect(actual[0]).toContain("SUITE-START");
		expect(actual[0]).toContain("SUITE-VERDICT 3 failed 118 passed");
	});

	test("holds the floor clip when the transcript cannot fit a single window", async () => {
		const model = testModel(25_000);
		const messages = Array.from({ length: 12 }, (_, index) =>
			bigToolResult(index, `START-${index}`, `VERDICT-${index}`),
		).flat();

		const actual = await capturedConversations(messages as AgentMessage[], model);

		expect(actual.length).toBeGreaterThan(1);
		expect(actual).toEqual(expectedWindows(messages, model));
	});
});

describe("the session model's own summary section", () => {
	test("replaces the previous round's note instead of stacking a second one", () => {
		const first = upsertSelfSummary("## Goal\nShip the parser rewrite", "Ruled out the streaming parser.");
		const second = upsertSelfSummary(first, "parser.ts:88 is applied but unverified.");

		expect(second.match(/<self-summary>/g)).toHaveLength(1);
		expect(second).toContain("## Goal\nShip the parser rewrite");
		expect(second).toContain("parser.ts:88 is applied but unverified.");
		expect(second).not.toContain("Ruled out the streaming parser.");
	});

	test("leaves the summary untouched when the model produced no note", () => {
		const summary = "## Goal\nShip the parser rewrite";

		expect(upsertSelfSummary(summary, "  \n  ")).toBe(summary);
	});
});

describe("the minimum context a compaction may fire at", () => {
	function withSettings(overrides: Partial<CompactionSettings>): CompactionSettings {
		return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
	}

	test("holds an early configured threshold up to the floor on a window that can carry it", () => {
		const settings = withSettings({ thresholdTokens: 100_000 });

		expect(resolveThresholdTokens(1_000_000, settings)).toBe(MIN_COMPACTION_CONTEXT_TOKENS);
		expect(shouldCompact(MIN_COMPACTION_CONTEXT_TOKENS - 1_000, 1_000_000, settings)).toBe(false);
		expect(shouldCompact(MIN_COMPACTION_CONTEXT_TOKENS + 1_000, 1_000_000, settings)).toBe(true);
	});

	test("holds an early configured percentage up to the floor", () => {
		const settings = withSettings({ thresholdPercent: 20 });

		expect(resolveThresholdTokens(1_000_000, settings)).toBe(MIN_COMPACTION_CONTEXT_TOKENS);
		expect(resolveThresholdTokens(2_000_000, settings)).toBe(400_000);
	});

	test("drops the floor on a window too small to reach it, leaving the setting in force", () => {
		const settings = withSettings({ thresholdPercent: 50 });

		expect(resolveThresholdTokens(200_000, settings)).toBe(100_000);
		expect(shouldCompact(120_000, 200_000, settings)).toBe(true);
	});
});
