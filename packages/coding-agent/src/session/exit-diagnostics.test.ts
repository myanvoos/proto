import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { collectPendingToolCalls } from "./exit-diagnostics";
import type { SessionEntry } from "./session-entries";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("pending tool diagnostics retain only a bounded argument preview", () => {
	const command = "x".repeat(50_000);
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command } }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "entry_1",
			parentId: null,
			timestamp: "2026-09-10T00:00:00.000Z",
			message: assistant,
		},
	];

	const pending = collectPendingToolCalls(entries);

	expect(pending).toHaveLength(1);
	expect(pending[0]?.toolName).toBe("bash");
	expect(pending[0]?.args).toEqual({ command: `${"x".repeat(200)}…` });
	expect(JSON.stringify(pending)).not.toContain(command);
});
