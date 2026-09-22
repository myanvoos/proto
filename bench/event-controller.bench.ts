import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../packages/coding-agent/src/config/settings";
import type {
	ToolExecutionHandle,
	ToolExecutionUi,
} from "../packages/coding-agent/src/modes/components/tool-execution";
import { TranscriptContainer } from "../packages/coding-agent/src/modes/components/transcript-container";
import { EventController } from "../packages/coding-agent/src/modes/controllers/event-controller";
import { initTheme } from "../packages/coding-agent/src/modes/theme/theme";
import type { InteractiveModeContext } from "../packages/coding-agent/src/modes/types";
import type { AgentSessionEvent } from "../packages/coding-agent/src/session/agent-session";
import { formatArtifact, labelFromArgv, runSuite } from "./harness";

await Settings.init();
await initTheme(false, false, "proto");

const NOOP = () => {};
const UI: ToolExecutionUi & { terminal: { setProgress: (active: boolean) => void } } = {
	requestRender: NOOP,
	requestComponentRender: NOOP,
	terminal: { setProgress: NOOP },
};

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

type BenchFixture = {
	updates: AssistantMessage[];
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason: "toolUse",
		api: "openai-completions",
		provider: "bench",
		model: "bench",
		usage: USAGE,
		timestamp: 1,
	};
}

function buildFixture(toolCallCount: number): BenchFixture {
	const calls: ToolCall[] = [];
	const updates: AssistantMessage[] = [];
	for (let index = 0; index < toolCallCount; index++) {
		const call: ToolCall = {
			type: "toolCall",
			id: `bench-call-${index}`,
			name: "bench_tool",
			arguments: { value: `value-${index}` },
		};
		setStreamingPartialJson(call, `{"value":"value-${index}`);
		calls.push(call);
		updates.push(assistantMessage(calls.slice()));
	}
	return { updates };
}

function createContext(): { context: InteractiveModeContext; chatContainer: TranscriptContainer } {
	const chatContainer = new TranscriptContainer();
	const context = {
		isInitialized: true,
		init: async () => {},
		ui: UI,
		chatContainer,
		pendingTools: new Map<string, ToolExecutionHandle>(),
		settings: { get: () => false },
		viewSession: {
			isStreaming: true,
			isRetrying: false,
			isTtsrAbortPending: false,
			extensionRunner: undefined,
			hasBuiltInTool: () => false,
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
	return { context: context as unknown as InteractiveModeContext, chatContainer };
}

async function runFixture(fixture: BenchFixture): Promise<void> {
	const { context, chatContainer } = createContext();
	const controller = new EventController(context);
	try {
		const empty = assistantMessage([]);
		await controller.handleEvent({ type: "message_start", message: empty } as unknown as AgentSessionEvent);
		for (const message of fixture.updates) {
			await controller.handleEvent({ type: "message_update", message } as unknown as AgentSessionEvent);
		}
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
}

const artifact = await runSuite(
	"event-controller",
	[100, 500, 1000].map(toolCallCount => ({
		name: `${toolCallCount}-tool-call-blocks`,
		setup: () => buildFixture(toolCallCount),
		run: runFixture,
		runs: 5,
		warmup: 1,
	})),
	{ label: labelFromArgv() },
);
console.log(formatArtifact(artifact));
