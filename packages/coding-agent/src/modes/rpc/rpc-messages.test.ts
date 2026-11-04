import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { pageRpcMessages } from "./rpc-messages";

test("RPC history traverses an expanded chronological count window without accepting an unbounded request", () => {
	const messages: AgentMessage[] = Array.from({ length: 600 }, (_, index) => ({
		role: "user",
		content: `rpc-history-${index}`,
		timestamp: index,
	}));
	const snapshot = { sessionId: "history", leafId: "head", messageCount: messages.length };
	const page = pageRpcMessages(messages, snapshot, { limit: 512 });
	expect(page.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual(
		Array.from({ length: 512 }, (_, index) => `rpc-history-${index}`),
	);
	const next = pageRpcMessages(messages, snapshot, { cursor: page.nextCursor, limit: 512 });
	expect(next.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual(
		Array.from({ length: 88 }, (_, index) => `rpc-history-${index + 512}`),
	);
	expect(() => pageRpcMessages(messages, snapshot, { limit: 513 })).toThrow();
});

test("RPC history expands the serialized byte budget but leaves the next payload for a later page", () => {
	const messages: AgentMessage[] = Array.from({ length: 8 }, (_, index) => ({
		role: "user",
		content: `${index}:${"x".repeat(220_000)}`,
		timestamp: index,
	}));
	const snapshot = { sessionId: "history", leafId: "head", messageCount: messages.length };
	const page = pageRpcMessages(messages, snapshot, { limit: 512 });
	expect(
		page.messages.map(message =>
			message.role === "user" && typeof message.content === "string" ? message.content.slice(0, 2) : "unexpected",
		),
	).toEqual(["0:", "1:", "2:", "3:", "4:", "5:", "6:"]);
	expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThan(1536 * 1024);
	const next = pageRpcMessages(messages, snapshot, { cursor: page.nextCursor, limit: 512 });
	expect(
		next.messages.map(message =>
			message.role === "user" && typeof message.content === "string" ? message.content.slice(0, 2) : "unexpected",
		),
	).toEqual(["7:"]);
});
