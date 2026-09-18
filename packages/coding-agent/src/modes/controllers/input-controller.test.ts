import { expect, test } from "bun:test";
import type { AgentSession } from "../../session/agent-session";
import type { InteractiveModeContext } from "../types";
import { InputController } from "./input-controller";

test("Escape surfaces a streaming abort rejection", async () => {
	const errors: string[] = [];
	const editor = {
		onEscape: undefined as (() => void) | undefined,
		getText: () => "",
		setText: () => {},
		setActionKeys: () => {},
		clearCustomKeyHandlers: () => {},
		setCustomKeyHandler: () => {},
		composerChips: () => [],
		pasteText: () => {},
	};
	const session = {
		isStreaming: true,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		abort: () => Promise.reject(new Error("abort transaction failed")),
	} as unknown as AgentSession;
	const context = {
		editor,
		session,
		viewSession: { isCompacting: false, isRetrying: false },
		focusedAgentId: undefined,
		mcpTestEscapeHandlers: new Set<() => void>(),
		hasActiveSideQuestion: () => false,
		handleSideQuestionEscape: () => false,
		loopModeEnabled: false,
		loadingAnimation: undefined,
		isBashMode: false,
		isPythonMode: false,
		keybindings: { getKeys: () => [], matches: () => false },
		ui: {
			addInputListener: () => {},
			addStartListener: () => {},
			hasOverlay: () => false,
			getFocused: () => editor,
			requestRender: () => {},
			terminal: { write: () => {} },
		},
		showStatus: () => {},
		showError: (message: string) => errors.push(message),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(context);
	controller.setupKeyHandlers();

	editor.onEscape?.();
	const nextTurn = Promise.withResolvers<void>();
	setImmediate(nextTurn.resolve);
	await nextTurn.promise;

	expect(errors).toEqual(["Failed to abort session: abort transaction failed"]);
});
