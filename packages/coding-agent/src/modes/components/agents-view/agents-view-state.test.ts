import { describe, expect, test } from "bun:test";
import type { AgentRef } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/session-listing";
import { buildAgentsViewRows, countAgentsBySection, reconcileAgentsViewRecords } from "./agents-view-state";

function fakeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "/tmp/proto-view/sess_main.jsonl",
		id: "sess",
		cwd: "/tmp/proto-view",
		created: new Date(1000),
		modified: new Date(1000),
		messageCount: 2,
		size: 128,
		firstMessage: "hello",
		allMessagesText: "hello",
		...overrides,
	};
}

function fakeRef(overrides: Partial<AgentRef> = {}): AgentRef {
	return {
		id: "w",
		displayName: "w",
		kind: "sub",
		status: "parked",
		session: null,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
		...overrides,
	};
}

describe("agents view live-session classification", () => {
	test("a session streaming in another process is classified as running", () => {
		const records = reconcileAgentsViewRecords([], [fakeSession({ liveStreaming: true })]);
		expect(records).toHaveLength(1);
		expect(records[0].section).toBe("running");
	});

	test("a session merely open in another process stays inactive but reports in use", () => {
		const records = reconcileAgentsViewRecords([], [fakeSession({ liveOpen: true })]);
		expect(records[0].section).toBe("inactive");
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		expect(rows[0].subtitle).toBe("in use");
	});

	test("live session rows report running regardless of stale transcript tail status", () => {
		const rows = buildAgentsViewRows(
			reconcileAgentsViewRecords([], [fakeSession({ liveStreaming: true, status: "interrupted" })]),
			new Set(),
			new Set(),
			new Map(),
			undefined,
		);
		expect(rows[0].subtitle).toBe("running");
	});
});

describe("agents view section counts", () => {
	test("children count toward the section they are displayed in, not their own", () => {
		const base = "/tmp/proto-view/sess.jsonl";
		const parent = fakeRef({
			id: "parent",
			status: "parked",
			sessionFile: base,
			lastActivity: 5000,
		});
		const child = fakeRef({
			id: "child",
			parentId: "parent",
			status: "running",
			// Subagent transcripts live inside the parent's artifacts directory
			// (session path minus the .jsonl extension).
			sessionFile: "/tmp/proto-view/sess/worker.jsonl",
			lastActivity: 6000,
		});
		const records = reconcileAgentsViewRecords([parent, child], []);
		// Expand the parent so the child row is actually rendered; collapsed children only
		// appear as the summary row's "1 subagent running" text.
		const rows = buildAgentsViewRows(
			records,
			new Set(["file:/tmp/proto-view/sess.jsonl"]),
			new Set(),
			new Map(),
			undefined,
		);

		const childRow = rows.find(row => row.identity === "file:/tmp/proto-view/sess/worker.jsonl");
		expect(childRow?.depth).toBe(1);

		const counts = countAgentsBySection(rows);
		// The running child renders nested under its parked parent in the Idle section;
		// counting it as running would make the header disagree with the visible sections.
		expect(counts.running).toBe(0);
		expect(counts.idle).toBe(2);
	});

	test("collapsed children are not counted into sections they are not displayed in", () => {
		const parent = fakeRef({ id: "parent", status: "parked", sessionFile: "/tmp/proto-view/sess.jsonl" });
		const child = fakeRef({
			id: "child",
			parentId: "parent",
			status: "running",
			sessionFile: "/tmp/proto-view/sess/worker.jsonl",
		});
		const records = reconcileAgentsViewRecords([parent, child], []);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		const counts = countAgentsBySection(rows);
		expect(counts.running).toBe(0);
		expect(counts.idle).toBe(1);
	});

	test("top-level running sessions are counted as running", () => {
		const records = reconcileAgentsViewRecords([], [fakeSession({ liveStreaming: true })]);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		expect(countAgentsBySection(rows).running).toBe(1);
	});
});
