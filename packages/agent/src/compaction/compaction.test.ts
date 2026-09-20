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
	compactionThresholdRatio,
	DEFAULT_COMPACTION_SETTINGS,
	resolveThresholdTokens,
	shouldCompact,
} from "./compaction";
import { NativeCompactionError } from "./errors";
import {
	createFileOps,
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

describe("the context a compaction fires at", () => {
	function withSettings(overrides: Partial<CompactionSettings>): CompactionSettings {
		return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
	}

	/** Unconfigured: `thresholdPercent`/`thresholdTokens` at their "not set" sentinel. */
	const unconfigured = DEFAULT_COMPACTION_SETTINGS;

	test("an unconfigured window compacts at the anchor ratio for its size", () => {
		// The share of the window a session may fill falls as the window grows.
		expect(resolveThresholdTokens(131_072, unconfigured)).toBe(104_857);
		expect(resolveThresholdTokens(262_144, unconfigured)).toBe(183_500);
		expect(resolveThresholdTokens(1_048_576, unconfigured)).toBe(419_430);
	});

	test("a window between anchors interpolates instead of stepping", () => {
		const ratio = compactionThresholdRatio(200_000);

		expect(ratio).toBeGreaterThan(compactionThresholdRatio(262_144));
		expect(ratio).toBeLessThan(compactionThresholdRatio(131_072));
		expect(resolveThresholdTokens(200_000, unconfigured)).toBe(149_482);
	});

	test("windows past the last anchor hold its ratio rather than falling further", () => {
		expect(compactionThresholdRatio(4_000_000)).toBe(0.4);
		expect(resolveThresholdTokens(2_000_000, unconfigured)).toBe(800_000);
	});

	test("a window too small for the curve's headroom is bounded by the room a compaction needs", () => {
		// 90% of 32k would leave less than the summary itself needs, so the reserve governs.
		expect(compactionThresholdRatio(32_768)).toBe(0.9);
		expect(resolveThresholdTokens(32_768, unconfigured)).toBe(16_384);
		expect(shouldCompact(20_000, 32_768, unconfigured)).toBe(true);
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
