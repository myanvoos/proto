import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	collectPendingToolCalls,
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "./exit-diagnostics";
import type { SessionEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

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

test("a resumed session keeps an interrupted ask call paired in model context", () => {
	const sessionManager = SessionManager.inMemory();
	const question = { questions: [{ question: "Deploy now?", options: ["Yes", "No"] }] };
	sessionManager.appendMessage({ role: "user", content: "prepare deployment", timestamp: 1 });
	sessionManager.appendMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "toolu_done", name: "read", arguments: { path: "deploy.md" } },
			{ type: "toolCall", id: "toolu_ask", name: "ask", arguments: question },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	});
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "toolu_done",
		toolName: "read",
		content: [{ type: "text", text: "Deployment instructions" }],
		isError: false,
		timestamp: 3,
	});
	sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
		toolCallId: "toolu_ask",
		toolName: "ask",
		startedAt: "2026-09-30T00:00:00.000Z",
	});
	sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "exit",
		kind: "process_exit",
		recordedAt: "2026-09-30T00:00:01.000Z",
	});

	const branch = sessionManager.getBranch();
	const aborted = createInterruptedTurnAbortMessage(branch);
	expect(aborted).toBeDefined();
	for (const result of createInterruptedToolResults(branch)) sessionManager.appendMessage(result);
	sessionManager.appendMessage(aborted!);

	const context = sessionManager.buildSessionContext().messages;
	const askCall = context.some(
		message =>
			message.role === "assistant" &&
			message.content.some(part => part.type === "toolCall" && part.id === "toolu_ask"),
	);
	expect(askCall).toBe(true);
	const askResults = context.filter(message => message.role === "toolResult" && message.toolCallId === "toolu_ask");
	expect(askResults).toHaveLength(1);
	expect(askResults[0]).toMatchObject({ isError: true });
	expect(context.filter(message => message.role === "toolResult" && message.toolCallId === "toolu_done")).toHaveLength(
		1,
	);
});
