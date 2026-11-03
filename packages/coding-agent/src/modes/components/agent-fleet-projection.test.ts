import { describe, expect, test } from "bun:test";
import type { AgentMetricsSummary, AgentRef } from "../../registry/agent-registry";
import type { ObservableSession } from "../session-observer-registry";
import { fleetRowMetrics, refBelongsToSessionTree } from "./agent-fleet-projection";

function refWith(sessionFile: string | null): Pick<AgentRef, "sessionFile"> {
	return { sessionFile };
}

describe("refBelongsToSessionTree", () => {
	test("keeps refs whose transcript lives inside the session artifacts tree", () => {
		const sessionFile = "/w/.proto/sessions/proj/sess.jsonl";
		expect(refBelongsToSessionTree(refWith("/w/.proto/sessions/proj/sess/worker.jsonl"), sessionFile)).toBe(true);
		expect(refBelongsToSessionTree(refWith("/w/.proto/sessions/proj/sess/w/nested.jsonl"), sessionFile)).toBe(true);
	});

	test("drops refs from other sessions", () => {
		expect(
			refBelongsToSessionTree(
				refWith("/w/.proto/sessions/other/sess2.jsonl/worker.jsonl"),
				"/w/.proto/sessions/proj/sess.jsonl",
			),
		).toBe(false);
		expect(refBelongsToSessionTree(refWith("/w/somewhere/else.jsonl"), "/w/.proto/sessions/proj/sess.jsonl")).toBe(
			false,
		);
	});

	test("in-memory refs belong; unknown host session only keeps in-memory refs", () => {
		expect(refBelongsToSessionTree(refWith(null), "/w/.proto/sessions/proj/sess.jsonl")).toBe(true);
		expect(refBelongsToSessionTree(refWith("/w/.proto/sessions/proj/sess.jsonl/worker.jsonl"), null)).toBe(false);
		expect(refBelongsToSessionTree(refWith(null), null)).toBe(true);
	});
});

test("fleet rows preserve lifetime spend when progress restarts and the session parks", () => {
	const metrics: AgentMetricsSummary = { tokens: 100, requests: 2, tools: 3, cost: 5, durationMs: 1000 };
	const session = {} as NonNullable<AgentRef["session"]>;
	const ref = { id: "worker", session } as AgentRef;
	const snapshots = new WeakMap<object, { metrics: AgentMetricsSummary | undefined }>();
	snapshots.set(session, { metrics });
	snapshots.set(ref, { metrics });
	const observed = {
		progress: { tokens: 1, requests: 1, toolCount: 0, cost: 0.1, durationMs: 10 },
	} as ObservableSession;
	expect(fleetRowMetrics(ref, observed, snapshots)).toMatchObject({ cost: 5, durationMs: 10 });
	ref.session = null;
	ref.history = { metrics: { ...metrics, cost: 1 } };
	expect(fleetRowMetrics(ref, undefined, snapshots)?.cost).toBe(5);
});
