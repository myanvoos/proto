import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildSessionContext } from "./session-context";
import type { SessionEntry } from "./session-entries";

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntry {
	const content = [{ type: "text", text }];
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message:
			role === "assistant"
				? {
						role,
						content,
						provider: "test",
						model: "test-model",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						stopReason: "stop",
					}
				: { role, content },
	} as unknown as SessionEntry;
}

function compaction(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		id,
		parentId,
		type: "compaction",
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: "folded summary",
		shortSummary: "folded",
		firstKeptEntryId,
		tokensBefore: 100,
	} as unknown as SessionEntry;
}

function branch(firstKeptEntryId: string): SessionEntry[] {
	return [
		message("u1", null, "user", "first request"),
		message("a1", "u1", "assistant", "first answer"),
		message("u2", "a1", "user", "second request"),
		message("a2", "u2", "assistant", "second answer"),
		compaction("c1", "a2", firstKeptEntryId),
	];
}

function textsOf(firstKeptEntryId: string, transcript: boolean, collapseCompactedHistory?: boolean): string[] {
	const context = buildSessionContext(branch(firstKeptEntryId), "c1", undefined, {
		transcript: transcript || undefined,
		collapseCompactedHistory,
	});
	return context.messages.map(msg => {
		if (msg.role === "compactionSummary") return "<summary>";
		if (msg.role !== "user" && msg.role !== "assistant") return `<${msg.role}>`;
		if (typeof msg.content === "string") return msg.content;
		const block = msg.content[0];
		return block?.type === "text" ? block.text : `<${block?.type ?? "empty"}>`;
	});
}

describe("compaction boundaries", () => {
	test("the transcript keeps pre-compaction messages unless collapse is explicitly requested", () => {
		expect(textsOf("u2", true)).toEqual([
			"first request",
			"first answer",
			"second request",
			"second answer",
			"<summary>",
		]);
	});

	test("keeps history from the boundary when it resolves", () => {
		expect(textsOf("u2", true, true)).toEqual(["second request", "second answer", "<summary>"]);
	});

	test("keeps the full scrollback when an extension folds the whole window", () => {
		expect(textsOf("", true, true)).toEqual([
			"first request",
			"first answer",
			"second request",
			"second answer",
			"<summary>",
		]);
	});

	test("keeps the full scrollback when the boundary id is stale", () => {
		expect(textsOf("rewritten-away", true, true)).toEqual([
			"first request",
			"first answer",
			"second request",
			"second answer",
			"<summary>",
		]);
	});

	test("still folds the model context for an unresolvable boundary", () => {
		expect(textsOf("", false)).toEqual(["<summary>"]);
		expect(textsOf("rewritten-away", false)).toEqual(["<summary>"]);
		expect(textsOf("u2", false)).toEqual(["<summary>", "second request", "second answer"]);
	});
});

function toolAssistant(id: string, parentId: string | null, toolCallIds: string[]): SessionEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: toolCallIds.map(toolCallId => ({
				type: "toolCall",
				id: toolCallId,
				name: "read",
				arguments: { path: `/tmp/${toolCallId}` },
			})),
			provider: "test",
			model: "test-model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
		},
	} as unknown as SessionEntry;
}

function toolResult(id: string, parentId: string | null, toolCallId: string): SessionEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: `result for ${toolCallId}` }],
			isError: false,
		},
	} as unknown as SessionEntry;
}

function expectClosedToolPairs(messages: AgentMessage[]): void {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.add(block.id);
			}
		} else if (message.role === "toolResult") {
			expect(calls.has(message.toolCallId)).toBe(true);
			results.add(message.toolCallId);
		}
	}
	for (const call of calls) expect(results.has(call)).toBe(true);
}

describe("compaction tool-pair boundaries", () => {
	// Regression: provider 400 on unpaired tool message when firstKeptEntryId lands exactly on a tool result.
	test("snaps a tool-result boundary back to its assistant owner", () => {
		const entries = [toolAssistant("a", null, ["call"]), toolResult("r", "a", "call"), compaction("c", "r", "r")];
		const context = buildSessionContext(entries, "c");

		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "assistant", "toolResult"]);
		expectClosedToolPairs(context.messages);
	});

	// Regression: provider 400 on unpaired tool message when the boundary splits interleaved, multi-result calls.
	test("keeps the whole owner and all earlier results at a mid-pair boundary", () => {
		const entries = [
			toolAssistant("a", null, ["call-a", "call-b"]),
			toolResult("ra1", "a", "call-a"),
			toolResult("rb", "ra1", "call-b"),
			toolResult("ra2", "rb", "call-a"),
			compaction("c", "ra2", "rb"),
		];
		const context = buildSessionContext(entries, "c");

		expect(context.messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"assistant",
			"toolResult",
			"toolResult",
			"toolResult",
		]);
		expectClosedToolPairs(context.messages);
	});

	// Regression: provider 400 on unpaired tool message when restored history has no reachable assistant owner.
	test("drops an orphaned result that cannot be repaired", () => {
		const entries = [toolResult("r", null, "call"), compaction("c", "r", "r")];
		const context = buildSessionContext(entries, "c");

		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary"]);
		expectClosedToolPairs(context.messages);
	});
});

describe("thinking level restoration", () => {
	function thinkingLevelChange(
		id: string,
		parentId: string | null,
		thinkingLevel: string | null,
		configured: string | null,
	): SessionEntry {
		return {
			id,
			parentId,
			type: "thinking_level_change",
			timestamp: "2026-01-01T00:00:00.000Z",
			thinkingLevel,
			configured,
		} as unknown as SessionEntry;
	}

	// Regression: a session that never chose a level was restored as an explicit "off", which pinned
	// a level nobody asked for and changed the model string a revived worker reports.
	test("a recorded absence of a level restores as no level", () => {
		const context = buildSessionContext([thinkingLevelChange("t", null, null, null)], "t");

		expect(context.thinkingLevel).toBeUndefined();
		expect(context.configuredThinkingLevel).toBeUndefined();
	});

	test("an explicit level is restored as chosen", () => {
		const context = buildSessionContext([thinkingLevelChange("t", null, "high", "high")], "t");

		expect(context.thinkingLevel).toBe("high");
		expect(context.configuredThinkingLevel).toBe("high");
	});
});
