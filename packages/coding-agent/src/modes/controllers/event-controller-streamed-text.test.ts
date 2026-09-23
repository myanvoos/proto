import { expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { CHECKLIST_STRIKE_TOTAL_FRAMES } from "../../tools/checklist";
import { ServedModelTracker } from "../components/served-model-marker";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme, theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { EventController } from "./event-controller";

await Settings.init();
await initTheme(false, false, "proto");

const NOOP = () => {};
const RENDER_WIDTH = 120;
const TEXT = "I will read the controller first.";
const THINKING = "Upstream organizes its TUI code with separate modules.";
const POST_TOOL_TEXT = "Now I will apply the patch.";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Block = AssistantMessage["content"][number];

function toolCallBlock(id: string, name = "bash"): Block {
	return { type: "toolCall", id, name, arguments: { command: "ls" } } as Block;
}

// Mirrors the provider snapshot the agent loop pushes: every update is a fresh
// message object whose blocks are fresh objects, so a stored block reference
// never observes later growth.
function snapshot(blocks: Block[], stopReason: "toolUse" | "stop" = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content: blocks.map(block => ({ ...block })),
		stopReason,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: USAGE,
		timestamp: 1,
	} as AssistantMessage;
}

function createContext() {
	const chatContainer = new TranscriptContainer();
	const context = {
		isInitialized: true,
		init: async () => {},
		ui: { requestRender: NOOP, requestComponentRender: NOOP, resetDisplay: NOOP, terminal: { setProgress: NOOP } },
		chatContainer,
		pendingTools: new Map(),
		settings: { get: () => false },
		viewSession: {
			isStreaming: true,
			isRetrying: false,
			isTtsrAbortPending: false,
			extensionRunner: undefined,
			hasBuiltInTool: () => true,
			getToolByName: () => undefined,
			retryAttempt: undefined,
		},
		session: { isAborting: false },
		toolOutputExpanded: false,
		hideToolActivity: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		noteDisplayableThinkingContent: () => false,
		transcriptMessageComponents: new WeakMap<object, Component>(),
		statusLine: { invalidate: NOOP, markActivityEnd: NOOP, markActivityStart: NOOP },
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusContainer: { disposeChildren: NOOP },
		ensureLoadingAnimation: NOOP,
		setWorkingMessage: NOOP,
		clearPinnedError: NOOP,
		showPinnedError: NOOP,
		showError: NOOP,
		showWarning: NOOP,
		showStatus: NOOP,
		editor: { setText: NOOP },
		updatePendingMessagesDisplay: NOOP,
		clearOptimisticUserMessage: NOOP,
		replaceOptimisticUserMessage: NOOP,
		optimisticSkillMessagePending: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		flushPendingCommandOutput: NOOP,
		setChecklist: NOOP,
		addMessageToChat: () => [] as Component[],
		lastAssistantUsage: undefined,
		servedModelTracker: new ServedModelTracker(),
		streamingComponent: undefined,
		streamingMessage: undefined,
	};
	return { chatContainer, context: context as unknown as InteractiveModeContext };
}

function visibleText(component: Component | undefined): string {
	if (!component) return "";
	return component
		.render(RENDER_WIDTH)
		.map(row =>
			row
				.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "")
				.replace(/\x1b\][^\x07]*\x07/g, "")
				.trim(),
		)
		.filter(row => row.length > 0)
		.join(" ");
}

test("assistant text that grows in the same update as its tool call renders in full", async () => {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "message_start",
			message: snapshot([]),
		} as unknown as AgentSessionEvent);

		const partial = snapshot([{ type: "text", text: "I" } as Block]);
		await controller.handleEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "I", partial },
		} as unknown as AgentSessionEvent);

		// One coalesced update: the text block finished growing and the tool call appeared,
		// so the provider reports the tool call index as the changed one.
		const joined = snapshot([{ type: "text", text: TEXT } as Block, toolCallBlock("call-1")]);
		await controller.handleEvent({
			type: "message_update",
			message: joined,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: joined },
		} as unknown as AgentSessionEvent);

		expect(visibleText(context.streamingComponent)).toBe(TEXT);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("assistant thinking that grows in the same update as its tool call renders in full", async () => {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "message_start",
			message: snapshot([]),
		} as unknown as AgentSessionEvent);

		const partial = snapshot([{ type: "thinking", thinking: "Upstream organizes its TUI code with separ" } as Block]);
		await controller.handleEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "separ", partial },
		} as unknown as AgentSessionEvent);

		const joined = snapshot([{ type: "thinking", thinking: THINKING } as Block, toolCallBlock("call-1")]);
		await controller.handleEvent({
			type: "message_update",
			message: joined,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: joined },
		} as unknown as AgentSessionEvent);

		expect(visibleText(context.streamingComponent)).toBe(`Thinking ${THINKING}`);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("assistant text that grows in the last update before message_end renders in full", async () => {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "message_start",
			message: snapshot([]),
		} as unknown as AgentSessionEvent);

		const thinkingOnly = snapshot([{ type: "thinking", thinking: "Upstream organizes" } as Block]);
		await controller.handleEvent({
			type: "message_update",
			message: thinkingOnly,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "organizes", partial: thinkingOnly },
		} as unknown as AgentSessionEvent);

		// Thinking finished growing in the update that opened the text block.
		const withText = snapshot([
			{ type: "thinking", thinking: THINKING } as Block,
			{ type: "text", text: "I" } as Block,
		]);
		await controller.handleEvent({
			type: "message_update",
			message: withText,
			assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: withText },
		} as unknown as AgentSessionEvent);

		// Text finished growing in the update that opened the tool call.
		const withToolCall = snapshot([
			{ type: "thinking", thinking: THINKING } as Block,
			{ type: "text", text: TEXT } as Block,
			toolCallBlock("call-1"),
		]);
		await controller.handleEvent({
			type: "message_update",
			message: withToolCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: withToolCall },
		} as unknown as AgentSessionEvent);

		const component = context.streamingComponent;
		await controller.handleEvent({
			type: "message_end",
			message: withToolCall,
		} as unknown as AgentSessionEvent);

		expect(visibleText(component)).toBe(`Thinking ${THINKING} ${TEXT}`);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("post-tool assistant text that grows alongside the next tool call renders in full", async () => {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "message_start",
			message: snapshot([]),
		} as unknown as AgentSessionEvent);

		const firstCall = snapshot([toolCallBlock("call-1")]);
		await controller.handleEvent({
			type: "message_update",
			message: firstCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: firstCall },
		} as unknown as AgentSessionEvent);

		const withPartialText = snapshot([toolCallBlock("call-1"), { type: "text", text: "Now" } as Block]);
		await controller.handleEvent({
			type: "message_update",
			message: withPartialText,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Now", partial: withPartialText },
		} as unknown as AgentSessionEvent);

		const withSecondCall = snapshot([
			toolCallBlock("call-1"),
			{ type: "text", text: POST_TOOL_TEXT } as Block,
			toolCallBlock("call-2"),
		]);
		await controller.handleEvent({
			type: "message_update",
			message: withSecondCall,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: withSecondCall },
		} as unknown as AgentSessionEvent);

		const postToolComponents = controller.getLivePostToolAssistantComponents();
		expect(postToolComponents).toHaveLength(1);
		expect(visibleText(postToolComponents[0])).toBe(POST_TOOL_TEXT);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

// Providers can retain a completed tool call or drop a partial one from their final
// aborted snapshot. Both paths must append a marker after the live card, not try to
// update the already-finalized assistant prefix above it.
test.each(["retained", "discarded", "retained-prefix"] as const)(
	"Esc while a tool call streams shows exactly one dim marker when the final call is %s",
	async disposition => {
		const { chatContainer, context } = createContext();
		const controller = new EventController(context);
		try {
			await controller.handleEvent({ type: "message_start", message: snapshot([]) });
			const prefix: Block[] = [{ type: "text", text: TEXT }];
			if (disposition === "retained-prefix") prefix.push(toolCallBlock("call-complete"));
			const partial = snapshot([...prefix, toolCallBlock("call-interrupted")]);
			await controller.handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: partial.content.length - 1, partial },
			});
			chatContainer.render(RENDER_WIDTH);

			const interrupted: AssistantMessage = {
				...snapshot(disposition === "retained" ? partial.content : prefix),
				stopReason: "aborted",
				errorMessage: USER_INTERRUPT_LABEL,
			};
			await controller.handleEvent({ type: "message_end", message: interrupted });
			const lines = chatContainer.render(RENDER_WIDTH);
			const marker = `${theme.symbol("status.aborted")} Interrupted`;
			const markerLines = lines.filter(line => Bun.stripANSI(line).includes(marker));
			expect(markerLines).toHaveLength(1);
			expect(markerLines[0]).toContain(theme.getFgAnsi("dim"));
			expect(markerLines[0]).not.toContain(theme.getFgAnsi("error"));
			const output = Bun.stripANSI(lines.join("\n"));
			expect(output).not.toContain(USER_INTERRUPT_LABEL);
			expect(output.lastIndexOf(marker)).toBeGreaterThan(output.indexOf(TEXT));
			expect(output.lastIndexOf(marker)).toBeGreaterThan(output.lastIndexOf("ls"));
		} finally {
			controller.dispose();
			chatContainer.dispose();
		}
	},
);

class DisplaceableChecklistSnapshot implements Component {
	sealed = false;
	disposed = false;
	#displaceable: boolean;
	#finalized: boolean;

	constructor(initiallyFinalized = false) {
		this.#finalized = initiallyFinalized;
		this.#displaceable = !initiallyFinalized;
	}

	render(): readonly string[] {
		return ["checklist snapshot"];
	}

	isTranscriptBlockFinalized(): boolean {
		return this.sealed || this.#finalized;
	}

	isDisplaceableBlock(): boolean {
		return this.#displaceable && !this.sealed;
	}

	canBeDisplacedBy(toolName: string | undefined): boolean {
		return toolName === "checklist" && this.isDisplaceableBlock();
	}

	activateDisplacement(): void {
		this.#finalized = false;
		this.#displaceable = true;
	}

	seal(): void {
		this.sealed = true;
		this.#displaceable = false;
	}

	dispose(): void {
		this.disposed = true;
	}
}

async function startAfterChecklistSnapshot(initiallyFinalized = false) {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	const snapshotBlock = new DisplaceableChecklistSnapshot(initiallyFinalized);
	chatContainer.addChild(snapshotBlock);
	if (initiallyFinalized) {
		const batch = chatContainer.peekFlushBatch(RENDER_WIDTH);
		expect(batch).toBeDefined();
		chatContainer.acknowledgeFinalizedBatch(batch!.id);
		snapshotBlock.activateDisplacement();
	}
	controller.inheritDisplaceableChecklist(snapshotBlock as never);
	await controller.handleEvent({
		type: "message_start",
		message: snapshot([]),
	} as unknown as AgentSessionEvent);
	return { chatContainer, context, controller, snapshotBlock };
}

test("an empty assistant placeholder preserves same-checklist replacement while the old snapshot is removable", async () => {
	const { chatContainer, controller, snapshotBlock } = await startAfterChecklistSnapshot();
	try {
		expect(chatContainer.children).toContain(snapshotBlock);
		await controller.handleEvent({
			type: "message_update",
			message: snapshot([toolCallBlock("next-checklist", "checklist")]),
		} as unknown as AgentSessionEvent);
		expect(chatContainer.children).not.toContain(snapshotBlock);
		expect(snapshotBlock.disposed).toBe(true);
		expect(snapshotBlock.sealed).toBe(true);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test.each([
	["text", { type: "text", text: "actual output" } as Block],
	["thinking", { type: "thinking", thinking: "actual reasoning" } as Block],
])("visible assistant %s seals and retains the prior checklist snapshot", async (_kind, visibleBlock) => {
	const { chatContainer, controller, snapshotBlock } = await startAfterChecklistSnapshot();
	try {
		await controller.handleEvent({
			type: "message_update",
			message: snapshot([visibleBlock]),
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: snapshot([visibleBlock, toolCallBlock("next-checklist", "checklist")]),
		} as unknown as AgentSessionEvent);
		expect(chatContainer.children).toContain(snapshotBlock);
		expect(snapshotBlock.sealed).toBe(true);
		expect(snapshotBlock.disposed).toBe(false);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("an unrelated tool seals and retains the prior checklist snapshot", async () => {
	const { chatContainer, controller, snapshotBlock } = await startAfterChecklistSnapshot();
	try {
		await controller.handleEvent({
			type: "message_update",
			message: snapshot([toolCallBlock("next-tool", "bash")]),
		} as unknown as AgentSessionEvent);
		expect(chatContainer.children).toContain(snapshotBlock);
		expect(snapshotBlock.sealed).toBe(true);
		expect(snapshotBlock.disposed).toBe(false);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("a committed checklist snapshot is sealed rather than removed for a same-tool transition", async () => {
	const { chatContainer, controller, snapshotBlock } = await startAfterChecklistSnapshot(true);
	try {
		expect(chatContainer.canRemoveBlock(snapshotBlock)).toBe(false);
		await controller.handleEvent({
			type: "message_update",
			message: snapshot([toolCallBlock("next-checklist", "checklist")]),
		} as unknown as AgentSessionEvent);
		expect(chatContainer.children).toContain(snapshotBlock);
		expect(snapshotBlock.sealed).toBe(true);
		expect(snapshotBlock.disposed).toBe(false);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("checklist reveal remains active until its final frame and retires its timer when sealed", () => {
	vi.useFakeTimers();
	let paints = 0;
	const card = new ToolExecutionComponent("checklist", { op: "done" }, { useBuiltInRenderer: false }, undefined, {
		requestRender: NOOP,
		requestComponentRender: () => {
			paints++;
		},
	});
	try {
		card.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: { completedTasks: [{ content: "finished" }] },
			},
			false,
		);
		expect(card.isTranscriptBlockFinalized()).toBe(false);
		vi.advanceTimersByTime(65 * (CHECKLIST_STRIKE_TOTAL_FRAMES + 2));
		expect(card.isTranscriptBlockFinalized()).toBe(true);
		const paintsAfterCompletion = paints;
		vi.advanceTimersByTime(650);
		expect(paints).toBe(paintsAfterCompletion);

		card.updateResult(
			{
				content: [{ type: "text", text: "done again" }],
				details: { completedTasks: [{ content: "finished again" }] },
			},
			false,
		);
		expect(card.isTranscriptBlockFinalized()).toBe(false);
		card.seal();
		expect(card.isTranscriptBlockFinalized()).toBe(true);
		const paintsAfterSeal = paints;
		vi.advanceTimersByTime(650);
		expect(paints).toBe(paintsAfterSeal);
	} finally {
		card.dispose();
		vi.useRealTimers();
	}
});

test("unlocking thinking visibility requests a destructive display reset", async () => {
	const { chatContainer, context } = createContext();
	let resets = 0;
	context.noteDisplayableThinkingContent = () => true;
	context.ui.resetDisplay = () => {
		resets++;
	};
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "message_start",
			message: snapshot([]),
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: snapshot([{ type: "thinking", thinking: "now visible" }]),
		} as unknown as AgentSessionEvent);
		expect(resets).toBe(1);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});
