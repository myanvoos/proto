import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import type { SessionInfo } from "../../../session/session-listing";
import {
	buildAgentsViewRows,
	collectSessionTreeAgents,
	countAgentsBySection,
	reconcileAgentsViewRecords,
	sumAgentsViewUsage,
} from "./agents-view-state";

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
		label: "w",
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

describe("agents view spend", () => {
	const measured = (id: string, cost: number, tokens: number): AgentRef =>
		fakeRef({
			id,
			label: id,
			sessionFile: `/tmp/proto-view/${id}.jsonl`,
			history: { metrics: { tokens, requests: 2, tools: 1, cost, durationMs: 10, durationKind: "span" } },
		});

	test("each measured agent reports its own tokens and cost", () => {
		const records = reconcileAgentsViewRecords([measured("c1", 0.08, 12_300)], []);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		expect(rows[0]?.usage).toBe("$0.080 · 12K tok");
	});

	test("an agent with nothing measured reports no spend", () => {
		const rows = buildAgentsViewRows(
			reconcileAgentsViewRecords([fakeRef({ id: "fresh" })], []),
			new Set(),
			new Set(),
			new Map(),
			undefined,
		);
		expect(rows[0]?.usage).toBeUndefined();
	});

	test("the view total counts every listed agent exactly once", () => {
		const records = reconcileAgentsViewRecords([measured("c1", 0.08, 12_000), measured("c2", 0.08, 8_000)], []);
		const rows = buildAgentsViewRows(records, new Set(), new Set(), new Map(), undefined);
		const total = sumAgentsViewUsage([...rows, ...rows]);
		expect(total.agents).toBe(2);
		expect(total.cost).toBeCloseTo(0.16, 10);
		expect(total.tokens).toBe(20_000);
	});
});

describe("collectSessionTreeAgents", () => {
	test("scopes rows to the session artifact subtree and live children, newest first", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proto-tree-agents-")));
		try {
			const parentFile = path.join(dir, "2026_parent.jsonl");
			fs.writeFileSync(parentFile, "");
			fs.mkdirSync(path.join(dir, "2026_parent"));
			const sideFile = path.join(dir, "2026_parent", "Side-1.jsonl");
			// The persisted scan skips transcripts without a session_init or conversation record.
			fs.writeFileSync(
				sideFile,
				`${JSON.stringify({ type: "session", version: 3, id: "Side-1", timestamp: "2026-10-01T00:00:00.000Z", cwd: dir })}\n${JSON.stringify({ type: "session_init", timestamp: "2026-10-01T00:00:01.000Z", task: "side work" })}\n`,
			);
			const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proto-tree-agents-other-")));
			fs.writeFileSync(path.join(otherDir, "2026_other.jsonl"), "");

			const registry = new AgentRegistry();
			// Side transcript inside the parent's artifact directory — registered by the scan.
			await collectSessionTreeAgents({ registry, currentSessionFile: parentFile, ownAgentId: "Main" });

			registry.register({
				id: "Sub-9",
				label: "live subagent",
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile: null,
				status: "running",
				lastActivity: 200,
			});
			registry.register({
				id: "Other-1",
				label: "unrelated session agent",
				kind: "side",
				session: null,
				sessionFile: path.join(otherDir, "2026_other.jsonl"),
				status: "idle",
				lastActivity: 300,
			});
			registry.register({
				id: "Adv-1",
				label: "advisor",
				kind: "advisor",
				session: null,
				sessionFile: sideFile,
				status: "idle",
				lastActivity: 400,
			});

			const rows = await collectSessionTreeAgents({ registry, currentSessionFile: parentFile, ownAgentId: "Main" });
			// Newest activity first: the scanned side transcript carries its file mtime (now),
			// the live child the explicit lastActivity of 200.
			expect(rows.map(row => row.id)).toEqual(["Side-1", "Sub-9"]);
			expect(rows[0]).toMatchObject({ kindLabel: "side agent", status: "parked", aborted: false });
			expect(rows[1]).toMatchObject({ running: true, aborted: false, kindLabel: "subagent" });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
