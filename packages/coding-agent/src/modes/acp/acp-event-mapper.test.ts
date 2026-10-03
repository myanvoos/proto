import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "../../session/agent-session";
import { mapAgentSessionEventToAcpSessionUpdates } from "./acp-event-mapper";

interface ToolUpdate {
	sessionUpdate: string;
	content?: unknown;
	rawOutput?: unknown;
	locations?: { path: string }[];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-acp-mapper-"));
fs.writeFileSync(path.join(dir, "file.ts"), "data\n");
fs.writeFileSync(path.join(dir, "notes:1-20"), "literal\n");
fs.writeFileSync(path.join(dir, "archive.zip"), "data\n");
fs.mkdirSync(path.join(dir, "docs"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function mapOne(event: AgentSessionEvent): ToolUpdate {
	const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", { cwd: dir });
	expect(updates).toHaveLength(1);
	return updates[0]!.update as ToolUpdate;
}

function readStart(readPath: string): ToolUpdate {
	return mapOne({
		type: "tool_execution_start",
		toolCallId: `read-${readPath}`,
		toolName: "read",
		args: { path: readPath },
	} as AgentSessionEvent);
}

describe("ACP event mapper", () => {
	test("does not serialize a text-less progress envelope into content", () => {
		const partialResult = {
			content: [{ type: "text", text: "" }],
			details: { op: "wait", jobs: [{ id: "bash_1", state: "running" }] },
		};
		const update = mapOne({
			type: "tool_execution_update",
			toolCallId: "jobs-wait",
			toolName: "jobs",
			args: { op: "wait" },
			partialResult,
		} as AgentSessionEvent);
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.rawOutput).toEqual(partialResult);
		expect(update.content).toBeUndefined();
	});

	test("strips read selectors from locations", () => {
		for (const readPath of ["file.ts:1-20", "file.ts:raw", "file.ts:1-20:raw", "file.ts:5-16,960-973"]) {
			expect(readStart(readPath).locations).toEqual([{ path: path.join(dir, "file.ts") }]);
		}
	});

	test("keeps a literal file whose name looks like a selector", () => {
		expect(readStart("notes:1-20").locations).toEqual([{ path: path.join(dir, "notes:1-20") }]);
	});

	test("omits read locations that are not a single existing file", () => {
		for (const readPath of ["src/**/*.ts", "docs", "missing.ts", "archive.zip:inner/SKILL.md", "skill://x"]) {
			expect(readStart(readPath).locations).toBeUndefined();
		}
	});

	test("reports the resolved file on read completion", () => {
		const update = mapOne({
			type: "tool_execution_end",
			toolCallId: "read-end",
			toolName: "read",
			result: { content: [{ type: "text", text: "data" }], details: { resolvedPath: path.join(dir, "file.ts") } },
			isError: false,
		} as AgentSessionEvent);
		expect(update.locations).toEqual([{ path: path.join(dir, "file.ts") }]);
	});
});
