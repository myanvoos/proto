import { expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Component, RenderScheduler, Terminal } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { Settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import { ServedModelTracker } from "../components/served-model-marker";
import { TranscriptContainer } from "../components/transcript-container";
import { Composer } from "../composer";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { EventController } from "./event-controller";

await Settings.init();
initThemeSync();

const NOOP = () => {};
const TEXT = "Step 2 is the real fix. Let me check the helpers I need to preserve semantics exactly.";
const THINKING = "Checking the implementation details.";

class BufferTerminal implements Terminal {
	columns: number;
	rows: number;
	readonly vt: VTermTerminal;

	#onResize?: () => void;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 5_000 });
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
		this.#onResize?.();
	}

	get pendingOutputBytes(): number {
		return 0;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	get appearance(): undefined {
		return undefined;
	}
	start(_onInput: (data: string) => void, onResize: () => void): void {
		this.#onResize = onResize;
	}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.vt.write(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(_force?: boolean): void {}
	showCursor(_force?: boolean): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: "dark" | "light", requestToken?: number) => void): void {}
	onPrivateModeReport(_callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {}

	tape(): string[] {
		const lines = this.vt.buffer.normal;
		const rows = Array.from(
			{ length: lines.length },
			(_value, index) => lines.getLine(index)?.translateToString(true).trimEnd() ?? "",
		);
		while (rows.at(-1) === "") rows.pop();
		return rows;
	}
}

class StaticBlock implements Component {
	constructor(readonly lines: readonly string[]) {}
	render(): readonly string[] {
		return this.lines;
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

const scheduledRenders: Array<() => void> = [];
const SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate(callback): void {
		scheduledRenders.push(callback);
	},
	scheduleRender(callback): { cancel(): void } {
		let cancelled = false;
		scheduledRenders.push(() => {
			if (!cancelled) callback();
		});
		return {
			cancel(): void {
				cancelled = true;
			},
		};
	},
};

function flushScheduledRenders(): void {
	while (scheduledRenders.length > 0) scheduledRenders.shift()!();
}

function assistantMessage(
	text: string,
	withToolCall = false,
	options: { stopReason?: AssistantMessage["stopReason"]; callId?: string; timestamp?: number } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text },
			...(withToolCall
				? [{ type: "toolCall" as const, id: options.callId ?? "call-1", name: "test_tool", arguments: {} }]
				: []),
		],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? (withToolCall ? "toolUse" : "stop"),
		timestamp: options.timestamp ?? 0,
	} as AssistantMessage;
}

function startHarness(
	terminal: BufferTerminal,
	options: { smoothStreaming?: boolean; history?: readonly Component[] } = {},
) {
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: SCHEDULER },
		preferences: { quiet: true },
	});
	const tui = composer.ui;
	const chatContainer = new TranscriptContainer();
	for (const child of options.history ?? []) chatContainer.addChild(child);
	composer.setRuntimeChildren([chatContainer]);
	const ui = {
		requestRender: () => tui.requestRender(true),
		requestComponentRender: (component: Component) => tui.requestComponentRender(component),
		resetDisplay: NOOP,
		terminal,
	};
	const context = {
		isInitialized: true,
		init: async () => {},
		ui,
		chatContainer,
		pendingTools: new Map(),
		settings: { get: (key: string) => options.smoothStreaming === true && key === "display.smoothStreaming" },
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
		editor: composer.editor,
		updatePendingMessagesDisplay: NOOP,
		clearOptimisticUserMessage: NOOP,
		replaceOptimisticUserMessage: NOOP,
		optimisticSkillMessagePending: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		flushPendingCommandOutput: NOOP,
		setChecklist: NOOP,
		addMessageToChat: () => [] as Component[],
		servedModelTracker: new ServedModelTracker(),
		streamingComponent: undefined,
		streamingMessage: undefined,
	};
	const ctx = context as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	composer.start({ deferInput: true });
	flushScheduledRenders();
	const send = async (event: unknown) => {
		await controller.handleEvent(event as AgentSessionEvent);
		flushScheduledRenders();
	};
	const stop = () => {
		controller.dispose();
		chatContainer.dispose();
		composer.stop();
	};
	return { composer, tui, chatContainer, ctx, send, stop };
}

test("a wrapped pre-tool continuation is not permanently re-appended on every reveal tick", async () => {
	vi.useFakeTimers();
	const terminal = new BufferTerminal(56, 8);
	const { composer, tui, ctx, send, stop } = startHarness(terminal, {
		smoothStreaming: true,
		history: [new StaticBlock(Array.from({ length: 8 }, (_value, index) => `earlier-history-row-${index}`))],
	});
	try {
		await send({ type: "message_start", message: assistantMessage("") });
		for (let end = 3; end < TEXT.length; end += 3) {
			await send({ type: "message_update", message: assistantMessage(TEXT.slice(0, end)) });
			if (end % 12 === 0) {
				vi.advanceTimersByTime(34);
				flushScheduledRenders();
			}
		}

		await send({ type: "message_update", message: assistantMessage(TEXT, true) });
		expect(ctx.streamingComponent?.isTranscriptBlockFinalized()).toBe(true);
		composer.editor.setText("draft one\ndraft two\ndraft three\ndraft four");
		tui.requestRender();
		flushScheduledRenders();
		for (let update = 0; update < 10; update++) {
			await send({ type: "message_update", message: assistantMessage(TEXT, true) });
		}
		for (let frame = 0; frame < 100; frame++) {
			vi.advanceTimersByTime(34);
			flushScheduledRenders();
		}

		const tape = terminal.tape().map(line => Bun.stripANSI(line).trim());
		const continuationRows = tape.filter(line => line.includes("need to"));
		expect(continuationRows).toEqual(["need to preserve semantics exactly."]);
		// Retired rows can still occupy the grid above the prompt; history ownership
		// no longer implies an old full-document viewport index.
		expect(tape.filter(line => line.startsWith("earlier-history-row-"))).toEqual(
			Array.from({ length: 8 }, (_, index) => `earlier-history-row-${index}`),
		);
	} finally {
		stop();
		vi.useRealTimers();
	}
});

test("a tool call cut off mid-stream by a guard interrupt does not hold the rest of the turn live", async () => {
	const terminal = new BufferTerminal(80, 12);
	const { chatContainer, ctx, send, stop } = startHarness(terminal);
	try {
		// 1. The model streams a tool call; kernel preflight aborts the message before it runs.
		await send({ type: "message_start", message: assistantMessage("", false, { callId: "cut", timestamp: 1 }) });
		await send({
			type: "message_update",
			message: assistantMessage("editing now", true, { callId: "cut", timestamp: 1 }),
		});
		await send({
			type: "message_end",
			message: assistantMessage("editing now", true, { stopReason: "aborted", callId: "cut", timestamp: 1 }),
		});
		await send({ type: "agent_end", messages: [], isTerminal: false });
		expect(ctx.pendingTools.has("cut"), "a call that never ran can never receive a result").toBe(false);

		// 2. The turn continues: many more completed tool calls follow the orphaned card.
		for (let step = 0; step < 30; step++) {
			const id = `ok-${step}`;
			await send({
				type: "message_start",
				message: assistantMessage("", false, { callId: id, timestamp: 10 + step }),
			});
			await send({
				type: "message_update",
				message: assistantMessage(`step ${step}`, true, { callId: id, timestamp: 10 + step }),
			});
			await send({
				type: "message_end",
				message: assistantMessage(`step ${step}`, true, {
					stopReason: "toolUse",
					callId: id,
					timestamp: 10 + step,
				}),
			});
			await send({ type: "tool_execution_start", toolCallId: id, toolName: "test_tool", args: {} });
			await send({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "test_tool",
				result: { content: [{ type: "text", text: `result ${step}` }] },
				isError: false,
			});
		}
		// Sixty finished blocks cannot fit a 12-row terminal. They must retire into
		// scrollback in full rather than stay live behind the cut-off card, where the
		// viewport squeezes every one of them down to a single row.
		const states = chatContainer.blockStates();
		expect(states.filter(state => state === "active")).toEqual([]);
		expect(states.filter(state => state === "settled").length).toBeLessThan(12);
		const tape = terminal.tape().map(line => Bun.stripANSI(line).trim());
		expect(tape.filter(line => line.includes("step 0")).length, "early blocks reach scrollback").toBeGreaterThan(0);
	} finally {
		stop();
	}
});

// A paragraph taller than the viewport used to stay live until it ended with
// its top clipped off the screen; shrinking the pane then pushed the clipped
// rows into scrollback, and the finished paragraph was written after them again.
test("a paragraph taller than the viewport reaches scrollback once when the pane shrinks mid-stream", async () => {
	const terminal = new BufferTerminal(60, 14);
	const { send, stop } = startHarness(terminal);
	const words = Array.from({ length: 160 }, (_value, index) => `w${String(index + 1).padStart(3, "0")}`);
	const paragraph = words.join(" ");
	try {
		await send({ type: "message_start", message: assistantMessage("") });
		for (let end = 7; end < paragraph.length; end += 7) {
			if (end === 504) terminal.resize(60, 9);
			await send({ type: "message_update", message: assistantMessage(paragraph.slice(0, end)) });
		}
		await send({ type: "message_update", message: assistantMessage(paragraph) });
		await send({ type: "message_end", message: assistantMessage(paragraph) });
		await send({ type: "agent_end", messages: [], isTerminal: true });

		const shown = terminal
			.tape()
			.flatMap(line => Bun.stripANSI(line).split(/\s+/))
			.filter(word => /^w\d{3}$/.test(word));
		expect(shown).toEqual(words);
	} finally {
		stop();
	}
});
