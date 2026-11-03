import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildSessionContext } from "./session-context";
import type { SessionEntry } from "./session-entries";
import { isUnexpectedStopCandidate } from "./unexpected-stop-classifier";
import { YieldQueue } from "./yield-queue";

function assistant(id: string, callId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: id === "old" ? null : "question",
		timestamp: "2026-11-01T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "test",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "source.ts" } }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

describe("upstream runtime regressions", () => {
	test("a mid-turn rebuild keeps the running call but never revives a prior abandoned call", () => {
		const entries: SessionEntry[] = [
			assistant("old", "abandoned"),
			{
				type: "message",
				id: "question",
				parentId: "old",
				timestamp: "2026-11-01T00:00:01.000Z",
				message: { role: "user", content: "new request", timestamp: 2 },
			},
			assistant("live", "running"),
		];
		const live = buildSessionContext(entries, "live", undefined, {
			transcript: true,
			inFlightToolCallIds: new Set(["running"]),
		});
		const calls = live.messages.flatMap(message =>
			message.role === "assistant"
				? message.content.filter(block => block.type === "toolCall").map(block => block.id)
				: [],
		);
		expect(calls).toEqual(["running"]);
		expect(buildSessionContext(entries, "live").messages.filter(message => message.role === "assistant")).toEqual([]);
	});

	test("consumed completions do not wake waits and peeking does not consume deliverable results", async () => {
		const delivered: string[] = [];
		const queue = new YieldQueue({
			isStreaming: () => true,
			scheduleIdleFlush: () => {},
			injectIdle: async messages => {
				delivered.push(...messages.map(message => message.role));
			},
		});
		const consumed = new Set(["already-read"]);
		queue.register<string>("result", {
			isStale: id => consumed.has(id),
			build: ids => ({
				role: "user",
				content: ids.join(","),
				timestamp: 0,
			}),
		});
		queue.enqueue("result", "already-read");
		expect(queue.hasDeliverable("result")).toBe(false);
		queue.enqueue("result", "unread");
		expect(queue.hasDeliverable("result")).toBe(true);
		expect(queue.hasDeliverable("result")).toBe(true);
		await queue.flush("idle");
		expect(delivered).toEqual(["user"]);
		expect(queue.hasDeliverable("result")).toBe(false);
	});

	test("an image-bearing stop is delivered once rather than classified for an unexpected-stop retry", () => {
		const entry = assistant("old", "unused");
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Invalid fixture");
		const message: AssistantMessage = {
			...entry.message,
			stopReason: "stop",
			content: [
				{ type: "text", text: "Here is the generated image" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		};
		expect(isUnexpectedStopCandidate(message)).toBe(false);
		expect(
			isUnexpectedStopCandidate({ ...message, content: [{ type: "text", text: "I will inspect that next" }] }),
		).toBe(true);
	});
});
