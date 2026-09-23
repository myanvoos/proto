/**
 * Remote (OpenAI Responses) compaction replays its kept tool calls through the summary's provider payload, not as local
 * assistant messages. A local result under `providerReplayThroughEntryId` pairs with such a call and must survive the
 * orphan-result repair instead of being dropped.
 */
import { expect, it } from "bun:test";
import { buildSessionContext } from "./session-context";
import type { SessionEntry } from "./session-entries";

const timestamp = new Date(0).toISOString();

it("keeps a result paired with a tool call carried only in the remote-compaction replay payload", () => {
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "start the remote job", attribution: "user", timestamp: 1 },
		},
		{
			type: "message",
			id: "r1",
			parentId: "u1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-remote",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 2,
			},
		},
		{
			type: "compaction",
			id: "c1",
			parentId: "r1",
			timestamp,
			summary: "remote compaction",
			firstKeptEntryId: "u1",
			tokensBefore: 100,
			providerReplayThroughEntryId: "u1",
			preserveData: {
				openaiRemoteCompaction: {
					provider: "openai-codex",
					replacementHistory: [{ type: "function_call", call_id: "call-remote", name: "bash", arguments: "{}" }],
				},
			},
		},
	] as SessionEntry[];

	const results = buildSessionContext(entries).messages.filter(message => message.role === "toolResult");

	expect(results.map(message => message.toolCallId)).toEqual(["call-remote"]);
});
