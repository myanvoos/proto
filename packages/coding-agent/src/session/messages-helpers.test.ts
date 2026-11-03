import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildReplanTitleContext, dedupeEphemeralReply, wrapSteeringForModel } from "./messages";

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason,
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("long tool loops keep their opening goal in regenerated title context", () => {
	const history: AgentMessage[] = [
		{ role: "user", content: "Implement durable session storage", attribution: "user", timestamp: 1 },
	];
	for (let i = 0; i < 10; i++) history.push(assistant(`Investigating helper ${i}`));
	const context = buildReplanTitleContext(history);
	expect(context).toContain("Implement durable session storage");
	expect(context).toContain("Investigating helper 9");
});

test("reply caps preserve UTF-8 without replacement bytes at the cut", () => {
	const capped = dedupeEphemeralReply("é".repeat(100), 31);
	expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(31);
	expect(capped).not.toContain("�");
	expect(capped).toContain("truncated");
});

test("steering replay retains its wrapper until owner invalidation replaces edited text", () => {
	const steer: AgentMessage = {
		role: "user",
		content: "initial steer",
		attribution: "user",
		steering: true,
		timestamp: 1,
	};
	const history = [steer];
	const first = wrapSteeringForModel(history);
	expect(wrapSteeringForModel([...history])[0]).toBe(first[0]);
	steer.content = "updated steer";
	invalidateMessageCache(steer);
	const updated = wrapSteeringForModel(history);
	const updatedMessage = updated[0];
	expect(updatedMessage && "content" in updatedMessage && JSON.stringify(updatedMessage.content)).toContain(
		"updated steer",
	);
});
