import { describe, expect, test } from "bun:test";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { prepareBranchEntries } from "./branch-summarization";
import type { SessionMessageEntry } from "./entries";

class PairBoundaryTokenizer extends Tokenizer {
	override countMessage(message: AgentMessage): number {
		return message.role === "assistant" ? 100 : 5;
	}
}

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return {
		id,
		parentId,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	};
}

function assistant(id: string, parentId: string | null, toolCallIds: string[]): SessionMessageEntry {
	return entry(id, parentId, {
		role: "assistant",
		content: toolCallIds.map(toolCallId => ({
			type: "toolCall" as const,
			id: toolCallId,
			name: "read",
			arguments: { path: `/tmp/${toolCallId}` },
		})),
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
		timestamp: 0,
	});
}

function result(id: string, parentId: string, toolCallId: string): SessionMessageEntry {
	return entry(id, parentId, {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `result for ${toolCallId}` }],
		isError: false,
		timestamp: 0,
	});
}

function user(id: string, parentId: string): SessionMessageEntry {
	return entry(id, parentId, { role: "user", content: "continue", timestamp: 0 });
}

function expectClosedPairs(messages: AgentMessage[]): void {
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

describe("branch summary tool pairing", () => {
	// Regression: provider 400 on unpaired tool message when the budget retained a result but evicted its assistant owner.
	test("overruns the budget through the owning assistant entry", () => {
		const entries = [assistant("a", null, ["call"]), result("r", "a", "call"), user("u", "r")];
		const prepared = prepareBranchEntries(entries, new PairBoundaryTokenizer(), 10);

		expect(prepared.messages.map(message => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(prepared.totalTokens).toBe(110);
		expectClosedPairs(prepared.messages);
	});

	// Regression: provider 400 on unpaired tool message when malformed retained history contains a result without an owner.
	test("filters an orphaned result from the emitted branch", () => {
		const prepared = prepareBranchEntries(
			[result("r", "missing", "call"), user("u", "r")],
			new PairBoundaryTokenizer(),
		);

		expect(prepared.messages.map(message => message.role)).toEqual(["user"]);
		expectClosedPairs(prepared.messages);
	});
});
