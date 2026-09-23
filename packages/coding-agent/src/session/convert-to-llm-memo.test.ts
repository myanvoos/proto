import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { convertToLlm, invalidateConvertToLlmArrayCache } from "./messages";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

test("an in-place history rewrite that keeps length and tail converts the new prefix", () => {
	const tail = user("latest request");
	const history: AgentMessage[] = [user("old request"), user("old follow-up"), tail];
	expect(convertToLlm(history).map(message => message.content)).toEqual([
		"old request",
		"old follow-up",
		"latest request",
	]);

	// Mid-run compaction splices the live array: same object, same length, same tail.
	history.splice(0, history.length, user("compacted summary"), user("kept request"), tail);
	invalidateConvertToLlmArrayCache(history);

	expect(convertToLlm(history).map(message => message.content)).toEqual([
		"compacted summary",
		"kept request",
		"latest request",
	]);
});
