import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { DEFAULT_COMPACTION_SETTINGS, findCutPoint, prepareCompaction } from "./compaction";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "./entries";

const tokenizer = new Tokenizer();
const settings = { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false };

const USAGE = {
	input: 0,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let seq = 0;
function base() {
	return { id: `e${seq++}`, parentId: null, timestamp: new Date(0).toISOString() };
}

function entry(message: AgentMessage): SessionMessageEntry {
	return { ...base(), type: "message", message };
}

function user(text: string): SessionMessageEntry {
	return entry({ role: "user", content: text, timestamp: 0 });
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: USAGE,
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0,
	};
}

function assistant(text: string): SessionMessageEntry {
	return entry(assistantMessage([{ type: "text", text }]));
}

function toolResult(toolCallId: string, text: string): SessionMessageEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
	return entry(message);
}

function compaction(summary: string, firstKeptEntryId: string): CompactionEntry {
	return { ...base(), type: "compaction", summary, firstKeptEntryId, tokensBefore: 0 };
}

function messagesOf(...entries: SessionMessageEntry[]): AgentMessage[] {
	return entries.map(e => e.message);
}

const NATIVE_PAYLOAD = {
	openaiRemoteCompaction: {
		provider: "openai",
		replacementHistory: [{ type: "compaction", encrypted_content: "replay" }],
		compactionItem: { type: "compaction", encrypted_content: "replay" },
	},
};

function openAiModel(api: Model["api"]): Model {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api,
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

describe("findCutPoint retention budget", () => {
	test("summarizes an older oversized step instead of keeping it past the recent-history budget", () => {
		// One user turn with a ~22k-token step followed by a ~18k-token step: keeping both defeats a 20k budget.
		const older = entry(
			assistantMessage([
				{ type: "thinking", thinking: "r".repeat(87_382) },
				{ type: "toolCall", id: "older-call", name: "read", arguments: {} },
			]),
		);
		const latest = entry(
			assistantMessage([
				{ type: "thinking", thinking: "r".repeat(67_448) },
				{ type: "text", text: "t".repeat(1_412) },
				{ type: "toolCall", id: "latest-call", name: "read", arguments: {} },
			]),
		);
		const latestResult = toolResult("latest-call", "small result");
		const entries = [
			user("Continue the review"),
			older,
			toolResult("older-call", "small result"),
			latest,
			latestResult,
		];

		const preparation = prepareCompaction(entries, { ...settings, keepRecentTokens: 20_000 });
		expect(preparation?.firstKeptEntryId).toBe(latest.id);
		expect(preparation?.turnPrefixMessages).toContain(older.message);
		expect(preparation?.recentMessages).toEqual(messagesOf(latest, latestResult));
		expect(tokenizer.countMessages(preparation!.recentMessages)).toBeLessThanOrEqual(20_000);
	});

	test("keeps the newest oversized tool group without dragging earlier history into the tail", () => {
		const entries = [
			user("Old request"),
			assistant("Old answer"),
			entry(assistantMessage([{ type: "toolCall", id: "large-call", name: "read", arguments: {} }])),
			toolResult("large-call", "x".repeat(100_000)),
		];
		expect(findCutPoint(entries, tokenizer, 0, entries.length, 20_000).firstKeptEntryIndex).toBe(2);
	});

	test("does not re-admit an oversized custom message while pulling metadata into the kept region", () => {
		const custom: SessionEntry = {
			...base(),
			type: "custom_message",
			customType: "test",
			content: "x".repeat(100_000),
			display: true,
		};
		const answer = assistant("small answer");
		const entries = [custom, answer];

		const cut = findCutPoint(entries, tokenizer, 0, entries.length, 20_000);
		expect(cut).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: 0, isSplitTurn: true });
		expect(prepareCompaction(entries, { ...settings, keepRecentTokens: 20_000 })?.recentMessages).toEqual([
			answer.message,
		]);
	});

	test("a kept custom message opens its own turn instead of splitting the previous one", () => {
		const custom: SessionEntry = {
			...base(),
			type: "custom_message",
			customType: "test",
			content: "small question",
			display: true,
		};
		const entries = [assistant("x".repeat(100_000)), custom, assistant("small answer")];
		expect(findCutPoint(entries, tokenizer, 0, entries.length, 20_000)).toEqual({
			firstKeptEntryIndex: 1,
			turnStartIndex: -1,
			isSplitTurn: false,
		});
	});
});

describe("prepareCompaction retained history", () => {
	test("partitions a local summary's retained tail on the next pass instead of skipping it", () => {
		const a = user("Already summarized A");
		const b1 = user("Retained B1");
		const b2 = user("Retained B2");
		const modelChange: SessionEntry = { ...base(), type: "model_change", model: "openai/gpt-5" };
		const entries: SessionEntry[] = [a, b1, modelChange, b2];
		const first = prepareCompaction(entries, {
			...settings,
			keepRecentTokens: tokenizer.countMessages(messagesOf(b1, b2)),
		});
		expect(first?.messagesToSummarize).toEqual([a.message]);
		expect(first?.recentMessages).toEqual(messagesOf(b1, b2));
		entries.push(compaction("Summary A", first!.firstKeptEntryId));
		const c = user("New C");
		entries.push(c);

		// C alone fits; B1 sits before the compaction record and must still be summarized.
		const second = prepareCompaction(entries, {
			...settings,
			keepRecentTokens: tokenizer.countMessages(messagesOf(b2, c)),
		});
		expect(second?.previousSummary).toBe("Summary A");
		expect(second?.messagesToSummarize).toEqual([b1.message]);
		expect(second?.recentMessages).toEqual(messagesOf(b2, c));
		expect(second?.firstKeptEntryId).toBe(b2.id);
	});

	test("a /clear before the previous compaction still bounds the recovered retained tail", () => {
		const pre = user("PRE user");
		const reset: SessionEntry = { ...base(), type: "reset_boundary" };
		const keptUser = user("MID user");
		const keptAssistant = assistant("MID assistant");
		const tail = [user("TAIL one"), assistant("TAIL one answer"), user("TAIL two")];
		const prep = prepareCompaction(
			[pre, reset, keptUser, keptAssistant, compaction("KEEP SUMMARY", keptUser.id), ...tail],
			{ ...settings, keepRecentTokens: 1 },
		);
		expect(prep?.previousSummary).toBe("KEEP SUMMARY");
		expect(prep?.messagesToSummarize).toEqual(messagesOf(keptUser, keptAssistant, tail[0], tail[1]));
	});

	test("a reindexed advisor snapshot keeps every post-summary message", () => {
		const previous = compaction("Summary A", "pending");
		const b = user("Retained B");
		const c = user("New C");
		const d = user("New D");
		// Advisor snapshots rebuild ids; an old keep id can name a later message now.
		previous.firstKeptEntryId = d.id;
		const preparation = prepareCompaction([previous, b, c, d], { ...settings, keepRecentTokens: 1 });
		expect(preparation?.messagesToSummarize).toEqual(messagesOf(b, c));
		expect(preparation?.recentMessages).toEqual([d.message]);
	});

	test("messages appended while a native snapshot ran stay compactable after its record", () => {
		const snapshot = [user("Snapshot request"), assistant("Snapshot answer")];
		const appended = [user("Appended during request"), assistant("Appended answer"), user("Follow-up")];
		const native = compaction("Opaque native summary", snapshot[1].id);
		native.preserveData = NATIVE_PAYLOAD;
		native.providerReplayThroughEntryId = snapshot[1].id;
		const entries: SessionEntry[] = [...snapshot, ...appended, native];
		const active = openAiModel("openai-responses");

		// The record is the newest entry, but the appended interval is still uncovered.
		const preparation = prepareCompaction(entries, { ...settings, remoteEnabled: true, keepRecentTokens: 1 }, active);
		expect(preparation?.messagesToSummarize).toEqual(messagesOf(appended[0], appended[1]));
		expect(preparation?.recentMessages).toEqual([appended[2].message]);
	});

	test("a native payload the active encoder cannot replay falls back to the local summary", () => {
		const a = user("Summarized A");
		const b = user("Retained B");
		const local = compaction("Summary A", b.id);
		const c = user("Original remote C");
		const remote = compaction("Opaque remote summary", c.id);
		remote.preserveData = NATIVE_PAYLOAD;
		const d = user("New D");
		const e = user("New E");
		const entries: SessionEntry[] = [a, b, local, c, remote, d, e];
		const nativeSettings = { ...settings, remoteEnabled: true, keepRecentTokens: 1 };

		const reused = prepareCompaction(entries, nativeSettings, openAiModel("openai-responses"));
		expect(reused?.previousSummary).toBe("Opaque remote summary");
		expect(reused?.messagesToSummarize).toEqual([d.message]);

		// Same provider, but Chat Completions cannot replay Responses compaction items.
		const expanded = prepareCompaction(entries, nativeSettings, openAiModel("openai-completions"));
		expect(expanded?.previousSummary).toBe("Summary A");
		expect(expanded?.messagesToSummarize).toEqual(messagesOf(b, c, d));
		expect(expanded?.recentMessages).toEqual([e.message]);
	});
});
