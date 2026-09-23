import { expect, test, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import { RETRY_BUDGET_EXHAUSTED_PREFIX } from "../../session/turn-recovery";
import { ServedModelTracker } from "../components/served-model-marker";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { EventController } from "./event-controller";

await Settings.init();
await initTheme(false, false, "proto");

const NOOP = () => {};
const LOOP_DETAIL = "repeated an exact 46-character cycle 25× back-to-back";
const LOOP_ERROR = `Thinking loop detected: the model repeated near-identical content (${LOOP_DETAIL}). Treating as a stream stall and retrying.`;

function createContext(lastAssistantError?: string) {
	const chatContainer = new TranscriptContainer();
	const errors: string[] = [];
	const pinnedErrors: string[] = [];
	const context = {
		isInitialized: true,
		ui: { requestRender: NOOP, requestComponentRender: NOOP, resetDisplay: NOOP, terminal: { setProgress: NOOP } },
		chatContainer,
		pendingTools: new Map(),
		settings: { get: () => false },
		viewSession: {
			isStreaming: false,
			isRetrying: false,
			isTtsrAbortPending: false,
			extensionRunner: undefined,
			hasBuiltInTool: () => true,
			getToolByName: () => undefined,
			retryAttempt: undefined,
			getLastAssistantMessage: () =>
				lastAssistantError === undefined
					? undefined
					: { role: "assistant", content: [], stopReason: "error", errorMessage: lastAssistantError },
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
		statusContainer: { disposeChildren: NOOP, addChild: NOOP },
		ensureLoadingAnimation: NOOP,
		setWorkingMessage: NOOP,
		clearPinnedError: NOOP,
		showPinnedError: (message: string) => pinnedErrors.push(message),
		showError: (message: string) => errors.push(message),
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
		flushPendingBashComponents: NOOP,
		setChecklist: NOOP,
		addMessageToChat: () => [] as Component[],
		lastAssistantUsage: undefined,
		servedModelTracker: new ServedModelTracker(),
		streamingComponent: undefined,
		streamingMessage: undefined,
	};
	return { chatContainer, errors, pinnedErrors, context: context as unknown as InteractiveModeContext };
}

function retryLoaderText(context: InteractiveModeContext): string {
	const loader = context.retryLoader;
	if (!loader) return "";
	const text = loader
		.render(200)
		.map(row => Bun.stripANSI(row).trim())
		.join(" ");
	loader.stop();
	return text;
}

// Regression: a repetition-guard retry rendered exactly like a network retry — "Retrying (5/10) in
// 7s…" — while the guard's evidence was thrown away, so the user had no way to tell a discarded
// turn from a provider fault.
test("a repetition-guard retry names the guard and its evidence while it waits", async () => {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 5,
			maxAttempts: 10,
			delayMs: 7_000,
			errorMessage: LOOP_ERROR,
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
		} as unknown as AgentSessionEvent);

		const text = retryLoaderText(context);
		expect(text).toMatch(/Retrying \(5\/10\) in [67]\.\ds…/);
		expect(text).toContain("repetition guard");
		expect(text).toContain(LOOP_DETAIL);
		// The cancel key stays ahead of the evidence so a narrow terminal drops evidence, not the key.
		expect(text.indexOf("esc to cancel")).toBeLessThan(text.indexOf("repetition guard"));
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("a plain provider retry still reports only the wait, with no invented cause", async () => {
	const { chatContainer, context } = createContext();
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 10,
			delayMs: 3_000,
			errorMessage: "500 upstream exploded",
		} as unknown as AgentSessionEvent);

		const text = retryLoaderText(context);
		expect(text).toMatch(/Retrying \(2\/10\) in [23]\.\ds…/);
		expect(text).not.toContain("repetition guard");
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

// Regression: exhaustion printed the failed turn's report and then a second near-duplicate banner
// in different words, so the user read the same failure twice.
test("an exhausted retry budget is reported once, by the turn that carries it", async () => {
	const report = `${RETRY_BUDGET_EXHAUSTED_PREFIX} 10 retries: repetition guard: ${LOOP_DETAIL}`;
	const { chatContainer, errors, pinnedErrors, context } = createContext(report);
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 10,
			finalError: `repetition guard: ${LOOP_DETAIL}`,
		} as unknown as AgentSessionEvent);

		expect(errors).toEqual([]);
		expect(pinnedErrors).toEqual([]);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

test("a terminal failure the turn does not report is still announced", async () => {
	const { chatContainer, errors, context } = createContext("some unrelated earlier error");
	const controller = new EventController(context);
	try {
		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 4,
			finalError: "Retry cancelled",
		} as unknown as AgentSessionEvent);

		expect(errors).toEqual(["Retry failed after 4 attempts: Retry cancelled"]);
	} finally {
		controller.dispose();
		chatContainer.dispose();
	}
});

vi.restoreAllMocks();
