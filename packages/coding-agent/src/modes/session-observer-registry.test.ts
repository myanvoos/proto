import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../registry/agent-registry";
import {
	type AgentProgress,
	projectAgentProgress,
	WORKER_SUBAGENT_LIFECYCLE_CHANNEL,
	WORKER_SUBAGENT_PROGRESS_CHANNEL,
} from "../task";
import { EventBus } from "../utils/event-bus";
import { SessionObserverRegistry } from "./session-observer-registry";

function subagentProgress(): AgentProgress {
	return {
		index: 0,
		id: "worker",
		agent: "lightbot",
		agentSource: "bundled",
		status: "running",
		task: "task",
		recentTools: [],
		recentOutput: [],
		toolCount: 1,
		requests: 1,
		tokens: 1,
		cost: 0,
		durationMs: 1,
		extractedToolData: { yield: [{ data: "large result" }] },
	};
}
describe("SessionObserverRegistry subagent progress", () => {
	test("retains display progress without retaining extracted yield data", () => {
		const registry = new SessionObserverRegistry();
		const eventBus = new EventBus();
		registry.subscribeToEventBus(eventBus);
		const progress = subagentProgress();
		const projected = projectAgentProgress(progress);

		eventBus.emit(WORKER_SUBAGENT_PROGRESS_CHANNEL, {
			id: progress.id,
			index: progress.index,
			agent: progress.agent,
			agentSource: progress.agentSource,
			task: progress.task,
			progress: projected,
		});

		const observed = registry.getSession(progress.id);
		expect(observed?.progress?.requests).toBe(1);
		expect("extractedToolData" in (observed?.progress ?? {})).toBe(false);
		expect(progress.extractedToolData?.yield).toHaveLength(1);
	});
});

describe("SessionObserverRegistry detached reattachment", () => {
	test("restores running workers from the reattached session fleet", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "running-worker",
			label: "running-worker",
			kind: "sub",
			fleetRoot: "/session-a/fleet",
			sessionFile: "/session-a/fleet/running-worker.jsonl",
			status: "running",
			session: null,
			activity: "checking the detached turn",
		});
		agents.register({
			id: "other-worker",
			label: "other-worker",
			kind: "sub",
			fleetRoot: "/session-b/fleet",
			status: "running",
			session: null,
		});
		const observers = new SessionObserverRegistry();

		observers.seedAgentRefs(agents.listInFleet("running-worker"));

		expect(observers.getActiveSubagentCount()).toBe(1);
		expect(observers.getSession("running-worker")).toMatchObject({
			status: "active",
			description: "checking the detached turn",
			sessionFile: "/session-a/fleet/running-worker.jsonl",
		});
		expect(observers.getSession("other-worker")).toBeUndefined();
	});

	test("ignores progress emitted by a different detached session fleet", () => {
		const observers = new SessionObserverRegistry();
		const eventBus = new EventBus();
		observers.setMainSession("/session-b.jsonl", "/session-b/fleet");
		observers.subscribeToEventBus(eventBus);
		const progress = subagentProgress();

		eventBus.emit(WORKER_SUBAGENT_PROGRESS_CHANNEL, {
			id: progress.id,
			index: progress.index,
			agent: progress.agent,
			agentSource: progress.agentSource,
			task: progress.task,
			progress: projectAgentProgress(progress),
			fleetRoot: "/session-a/fleet",
		});
		expect(observers.getSession(progress.id)).toBeUndefined();

		eventBus.emit(WORKER_SUBAGENT_PROGRESS_CHANNEL, {
			id: progress.id,
			index: progress.index,
			agent: progress.agent,
			agentSource: progress.agentSource,
			task: progress.task,
			progress: projectAgentProgress(progress),
			fleetRoot: "/session-b/fleet",
		});
		expect(observers.getSession(progress.id)?.status).toBe("active");
	});
});

test("completed progress and grouping owners retire without hiding active workers or durable histories", () => {
	const registry = new SessionObserverRegistry();
	const bus = new EventBus();
	registry.subscribeToEventBus(bus);
	bus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "active",
		status: "started",
		index: 0,
		parentToolCallId: "active-group",
	});
	for (let index = 0; index < 160; index++) {
		bus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: `finished-${index}`,
			status: "completed",
			index: 0,
			parentToolCallId: `group-${index}`,
			sessionFile: `/history/finished-${index}.jsonl`,
		});
	}
	expect(registry.getActiveSubagentCount()).toBe(1);
	expect(registry.getSessions()).toHaveLength(129);
	expect(registry.getSession("finished-0")).toBeUndefined();
	expect(registry.getSession("finished-159")?.sessionFile).toBe("/history/finished-159.jsonl");
	bus.emit(WORKER_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "finished-0",
		status: "started",
		index: 0,
		parentToolCallId: "new-group",
	});
	expect(registry.getSession("finished-0")?.status).toBe("active");
	expect(registry.getActiveSubagentCount()).toBe(2);
	registry.dispose();
});

test("progress previews bound task, tool, retry and output bytes without discarding usage counters", () => {
	const progress = subagentProgress();
	const oversized = "é".repeat(128 * 1024);
	progress.task = oversized;
	progress.assignment = oversized;
	progress.currentToolArgs = oversized;
	progress.recentTools = Array.from({ length: 40 }, () => ({ tool: "read", args: oversized, endMs: 1 }));
	progress.recentOutput = Array.from({ length: 40 }, () => oversized);
	progress.retryFailure = { attempt: 1, errorMessage: oversized };
	const observed = projectAgentProgress(progress);
	expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(40 * 1024);
	expect(observed.tokens).toBe(progress.tokens);
	expect(observed.recentOutput).toHaveLength(8);
	expect(progress.task).toBe(oversized);
});
