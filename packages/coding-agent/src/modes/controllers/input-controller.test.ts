import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBytes } from "@oh-my-pi/pi-utils";
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

test("focused-agent gestures: Esc returns to main, ←← hops to the parent, →→ opens the agent's subagents", async () => {
	const navigation: string[] = [];
	const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
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
	const context = {
		editor,
		session: { isStreaming: false, isBashRunning: false, isEvalRunning: false, extensionRunner: undefined },
		focusedAgentId: "Side-1",
		lastLeftTapTime: 0,
		lastRightTapTime: 0,
		mcpTestEscapeHandlers: new Set<() => void>(),
		hasActiveSideQuestion: () => false,
		keybindings: { getKeys: () => [], matches: () => false },
		ui: {
			addInputListener: (listener: (data: string) => { consume?: boolean } | undefined) =>
				inputListeners.push(listener),
			addStartListener: () => {},
			hasOverlay: () => false,
			getFocused: () => editor,
			requestRender: () => {},
			terminal: { write: () => {} },
		},
		unfocusSession: async () => {
			navigation.push("main");
		},
		focusParentSession: async () => {
			navigation.push("parent");
		},
		showAgentsView: async (scope: string) => {
			navigation.push(`agents:${scope}`);
		},
		showStatus: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	new InputController(context).setupKeyHandlers();
	let now = 10_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const doubleTap = (data: string) => {
		for (let tap = 0; tap < 2; tap++) {
			now += 100;
			for (const listener of inputListeners) {
				if (listener(data)?.consume) break;
			}
		}
	};

	editor.onEscape?.();
	doubleTap("\x1b[D");
	now += 1_000;
	doubleTap("\x1b[C");

	expect(navigation).toEqual(["main", "parent", "agents:current"]);
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

function focusedSubmitHarness() {
	vi.spyOn(commandUsage, "recordSlashCommandUsage").mockImplementation(() => {});
	const statuses: string[] = [];
	const prompted: Array<{ text: string; streamingBehavior: string }> = [];
	let modelSelectors = 0;
	const editor = {
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		text: "",
		pendingImages: [] as unknown[],
		pendingImageLinks: [] as unknown[],
		imageLinks: undefined,
		setText(text: string) {
			this.text = text;
		},
		setCollapsedText(text: string) {
			this.text = text;
		},
		getExpandedText() {
			return this.text;
		},
		addToHistory: () => {},
		clearDraft: () => {},
	};
	const mainSession = {
		isStreaming: false,
		isCompacting: false,
		prompt: () => Promise.reject(new Error("the main session must not receive a focused submission")),
		maybeStartTitleGeneration: () => {},
	} as unknown as AgentSession;
	const viewSession = {
		isStreaming: false,
		queuedMessageCount: 0,
		prompt: (text: string, options: { streamingBehavior: string }) => {
			prompted.push({ text, streamingBehavior: options.streamingBehavior });
			return Promise.resolve();
		},
	} as unknown as AgentSession;
	const context = {
		editor,
		session: mainSession,
		viewSession,
		focusedAgentId: "Side-1",
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: () => false,
		withLocalSubmission: (_text: string, run: () => Promise<void>) => run(),
		updatePendingMessagesDisplay: () => {},
		showModelSelector: () => {
			modelSelectors++;
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => statuses.push(message),
		showWarning: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(context);
	controller.setupEditorSubmitHandler();
	return {
		submit: (text: string) => editor.onSubmit?.(text) ?? Promise.resolve(),
		followUp: () => controller.handleFollowUp(),
		editor,
		statuses,
		prompted,
		get modelSelectors() {
			return modelSelectors;
		},
	};
}

test("a focused agent takes plain messages as steers and follow-ups instead of the main session", async () => {
	const harness = focusedSubmitHarness();

	await harness.submit("keep going on the parser");
	harness.editor.text = "and then run the tests";
	await harness.followUp();

	expect(harness.prompted).toEqual([
		{ text: "keep going on the parser", streamingBehavior: "steer" },
		{ text: "and then run the tests", streamingBehavior: "followUp" },
	]);
	expect(harness.statuses).toEqual([]);
});

test("/model retargets the focused agent while other commands still bounce to the main session", async () => {
	const harness = focusedSubmitHarness();

	await harness.submit("/model");
	await harness.submit("/compact");

	expect(harness.modelSelectors).toBe(1);
	expect(harness.statuses).toEqual(["Commands run in the main session — press Esc to return first"]);
	expect(harness.prompted).toEqual([]);
});

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

function composerModeContext(): {
	context: InteractiveModeContext;
	editor: { onChange?: (text: string) => void };
	modes: { bash: boolean; python: boolean };
} {
	const editor = {
		onChange: undefined as ((text: string) => void) | undefined,
		getText: () => "",
		setText: () => {},
		setActionKeys: () => {},
		clearCustomKeyHandlers: () => {},
		setCustomKeyHandler: () => {},
		composerChips: () => [],
		pasteText: () => {},
		pendingImages: [],
		pendingImageLinks: [],
	};
	const modes = { bash: false, python: false };
	const context = {
		editor,
		session: { isStreaming: false, isBashRunning: false, isEvalRunning: false, extensionRunner: undefined },
		viewSession: { isCompacting: false, isRetrying: false },
		focusedAgentId: undefined,
		mcpTestEscapeHandlers: new Set<() => void>(),
		hasActiveSideQuestion: () => false,
		loadingAnimation: undefined,
		keybindings: { getKeys: () => [], matches: () => false },
		ui: {
			addInputListener: () => {},
			addStartListener: () => {},
			hasOverlay: () => false,
			getFocused: () => editor,
			requestRender: () => {},
			terminal: { write: () => {} },
		},
		updateEditorBorderColor: () => {},
		updatePlaceholder: () => {},
		showStatus: () => {},
		showError: () => {},
		get isBashMode() {
			return modes.bash;
		},
		set isBashMode(value: boolean) {
			modes.bash = value;
		},
		get isPythonMode() {
			return modes.python;
		},
		set isPythonMode(value: boolean) {
			modes.python = value;
		},
	} as unknown as InteractiveModeContext;
	return { context, editor, modes };
}

function composerModeFor(draft: string): { bash: boolean; python: boolean } {
	const { context, editor, modes } = composerModeContext();
	const controller = new InputController(context);
	controller.setupKeyHandlers();
	editor.onChange?.(draft);
	return modes;
}

test("$code without a space enters python mode, matching !cmd", () => {
	expect(composerModeFor("!ls")).toEqual({ bash: true, python: false });
	expect(composerModeFor("$print(1)")).toEqual({ bash: false, python: true });
	expect(composerModeFor("$$print(1)")).toEqual({ bash: false, python: true });
	expect(composerModeFor("$ print(1)")).toEqual({ bash: false, python: true });
});

test("$ stays out of python mode for shell interpolation and pasted shell prompts", () => {
	const dollar = "$";
	expect(composerModeFor(`${dollar}{HOME}/bin`)).toEqual({ bash: false, python: false });
	expect(composerModeFor(`${dollar}${dollar}{HOME}`)).toEqual({ bash: false, python: false });
	expect(composerModeFor("$ git status")).toEqual({ bash: false, python: false });
	expect(composerModeFor("$git status")).toEqual({ bash: false, python: false });
	expect(composerModeFor("plain text")).toEqual({ bash: false, python: false });
});

function imagePasteHarness() {
	const statuses: string[] = [];
	const pastedText: string[] = [];
	const editor = {
		pendingImages: [] as unknown[],
		pendingImageLinks: [] as unknown[],
		imageLinks: [] as unknown[],
		pasteText: (text: string) => pastedText.push(text),
		insertAtom: () => {},
	};
	const context = {
		editor,
		sessionManager: { getCwd: () => process.cwd(), putBlob: async () => undefined },
		ui: { requestRender: () => {} },
		showStatus: (message: string) => statuses.push(message),
		showWarning: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	const clipboard = {
		readImage: async () => null,
		readText: async () => "",
		readMacFileUrls: async () => [],
	} as unknown as ConstructorParameters<typeof InputController>[1];
	return { controller: new InputController(context, clipboard), editor, statuses, pastedText };
}

test("pasting a corrupt image path reports the failure instead of attaching undecodable bytes", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-image-paste-"));
	try {
		const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const body = Buffer.alloc(5000);
		for (let i = 0; i < body.length; i++) body[i] = (i * 37 + 11) % 251;
		const corrupt = path.join(directory, "corrupt.png");
		await Bun.write(corrupt, Buffer.concat([signature, body]));

		const harness = imagePasteHarness();
		await harness.controller.handleImagePathPaste(corrupt);

		expect(harness.editor.pendingImages).toHaveLength(0);
		expect(harness.statuses.join("\n")).toContain("corrupt or truncated");
		expect(harness.pastedText).toEqual([corrupt]);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

function largePasteHarness(choose: (title: string, options: Array<{ label: string }>) => Promise<string | undefined>) {
	const statuses: string[] = [];
	const attachments: Array<{ content: string; expansion?: string }> = [];
	const titles: string[] = [];
	const helpTexts: Array<string | undefined> = [];
	const editor = {
		insertTextAttachment: (content: string, expansion?: string) => attachments.push({ content, expansion }),
		insertText: () => {},
	};
	const context = {
		editor,
		settings: { get: () => 5 },
		showHookSelector: (title: string, options: Array<{ label: string }>, dialogOptions?: { helpText?: string }) => {
			titles.push(title);
			helpTexts.push(dialogOptions?.helpText);
			return choose(title, options);
		},
		ui: { requestRender: () => {} },
		showStatus: (message: string) => statuses.push(message),
		showError: () => {},
	} as unknown as InteractiveModeContext;
	return { controller: new InputController(context), statuses, attachments, titles, helpTexts };
}

test("cancelling the large-paste menu discards the paste instead of committing it", async () => {
	const { controller, statuses, attachments, titles, helpTexts } = largePasteHarness(() => Promise.resolve(undefined));
	const text = Array.from({ length: 221 }, () => "The quick brown fox jumps over the lazy dog").join("\n");

	await controller.presentLargePasteMenu(text, 221);

	expect(attachments).toEqual([]);
	expect(statuses).toEqual(["Discarded 221 pasted lines"]);
	expect(helpTexts).toEqual(["Esc to discard the paste"]);
	// The title carries the payload size, which a line count cannot convey.
	expect(titles[0]).toBe(`Pasted 221 lines · ${formatBytes(Buffer.byteLength(text))}`);
	expect(titles[0]).toContain("KB");
});

test("a large-paste menu that cannot open keeps the pasted text", async () => {
	const { controller, attachments, statuses } = largePasteHarness(() => Promise.reject(new Error("no dialog")));
	const text = "line\n".repeat(30);

	await controller.presentLargePasteMenu(text, 30);

	expect(attachments).toEqual([{ content: text, expansion: undefined }]);
	expect(statuses).toEqual([]);
});

test("a paste under the menu threshold attaches without a dialog", () => {
	const { controller, attachments, titles } = largePasteHarness(() => Promise.reject(new Error("unreachable")));
	const text = "line\nline\nline";

	expect(controller.handleLargePaste(text, 3)).toBe(true);

	expect(titles).toEqual([]);
	expect(attachments).toEqual([{ content: text, expansion: undefined }]);
});

test("choosing inline still attaches the paste", async () => {
	const { controller, attachments } = largePasteHarness((_title, options) =>
		Promise.resolve(options.find(option => option.label === "Paste inline")?.label),
	);
	const text = "line\n".repeat(30);

	await controller.presentLargePasteMenu(text, 30);

	expect(attachments).toEqual([{ content: text, expansion: undefined }]);
});
