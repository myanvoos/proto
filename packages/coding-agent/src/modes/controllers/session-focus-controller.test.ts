import { expect, test } from "bun:test";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { InteractiveModeContext } from "../types";
import { SessionFocusController } from "./session-focus-controller";

test("registry-driven unfocus restores the main subscription and surfaces attachment failures", async () => {
	let focusedSubscriptions = 0;
	let mainSubscriptions = 0;
	let failNextMainSubscription = false;
	const focusedSession = {
		isStreaming: false,
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [],
		subscribe: () => {
			focusedSubscriptions++;
			return () => {
				focusedSubscriptions--;
			};
		},
	} as unknown as AgentSession;
	const mainSession = {
		isStreaming: false,
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [],
		subscribe: () => {
			if (failNextMainSubscription) {
				failNextMainSubscription = false;
				throw new Error("main subscription failed once");
			}
			mainSubscriptions++;
			return () => {
				mainSubscriptions--;
			};
		},
	} as unknown as AgentSession;
	const errors: string[] = [];
	const context = {
		session: mainSession,
		unsubscribe: undefined,
		clearTransientSessionUi: () => {},
		eventController: {
			resetTranscriptAnchors: () => 1,
			dispatchEvent: async () => {},
		},
		statusLine: { setSession: () => {} },
		renderInitialMessages: async () => {},
		reloadChecklist: async () => {},
		updatePendingMessagesDisplay: () => {},
		updateEditorBorderColor: () => {},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		showError: (message: string) => errors.push(message),
	} as unknown as InteractiveModeContext;
	const registry = new AgentRegistry();
	registry.register({
		id: MAIN_AGENT_ID,
		label: "main",
		kind: "main",
		session: mainSession,
	});
	registry.register({
		id: "focused-worker",
		label: "focused-worker",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		status: "running",
		session: focusedSession,
	});
	const holds: Array<string | undefined> = [];
	const lifecycle = {
		ensureLive: async () => focusedSession,
		holdForFocus: (id: string | undefined) => holds.push(id),
	} as unknown as AgentLifecycleManager;
	const controller = new SessionFocusController(context, registry, () => lifecycle);
	try {
		await controller.focusAgent("focused-worker");
		expect(focusedSubscriptions).toBe(1);
		// Focus pins the agent against the idle reclaim timer for as long as it is on screen.
		expect(holds).toEqual(["focused-worker"]);

		failNextMainSubscription = true;
		expect(registry.setStatus("focused-worker", "parked")).toBe(true);
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;

		expect(controller.focusedAgentId).toBeUndefined();
		expect(controller.target).toBeUndefined();
		expect(holds).toEqual(["focused-worker", undefined]);
		expect(focusedSubscriptions).toBe(0);
		expect(mainSubscriptions).toBe(1);
		expect(errors).toEqual(["Failed to return to the main session: main subscription failed once"]);
	} finally {
		context.unsubscribe?.();
		controller.dispose();
	}
});

test("parent hops walk a side agent's subagent up to the side agent, then back to main", async () => {
	const sessionFor = (id: string) =>
		({
			id,
			isStreaming: false,
			subscribe: () => () => {},
			settleInFlightMessagePersistence: async () => {},
			activeToolExecutionUpdates: () => [],
		}) as unknown as AgentSession;
	const mainSession = sessionFor(MAIN_AGENT_ID);
	const sessions: Record<string, AgentSession> = {
		"Side-1": sessionFor("Side-1"),
		"Side-1-worker": sessionFor("Side-1-worker"),
	};
	const viewed: AgentSession[] = [];
	const checklistSources: AgentSession[] = [];
	const context = {
		session: mainSession,
		unsubscribe: undefined,
		clearTransientSessionUi: () => {},
		eventController: { resetTranscriptAnchors: () => 1, dispatchEvent: async () => {} },
		statusLine: { setSession: (session: AgentSession) => viewed.push(session) },
		renderInitialMessages: async () => {},
		reloadChecklist: async (source: AgentSession) => {
			checklistSources.push(source);
		},
		updatePendingMessagesDisplay: () => {},
		updateEditorBorderColor: () => {},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	const registry = new AgentRegistry();
	registry.register({ id: MAIN_AGENT_ID, label: "main", kind: "main", session: mainSession });
	registry.register({
		id: "Side-1",
		label: "side",
		kind: "side",
		parentId: MAIN_AGENT_ID,
		status: "idle",
		session: sessions["Side-1"],
	});
	registry.register({
		id: "Side-1-worker",
		label: "worker",
		kind: "sub",
		parentId: "Side-1",
		status: "running",
		session: sessions["Side-1-worker"],
	});
	const lifecycle = {
		ensureLive: async (id: string) => sessions[id],
		holdForFocus: () => {},
	} as unknown as AgentLifecycleManager;
	const controller = new SessionFocusController(context, registry, () => lifecycle);
	try {
		await controller.focusAgent("Side-1-worker");
		await controller.focusParent();
		expect(controller.focusedAgentId).toBe("Side-1");

		await controller.focusParent();
		expect(controller.focusedAgentId).toBeUndefined();
		expect(viewed).toEqual([sessions["Side-1-worker"], sessions["Side-1"], mainSession]);
		// The checklist HUD reloads each attached session's own plan, never the main session's.
		expect(checklistSources).toEqual(viewed);
	} finally {
		controller.dispose();
	}
});

function focusHarness() {
	const subscriptions = new Map<AgentSession, number>();
	const blocked = new Map<AgentSession, Promise<void>>();
	const failing = new Set<AgentSession>();
	const sessionFor = (id: string, updates: unknown[] = []) => {
		const session = {
			id,
			isStreaming: false,
			subscribe: () => {
				if (failing.has(session)) throw new Error(`${id} subscription failed`);
				subscriptions.set(session, (subscriptions.get(session) ?? 0) + 1);
				return () => subscriptions.set(session, (subscriptions.get(session) ?? 0) - 1);
			},
			settleInFlightMessagePersistence: async () => {},
			activeToolExecutionUpdates: () => updates,
		} as unknown as AgentSession;
		return session;
	};
	const main = sessionFor(MAIN_AGENT_ID);
	const viewed: AgentSession[] = [];
	const checklistSources: AgentSession[] = [];
	const dispatched: unknown[] = [];
	const statuses: string[] = [];
	let pendingDisplays = 0;
	let renderStarted = Promise.withResolvers<void>();
	const context = {
		session: main,
		unsubscribe: undefined,
		clearTransientSessionUi: () => {},
		eventController: {
			resetTranscriptAnchors: () => 1,
			dispatchEvent: async (event: unknown) => {
				dispatched.push(event);
			},
		},
		statusLine: { setSession: (session: AgentSession) => viewed.push(session) },
		renderInitialMessages: async () => {
			renderStarted.resolve();
			await blocked.get(viewed.at(-1)!);
		},
		reloadChecklist: async (source: AgentSession) => {
			checklistSources.push(source);
		},
		updatePendingMessagesDisplay: () => {
			pendingDisplays++;
		},
		updateEditorBorderColor: () => {},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => statuses.push(message),
		showError: () => {},
	} as unknown as InteractiveModeContext;
	const registry = new AgentRegistry();
	registry.register({ id: MAIN_AGENT_ID, label: "main", kind: "main", session: main });
	const revives = new Map<string, Promise<AgentSession>>();
	const sessions = new Map<string, AgentSession>();
	const addAgent = (id: string, updates: unknown[] = []) => {
		const session = sessionFor(id, updates);
		sessions.set(id, session);
		registry.register({ id, label: id, kind: "sub", parentId: MAIN_AGENT_ID, status: "running", session });
		return session;
	};
	const lifecycle = {
		ensureLive: async (id: string) => (await revives.get(id)) ?? sessions.get(id),
		holdForFocus: () => {},
	} as unknown as AgentLifecycleManager;
	const controller = new SessionFocusController(context, registry, () => lifecycle);
	return {
		main,
		context,
		controller,
		addAgent,
		revives,
		blocked,
		failing,
		subscriptions,
		viewed,
		checklistSources,
		dispatched,
		statuses,
		pendingDisplays: () => pendingDisplays,
		nextRender: () => {
			renderStarted = Promise.withResolvers<void>();
			return renderStarted.promise;
		},
	};
}

test("a slow revive that resolves after a newer focus request does not replace the view", async () => {
	const h = focusHarness();
	const slow = h.addAgent("slow");
	const fast = h.addAgent("fast");
	const revive = Promise.withResolvers<AgentSession>();
	h.revives.set("slow", revive.promise);
	try {
		const first = h.controller.focusAgent("slow");
		await h.controller.focusAgent("fast");
		revive.resolve(slow);
		await first;

		expect(h.controller.focusedAgentId).toBe("fast");
		expect(h.viewed).toEqual([fast]);
	} finally {
		h.controller.dispose();
	}
});

test("leaving for main cancels a focus request still waiting on its revive", async () => {
	const h = focusHarness();
	const parked = h.addAgent("parked");
	const revive = Promise.withResolvers<AgentSession>();
	h.revives.set("parked", revive.promise);
	try {
		const pending = h.controller.focusAgent("parked");
		await h.controller.unfocus();
		revive.resolve(parked);
		await pending;

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.viewed).toEqual([]);
	} finally {
		h.controller.dispose();
	}
});

test("a superseded attachment stops before reloading its HUD or announcing its view", async () => {
	const h = focusHarness();
	const first = h.addAgent("first");
	const second = h.addAgent("second");
	const render = Promise.withResolvers<void>();
	h.blocked.set(first, render.promise);
	try {
		const rendering = h.nextRender();
		const pending = h.controller.focusAgent("first");
		await rendering;
		await h.controller.focusAgent("second");
		render.resolve();
		await pending;

		expect(h.controller.focusedAgentId).toBe("second");
		expect(h.checklistSources).toEqual([second]);
		expect(h.statuses).toHaveLength(1);
		expect(h.statuses[0]).toContain("Viewing agent second");
	} finally {
		h.controller.dispose();
	}
});

test("a failed focus attachment restores the main session subscription", async () => {
	const h = focusHarness();
	const broken = h.addAgent("broken");
	h.failing.add(broken);
	try {
		await expect(h.controller.focusAgent("broken")).rejects.toThrow("broken subscription failed");

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.subscriptions.get(h.main)).toBe(1);
		expect(h.viewed).toEqual([h.main]);
	} finally {
		h.context.unsubscribe?.();
		h.controller.dispose();
	}
});

test("attaching repaints queued messages and replays running tools' latest partial results", async () => {
	const update = { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: {} };
	const h = focusHarness();
	h.addAgent("worker", [update]);
	try {
		await h.controller.focusAgent("worker");

		expect(h.pendingDisplays()).toBe(1);
		expect(h.dispatched).toContain(update);
	} finally {
		h.context.unsubscribe?.();
		h.controller.dispose();
	}
});
