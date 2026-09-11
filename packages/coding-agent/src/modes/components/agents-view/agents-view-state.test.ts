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

	test("live markers override a stale parked registry ref", () => {
		const sessionPath = "/tmp/proto-view/parallel.jsonl";
		const records = reconcileAgentsViewRecords(
			[fakeRef({ id: "parallel", sessionFile: sessionPath, status: "parked" })],
			[fakeSession({ path: sessionPath, id: "parallel", liveOpen: true, liveStreaming: true })],
		);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);

		expect(records[0]?.section).toBe("running");
		expect(rows[0]?.subtitle).toBe("running");
	});
});

describe("agents view idle lifecycle details", () => {
	test("idle rows tell a live idle worker apart from one parked to disk", () => {
		const live = fakeRef({ id: "live", status: "idle", sessionFile: "/tmp/proto-view/live.jsonl" });
		const parked = fakeRef({ id: "parked", status: "parked", sessionFile: "/tmp/proto-view/parked.jsonl" });
		const rows = buildAgentsViewRows(
			reconcileAgentsViewRecords([live, parked], []),
			new Set(),
			new Set(),
			new Map(),
			undefined,
		);
		const details = new Map(rows.map(row => [row.identity, row.details]));
		expect(details.get("file:/tmp/proto-view/live.jsonl")).toMatch(/^idle · /);
		expect(details.get("file:/tmp/proto-view/parked.jsonl")).toMatch(/^parked · /);
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
			sessionFile: "/tmp/proto-view/sess/worker.jsonl",
			lastActivity: 6000,
		});
		const records = reconcileAgentsViewRecords([parent, child], []);
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

describe("agents view lineage nesting", () => {
	const parentFile = "/tmp/proto-view/sess_main/alpha.jsonl";
	const childFile = "/tmp/proto-view/sess_main/alpha/alpha.beta.jsonl";

	function nestedSessionTree(): { parent: SessionInfo; child: SessionInfo } {
		return {
			parent: fakeSession({ path: parentFile, id: "alpha", firstMessage: "alpha task" }),
			child: fakeSession({ path: childFile, id: "alpha.beta", firstMessage: "beta task" }),
		};
	}

	test("a nested transcript without a registry ref nests under its parent session", () => {
		const { parent, child } = nestedSessionTree();
		const records = reconcileAgentsViewRecords([], [parent, child]);
		const rows = buildAgentsViewRows(records, new Set([`file:${parentFile}`]), new Set(), new Map(), undefined);

		const childRow = rows.find(row => row.identity === `file:${childFile}`);
		expect(childRow?.kind).toBe("subagent");
		expect(childRow?.depth).toBe(1);
		expect(childRow?.parentIdentity).toBe(`file:${parentFile}`);

		const parentRow = rows.find(row => row.identity === `file:${parentFile}`);
		expect(parentRow?.kind).toBe("agent");
		expect(parentRow?.hasChildren).toBe(true);
	});

	test("an unregistered nested transcript stays nested after its ref is dropped", () => {
		const { parent, child } = nestedSessionTree();
		const ref = fakeRef({
			id: "alpha.beta",
			parentId: "alpha",
			status: "parked",
			sessionFile: childFile,
		});
		const registered = reconcileAgentsViewRecords([ref], [parent, child]);
		const expanded = new Set([`file:${parentFile}`]);
		const rows = buildAgentsViewRows(registered, expanded, new Set(), new Map(), undefined);
		expect(rows.find(row => row.identity === `file:${childFile}`)?.depth).toBe(1);

		// keepAlive:false agents unregister on completion; the transcript must keep its
		// place in the tree instead of jumping to the top level.
		const unregistered = reconcileAgentsViewRecords([], [parent, child]);
		const afterRows = buildAgentsViewRows(unregistered, expanded, new Set(), new Map(), undefined);
		const childRow = afterRows.find(row => row.identity === `file:${childFile}`);
		expect(childRow?.kind).toBe("subagent");
		expect(childRow?.depth).toBe(1);
	});

	test("transcripts from unrelated sessions stay at the top level", () => {
		const { parent, child } = nestedSessionTree();
		const unrelated = fakeSession({ path: "/tmp/proto-view/sess_other.jsonl", id: "other" });
		const records = reconcileAgentsViewRecords([], [parent, child, unrelated]);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		expect(rows.find(row => row.identity === "file:/tmp/proto-view/sess_other.jsonl")?.kind).toBe("agent");
		expect(rows.find(row => row.identity === "file:/tmp/proto-view/sess_other.jsonl")?.depth).toBe(0);
	});

	test("a session-only child of the scope root stays flattened in the scoped view", () => {
		const { parent, child } = nestedSessionTree();
		const records = reconcileAgentsViewRecords([], [parent, child]);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), `file:${parentFile}`);
		const childRow = rows.find(row => row.identity === `file:${childFile}`);
		expect(childRow?.kind).toBe("agent");
		expect(childRow?.depth).toBe(0);
	});

	test("a nested transcript whose parent record is absent stays at the top level", () => {
		const { child } = nestedSessionTree();
		const records = reconcileAgentsViewRecords([], [child]);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		const childRow = rows.find(row => row.identity === `file:${childFile}`);
		expect(childRow?.kind).toBe("agent");
		expect(childRow?.depth).toBe(0);
	});
});
