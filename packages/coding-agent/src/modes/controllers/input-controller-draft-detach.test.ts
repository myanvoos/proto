import { afterEach, expect, test, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "../../config/keybindings";
import { Settings } from "../../config/settings";
import type { ExtensionRunner } from "../../extensibility/extensions/runner";
import type { InputEventResult } from "../../extensibility/extensions/types";
import type { Skill } from "../../extensibility/skills";
import * as commandUsage from "../../utils/command-usage";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme, initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { UiHelpers } from "../utils/ui-helpers";
import { InputController } from "./input-controller";
import { ScheduledQueueController } from "./scheduled-queue-controller";

await Settings.init({ inMemory: true });
initThemeSync();
afterEach(() => vi.restoreAllMocks());
const original: ImageContent = { type: "image", mimeType: "image/png", data: "b2xk" };
const newer: ImageContent = { type: "image", mimeType: "image/png", data: "bmV3" };

function harness() {
	vi.spyOn(commandUsage, "recordSlashCommandUsage").mockImplementation(() => {});
	const editor = new CustomEditor(getEditorTheme());
	const session = {
		isStreaming: true,
		isCompacting: false,
		queuedMessageCount: 0,
		customCommands: [],
		promptTemplates: [],
		prompt: vi.fn(async (_text: string, _options?: { images?: ImageContent[] }) => {}),
		followUp: vi.fn(async (_text: string, _images?: ImageContent[]) => {}),
		promptCustomMessage: vi.fn(async () => {}),
		extensionRunner: undefined as ExtensionRunner | undefined,
	};
	const ctx = {
		editor,
		session,
		viewSession: session,
		keybindings: new KeybindingsManager(),
		skillCommands: new Map<string, Skill>(),
		fileSlashCommands: new Set<string>(),
		compactionQueuedMessages: [],
		ui: { requestRender: vi.fn(), addInputListener: vi.fn(), addStartListener: vi.fn(), getFocused: () => editor },
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>) => submit(),
		ensureLatestTranscriptWindow: async () => {},
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		handleGoalModeCommand: vi.fn(async () => true),
		showSetupWizard: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	ctx.handleQueueCommand = (text, detached) => controller.handleQueueCommand(text, detached);
	const helpers = new UiHelpers(ctx);
	ctx.queueCompactionMessage = (text, mode, images, options) =>
		helpers.queueCompactionMessage(text, mode, images, options);
	controller.setupKeyHandlers();
	controller.setupEditorSubmitHandler();
	const onSubmit = editor.onSubmit;
	let enterCompletion: Promise<void> | undefined;
	editor.onSubmit = text => {
		enterCompletion = Promise.resolve(onSubmit?.(text));
		return enterCompletion;
	};
	function pressEnter() {
		enterCompletion = undefined;
		editor.handleInput("\r");
		if (!enterCompletion) throw new Error("Enter did not submit");
		return enterCompletion;
	}
	const followUp = vi.spyOn(controller, "handleFollowUp");
	function press() {
		const index = followUp.mock.calls.length;
		editor.handleInput("\x1b[13;5u");
		expect(followUp.mock.calls.length).toBe(index + 1);
		return followUp.mock.results[index].value as Promise<void>;
	}
	function draft(text: string, image = original, link = "local://old.png") {
		editor.pendingImages = [image];
		editor.pendingImageLinks = [link];
		editor.imageLinks = editor.pendingImageLinks;
		editor.setCollapsedText(text);
	}
	return { editor, session, ctx, press, pressEnter, draft };
}

test("double Ctrl+Enter dispatches a slow builtin only once and preserves newer text and images", async () => {
	const h = harness();
	const release = Promise.withResolvers<void>();
	const setup = vi.spyOn(h.ctx, "showSetupWizard").mockImplementation(() => release.promise);
	h.editor.setText("/setup");
	const first = h.press();
	expect(h.editor.getExpandedText()).toBe("");
	await h.press();
	expect(setup).toHaveBeenCalledTimes(1);
	h.draft("newer [Image #1]", newer, "local://new.png");
	release.resolve();
	await first;
	expect(h.editor.getExpandedText()).toBe("newer [Image #1]");
	expect(h.editor.pendingImages).toEqual([newer]);
});

test.each([
	{ streaming: true, reject: false },
	{ streaming: true, reject: true },
	{ streaming: false, reject: true },
])("Ctrl+Enter prompt preserves a newer draft (%j)", async ({ streaming, reject }) => {
	const h = harness();
	const release = Promise.withResolvers<void>();
	h.session.isStreaming = streaming;
	h.session.prompt.mockImplementation(async () => {
		await release.promise;
		if (reject) throw new Error("dispatch failed");
	});
	h.draft("original [Image #1]");
	const submitting = h.press();
	expect(h.editor.pendingImages).toEqual([]);
	h.draft("newer [Image #1]", newer, "local://new.png");
	release.resolve();
	await submitting;
	expect(h.editor.getExpandedText()).toBe(reject ? "original [Image #2]\n\nnewer [Image #1]" : "newer [Image #1]");
	expect(h.editor.pendingImages).toEqual(reject ? [newer, original] : [newer]);
	expect(h.editor.pendingImageLinks).toEqual(reject ? ["local://new.png", "local://old.png"] : ["local://new.png"]);
});

test.each([0, 1, 2])(
	"Ctrl+Enter /queue keeps attachments and restores only undelivered messages after %s deliveries",
	async delivered => {
		const h = harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		h.session.followUp.mockImplementation(async () => {
			if (calls++ === Math.min(delivered, 1)) {
				entered.resolve();
				await release.promise;
				if (delivered < 2) throw new Error("queue rejected");
			}
		});
		h.draft("/queue 1. first [Image #1]\n2. second");
		const submitting = h.press();
		await entered.promise;
		h.draft("newer [Image #1]", newer, "local://new.png");
		release.resolve();
		await submitting;
		expect(h.session.followUp.mock.calls[0]).toEqual(["first [Image #1]", [original]]);
		expect(h.editor.getExpandedText()).toBe(
			delivered === 0
				? "/queue 1. first [Image #2]\n2. second\n\nnewer [Image #1]"
				: delivered === 1
					? "=> second\n\nnewer [Image #1]"
					: "newer [Image #1]",
		);
		expect(h.editor.pendingImages).toEqual(delivered === 0 ? [newer, original] : [newer]);
	},
);

test.each(["followUp", "enter"])("failed goal via %s restores text and attachments beside newer typing", async key => {
	const h = harness();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	vi.spyOn(h.ctx, "handleGoalModeCommand").mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		throw new Error("goal failed");
	});
	h.draft("/goal inspect [Image #1]");
	const submitting = key === "followUp" ? h.press() : h.pressEnter();
	await entered.promise;
	h.draft("newer [Image #1]", newer, "local://new.png");
	release.resolve();
	await submitting;
	expect(h.editor.getExpandedText()).toBe("/goal inspect [Image #2]\n\nnewer [Image #1]");
	expect(h.editor.pendingImages).toEqual([newer, original]);
	expect(h.ctx.showError).toHaveBeenCalledWith("goal failed");
});

test("Ctrl+Enter skill rejection merges the submitted images without erasing newer typing", async () => {
	const h = harness();
	h.ctx.skillCommands.set("skill:test", {
		name: "test",
		description: "",
		filePath: import.meta.path,
		baseDir: import.meta.dir,
		source: "test",
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	h.session.promptCustomMessage.mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		throw new Error("skill failed");
	});
	h.draft("/skill:test inspect [Image #1]");
	const submitting = h.press();
	await entered.promise;
	h.draft("newer [Image #1]", newer, "local://new.png");
	release.resolve();
	await submitting;
	expect(h.editor.getExpandedText()).toBe("/skill:test inspect [Image #2]\n\nnewer [Image #1]");
	expect(h.editor.pendingImages).toEqual([newer, original]);
	expect(h.ctx.showError).toHaveBeenCalledWith("skill failed");
});

test.each(["handled", "failed", "compaction"] as const)(
	"Ctrl+Enter detaches before async input hooks (%s)",
	async outcome => {
		const h = harness();
		const release = Promise.withResolvers<InputEventResult>();
		const emitInput = vi.fn(() => release.promise);
		h.session.extensionRunner = { hasHandlers: () => true, emitInput } as unknown as ExtensionRunner;
		h.session.isCompacting = outcome === "compaction";
		h.draft("original [Image #1]");
		const submitting = h.press();
		expect(h.editor.getExpandedText()).toBe("");
		expect(h.editor.pendingImages).toEqual([]);
		await h.press();
		expect(emitInput).toHaveBeenCalledTimes(1);
		h.draft("newer [Image #1]", newer, "local://new.png");
		if (outcome === "failed") release.reject(new Error("input hook failed"));
		else release.resolve(outcome === "handled" ? { handled: true } : {});
		await submitting;
		expect(h.editor.getExpandedText()).toBe(
			outcome === "failed" ? "original [Image #2]\n\nnewer [Image #1]" : "newer [Image #1]",
		);
		expect(h.editor.pendingImages).toEqual(outcome === "failed" ? [newer, original] : [newer]);
		if (outcome === "compaction") {
			expect(h.ctx.compactionQueuedMessages).toEqual([
				{ text: "original [Image #1]", mode: "followUp", images: [original] },
			]);
		}
	},
);

test("Ctrl+Enter timed queue retains submitted attachments and cancel leaves a newer draft alone", async () => {
	const h = harness();
	h.ctx.scheduledQueue = new ScheduledQueueController(h.ctx);
	try {
		h.draft("/queue 3h inspect [Image #1]");
		const submitted = h.press();
		h.draft("newer [Image #1]", newer, "local://new.png");
		await submitted;
		expect(h.ctx.scheduledQueue.list()[0]).toMatchObject({
			messages: ["inspect [Image #1]"],
			images: [original],
			imageLinks: ["local://old.png"],
		});
		expect(h.editor.getExpandedText()).toBe("newer [Image #1]");
		await h.ctx.handleQueueCommand("--cancel all", { text: "/queue --cancel all" });
		expect(h.ctx.scheduledQueue.list()).toEqual([]);
		expect(h.editor.getExpandedText()).toBe("newer [Image #1]");
		expect(h.editor.pendingImages).toEqual([newer]);
	} finally {
		h.ctx.scheduledQueue.cancelAll();
	}
});

test("a failed builtin dispatch restores its text beside newer typing and attachments", async () => {
	const h = harness();
	const release = Promise.withResolvers<void>();
	vi.spyOn(h.ctx, "showSetupWizard").mockImplementation(() => release.promise);
	h.editor.setText("/setup");
	const submitting = h.press();
	h.draft("newer [Image #1]", newer, "local://new.png");
	release.reject(new Error("setup failed"));
	await submitting;
	expect(h.editor.getExpandedText()).toBe("/setup\n\nnewer [Image #1]");
	expect(h.editor.pendingImages).toEqual([newer]);
	expect(h.ctx.showError).toHaveBeenCalledWith("setup failed");
});

test("Enter prompt rejection merges submitted attachments without overwriting newer ones", async () => {
	const h = harness();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	h.session.prompt.mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		throw new Error("prompt failed");
	});
	h.draft("original [Image #1]");
	const submitting = h.pressEnter();
	await entered.promise;
	h.draft("newer [Image #1]", newer, "local://new.png");
	release.resolve();
	await submitting;
	expect(h.editor.getExpandedText()).toBe("original [Image #2]\n\nnewer [Image #1]");
	expect(h.editor.pendingImages).toEqual([newer, original]);
});
