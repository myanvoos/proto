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
		subscribe: () => {
			focusedSubscriptions++;
			return () => {
				focusedSubscriptions--;
			};
		},
	} as unknown as AgentSession;
	const mainSession = {
		isStreaming: false,
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
		({ id, isStreaming: false, subscribe: () => () => {} }) as unknown as AgentSession;
	const mainSession = sessionFor(MAIN_AGENT_ID);
	const sessions: Record<string, AgentSession> = {
		"Side-1": sessionFor("Side-1"),
		"Side-1-worker": sessionFor("Side-1-worker"),
	};
	const viewed: AgentSession[] = [];
	const context = {
		session: mainSession,
		unsubscribe: undefined,
		clearTransientSessionUi: () => {},
		eventController: { resetTranscriptAnchors: () => 1, dispatchEvent: async () => {} },
		statusLine: { setSession: (session: AgentSession) => viewed.push(session) },
		renderInitialMessages: async () => {},
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
	} finally {
		controller.dispose();
	}
});
