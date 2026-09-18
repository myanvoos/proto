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
	const lifecycle = {
		ensureLive: async () => focusedSession,
	} as unknown as AgentLifecycleManager;
	const controller = new SessionFocusController(context, registry, () => lifecycle);
	try {
		await controller.focusAgent("focused-worker");
		expect(focusedSubscriptions).toBe(1);

		failNextMainSubscription = true;
		expect(registry.setStatus("focused-worker", "parked")).toBe(true);
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;

		expect(controller.focusedAgentId).toBeUndefined();
		expect(controller.target).toBeUndefined();
		expect(focusedSubscriptions).toBe(0);
		expect(mainSubscriptions).toBe(1);
		expect(errors).toEqual(["Failed to return to the main session: main subscription failed once"]);
	} finally {
		context.unsubscribe?.();
		controller.dispose();
	}
});
