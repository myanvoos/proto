import { expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, type RenderScheduler, type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { Settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import { TranscriptContainer } from "../components/transcript-container";
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

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 5_000 });
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
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
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

function assistantMessage(text: string, withToolCall = false): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text },
			...(withToolCall ? [{ type: "toolCall" as const, id: "call-1", name: "test_tool", arguments: {} }] : []),
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
		stopReason: withToolCall ? "toolUse" : "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

test("a wrapped pre-tool continuation is not permanently re-appended on every reveal tick", async () => {
	vi.useFakeTimers();
	const terminal = new BufferTerminal(56, 8);
	const tui = new TUI(terminal, false, { renderScheduler: SCHEDULER });
	const chatContainer = new TranscriptContainer();
	chatContainer.addChild(
		new StaticBlock(Array.from({ length: 8 }, (_value, index) => `earlier-history-row-${index}`)),
	);
	tui.addChild(chatContainer);
	tui.addChild(
		new StaticBlock(["", "chrome-1", "chrome-2", "chrome-3", "chrome-4", "chrome-5", "> editor", "status"]),
	);
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
		settings: { get: (key: string) => key === "display.smoothStreaming" },
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
	const interactiveContext = context as unknown as InteractiveModeContext;
	const controller = new EventController(interactiveContext);
	tui.start({ deferInput: true });
	flushScheduledRenders();
	try {
		await controller.handleEvent({
			type: "message_start",
			message: assistantMessage(""),
		} as unknown as AgentSessionEvent);
		flushScheduledRenders();
		for (let end = 3; end < TEXT.length; end += 3) {
			await controller.handleEvent({
				type: "message_update",
				message: assistantMessage(TEXT.slice(0, end)),
			} as unknown as AgentSessionEvent);
			flushScheduledRenders();
			if (end % 12 === 0) {
				vi.advanceTimersByTime(34);
				flushScheduledRenders();
			}
		}

		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage(TEXT, true),
		} as unknown as AgentSessionEvent);
		flushScheduledRenders();
		expect(interactiveContext.streamingComponent?.isTranscriptBlockFinalized()).toBe(true);
		for (let update = 0; update < 10; update++) {
			await controller.handleEvent({
				type: "message_update",
				message: assistantMessage(TEXT, true),
			} as unknown as AgentSessionEvent);
			flushScheduledRenders();
		}
		for (let frame = 0; frame < 100; frame++) {
			vi.advanceTimersByTime(34);
			flushScheduledRenders();
		}

		const tape = terminal.tape().map(line => stripAnsi(line).trim());
		const continuationRows = tape.filter(line => line.includes("need to"));
		expect(continuationRows).toEqual(["need to preserve semantics exactly."]);
		expect(tape.indexOf(continuationRows[0]!)).toBeLessThan(tape.length - terminal.rows);
	} finally {
		controller.dispose();
		chatContainer.dispose();
		tui.stop();
		vi.useRealTimers();
	}
});
