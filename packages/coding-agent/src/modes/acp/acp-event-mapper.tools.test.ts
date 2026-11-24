import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import type { AgentSessionEvent } from "../../session/agent-session";
import { mapAgentSessionEventToAcpSessionUpdates } from "./acp-event-mapper";

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

const root = path.resolve("/project");

function mapOne(event: AgentSessionEvent): ToolUpdate {
	const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", { cwd: root });
	expect(updates).toHaveLength(1);
	return updates[0]!.update as ToolUpdate;
}

function bashEnd(statusEvents: unknown[], text = "done"): ToolUpdate {
	return mapOne({
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		result: { content: [{ type: "text", text }], details: { statusEvents } },
		isError: false,
	} as AgentSessionEvent);
}

function texts(update: ToolUpdate): string[] {
	return (update.content ?? []).flatMap(item =>
		item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
	);
}

describe("ACP tool call lifecycle", () => {
	// Repro of the T3 Code probe: `sleep 4; echo probe-done` sat in `pending` for the whole run, then showed its
	// output twice ("probe-done\n" and "probe-done") once it finished.
	test("a running command is in progress from its start and shows its output once", () => {
		const args = { command: "sleep 4; echo probe-done" };
		const start = mapOne({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args });
		expect(start).toMatchObject({ sessionUpdate: "tool_call", kind: "execute", status: "in_progress" });

		const update = mapOne({
			type: "tool_execution_update",
			toolCallId: "bash-1",
			toolName: "bash",
			args,
			partialResult: { content: [{ type: "text", text: "probe-done\n" }], details: {} },
		} as AgentSessionEvent);
		expect(texts(update)).toEqual(["$ sleep 4; echo probe-done", "probe-done\n"]);

		const end = bashEnd([{ op: "kernel-state", language: "javascript" }], "probe-done\n\nWall time: 4.1 seconds");
		expect(end.status).toBe("completed");
		expect(end.kind).toBeUndefined();
		expect(texts(end)).toEqual(["probe-done\n\nWall time: 4.1 seconds"]);
	});

	// session/load replays a stored failure as `{ content, details, errorMessage }`.
	test("a replayed failure still shows an error message its output does not repeat", () => {
		const end = mapOne({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "partial listing" }], errorMessage: "permission denied" },
			isError: true,
		} as AgentSessionEvent);
		expect(texts(end)).toEqual(["partial listing", "permission denied"]);
	});
});

test("an oversized tool result keeps its output's head and tail in rawOutput, not its payloads", () => {
	const output = ["HEAD-LINE", ...Array.from({ length: 4000 }, (_, i) => `output line ${i}`), "TAIL-LINE"].join("\n");
	const update = mapOne({
		type: "tool_execution_end",
		toolCallId: "read-image",
		toolName: "read",
		result: {
			content: [
				{ type: "text", text: output },
				{ type: "image", data: "A".repeat(300_000), mimeType: "image/png" },
			],
			details: { images: [{ type: "image", data: "B".repeat(300_000), mimeType: "image/png" }] },
		},
		isError: false,
	} as AgentSessionEvent);

	const raw = update.rawOutput as { content: Array<{ type: string; text: string }>; truncated: boolean };
	expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(64 * 1024);
	expect(raw.truncated).toBe(true);
	expect(raw.content).toHaveLength(1);
	expect(raw.content[0].text).toStartWith("HEAD-LINE\n");
	expect(raw.content[0].text).toEndWith("\nTAIL-LINE");
});
