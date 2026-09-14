import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { TerminalCursorPosition } from "./terminal";
import { CURSOR_MARKER, TUI } from "./tui";

type GrowMode = "always" | "cursorOnLastRow";

class FakeTerminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	readonly vt: VTermTerminal;
	answersCursorPosition = true;
	#resizeCallback: (() => void) | undefined;

	constructor(columns: number, rows: number, growPullsHistory: GrowMode) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 2_000, growPullsHistory });
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

	start(_input: (data: string) => void, resize: () => void): void {
		this.#resizeCallback = resize;
	}

	enableInput(): void {}

	stop(): void {}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
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

	onAppearanceChange(_callback: (appearance: "dark" | "light") => void): void {}

	onPrivateModeReport(_callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {}

	queryCursorPosition(): Promise<TerminalCursorPosition | undefined> {
		if (!this.answersCursorPosition) return Promise.resolve(undefined);
		const buffer = this.vt.buffer.normal;
		return Promise.resolve({ row: buffer.cursorY, col: buffer.cursorX });
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
	}

	triggerResize(): void {
		this.#resizeCallback?.();
	}

	tape(): string[] {
		const buffer = this.vt.buffer.normal;
		const lines = Array.from(
			{ length: buffer.length },
			(_value, index) => buffer.getLine(index)?.translateToString(true).trimEnd() ?? "",
		);
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines;
	}
}

class TestScheduler {
	#pending: Array<{ callback: () => void; cancelled: boolean; at: number }> = [];
	#now = 100;

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void, delayMs: number): { cancel(): void } {
		const entry = { callback, cancelled: false, at: this.#now + delayMs };
		this.#pending.push(entry);
		return {
			cancel: () => {
				entry.cancelled = true;
			},
		};
	}

	async flush(): Promise<void> {
		while (this.#pending.length > 0) {
			// Let probe replies settle between timer hops, as they would on a real event loop.
			await Promise.resolve();
			await Promise.resolve();
			this.#pending.sort((a, b) => a.at - b.at);
			const entry = this.#pending.shift()!;
			this.#now = Math.max(this.#now, entry.at);
			if (!entry.cancelled) entry.callback();
		}
	}
}

function setEnvironment(values: Record<string, string | undefined>): () => void {
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(values)) {
		previous[key] = Bun.env[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	};
}

const ROWS = 180;

function buildFrame(): { body: string[]; rendered: string[] } {
	const body = Array.from({ length: ROWS }, (_value, index) => `row-${index}`);
	const rendered = body.slice();
	// The editor cursor sits a few rows above the status line, like the coding agent.
	rendered[ROWS - 4] = `${CURSOR_MARKER}${rendered[ROWS - 4]}`;
	return { body, rendered };
}

interface Harness {
	terminal: FakeTerminal;
	scheduler: TestScheduler;
	tui: TUI;
	body: string[];
	resize(rows: number): Promise<void>;
	stop(): void;
}

function startHarness(growPullsHistory: GrowMode, options: { answersCursorPosition?: boolean } = {}): Harness {
	const restore = setEnvironment({ HERDR_ENV: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(54, 38, growPullsHistory);
	terminal.answersCursorPosition = options.answersCursorPosition ?? true;
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const { body, rendered } = buildFrame();
	tui.addChild({ render: () => rendered.slice() });
	tui.start({ deferInput: true });
	return {
		terminal,
		scheduler,
		tui,
		body,
		async resize(rows: number): Promise<void> {
			terminal.resize(54, rows);
			terminal.triggerResize();
			await scheduler.flush();
		},
		stop(): void {
			tui.stop();
			restore();
		},
	};
}

for (const mode of ["cursorOnLastRow", "always"] as const) {
	test(`height shrink then grow keeps history exact when the host ${mode === "always" ? "pulls history" : "pads blank rows"}`, async () => {
		const h = startHarness(mode);
		try {
			expect(h.terminal.tape()).toEqual(h.body);
			await h.resize(20);
			expect(h.terminal.tape(), "after shrink").toEqual(h.body);
			await h.resize(38);
			expect(h.terminal.tape(), "after grow").toEqual(h.body);
			h.tui.requestRender(true);
			expect(h.terminal.tape(), "after a follow-up frame").toEqual(h.body);
		} finally {
			h.stop();
		}
	});

	test(`a lone height grow keeps history exact when the host ${mode === "always" ? "pulls history" : "pads blank rows"}`, async () => {
		const h = startHarness(mode);
		try {
			await h.resize(50);
			expect(h.terminal.tape()).toEqual(h.body);
		} finally {
			h.stop();
		}
	});
}

test("a shrink and grow that settle before a frame is painted keep history exact", async () => {
	const h = startHarness("cursorOnLastRow");
	try {
		// Two resize events inside one debounce window: the host pushed rows
		// into history on the shrink and padded the grow with blank rows.
		h.terminal.resize(54, 20);
		h.terminal.triggerResize();
		h.terminal.resize(54, 38);
		h.terminal.triggerResize();
		await h.scheduler.flush();
		expect(h.terminal.tape()).toEqual(h.body);
		h.tui.requestRender(true);
		expect(h.terminal.tape()).toEqual(h.body);
	} finally {
		h.stop();
	}
});

test("without a cursor report the ledger assumes the host pulled history", async () => {
	const h = startHarness("always", { answersCursorPosition: false });
	try {
		await h.resize(20);
		await h.resize(38);
		expect(h.terminal.tape()).toEqual(h.body);
	} finally {
		h.stop();
	}
});

test("a frame that shifts above the seam during a resize is appended, not skipped", async () => {
	const restore = setEnvironment({ HERDR_ENV: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(54, 38, "cursorOnLastRow");
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	let { body, rendered } = buildFrame();
	const original = body;
	tui.addChild({ render: () => rendered.slice() });
	try {
		tui.start({ deferInput: true });
		// Drop five rows near the top of the frame while the host shrinks.
		body = [...body.slice(0, 10), ...body.slice(15)];
		rendered = [...rendered.slice(0, 10), ...rendered.slice(15)];
		terminal.resize(54, 20);
		terminal.triggerResize();
		await scheduler.flush();
		terminal.resize(54, 38);
		terminal.triggerResize();
		await scheduler.flush();
		// History above the seam (the 38-row window that was committed before
		// the resize) is stale and stays put; everything from the seam on is
		// re-appended from the current frame instead of being skipped.
		const seam = ROWS - 38;
		const tape = terminal.tape();
		expect(tape.slice(0, seam), "committed history is never rewritten").toEqual(original.slice(0, seam));
		expect(tape.slice(-(body.length - seam)), "the current frame is appended from the seam").toEqual(
			body.slice(seam),
		);
	} finally {
		tui.stop();
		restore();
	}
});

test("rows streamed in during a resize burst scroll into history exactly once", async () => {
	const restore = setEnvironment({ HERDR_ENV: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(54, 38, "cursorOnLastRow");
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const rows = Array.from({ length: ROWS }, (_value, index) => `row-${index}`);
	const render = () => {
		const frame = rows.slice();
		frame[frame.length - 4] = `${CURSOR_MARKER}${frame[frame.length - 4]}`;
		return frame;
	};
	tui.addChild({ render });
	try {
		tui.start({ deferInput: true });
		for (const height of [20, 38, 24, 38]) {
			for (let i = 0; i < 6; i++) rows.push(`row-${rows.length}`);
			terminal.resize(54, height);
			terminal.triggerResize();
			await scheduler.flush();
			expect(terminal.tape(), `after resizing to ${height} rows`).toEqual(rows);
		}
	} finally {
		tui.stop();
		restore();
	}
});
