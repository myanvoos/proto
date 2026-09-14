import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../registry/agent-registry";
import { type AgentProgress, projectAgentProgress, WORKER_SUBAGENT_PROGRESS_CHANNEL } from "../task";
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
			displayName: "running-worker",
			kind: "sub",
			fleetRoot: "/session-a/fleet",
			sessionFile: "/session-a/fleet/running-worker.jsonl",
			status: "running",
			session: null,
			activity: "checking the detached turn",
		});
		agents.register({
			id: "other-worker",
			displayName: "other-worker",
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
