import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { SessionUpdate, ToolCallContent, ToolKind } from "@oh-my-pi/pi-utils/acp";
import type { AgentSessionEvent } from "../../session/agent-session";
import { capEventDiff } from "../../utils/diff";
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

function diffs(update: ToolUpdate): Extract<ToolCallContent, { type: "diff" }>[] {
	return (update.content ?? []).filter(item => item.type === "diff");
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

	test("think and recall carry their ACP tool kinds", () => {
		const expected: Array<[string, ToolKind]> = [
			["think", "think"],
			["recall", "search"],
		];
		for (const [toolName, kind] of expected) {
			const start = mapOne({ type: "tool_execution_start", toolCallId: toolName, toolName, args: {} });
			expect(start.kind).toBe(kind);
		}
	});
});

describe("ACP file mutation mapping", () => {
	const edited = path.join(root, "src/app.ts");
	const created = path.join(root, "notes.md");

	test("kernel and shell writes become edit diffs with navigable locations", () => {
		const update = bashEnd([
			{ op: "kernel-state", language: "javascript", executionCount: 1 },
			{ op: "write", path: edited, id: `run:${edited}`, diff: " 1|a\n-2|b\n+2|B\n 3|c\n+4|d" },
			{ op: "write", path: created, id: created, diff: "+1|hello\n+2|world" },
			{ op: "revert", path: path.join(root, "restored.ts"), id: "run:restored" },
		]);
		expect(update.kind).toBe("edit");
		expect(diffs(update)).toEqual([
			{ type: "diff", path: edited, oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" },
			{ type: "diff", path: created, oldText: null, newText: "hello\nworld\n" },
		]);
		expect(update.locations).toEqual([
			{ path: edited, line: 2 },
			{ path: created, line: 1 },
		]);
	});

	test("a run that only removes files is a delete", () => {
		const removed = path.join(root, "old.txt");
		const update = bashEnd([{ op: "delete", path: removed, id: removed, diff: "-1|x\n-2|y" }]);
		expect(update.kind).toBe("delete");
		expect(diffs(update)).toEqual([{ type: "diff", path: removed, oldText: "x\ny\n", newText: "" }]);
		expect(update.locations).toEqual([{ path: removed }]);
	});

	test("distant hunks and an omitted middle stay marked in the excerpts", () => {
		const before = `${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const after = before.replace("line 5\n", "LINE 5\n").replace("line 40\n", "line 40\ninserted\n");
		const rewrite = `${Array.from({ length: 1200 }, (_, i) => `row ${i + 1}`).join("\n")}\n`;
		const capped = capEventDiff(rewrite, rewrite.toUpperCase());
		expect(capped?.diffTruncated).toBe(true);
		const update = bashEnd([
			{ op: "write", path: edited, id: edited, diff: capEventDiff(before, after)?.diff },
			{ op: "write", path: created, id: created, diff: capped?.diff, diffTruncated: true },
		]);

		const [hunks, truncated] = diffs(update);
		expect(hunks.oldText).toBe(
			"line 3\nline 4\nline 5\nline 6\nline 7\n… 31 unchanged lines\nline 39\nline 40\nline 41\nline 42\n",
		);
		expect(hunks.newText).toBe(
			"line 3\nline 4\nLINE 5\nline 6\nline 7\n… 31 unchanged lines\nline 39\nline 40\ninserted\nline 41\nline 42\n",
		);
		const omitted = /^… \d+ diff lines omitted$/m;
		expect(truncated.oldText).toMatch(omitted);
		expect(truncated.newText).toMatch(omitted);
		expect(truncated.oldText).toStartWith("row 1\n");
		expect(truncated.newText).toEndWith("ROW 1200\n");
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
