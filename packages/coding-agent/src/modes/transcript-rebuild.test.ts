import { afterEach, expect, test } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { Settings } from "../config/settings";
import { evalToolRenderer } from "../tools/eval-render";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { ToolExecutionComponent } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import { initTheme } from "./theme/theme";
import { resolvePreservedLiveToolCallIds, UiHelpers } from "./utils/ui-helpers";

await Settings.init();
await initTheme(false, false, "dark-hybrid-slate-cool");

afterEach(disposeSpinnerComponents);

const fakeTool: any = {
	name: "kernel",
	label: "Kernel",
	mergeCallAndResult: true,
	renderCall: evalToolRenderer.renderCall,
	renderResult: evalToolRenderer.renderResult,
	intent: (args: any) => args?.title,
};

const CALL_ID = "chatcmpl-tool-inflight-1";
const ARGS = { code: 'print("hi")', title: "inflight" };

const noop = () => {};
const stubUi = { requestRender: noop, requestComponentRender: noop, resetDisplay: noop, imageBudget: undefined };
const spinnerComponents: ToolExecutionComponent[] = [];
function makeLiveComponent(): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"kernel",
		ARGS,
		{ useBuiltInRenderer: true },
		fakeTool,
		stubUi as any,
		"/tmp",
		CALL_ID,
	);
	spinnerComponents.push(component);
	return component;
}
function disposeSpinnerComponents(): void {
	for (const component of spinnerComponents) component.dispose();
	spinnerComponents.length = 0;
}

function assistantMessageWithCall(): any {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: CALL_ID, name: "kernel", arguments: ARGS }],
		stopReason: "toolUse",
		api: "openai-completions",
		provider: "vllm",
		model: "cento-firefly",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function settledToolResultMessage(): any {
	return {
		role: "toolResult",
		toolCallId: CALL_ID,
		toolName: "kernel",
		content: [{ type: "text", text: "done" }],
		details: { language: "python", languages: ["python"] },
		isError: false,
		timestamp: Date.now(),
	};
}

function makeCtx(chatContainer: TranscriptContainer, pendingTools: Map<string, ToolExecutionHandle>): any {
	const noop = () => {};
	return {
		ui: {
			requestRender: noop,
			requestComponentRender: noop,
			resetDisplay: noop,
			imageBudget: undefined,
			terminal: { setProgress: noop },
		},
		chatContainer,
		pendingTools,
		statusContainer: new Container(),
		settings: { get: (k: string) => k !== "terminal.showImages" },
		sessionManager: { getCwd: () => "/tmp" },
		viewSession: {
			getToolByName: (n: string) => (n === "kernel" ? fakeTool : undefined),
			hasBuiltInTool: (n: string) => n === "kernel",
			isTtsrAbortPending: false,
			isRetrying: false,
			extensionRunner: undefined,
			sessionManager: { getCwd: () => "/tmp" },
			retryAttempt: undefined,
			isStreaming: true,
		},
		toolOutputExpanded: false,
		hideToolActivity: false,
		proseOnlyThinking: false,
		effectiveHideThinkingBlock: false,
		noteDisplayableThinkingContent: () => false,
		transcriptMessageComponents: new WeakMap(),
		statusLine: { invalidate: noop, markActivityEnd: noop, markActivityStart: noop },
		streamingComponent: undefined,
		streamingMessage: undefined,
		loadingAnimation: undefined,
		retryLoader: undefined,
		autoCompactionLoader: undefined,
		addMessageToChat: () => [],
	};
}

function toolComponentsIn(container: TranscriptContainer): ToolExecutionComponent[] {
	return container.children.filter(c => c instanceof ToolExecutionComponent) as ToolExecutionComponent[];
}

test("resolvePreservedLiveToolCallIds preserves in-flight calls without a persisted result", () => {
	const live = makeLiveComponent();
	const livePendingTools = new Map([[CALL_ID, live as unknown as ToolExecutionHandle]]);
	const liveComponents: unknown[] = [live];
	const messages = [assistantMessageWithCall()];

	const preserved = resolvePreservedLiveToolCallIds({
		livePendingTools,
		liveComponents: liveComponents as any,
		messages,
	});

	expect(
		preserved.has(CALL_ID),
		"an executing call with no persisted result must be preserved so the replay does not duplicate it",
	).toBe(true);
	expect(livePendingTools.has(CALL_ID)).toBe(true);
	expect(liveComponents).toHaveLength(1);
});

test("resolvePreservedLiveToolCallIds drops live components the replay settles from a persisted result", () => {
	const live = makeLiveComponent();
	const livePendingTools = new Map([[CALL_ID, live as unknown as ToolExecutionHandle]]);
	const liveComponents: unknown[] = [live];
	const messages = [assistantMessageWithCall(), settledToolResultMessage()];

	const preserved = resolvePreservedLiveToolCallIds({
		livePendingTools,
		liveComponents: liveComponents as any,
		messages,
	});

	expect(preserved.has(CALL_ID), "a settled persisted result must be replayed, not preserved").toBe(false);
	expect(livePendingTools.has(CALL_ID)).toBe(false);
	expect(liveComponents, "the dropped live component must not be re-appended after the replay").toHaveLength(0);
});

test("replay skips preserved ids and creates components for unpreserved calls", () => {
	const chatContainer = new TranscriptContainer();
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const ctx = makeCtx(chatContainer, pendingTools);
	const helpers = new UiHelpers(ctx);
	const sessionContext: any = { messages: [assistantMessageWithCall()] };

	// Unpreserved: the replay creates a component and registers it as pending
	// (the replay swaps ctx.pendingTools to a staged map on success).
	helpers.renderSessionContext(sessionContext, {});
	expect(toolComponentsIn(chatContainer), "unpreserved in-flight call is rendered by the replay").toHaveLength(1);
	expect(ctx.pendingTools.get(CALL_ID)).toBeDefined();

	// Preserved: the replay must not create a second component for the call.
	const chatContainer2 = new TranscriptContainer();
	const pendingTools2 = new Map<string, ToolExecutionHandle>();
	const ctx2 = makeCtx(chatContainer2, pendingTools2);
	const helpers2 = new UiHelpers(ctx2);
	helpers2.renderSessionContext(sessionContext, { preservedLiveToolCallIds: new Set([CALL_ID]) });
	expect(
		toolComponentsIn(chatContainer2),
		"preserved in-flight call must not be re-created by the replay (the live component renders it)",
	).toHaveLength(0);
	expect(ctx2.pendingTools.get(CALL_ID), "preserved call must stay pending on the live component").toBeUndefined();
});
