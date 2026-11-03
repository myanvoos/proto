import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionActions, ExtensionUIContext } from "../../extensibility/extensions/types";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

type Rendered = { level: "info" | "warning" | "error"; message: string };

function makeController(): {
	controller: ExtensionUiController;
	rendered: Rendered[];
	setSessionId: (id: string) => void;
} {
	const rendered: Rendered[] = [];
	const session = { sessionId: "session-a" };
	const ctx = {
		session,
		showStatus: (message: string) => rendered.push({ level: "info", message }),
		showWarning: (message: string) => rendered.push({ level: "warning", message }),
		showError: (message: string) => rendered.push({ level: "error", message }),
	} as unknown as InteractiveModeContext;
	return {
		controller: new ExtensionUiController(ctx),
		rendered,
		setSessionId: id => {
			session.sessionId = id;
		},
	};
}

test("a background extension repeating one unchanged warning renders it once", () => {
	const { controller, rendered } = makeController();
	const warning = "Observational memory: no observations — model did not call the observation tool";

	// Eight auto-compactions, each emitting the same warning plus a stats line
	// whose text differs per turn.
	for (let turn = 1; turn <= 8; turn++) {
		controller.showHookNotify(`Observational memory: observer running on ~${turn}k-token chunk`, "info");
		controller.showHookNotify(warning, "warning");
		controller.showHookNotify(`2 source entries processed; tail kept 0/${turn} user turns`, "info");
	}

	expect(rendered.filter(entry => entry.message === warning)).toHaveLength(1);
	// Everything whose text actually changed still renders on every turn.
	expect(rendered.filter(entry => entry.message.startsWith("Observational memory: observer running"))).toHaveLength(8);
	expect(rendered.filter(entry => entry.message.startsWith("2 source entries processed"))).toHaveLength(8);
});

test("a notice renders again once its text changes", () => {
	const { controller, rendered } = makeController();
	controller.showHookNotify("same", "warning");
	controller.showHookNotify("same", "warning");
	controller.showHookNotify("different", "warning");
	controller.showHookNotify("same", "warning");

	expect(rendered.map(entry => entry.message)).toEqual(["same", "different", "same"]);
});

test("identical text at different levels is tracked independently", () => {
	const { controller, rendered } = makeController();
	controller.showHookNotify("duplicate", "info");
	controller.showHookNotify("duplicate", "warning");
	controller.showHookNotify("duplicate", "error");
	controller.showHookNotify("duplicate", "info");
	controller.showHookNotify("duplicate", "warning");
	controller.showHookNotify("duplicate", "error");

	expect(rendered).toEqual([
		{ level: "info", message: "duplicate" },
		{ level: "warning", message: "duplicate" },
		{ level: "error", message: "duplicate" },
	]);
});

test("an omitted level is treated as info, matching the render it produces", () => {
	const { controller, rendered } = makeController();
	controller.showHookNotify("no level given");
	controller.showHookNotify("no level given", "info");

	expect(rendered).toEqual([{ level: "info", message: "no level given" }]);
});

test("switching sessions clears the collapse memory", () => {
	const { controller, rendered, setSessionId } = makeController();
	controller.showHookNotify("carried over", "warning");
	controller.showHookNotify("carried over", "warning");
	expect(rendered).toHaveLength(1);

	setSessionId("session-b");
	controller.showHookNotify("carried over", "warning");
	controller.showHookNotify("carried over", "warning");

	expect(rendered).toHaveLength(2);
});

test("an idle nextTurn extension notice appends once without resetting the existing transcript", async () => {
	const captured: { actions?: ExtensionActions } = {};
	const messages: AgentMessage[] = [];
	const appended: AgentMessage[] = [];
	let rebuilds = 0;
	const session = {
		isStreaming: false,
		messages,
		extensionRunner: {
			initialize: (actions: ExtensionActions) => {
				captured.actions = actions;
			},
		},
		sendCustomMessage: async (message: { customType: string; content: string | unknown[]; display: boolean }) => {
			messages.push({ role: "custom", ...message, timestamp: 1 } as AgentMessage);
		},
	};
	const ctx = {
		session,
		initialChatRendered: true,
		addMessageToChat: (message: AgentMessage) => appended.push(message),
		rebuildChatFromMessages: () => {
			rebuilds++;
		},
		ui: { requestRender: () => {} },
		showError: (message: string) => {
			throw new Error(message);
		},
	} as unknown as InteractiveModeContext;
	new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, true);
	captured.actions?.sendMessage(
		{ customType: "notice", content: "new notice", display: true },
		{ deliverAs: "nextTurn" },
	);
	await Promise.resolve();
	await Promise.resolve();
	expect(appended).toEqual(messages);
	expect(appended).toHaveLength(1);
	expect(rebuilds).toBe(0);
});
