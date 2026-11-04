import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TRANSCRIPT_WINDOW_BYTES, TRANSCRIPT_WINDOW_MESSAGES } from "../modes/utils/transcript-window";
import { selectTranscriptWindow } from "./session-history-window";

test("the expanded UI page keeps more than the old window without splitting the tool group at its boundary", () => {
	const messages: AgentMessage[] = Array.from({ length: 87 }, (_, index) => ({
		role: "user",
		content: `earlier-${index}`,
		timestamp: index,
	}));
	messages.push({
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{ type: "toolCall", id: "first", name: "read", arguments: {} },
			{ type: "toolCall", id: "second", name: "read", arguments: {} },
		],
	});
	for (const id of ["first", "second"])
		messages.push({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 0,
		});
	for (let index = 0; index < 510; index++)
		messages.push({ role: "user", content: `latest-${index}`, timestamp: index });
	const sizes = messages.map(() => 1024);
	const latest = selectTranscriptWindow(messages, sizes, 0, TRANSCRIPT_WINDOW_MESSAGES, TRANSCRIPT_WINDOW_BYTES);
	expect(
		messages
			.slice(latest.start, latest.end)
			.map(message => (message.role === "user" ? message.content : message.role)),
	).toEqual(Array.from({ length: 510 }, (_, index) => `latest-${index}`));
	const older = selectTranscriptWindow(messages, sizes, 1, TRANSCRIPT_WINDOW_MESSAGES, TRANSCRIPT_WINDOW_BYTES);
	expect(older.end).toBe(latest.start);
	expect(
		messages
			.slice(older.start, older.end)
			.slice(-3)
			.map(message => message.role),
	).toEqual(["assistant", "toolResult", "toolResult"]);
});

test("the expanded UI byte window admits history above the old budget and leaves earlier payload for a bounded next page", () => {
	const messages: AgentMessage[] = Array.from({ length: 10 }, (_, index) => ({
		role: "user",
		content: `payload-${index}`,
		timestamp: index,
	}));
	const sizes = messages.map(() => 600_000);
	const latest = selectTranscriptWindow(messages, sizes, 0, TRANSCRIPT_WINDOW_MESSAGES, TRANSCRIPT_WINDOW_BYTES);
	expect(
		messages
			.slice(latest.start, latest.end)
			.map(message => (message.role === "user" ? message.content : message.role)),
	).toEqual(["payload-4", "payload-5", "payload-6", "payload-7", "payload-8", "payload-9"]);
	const older = selectTranscriptWindow(messages, sizes, 1, TRANSCRIPT_WINDOW_MESSAGES, TRANSCRIPT_WINDOW_BYTES);
	expect(
		messages.slice(older.start, older.end).map(message => (message.role === "user" ? message.content : message.role)),
	).toEqual(["payload-0", "payload-1", "payload-2", "payload-3"]);
});
