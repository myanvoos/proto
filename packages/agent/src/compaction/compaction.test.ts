import { describe, expect, test } from "bun:test";
import type { ApiKey, AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import {
	type CompactionPreparation,
	type CompactionSettings,
	compact,
	consolidateSelfSummary,
	DEFAULT_COMPACTION_SETTINGS,
	generateSelfSummary,
	resolveThresholdTokens,
	shouldCompact,
} from "./compaction";
import { NativeCompactionError } from "./errors";
import {
	appendSelfSummary,
	createFileOps,
	extractSelfSummaries,
	type SummaryMessage,
	serializeConversationForSummary,
	TOOL_RESULT_MIN_CHARS,
	truncateToolResultForSummary,
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
	content: [{ type: "text", text: "summary" }],
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

// Compile-time coverage guard export used by type tests.

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
});

describe("tool result clipping for summaries", () => {
	test("keeps the tail of a clipped tool result instead of only its head", () => {
		const text = `HEAD-MARKER${"x".repeat(50_000)}TAIL-MARKER`;
		const clipped = truncateToolResultForSummary(text);

		expect(clipped).toStartWith("HEAD-MARKER");
		expect(clipped).toEndWith("TAIL-MARKER");
		expect(clipped).toContain("characters truncated from middle");
		expect(clipped.length).toBeLessThan(text.length);
	});
});

describe("remote endpoint compaction", () => {
	const settings: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		remoteEnabled: true,
		remoteStreamingV2Enabled: false,
		remoteEndpoint: "https://compaction.example/api/summarize",
	};

	function endpointCapture(): {
		requests: Array<{ url: string; body: Record<string, unknown> }>;
		fetch: FetchImpl;
	} {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		return {
			requests,
			fetch: (async (input, init) => {
				requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ summary: "endpoint summary text" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as FetchImpl,
		};
	}

	function preparation(): CompactionPreparation {
		return {
			firstKeptEntryId: "kept",
			messagesToSummarize: [user("investigate the failing suite", 0)],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			previousSummary: undefined,
			previousPreserveData: undefined,
			tokensBefore: 0,
			fileOps: createFileOps(),
			settings,
		};
	}

	test("summarizes through the configured endpoint when provider-native compaction is unavailable", async () => {
		const model = testModel(200_000);
		const { requests, fetch } = endpointCapture();

		const result = await compact(preparation(), model, "" as ApiKey, undefined, undefined, { fetch });

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://compaction.example/api/summarize");
		expect(requests[0].body.systemPrompt).toBeString();
		const promptText = String(requests[0].body.prompt);
		expect(promptText).toContain("<conversation>");
		expect(promptText).toContain("investigate the failing suite");
		expect(result.summary).toContain("endpoint summary text");
		expect(result.shortSummary).toBe("Remote compaction");
		expect(result.preserveData).toBeUndefined();
	});

	test("elides oversized transcript middles so the endpoint request fits its input budget", async () => {
		const model = testModel(25_000);
		const oversized = `HEAD_SENTINEL${"a".repeat(25_000)}MIDDLE_SENTINEL${"b".repeat(25_000)}TAIL_SENTINEL`;
		const { requests, fetch } = endpointCapture();

		const prep = preparation();
		prep.messagesToSummarize = [user(oversized, 0)];
		await compact(prep, model, "" as ApiKey, undefined, undefined, { fetch });

		const promptText = String(requests[0].body.prompt);
		expect(promptText).toContain("HEAD_SENTINEL");
		expect(promptText).toContain("TAIL_SENTINEL");
		expect(promptText).not.toContain("MIDDLE_SENTINEL");
		expect(promptText).toContain("characters truncated from middle");
		const tokenizer = new Tokenizer(model);
		expect(tokenizer.checkTokenBudget(promptText, summaryBudget(model.contextWindow ?? 200_000)).fits).toBe(true);
	});

	test("spends the endpoint input budget on wider tool-result clips instead of leaving it unused", async () => {
		const model = testModel(400_000);
		const { requests, fetch } = endpointCapture();
		const [call, result] = toolPair(1);
		const fatResult = {
			...(result as Extract<Message, { role: "toolResult" }>),
			content: [
				{
					type: "text" as const,
					text: `SUITE-START\n${"filler line\n".repeat(4_000)}\nSUITE-VERDICT 3 failed 118 passed`,
				},
			],
		};
		const atFloor = serializeConversationForSummary(
			[user("investigate the failing suite", 0), call, fatResult],
			preferredDialect(model.id),
			{ toolResultMaxChars: TOOL_RESULT_MIN_CHARS },
		);

		const prep = preparation();
		prep.messagesToSummarize = [user("investigate the failing suite", 0), call, fatResult] as AgentMessage[];
		await compact(prep, model, "" as ApiKey, undefined, undefined, { fetch });

		const promptText = String(requests[0].body.prompt);
		expect(promptText.length).toBeGreaterThan(atFloor.length);
		expect(promptText).toContain("SUITE-START");
		expect(promptText).toContain("SUITE-VERDICT 3 failed 118 passed");
	});

	test("fails when neither provider-native nor endpoint compaction can run", async () => {
		const model = testModel(200_000);
		const withoutEndpoint: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			remoteEnabled: true,
			remoteStreamingV2Enabled: false,
			remoteEndpoint: undefined,
		};

		const prep = preparation();
		prep.settings = withoutEndpoint;
		await expect(compact(prep, model, "" as ApiKey)).rejects.toThrow(NativeCompactionError);
	});
});

describe("the session model's own summary section", () => {
	test("appends corrections without rewriting the earlier learning", () => {
		const first = appendSelfSummary("## Goal\nShip the parser rewrite", "Ruled out the streaming parser.");
		const second = appendSelfSummary(first, "Correction: the streaming parser works after flushing its final token.");

		expect(second).toStartWith(first);
		expect(second.match(/<self-summary>/g)).toHaveLength(2);
		expect(second).toContain("Correction: the streaming parser works after flushing its final token.");
	});

	test("restores committed memory instead of a compactor's shortened or duplicated copy", () => {
		const original = appendSelfSummary("old structural summary", "The long-form lesson.\n\n  Exact example: a\tb.");
		const rewritten = "new structural summary\n<self-summary>Only a reading list survived.</self-summary>";
		const next = appendSelfSummary(rewritten, "A new exception to the lesson.", original);

		expect(next).toContain(extractSelfSummaries(original));
		expect(next).not.toContain("Only a reading list survived.");
		expect(next).not.toContain("old structural summary");
		expect(appendSelfSummary(next, "", next)).toBe(next);
	});

	test("a quoted closing wrapper cannot discard the rest of a memory entry on the next compaction", () => {
		const first = appendSelfSummary("summary", "The literal </self-summary> is followed by an important exception.");
		const second = appendSelfSummary("replacement summary", "", first);
		expect(extractSelfSummaries(second)).toBe(extractSelfSummaries(first));
		expect(second).toContain("&lt;/self-summary> is followed by an important exception.");
	});

	test("leaves the summary untouched when the model produced no note", () => {
		const summary = "## Goal\nShip the parser rewrite";

		expect(appendSelfSummary(summary, "  \n  ")).toBe(summary);
	});
});

describe("the context a compaction fires at", () => {
	function withSettings(overrides: Partial<CompactionSettings>): CompactionSettings {
		return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
	}

	/** Unconfigured: `thresholdPercent`/`thresholdTokens` at their "not set" sentinel. */
	const unconfigured = DEFAULT_COMPACTION_SETTINGS;

	test("keeps working knowledge until the effective window needs its reserve", () => {
		// Regression: the 272K worker folded 195,981 tokens despite still having room.
		expect(shouldCompact(195_981, 272_000, unconfigured)).toBe(false);
		expect(shouldCompact(231_200, 272_000, unconfigured)).toBe(false);
		expect(shouldCompact(231_201, 272_000, unconfigured)).toBe(true);
	});

	test("a larger window does not discard a greater fraction of its capacity", () => {
		expect(shouldCompact(450_000, 1_000_000, unconfigured)).toBe(false);
		expect(shouldCompact(850_000, 1_000_000, unconfigured)).toBe(false);
		expect(shouldCompact(850_001, 1_000_000, unconfigured)).toBe(true);
		expect(shouldCompact(1_700_001, 2_000_000, unconfigured)).toBe(true);
	});

	test("small windows and explicit reserves still leave room to produce a summary", () => {
		expect(resolveThresholdTokens(32_768, unconfigured)).toBe(16_384);
		expect(shouldCompact(20_000, 32_768, unconfigured)).toBe(true);
		expect(shouldCompact(25_000, 32_768, withSettings({ reserveTokens: 10_000 }))).toBe(true);
	});

	test("a configured threshold is obeyed as written, early or late", () => {
		const byTokens = withSettings({ thresholdTokens: 100_000 });
		const byPercent = withSettings({ thresholdPercent: 20 });

		expect(resolveThresholdTokens(1_000_000, byTokens)).toBe(100_000);
		expect(shouldCompact(99_000, 1_000_000, byTokens)).toBe(false);
		expect(shouldCompact(101_000, 1_000_000, byTokens)).toBe(true);
		expect(resolveThresholdTokens(1_000_000, byPercent)).toBe(200_000);
	});
});

describe("self-memory safety consolidation", () => {
	test("retains entries below 30%, consolidates at the boundary, then resumes appending", async () => {
		const initial = appendSelfSummary("current structural summary", "Old lesson: qualify the evidence. ".repeat(40));
		const combined = appendSelfSummary(initial, "New correction: the exception applies only before shutdown.");
		const memory = extractSelfSummaries(combined);
		const tokens = new Tokenizer().countTokens(memory, "strict");
		let requests = 0;
		const options = {
			systemPrompt: [],
			completeImpl: async (_model: Model, context: { messages: Message[] }) => {
				requests++;
				const replay = JSON.stringify(context.messages[0]);
				expect(replay).toContain("Old lesson: qualify the evidence.");
				expect(replay).toContain("the exception applies only before shutdown");
				expect(replay).not.toContain("current structural summary");
				return {
					...RESPONSE,
					content: [
						{ type: "text" as const, text: "Qualify the evidence; the exception applies only before shutdown." },
					],
				};
			},
		};
		const below = await consolidateSelfSummary(combined, testModel((tokens + 1) / 0.3), "test-key", options);
		expect(requests).toBe(0);
		expect(extractSelfSummaries(below)).toBe(memory);

		const consolidated = await consolidateSelfSummary(combined, testModel(tokens / 0.3), "test-key", options);
		expect(requests).toBe(1);
		expect(consolidated).toStartWith("current structural summary");
		expect(consolidated.match(/<self-summary>/g)).toHaveLength(1);
		expect(consolidated).toContain("Qualify the evidence; the exception applies only before shutdown.");
		expect(new Tokenizer().countTokens(extractSelfSummaries(consolidated), "strict")).toBeLessThan(tokens);
		expect(appendSelfSummary(consolidated, "Next lesson.")).toStartWith(consolidated);
	});
});

describe("self-summary working knowledge", () => {
	test("replays earlier learning, full source results, and the latest request together", async () => {
		const source = "A reference passage with a consequential exception. ".repeat(200);
		const read = toolPair(0);
		const result = read[1];
		if (result.role !== "toolResult") throw new Error("Expected a source result");
		result.content = [{ type: "text", text: source }];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "latest",
			messagesToSummarize: [user("Learn the voice before writing.", 0), ...read],
			turnPrefixMessages: [user("Compare the exception to the earlier reference.", 1)],
			recentMessages: [user("Keep the narrator's uncertainty, not just the short sentences.", 2)],
			previousSummary:
				"<self-summary>Earlier reference: unreliable chronology, not an unreliable witness.</self-summary>",
			isSplitTurn: true,
			tokensBefore: 195_981,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		await generateSelfSummary(preparation, testModel(272_000), "test-key", {
			systemPrompt: ["session instructions"],
			completeImpl: async (_model, context) => {
				const [previous, task, call, content, comparison, correction] = context.messages;
				expect(previous.content).toEqual([
					{ type: "text", text: expect.stringContaining("unreliable chronology, not an unreliable witness") },
				]);
				expect(task).toMatchObject(preparation.messagesToSummarize[0]);
				expect(call.content).toEqual(read[0].content);
				expect(content).toMatchObject({
					role: "toolResult",
					toolCallId: result.toolCallId,
					content: result.content,
				});
				expect(comparison).toMatchObject(preparation.turnPrefixMessages[0]);
				expect(correction).toMatchObject(preparation.recentMessages[0]);
				return RESPONSE;
			},
		});
	});

	test.each([
		{ history: 1_000, limit: 64_000, needed: 4_096, ceiling: 4_096 },
		{ history: 195_981, limit: 64_000, needed: 19_000, ceiling: 19_599 },
		{ history: 850_000, limit: 64_000, needed: 32_000, ceiling: 32_768 },
		{ history: 850_000, limit: 8_192, needed: 8_000, ceiling: 8_192 },
	])(
		"keeps learned detail within the provider output limit ($history input, $limit output)",
		async ({ history, limit, needed, ceiling }) => {
			const note = `${"Lesson and evidence. ".repeat(needed / 4)}Final exception: leave the cause unresolved.`;
			const summary = await generateSelfSummary(
				{
					firstKeptEntryId: "latest",
					messagesToSummarize: [user("Reference corpus", 0)],
					turnPrefixMessages: [],
					recentMessages: [],
					isSplitTurn: false,
					tokensBefore: history,
					fileOps: createFileOps(),
					settings: DEFAULT_COMPACTION_SETTINGS,
				},
				{ ...testModel(1_000_000), maxTokens: limit },
				"test-key",
				{
					systemPrompt: [],
					completeImpl: async (_model, _context, options) => {
						// Simulate a provider rejecting oversized allowances or truncating the learned content.
						if (options.maxTokens === undefined || options.maxTokens > ceiling)
							throw new Error("Output limit exceeded");
						return {
							...RESPONSE,
							content: [{ type: "text", text: options.maxTokens >= needed ? note : "Truncated learning" }],
						};
					},
				},
			);
			expect(summary).toEndWith("Final exception: leave the cause unresolved.");
		},
	);
});

function nativeOpenAiModel(): Model {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {},
	} as Model;
}

describe("entering native replay from a local summary", () => {
	test("the first native request carries the local summary once and later requests replay only native history", async () => {
		const requests: string[] = [];
		const fetchMock: FetchImpl = async (_url, init) => {
			requests.push(String(init?.body));
			const item = { type: "compaction", encrypted_content: `history-${requests.length}` };
			return new Response(JSON.stringify({ output: [item] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const model = nativeOpenAiModel();
		const preparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [user("long history", 0)],
			turnPrefixMessages: [],
			recentMessages: [user("recent", 0)],
			isSplitTurn: false,
			tokensBefore: 0,
			previousSummary: "Archived decision: use port 4242.",
			previousPreserveData: undefined,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: true, remoteStreamingV2Enabled: false },
		};

		const first = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });
		expect(requests[0].match(/Archived decision: use port 4242\./g)).toHaveLength(1);
		expect(requests[0]).toContain("long history");

		await compact(
			{ ...preparation, previousSummary: first.summary, previousPreserveData: first.preserveData },
			model,
			"test-key",
			undefined,
			undefined,
			{ fetch: fetchMock },
		);
		expect(requests[1].match(/history-1/g)).toHaveLength(1);
		expect(requests[1]).not.toContain(first.summary);
		expect(requests[1]).not.toContain("Archived decision");
	});
});

describe("V2 native compaction summary", () => {
	test("reports the provider-reported usage as processed input, not as retained history", async () => {
		const model = {
			...nativeOpenAiModel(),
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		} as Model;
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const events = [
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{ type: "response.completed", response: { usage: { input_tokens: 55, output_tokens: 1, total_tokens: 56 } } },
		];
		const fetchMock: FetchImpl = async () =>
			new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		const result = await compact(
			{
				firstKeptEntryId: "kept",
				messagesToSummarize: [user("long history", 0)],
				turnPrefixMessages: [],
				recentMessages: [user("recent", 0)],
				isSplitTurn: false,
				tokensBefore: 0,
				fileOps: createFileOps(),
				settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: true },
			},
			model,
			"test-key",
			undefined,
			undefined,
			{ fetch: fetchMock },
		);
		expect(result.summary).toContain("Compaction processed 55 input tokens");
		expect(result.summary).not.toContain("Retained");
	});
});
