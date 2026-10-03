/**
 * The primary's per-turn prune blanks old tool results in place. The advisor already reviewed those results, so the
 * prune must not register as a rewritten transcript: that would drop the advisor's context and replay the whole
 * primary history. Genuine rewrites still have to reset.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { DeltaCursorFeed } from "./delta-feed";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function toolResult(toolCallId: string, text: string, prunedAt?: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...(prunedAt === undefined ? {} : { prunedAt }),
	} as AgentMessage;
}

function createFeed(): { feed: DeltaCursorFeed; prefixResets: () => number } {
	let resets = 0;
	const feed = new DeltaCursorFeed(
		{ snapshotMessages: () => [] },
		{
			includeThinking: () => true,
			scrubHistory: () => false,
			stripPendingPlaceholderPrefixes: () => {},
			onDeliveredPrefixChanged: () => {
				resets++;
			},
		},
	);
	return { feed, prefixResets: () => resets };
}

describe("DeltaCursorFeed.rebase", () => {
	it("keeps the delivered prefix across an in-place prune and renders only the new step", () => {
		const { feed, prefixResets } = createFeed();
		feed.render([user("investigate"), toolResult("call-1", "huge output")]);

		const pruned = [user("investigate"), toolResult("call-1", "[pruned]", 123)];
		expect(feed.rebase(pruned)).toBe(true);
		// A later rebuild hands the feed equal clones rather than the objects it last saw.
		const next = feed.render([...structuredClone(pruned), user("next step")]);

		expect(prefixResets()).toBe(0);
		expect(next?.rawMessages).toHaveLength(1);
		expect(next?.text).toContain("next step");
	});

	it("refuses to rebase a rewrite that is not an in-place prune, so the next render resets", () => {
		const { feed, prefixResets } = createFeed();
		feed.render([user("investigate"), toolResult("call-1", "output")]);

		expect(feed.rebase([user("edited prompt"), toolResult("call-1", "output")])).toBe(false);
		feed.render([user("edited prompt"), toolResult("call-1", "output")]);

		expect(prefixResets()).toBe(1);
	});
});
