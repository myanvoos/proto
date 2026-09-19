import { expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, type RenderScheduler, type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { TodoToolDetails } from "../../tools/todo";
import { initThemeSync } from "../theme/theme";
import { AssistantMessageComponent } from "./assistant-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "./tool-execution";
import { TranscriptContainer } from "./transcript-container";

initThemeSync();

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
		while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		return rows;
	}
}

const IMMEDIATE_SCHEDULER: RenderScheduler = {
	now: () => 100,
	scheduleImmediate(callback): void {
		callback();
	},
	scheduleRender(callback): { cancel(): void } {
		callback();
		return { cancel() {} };
	},
};

class StaticBlock implements Component {
	constructor(readonly lines: readonly string[]) {}

	render(): readonly string[] {
		return this.lines;
	}

	invalidate(): void {}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

const REASONING =
	"The user wants a long structured answer. I will write several paragraphs, a heading, a list, a numbered list and a code block so that it spans well beyond one screen in a narrow pane.";

const ANSWER = `Here is the summary of what I found while looking through the rendering engine and the transcript container in the coding agent package.

The first paragraph explains the commit ledger. Rows before the committed index have entered terminal history and ordinary emitters never rewrite them, which is the whole point of the append-only contract.

## Findings

- The audit samples the prefix tail and re-anchors on a structural shift.
- Frozen snapshots of unpinned rows can diverge once the block finalizes.
- A narrow pane makes wrapping changes far more common during streaming.

1. First numbered item with enough words to wrap in a narrow terminal pane.
2. Second numbered item that also wraps because the pane is only fifty-five columns wide.

\`\`\`ts
const value = computeSomething(width, height);
console.log(value);
\`\`\`

Another paragraph follows the code block. It contains **bold text**, some \`inline code\`, and a [link](https://example.com) so that inline styling is exercised while streaming.

Finally, a closing paragraph that wraps across several rows and mentions that the editor sits below the transcript with a status line under it.`;

function message(text: string, thinking = REASONING): AssistantMessage {
	return {
		role: "assistant",
		content:
			text.length > 0
				? [
						{ type: "thinking", thinking },
						{ type: "text", text },
					]
				: [{ type: "thinking", thinking }],
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
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

for (const [cols, rows] of [
	[55, 38],
	[100, 24],
] as const) {
	test(`a streamed reply enters native scrollback exactly once (${cols}x${rows})`, () => {
		const terminal = new BufferTerminal(cols, rows);
		const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
		const transcript = new TranscriptContainer();
		transcript.addChild(
			new StaticBlock(Array.from({ length: 30 }, (_value, index) => `earlier-history-row-${index}`)),
		);
		transcript.addChild(new StaticBlock(["> user asked a question here"]));
		const reply = new AssistantMessageComponent(undefined, false);
		transcript.addChild(reply);
		tui.addChild(transcript);
		tui.addChild(new StaticBlock(["", "> editor", "", "status line"]));
		tui.start({ deferInput: true });
		try {
			for (let end = 3; end < REASONING.length; end += 3) {
				reply.updateContent(message("", REASONING.slice(0, end)), { transient: true });
				tui.requestRender(true);
			}
			// Reveal a few graphemes per frame, like the streaming reveal controller.
			for (let end = 3; end < ANSWER.length; end += 3) {
				reply.updateContent(message(ANSWER.slice(0, end)), { transient: true });
				tui.requestRender(true);
			}
			reply.updateContent(message(ANSWER), { transient: true });
			tui.requestRender(true);
			reply.updateContent(message(ANSWER));
			reply.markTranscriptBlockFinalized();
			tui.requestRender(true);

			const expected = tui.render(cols).map(line => stripAnsi(line).trimEnd());
			while (expected.length > 0 && expected[expected.length - 1] === "") expected.pop();
			expect(terminal.tape().map(stripAnsi)).toEqual(expected);
		} finally {
			tui.stop();
		}
	});
}

const WRAPPED_PRE_TOOL_TEXT = "Step 2 is the real fix. Let me check the helpers I need to preserve semantics exactly.";

const DIAGRAM_REPLY = `The renderer keeps a commit ledger so that rows which already entered terminal history are never rewritten by a later frame.

\`\`\`mermaid
flowchart TD
  A[stream] --> B[freeze]
  B --> C[commit]
  C --> D[history]
\`\`\`

Each stage above hands rows to the next one, and the last stage is the only one that writes to the terminal at all.

A closing paragraph keeps the block streaming for long enough that the composed frame outgrows the pane several times over.`;

test("a streamed reply containing a diagram settles rows while it streams", () => {
	const cols = 60;
	const rows = 14;
	const terminal = new BufferTerminal(cols, rows);
	const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
	const transcript = new TranscriptContainer();
	transcript.addChild(new StaticBlock(["> draw me a diagram"]));
	const reply = new AssistantMessageComponent(undefined, false);
	transcript.addChild(reply);
	tui.addChild(transcript);
	tui.addChild(new StaticBlock(["", "> editor", "", "status line"]));
	tui.start({ deferInput: true });

	try {
		// Settled rows are what lets the commit ceiling advance past a live block.
		// A reply that never settles strands every row it has scrolled past: they
		// reach history in one burst, and a live-source change before that burst
		// repaints from row zero, rewinding the pane to the title screen.
		let settledRows: readonly string[] = [];
		let maxSettled = 0;
		for (let end = 20; end < DIAGRAM_REPLY.length; end += 20) {
			reply.updateContent(message(DIAGRAM_REPLY.slice(0, end)), { transient: true });
			tui.requestRender(true);
			const rendered = reply.render(cols).map(line => stripAnsi(line).trimEnd());
			expect(rendered.slice(0, settledRows.length), "settled rows must never be rewritten").toEqual([
				...settledRows,
			]);
			const settled = reply.getTranscriptBlockSettledRows();
			maxSettled = Math.max(maxSettled, settled);
			settledRows = rendered.slice(0, settled);
		}
		reply.updateContent(message(DIAGRAM_REPLY));
		reply.markTranscriptBlockFinalized();
		tui.requestRender(true);

		const finalRows = reply.render(cols).map(line => stripAnsi(line).trimEnd());
		expect(finalRows.slice(0, settledRows.length), "finalizing must not rewrite settled rows").toEqual([
			...settledRows,
		]);
		const rowAfterDiagram = finalRows.findIndex(line => line.includes("Each stage above"));
		expect(rowAfterDiagram, "the fixture must keep prose after the diagram").toBeGreaterThan(0);
		expect(maxSettled, "rows after the diagram must settle too").toBeGreaterThan(rowAfterDiagram);

		const expected = tui.render(cols).map(line => stripAnsi(line).trimEnd());
		while (expected.length > 0 && expected[expected.length - 1] === "") expected.pop();
		expect(terminal.tape().map(stripAnsi)).toEqual(expected);
	} finally {
		tui.stop();
	}
});

test("a finalized wrapped assistant rejects post-final updates instead of creating a scrollback staircase", () => {
	const scheduledRenders: Array<() => void> = [];
	const scheduler: RenderScheduler = {
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
	const flush = (): void => {
		while (scheduledRenders.length > 0) scheduledRenders.shift()!();
	};
	const terminal = new BufferTerminal(56, 8);
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new TranscriptContainer();
	transcript.addChild(new StaticBlock(Array.from({ length: 8 }, (_value, index) => `history-${index}`)));
	const reply = new AssistantMessageComponent(undefined, false);
	transcript.addChild(reply);
	tui.addChild(transcript);
	tui.addChild(
		new StaticBlock(["", "chrome-1", "chrome-2", "chrome-3", "chrome-4", "chrome-5", "> editor", "status"]),
	);
	tui.start({ deferInput: true });
	flush();
	try {
		for (let end = 3; end <= 54; end += 3) {
			reply.updateContent(message(WRAPPED_PRE_TOOL_TEXT.slice(0, end), ""), { transient: true });
			tui.requestComponentRender(reply);
			flush();
		}

		// EventController drains the reveal before finalizing; updates after this point must be inert.
		reply.updateContent(message(WRAPPED_PRE_TOOL_TEXT, ""), { transient: true });
		tui.requestComponentRender(reply);
		flush();
		reply.markTranscriptBlockFinalized();
		for (let end = 55; end <= WRAPPED_PRE_TOOL_TEXT.length; end++) {
			reply.updateContent(message(WRAPPED_PRE_TOOL_TEXT.slice(0, end), ""), { transient: true });
			tui.requestComponentRender(reply);
			flush();
		}

		const tape = terminal.tape().map(line => stripAnsi(line).trim());
		const continuationRows = tape.filter(line => line.includes("need to"));
		expect(continuationRows).toEqual(["need to preserve semantics exactly."]);
		expect(tape.indexOf(continuationRows[0]!)).toBeLessThan(tape.length - terminal.rows);
	} finally {
		tui.stop();
	}
});

// A completed-todo card animates its strike-through reveal for ~900 ms after the
// block is already finalized. When the reply streaming below it pushes the card
// into native scrollback mid-reveal, every further tick used to rewrite rows the
// terminal can no longer repaint: the renderer re-anchored its commit seam to the
// card and re-appended everything below it once per tick, so scrolling up showed
// the reply spliced and replayed over and over.
test("a todo card that scrolls into history mid-strike leaves the transcript in scrollback once", () => {
	vi.useFakeTimers();
	const cols = 55;
	const rows = 20;
	const terminal = new BufferTerminal(cols, rows);
	const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
	const transcript = new TranscriptContainer();
	transcript.addChild(new StaticBlock(Array.from({ length: 8 }, (_value, index) => `earlier-history-row-${index}`)));
	const ui: ToolExecutionUi = {
		requestRender: () => tui.requestRender(true),
		requestComponentRender: () => tui.requestRender(true),
		resetDisplay: () => {},
	};
	const details: TodoToolDetails = {
		op: "done",
		storage: "session",
		phases: [
			{
				name: "Playtest",
				tasks: [
					{ content: "Play the game end to end", status: "completed" },
					{ content: "Fix what the playtest finds and re-verify", status: "completed" },
					{ content: "Write up the findings", status: "pending" },
				],
			},
		],
		completedTasks: [
			{ phase: "Playtest", content: "Play the game end to end" },
			{ phase: "Playtest", content: "Fix what the playtest finds and re-verify" },
		],
	};
	const card = new ToolExecutionComponent("todo", { op: "done" }, { useBuiltInRenderer: true }, undefined, ui);
	transcript.addChild(card);
	const reply = new AssistantMessageComponent(undefined, false);
	transcript.addChild(reply);
	tui.addChild(transcript);
	tui.addChild(new StaticBlock(["", "> editor", "", "status line"]));
	tui.start({ deferInput: true });

	try {
		card.updateResult({ content: [{ type: "text", text: "ok" }], details, isError: false }, false);
		tui.requestRender(true);

		for (let end = 40; end < ANSWER.length; end += 40) {
			reply.updateContent(message(ANSWER.slice(0, end)), { transient: true });
			tui.requestRender(true);
			// One strike frame per streamed chunk, the interval's own 65 ms period.
			vi.advanceTimersByTime(65);
		}
		reply.updateContent(message(ANSWER));
		reply.markTranscriptBlockFinalized();
		tui.requestRender(true);

		const expected = tui.render(cols).map(line => stripAnsi(line).trimEnd());
		while (expected.length > 0 && expected[expected.length - 1] === "") expected.pop();
		// The card has to have left the window for the respray to be reachable at all.
		expect(expected.length).toBeGreaterThan(rows);
		expect(terminal.tape().map(stripAnsi)).toEqual(expected);
	} finally {
		card.dispose();
		tui.stop();
		vi.useRealTimers();
	}
});
