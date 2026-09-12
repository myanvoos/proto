import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../registry/agent-registry";
import { type AgentProgress, projectAgentProgress, WORKER_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import { EventBus } from "../utils/event-bus";
import {
	CONDUCTOR_SESSION_ID,
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "./session-observer-registry";

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
function conductorSession(status: ObservableSession["status"] = "active"): ObservableSession {
	return {
		id: CONDUCTOR_SESSION_ID,
		kind: "conductor",
		label: "verifying — fix the flaky auth test",
		agent: "conductor",
		description: "verifying — fix the flaky auth test",
		status,
		lastUpdate: Date.now(),
	};
}

describe("SessionObserverRegistry conductor slot", () => {
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

	test("upserts the conductor observable and reports it through change listeners", () => {
		const registry = new SessionObserverRegistry();
		const kinds: SessionObserverChangeKind[] = [];
		registry.onChange(kind => kinds.push(kind));

		registry.setConductor(conductorSession());

		const session = registry.getSession(CONDUCTOR_SESSION_ID);
		expect(session?.kind).toBe("conductor");
		expect(session?.status).toBe("active");
		expect(kinds).toContain("progress");
	});

	test("removing the conductor observable is a no-op when none exists, and clears it when it does", () => {
		const registry = new SessionObserverRegistry();

		registry.setConductor(undefined);
		expect(registry.getSession(CONDUCTOR_SESSION_ID)).toBeUndefined();

		registry.setConductor(conductorSession());
		registry.setConductor(undefined);
		expect(registry.getSession(CONDUCTOR_SESSION_ID)).toBeUndefined();
	});

	test("a conductor run never inflates the active subagent count or the subagent HUD filter", () => {
		const registry = new SessionObserverRegistry();
		registry.setConductor(conductorSession("active"));

		expect(registry.getActiveSubagentCount()).toBe(0);
		const hudSessions = registry
			.getSessions()
			.filter(session => session.kind === "subagent" && session.status === "active" && session.detached === true);
		expect(hudSessions).toHaveLength(0);
		// …but it IS listed alongside the main session for the conductor HUD to pick up.
		expect(registry.getSessions().map(session => session.kind)).toContain("conductor");
	});

	test("terminal statuses keep the row so the fleet detail survives, while active filters drop it", () => {
		const registry = new SessionObserverRegistry();
		registry.setConductor(conductorSession("completed"));

		const session = registry.getSession(CONDUCTOR_SESSION_ID);
		expect(session?.status).toBe("completed");
		expect(session?.kind).toBe("conductor");
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
