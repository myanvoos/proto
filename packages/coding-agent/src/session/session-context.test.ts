import { describe, expect, test } from "bun:test";
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

function textsOf(firstKeptEntryId: string, transcript: boolean): string[] {
	const context = buildSessionContext(branch(firstKeptEntryId), "c1", undefined, {
		transcript: transcript || undefined,
		collapseCompactedHistory: transcript || undefined,
	});
	return context.messages.map(msg => {
		if (msg.role === "compactionSummary") return "<summary>";
		if (msg.role !== "user" && msg.role !== "assistant") return `<${msg.role}>`;
		if (typeof msg.content === "string") return msg.content;
		const block = msg.content[0];
		return block?.type === "text" ? block.text : `<${block?.type ?? "empty"}>`;
	});
}

describe("compaction boundary in the collapsed transcript", () => {
	test("keeps history from the boundary when it resolves", () => {
		expect(textsOf("u2", true)).toEqual(["second request", "second answer", "<summary>"]);
	});

	test("keeps the full scrollback when an extension folds the whole window", () => {
		expect(textsOf("", true)).toEqual([
			"first request",
			"first answer",
			"second request",
			"second answer",
			"<summary>",
		]);
	});

	test("keeps the full scrollback when the boundary id is stale", () => {
		expect(textsOf("rewritten-away", true)).toEqual([
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
