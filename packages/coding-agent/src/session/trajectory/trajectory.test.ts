import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../../session/session-entries";
import { trajectoryToOtlp } from "./export-otel";
import { buildTrajectory } from "./model";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-08-30T00:00:00.000Z", message };
}

function fixtureEntries(): SessionEntry[] {
	const user: UserMessage = { role: "user", content: "inspect the file", timestamp: 0 };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "I should check the file contents first." },
			{ type: "text", text: "Let me look at the file." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "file body" }],
		isError: false,
		timestamp: 0,
	};
	const thinkingOnly: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "No reply needed, just wrap up." }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
	return [entry("e1", user), entry("e2", assistant), entry("e3", toolResult), entry("e4", thinkingOnly)];
}

test("otel export preserves assistant reasoning blocks under pi.gen_ai.response.reasoning", () => {
	const trajectory = buildTrajectory(fixtureEntries(), { id: "s1", title: "t", cwd: "/w" });
	const doc = trajectoryToOtlp(trajectory);
	const chatSpans = doc.resourceSpans[0].scopeSpans[0].spans.filter(span => span.name.startsWith("chat "));
	const attrs = (span: (typeof chatSpans)[number]) =>
		Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue]));

	const first = attrs(chatSpans[0]!);
	expect(first["pi.gen_ai.response.reasoning"]).toBe("I should check the file contents first.");
	expect(first["pi.gen_ai.response.text"]).toBe("Let me look at the file.");
	expect(first["pi.gen_ai.response.text"]).not.toContain("[thinking]");

	const second = attrs(chatSpans[1]!);
	expect(second["pi.gen_ai.response.reasoning"]).toBe("No reply needed, just wrap up.");
	expect(second["pi.gen_ai.response.text"]).toBeUndefined();
});

test("trajectory step keeps reasoning for the interactive view while text stays pure", () => {
	const trajectory = buildTrajectory(fixtureEntries());
	const chat = trajectory.steps.find(step => step.kind === "chat");
	expect(chat?.thinking).toBe("I should check the file contents first.");
	expect(chat?.content).toContain("[thinking]\nI should check the file contents first.");
	expect(chat?.text).toBe("Let me look at the file.");
});
