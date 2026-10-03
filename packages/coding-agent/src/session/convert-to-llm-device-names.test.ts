import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { convertToLlm } from "./messages";

// Sessions saved before fallback-resolved calls were recorded under the tool's own name persist the
// `protolens://<device>` alias, which providers reject as a function name on replay.
test("replays tool calls saved under a protolens:// alias by their bare device name", () => {
	const saved: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "protolens://recall", arguments: { q: "x" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
	const history: AgentMessage[] = [
		saved,
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "protolens://recall",
			content: [{ type: "text", text: "remembered" }],
			isError: false,
			timestamp: 2,
		},
	];

	const [assistant, result] = convertToLlm(history);

	expect(assistant?.role === "assistant" ? assistant.content : []).toEqual([
		{ type: "toolCall", id: "call_1", name: "recall", arguments: { q: "x" } },
	]);
	expect(result?.role === "toolResult" ? [result.toolCallId, result.toolName] : []).toEqual(["call_1", "recall"]);
	// Persisted history stays untouched; only the provider view is canonical.
	expect(saved.content[0]).toMatchObject({ name: "protolens://recall" });
});
