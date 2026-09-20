import { afterEach, expect, test, vi } from "bun:test";
import type { AgentSession } from "../../session/agent-session";
import * as commandUsage from "../../utils/command-usage";
import type { InteractiveModeContext } from "../types";
import { InputController } from "./input-controller";

afterEach(() => vi.restoreAllMocks());

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

function submitHarness(options: { fileSlashCommands?: string[]; promptTemplates?: string[] } = {}) {
	vi.spyOn(commandUsage, "recordSlashCommandUsage").mockImplementation(() => {});
	const statuses: string[] = [];
	const submitted: string[] = [];
	let helpPanels = 0;
	const editor = {
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		text: "",
		pendingImages: [] as unknown[],
		pendingImageLinks: [] as unknown[],
		imageLinks: undefined,
		setText(text: string) {
			this.text = text;
		},
		addToHistory: () => {},
		clearDraft: () => {},
	};
	const session = {
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		customCommands: [],
		promptTemplates: (options.promptTemplates ?? []).map(name => ({ name, content: name })),
		maybeStartTitleGeneration: () => {},
	} as unknown as AgentSession;
	const context = {
		editor,
		session,
		focusedAgentId: undefined,
		loopModeEnabled: false,
		skillCommands: new Map(),
		fileSlashCommands: new Set(options.fileSlashCommands ?? []),
		isKnownSlashCommand: (text: string) => options.fileSlashCommands?.includes(text.slice(1)) ?? false,
		ensureLatestTranscriptWindow: async () => {},
		flushPendingBashComponents: () => {},
		startPendingSubmission: (input: { text: string }) => input,
		onInputCallback: (input: { text: string }) => submitted.push(input.text),
		handleHelpCommand: () => {
			helpPanels++;
		},
		showStatus: (message: string) => statuses.push(message),
		showWarning: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	new InputController(context).setupEditorSubmitHandler();
	const submit = async (text: string) => {
		editor.text = "";
		await editor.onSubmit?.(text);
	};
	return {
		submit,
		editor,
		statuses,
		submitted,
		get helpPanels() {
			return helpPanels;
		},
	};
}

test("a bare unknown slash command is reported and kept in the editor instead of prompting the model", async () => {
	const { submit, editor, statuses, submitted } = submitHarness({ fileSlashCommands: ["review"] });

	await submit("/hlep");

	expect(statuses).toEqual(["Unknown command /hlep — type / to browse commands"]);
	expect(editor.text).toBe("/hlep");
	expect(submitted).toEqual([]);
});

test("known file, template and argument-bearing slash inputs still reach the model", async () => {
	const { submit, statuses, submitted } = submitHarness({
		fileSlashCommands: ["review"],
		promptTemplates: ["standup"],
	});

	await submit("/review");
	await submit("/standup");
	await submit("/hlep now please");
	await submit("/hlep\nexplain this");
	await submit("/tmp/file");

	expect(statuses).toEqual([]);
	expect(submitted).toEqual(["/review", "/standup", "/hlep now please", "/hlep\nexplain this", "/tmp/file"]);
});

test("help and its question-mark alias open help without sending a model prompt", async () => {
	const harness = submitHarness();

	await harness.submit("/help");
	await harness.submit("/?");

	expect(harness.helpPanels).toBe(2);
	expect(harness.statuses).toEqual([]);
	expect(harness.submitted).toEqual([]);
});
