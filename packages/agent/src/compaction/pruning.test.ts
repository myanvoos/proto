import { describe, expect, test } from "bun:test";
import { Tokenizer } from "../tokenizer";
import type { SessionEntry } from "./entries";
import { DEFAULT_PRUNE_CONFIG, pruneSupersededToolResults, readToolSupersedeKey } from "./pruning";

const USAGE = {
	input: 0,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function readCall(id: string, path: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id: `call-${id}`,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: USAGE,
			stopReason: "toolUse",
			timestamp,
		},
	} as unknown as SessionEntry;
}

function readResult(id: string, text: string, timestamp: number, elidedLines?: number): SessionEntry {
	return {
		type: "message",
		id: `result-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp,
			details: elidedLines === undefined ? undefined : { summary: { lines: 3, elidedSpans: 1, elidedLines } },
		},
	} as unknown as SessionEntry;
}

function textOf(entry: SessionEntry): string {
	if (entry.type !== "message") throw new Error("expected a message entry");
	const { message } = entry;
	if (message.role !== "toolResult") throw new Error("expected a toolResult message");
	const block = message.content[0];
	if (block?.type !== "text") throw new Error("expected a leading text block");
	return block.text;
}

function prune(entries: SessionEntry[]) {
	return pruneSupersededToolResults(entries, new Tokenizer(), {
		supersedeKey: readToolSupersedeKey,
		pruneUseless: false,
		protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
		idleFlushMs: 0,
		now: Date.now() + 10_000_000,
	});
}

const DETAILED = Array.from({ length: 100 }, (_, i) => `  const importantLine${i} = compute(${i});`).join("\n");

describe("pruneSupersededToolResults read supersede", () => {
	test("a structurally summarized whole-file read does not supersede an explicit ranged read", () => {
		// read(path) with no selector returns an outline with bodies elided, so it carries strictly
		// less detail than read(path:100-200). Pruning the ranged result destroys content the
		// summary never contained, and the prune is persisted by rewriteEntries.
		const entries = [
			readCall("c1", "src/foo.ts:100-200", 1),
			readResult("c1", DETAILED, 2),
			readCall("c2", "src/foo.ts", 3),
			readResult("c2", "1-3: export function compute\n4-104: <elided>", 4, 100),
		];

		expect(prune(entries).prunedCount).toBe(0);
		expect(textOf(entries[1])).toBe(DETAILED);
	});

	test("a verbatim whole-file read still supersedes an earlier ranged read", () => {
		const entries = [
			readCall("c1", "src/foo.ts:100-200", 1),
			readResult("c1", DETAILED, 2),
			readCall("c2", "src/foo.ts", 3),
			readResult("c2", `${DETAILED}\n// rest of file`, 4),
		];

		expect(prune(entries).prunedCount).toBe(1);
		expect(textOf(entries[1])).not.toBe(DETAILED);
	});

	test("repeated identical reads still collapse to the newest result", () => {
		const entries = [
			readCall("c1", "src/bar.ts", 1),
			readResult("c1", "stale contents", 2),
			readCall("c2", "src/bar.ts", 3),
			readResult("c2", "fresh contents", 4),
		];

		expect(prune(entries).prunedCount).toBe(1);
		expect(textOf(entries[1])).not.toBe("stale contents");
		expect(textOf(entries[3])).toBe("fresh contents");
	});
});
