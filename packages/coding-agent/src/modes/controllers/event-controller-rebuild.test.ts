import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { SessionContext } from "../../session/session-context";
import { AssistantMessageComponent } from "../components/assistant-message";
import { ToolExecutionComponent, type ToolExecutionHandle, type ToolExecutionUi } from "../components/tool-execution";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { resolvePreservedLiveToolCallIds, UiHelpers } from "../utils/ui-helpers";
import { EventController } from "./event-controller";

await Settings.init();
await initTheme(false, false, "proto");

const NOOP = () => {};
const UI: ToolExecutionUi & { terminal: { setProgress: (active: boolean) => void } } = {
	requestRender: NOOP,
	requestComponentRender: NOOP,
	resetDisplay: NOOP,
	terminal: { setProgress: NOOP },
};

function kinds(container: TranscriptContainer): string[] {
	return container.children.map(child => {
		if (child instanceof AssistantMessageComponent) return "assistant";
		if (child instanceof ToolExecutionComponent) return "tool";
		return child.constructor.name;
	});
}

test("rebuild reinserts a cached post-tool assistant segment before its next update", async () => {
	const chatContainer = new TranscriptContainer();
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const baseContext = {
		isInitialized: true,
		init: async () => {},
		ui: UI,
		chatContainer,
		pendingTools,
		settings: { get: () => false },
		viewSession: {
			isStreaming: true,
			isRetrying: false,
			isTtsrAbortPending: false,
			extensionRunner: undefined,
			hasBuiltInTool: () => false,
			getToolByName: () => undefined,
			buildTranscriptSessionContext: () => ({ messages: [] }) as unknown as SessionContext,
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
		getUserMessageText: () => "",
		editor: { setText: NOOP },
		updatePendingMessagesDisplay: NOOP,
		clearOptimisticUserMessage: NOOP,
		replaceOptimisticUserMessage: NOOP,
		optimisticSkillMessagePending: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		syncConductorDisplay: NOOP,
		flushPendingCommandOutput: NOOP,
		setTodos: NOOP,
		addMessageToChat: () => [],
	};
	const context = baseContext as typeof baseContext & {
		streamingComponent: AssistantMessageComponent | undefined;
		streamingMessage: unknown;
		rebuildChatFromMessages: () => void;
	};
	context.streamingComponent = undefined;
	context.streamingMessage = undefined;
	const helpers = new UiHelpers(context as unknown as InteractiveModeContext);
	const controller = new EventController(context as unknown as InteractiveModeContext);
	context.rebuildChatFromMessages = () => {
		const liveComponents: Component[] = [];
		const livePendingTools = new Map<string, ToolExecutionHandle>();
		const liveSet = new Set<Component>();
		if (context.streamingComponent) liveSet.add(context.streamingComponent);
		for (const [id, component] of context.pendingTools) {
			livePendingTools.set(id, component);
			liveSet.add(component);
		}
		for (const component of controller.getLivePostToolAssistantComponents()) {
			liveSet.add(component);
		}
		for (const child of context.chatContainer.children) {
			if (liveSet.has(child)) liveComponents.push(child);
		}
		const previousChildren = [...context.chatContainer.children];
		context.chatContainer.clear();
		const fullContext = context.viewSession.buildTranscriptSessionContext();
		const preserved = resolvePreservedLiveToolCallIds({
			livePendingTools,
			liveComponents,
			messages: fullContext.messages,
		});
		const inserted = helpers.renderSessionContextWithLiveToolComponents(
			fullContext,
			{ preservedLiveToolCallIds: preserved },
			livePendingTools,
		);
		for (const child of liveComponents) {
			if (!inserted.has(child)) context.chatContainer.addChild(child);
		}
		for (const [id, component] of livePendingTools) context.pendingTools.set(id, component);
		const retained = new Set(context.chatContainer.children);
		for (const child of previousChildren) {
			if (!retained.has(child)) child.dispose?.();
		}
	};
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, total: 0 },
	};
	const assistant = (text: string) => ({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "A", name: "alpha", arguments: {} },
			{ type: "text", text },
		],
		stopReason: "toolUse",
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage,
		timestamp: 1,
	});
	try {
		await controller.handleEvent({
			type: "message_start",
			message: { ...assistant(""), content: [] },
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: assistant("after one"),
		} as unknown as AgentSessionEvent);
		expect(kinds(chatContainer)).toEqual(["assistant", "tool", "assistant"]);

		context.rebuildChatFromMessages();
		expect(kinds(chatContainer)).toEqual(["assistant", "tool", "assistant"]);

		await controller.handleEvent({
			type: "message_update",
			message: assistant("after two"),
		} as unknown as AgentSessionEvent);
		expect(kinds(chatContainer)).toEqual(["assistant", "tool", "assistant"]);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});
