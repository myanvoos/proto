import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { SessionContext } from "../../session/session-context";
import { ReadToolGroupComponent } from "../components/read-tool-group";
import { ToolExecutionComponent, type ToolExecutionHandle, type ToolExecutionUi } from "../components/tool-execution";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { UiHelpers } from "../utils/ui-helpers";
import { EventController } from "./event-controller";

await Settings.init();
await initTheme(false, false, "proto");

const NOOP = () => {};
const TOOL_CALL_ID = "streamed-read";
const STALE_PROVIDER_PATH = "arti";
const UI: ToolExecutionUi & { terminal: { setProgress: (active: boolean) => void } } = {
	requestRender: NOOP,
	requestComponentRender: NOOP,
	resetDisplay: NOOP,
	terminal: { setProgress: NOOP },
};

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, total: 0 },
};

function streamedReadMessage(partialJson: string): AssistantMessage {
	const call = {
		type: "toolCall" as const,
		id: TOOL_CALL_ID,
		name: "read",
		arguments: { path: STALE_PROVIDER_PATH },
	};
	setStreamingPartialJson(call, partialJson);
	return {
		role: "assistant",
		content: [call, { type: "text", text: "after read" }],
		stopReason: "toolUse",
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: USAGE,
		timestamp: 1,
	} as AssistantMessage;
}

function createContext() {
	const chatContainer = new TranscriptContainer();
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const context = {
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
		setTodos: NOOP,
		addMessageToChat: () => [] as Component[],
		streamingComponent: undefined,
		streamingMessage: undefined,
	};
	return { chatContainer, context: context as unknown as InteractiveModeContext, pendingTools };
}

function rebuiltToolComponent(message: AssistantMessage): ToolExecutionHandle | undefined {
	const harness = createContext();
	try {
		const helpers = new UiHelpers(harness.context);
		helpers.renderSessionContext({ messages: [message] } as unknown as SessionContext);
		return harness.pendingTools.get(TOOL_CALL_ID);
	} finally {
		harness.chatContainer.dispose();
	}
}

test("live and from-scratch rebuilt reads classify the same growing partial target", async () => {
	const harness = createContext();
	const controller = new EventController(harness.context);
	const first = streamedReadMessage('{"path":"arti');
	const second = streamedReadMessage('{"path":"artifact://12');
	try {
		await controller.handleEvent({
			type: "message_start",
			message: { ...first, content: [] },
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({ type: "message_update", message: first } as unknown as AgentSessionEvent);

		const firstLive = harness.pendingTools.get(TOOL_CALL_ID);
		const firstRebuilt = rebuiltToolComponent(first);
		expect(firstLive).toBeInstanceOf(ReadToolGroupComponent);
		expect(firstRebuilt).toBeInstanceOf(ReadToolGroupComponent);
		expect(firstLive?.constructor).toBe(firstRebuilt?.constructor);

		await controller.handleEvent({ type: "message_update", message: second } as unknown as AgentSessionEvent);

		const secondLive = harness.pendingTools.get(TOOL_CALL_ID);
		const secondRebuilt = rebuiltToolComponent(second);
		expect(secondRebuilt).toBeInstanceOf(ToolExecutionComponent);
		expect(secondLive).toBeInstanceOf(ToolExecutionComponent);
		expect(secondLive?.constructor).toBe(secondRebuilt?.constructor);
	} finally {
		controller.dispose();
		harness.chatContainer.dispose();
	}
});
