import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "../types";
import { ToolCallLoopGuard, type ToolCallLoopTurn } from "./tool-call-loop-guard";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let nextToolCallId = 0;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `tc_${nextToolCallId++}`, name, arguments: args };
}

function turn(...calls: ToolCall[]): ToolCallLoopTurn {
	const message: AssistantMessage = {
		role: "assistant",
		content: calls,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 0,
	};
	return { message, toolResults: [] };
}

function repeatedBatch(): ToolCall[] {
	return [toolCall("bash", { command: "echo same" }), toolCall("read", { path: "same.ts" })];
}

describe("ToolCallLoopGuard", () => {
	it("detects an identical repeated multi-call batch at the configured threshold", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });

		expect(guard.recordTurn(turn(...repeatedBatch()))).toBeNull();
		expect(guard.recordTurn(turn(...repeatedBatch()))).toBeNull();
		expect(guard.recordTurn(turn(...repeatedBatch()))).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 3,
		});
	});

	it("counts mixed batches while reporting their first non-exempt call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });

		expect(
			guard.recordTurn(turn(toolCall("read", { path: "same.ts" }), toolCall("bash", { command: "echo same" }))),
		).toBeNull();
		expect(
			guard.recordTurn(turn(toolCall("read", { path: "same.ts" }), toolCall("bash", { command: "echo same" }))),
		).toMatchObject({
			toolName: "bash",
			count: 2,
		});
	});

	it("treats a reordered parallel batch as the same repeated batch", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });

		expect(
			guard.recordTurn(turn(toolCall("bash", { command: "echo same" }), toolCall("read", { path: "same.ts" }))),
		).toBeNull();
		expect(
			guard.recordTurn(turn(toolCall("read", { path: "same.ts" }), toolCall("bash", { command: "echo same" }))),
		).toMatchObject({ kind: "repeated_tool_call", count: 2 });
	});
});

it("idle polls cannot hide repeated calls, while injected context and failed polls count as progress", () => {
	const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["wait"], hardLimit: 3 });
	const repeated = () => turn(toolCall("bash", { command: "same" }));
	const poll = (useless: boolean, injectedContext = false, isError = false): ToolCallLoopTurn => {
		const call = toolCall("wait", {});
		return {
			...turn(call),
			injectedContext,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [],
					isError,
					useless,
					timestamp: 0,
				},
			],
		};
	};
	guard.recordTurn(repeated());
	guard.recordTurn(poll(true));
	expect(guard.recordTurn(repeated())).toMatchObject({ count: 2, severity: "steer" });
	guard.recordTurn(poll(true, true));
	expect(guard.recordTurn(repeated())).toBeNull();
	guard.recordTurn(poll(false, false, true));
	expect(guard.recordTurn(repeated())).toBeNull();
	guard.recordTurn(poll(true));
	guard.recordTurn(repeated());
	expect(guard.recordTurn(repeated())).toMatchObject({ count: 3, severity: "stop" });
});
