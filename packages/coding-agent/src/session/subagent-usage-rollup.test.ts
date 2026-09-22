import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { SingleResult } from "../task/types";
import { recordSubagentRun, subagentRunUsage } from "../task/usage-rollup";
import { SessionManager } from "./session-manager";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

async function openSession(prefix: string): Promise<{ manager: SessionManager; file: string }> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	expect(file).toBeString();
	return { manager, file: file! };
}

function result(overrides: Partial<SingleResult>): SingleResult {
	return {
		index: 0,
		id: "worker-1",
		agent: "worker",
		agentSource: "bundled",
		task: "task",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

test("subagent runs roll up into the owning session total and survive a reload", async () => {
	const { manager, file } = await openSession("proto-subagent-usage-");
	manager.recordSubagentUsage({ agentId: "w1", agent: "worker", label: "c1", turn: 1, usage: usage(2000, 400, 0.08) });
	manager.recordSubagentUsage({ agentId: "w2", agent: "worker", label: "c2", turn: 1, usage: usage(1000, 200, 0.08) });
	manager.recordSubagentUsage({ agentId: "w1", agent: "worker", label: "c1", turn: 2, usage: usage(500, 100, 0.02) });

	const live = manager.getUsageStatistics();
	expect(live.subagent.cost).toBeCloseTo(0.18, 10);
	expect(live.subagent.totalTokens).toBe(4200);
	expect(live.subagent.runs).toBe(3);
	expect(live.subagent.agents).toBe(2);
	// The owner's own spend stays its own: rolling subagents into it would double count every agent
	// that is also reported on its own.
	expect(live.cost).toBe(0);
	expect(live.totalTokens).toBe(0);
	await manager.flush();
	await manager.close();

	const reopened = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
	const replayed = reopened.getUsageStatistics();
	await reopened.close();
	expect(replayed.subagent).toEqual(live.subagent);
});

test("a settled subagent run bills its own spend plus the nested spend it never reported", () => {
	const nested = {
		input: 300,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 400,
		premiumRequests: 0,
		cost: 0.05,
		agents: 1,
		runs: 1,
	};
	const first = subagentRunUsage(result({ usage: usage(1000, 200, 0.1), subagentUsage: nested }));
	expect(first?.totalTokens).toBe(1600);
	expect(first?.cost.total).toBeCloseTo(0.15, 10);

	// The worker's next turn reports the same nested cumulative total: nothing new to bill.
	const second = subagentRunUsage(result({ usage: usage(500, 100, 0.05), subagentUsage: nested }), nested);
	expect(second?.totalTokens).toBe(600);
	expect(second?.cost.total).toBeCloseTo(0.05, 10);

	// Nested spend that grew since the last turn bills only the delta.
	const grown = { ...nested, totalTokens: 900, input: 600, output: 300, cost: 0.09, runs: 2 };
	const third = subagentRunUsage(result({ usage: usage(500, 100, 0.05), subagentUsage: grown }), nested);
	expect(third?.totalTokens).toBe(1100);
	expect(third?.cost.total).toBeCloseTo(0.09, 10);
});

test("recordSubagentRun attributes each run to the owning session and returns the next baseline", async () => {
	const { manager } = await openSession("proto-subagent-rollup-");
	const session = { sessionManager: manager };
	const nested = {
		input: 200,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 300,
		premiumRequests: 0,
		cost: 0.03,
		agents: 1,
		runs: 1,
	};
	const baseline = recordSubagentRun(session, result({ usage: usage(1000, 200, 0.1), subagentUsage: nested }), {
		agentId: "w1",
		agent: "worker",
		turn: 1,
	});
	expect(baseline).toEqual(nested);

	recordSubagentRun(session, result({ usage: usage(400, 100, 0.04), subagentUsage: nested }), {
		agentId: "w1",
		agent: "worker",
		turn: 2,
		nestedBaseline: baseline,
	});

	const totals = manager.getSubagentUsage();
	await manager.close();
	expect(totals.cost).toBeCloseTo(0.17, 10);
	expect(totals.totalTokens).toBe(2000);
	expect(totals.runs).toBe(2);
	expect(totals.agents).toBe(1);
});

test("a run that reported no usage at all is not recorded as spend", async () => {
	const { manager } = await openSession("proto-subagent-empty-");
	recordSubagentRun({ sessionManager: manager }, result({}), { agentId: "w1" });
	const totals = manager.getSubagentUsage();
	await manager.close();
	expect(totals.runs).toBe(0);
	expect(totals.cost).toBe(0);
});
