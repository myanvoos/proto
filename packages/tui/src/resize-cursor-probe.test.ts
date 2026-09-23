import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { TerminalCursorPosition } from "./terminal";
import { setReportedTerminalHostIdentity } from "./ttyid";
import {
	CURSOR_MARKER,
	type HistoryBatch,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "./tui";

type GrowMode = "always" | "cursorOnLastRow";

class FakeTerminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	readonly vt: VTermTerminal;
	answersCursorPosition = true;
	keepCursorRowOnNarrow = false;
	// A size the OS already reports but whose SIGWINCH has not been handled yet.
	osSize: { columns: number; rows: number } | undefined;
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
		const oldColumns = this.columns;
		const cursorRow = this.vt.buffer.normal.cursorY;
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
		// xterm's narrower reflow may move rows below the visible cursor while
		// leaving its screen row unchanged. CPR then reports that detached row.
		if (this.keepCursorRowOnNarrow && columns < oldColumns) {
			this.vt.write(`\x1b[${Math.min(cursorRow, rows - 1) + 1};1H`);
		}
	}
	triggerResize(): void {
		this.#resizeCallback?.();
	}
	refreshSize(): boolean {
		const size = this.osSize;
		if (size === undefined) return false;
		this.osSize = undefined;
		this.columns = size.columns;
		this.rows = size.rows;
		this.#resizeCallback?.();
		return true;
	}
	tape(): string[] {
		const buffer = this.vt.buffer.normal;
		const lines = Array.from({ length: buffer.length }, (_value, index) =>
			(buffer.getLine(index)?.translateToString(true) ?? "").trimEnd(),
		);
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines;
	}
	screen(): string[] {
		const buffer = this.vt.buffer.normal;
		return Array.from({ length: this.rows }, (_value, index) =>
			(buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "").trimEnd(),
		);
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
		return { cancel: () => (entry.cancelled = true) };
	}
	async flush(): Promise<void> {
		while (this.#pending.length > 0) {
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

/** Explicitly retires every row that no longer fits the mutable viewport. */
class ResizeFrameProvider implements TerminalFrameProvider {
	rows: string[];
	readonly acknowledgements: number[] = [];
	#committedTo = 0;
	#nextId = 1;
	#pending: { batch: HistoryBatch; committedTo: number } | undefined;
	#flush = false;
	readonly #liveRows: number;
	constructor(rows: readonly string[], liveRows = 38) {
		this.rows = [...rows];
		this.#liveRows = liveRows;
	}
	#rendered(from: number, to = this.rows.length): string[] {
		const rendered = this.rows.slice(from, to);
		const cursor = this.rows.length - 4;
		if (cursor >= from && cursor < to) rendered[cursor - from] = `${CURSOR_MARKER}${rendered[cursor - from]}`;
		return rendered;
	}
	renderFrame(size: ViewportSize): TerminalFramePlan {
		if (this.#pending === undefined) {
			const commitTo = this.#flush
				? this.rows.length
				: Math.max(this.#committedTo, this.rows.length - this.#liveRows);
			if (commitTo > this.#committedTo) {
				this.#pending = {
					batch: { id: this.#nextId++, rows: this.rows.slice(this.#committedTo, commitTo) },
					committedTo: commitTo,
				};
			}
		}
		const viewportFrom = this.#pending?.committedTo ?? this.#committedTo;
		return {
			history: this.#pending?.batch,
			viewport: this.#rendered(viewportFrom).slice(-size.rows),
			viewportAnchor: "bottom",
		};
	}
	renderResizeFrame(size: ViewportSize): readonly string[] {
		// Transient preview only: history advances exclusively through an offered,
		// acknowledged batch from renderFrame().
		return this.#rendered(0).slice(-size.rows);
	}
	acknowledgeHistory(id: number): void {
		this.acknowledgements.push(id);
		if (this.#pending?.batch.id !== id) return;
		this.#committedTo = this.#pending.committedTo;
		this.#pending = undefined;
	}
	beginHistoryReplay(): void {
		this.#pending = {
			batch: { id: this.#nextId++, rows: [...this.rows], kind: "replay" },
			committedTo: this.rows.length,
		};
		this.#committedTo = 0;
	}
	beginHistoryFlush(): void {
		this.#flush = true;
	}
	expectedPaddedTape(height: number): string[] {
		const viewport = this.rows.slice(this.#committedTo);
		const gap = Array.from({ length: Math.max(0, height - viewport.length) }, () => "");
		return [...this.rows.slice(0, this.#committedTo), ...gap, ...viewport];
	}
}

interface Harness {
	terminal: FakeTerminal;
	scheduler: TestScheduler;
	tui: TUI;
	provider: ResizeFrameProvider;
	body: string[];
	resize(rows: number): Promise<void>;
	stop(): void;
}

function startHarness(
	growPullsHistory: GrowMode,
	options: { answersCursorPosition?: boolean; showHardwareCursor?: boolean; liveRows?: number } = {},
): Harness {
	const restore = setEnvironment({ HERDR_ENV: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(54, 38, growPullsHistory);
	terminal.answersCursorPosition = options.answersCursorPosition ?? true;
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, options.showHardwareCursor ?? false, { renderScheduler: scheduler });
	const body = Array.from({ length: ROWS }, (_value, index) => `row-${index}`);
	const provider = new ResizeFrameProvider(body, options.liveRows);
	tui.setFrameProvider(provider);
	tui.start({ deferInput: true });
	return {
		terminal,
		scheduler,
		tui,
		provider,
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
	test(`height shrink then grow preserves explicit history when the host ${mode === "always" ? "pulls history" : "pads blank rows"}`, async () => {
		const h = startHarness(mode);
		try {
			expect(h.terminal.tape()).toEqual(h.body);
			await h.resize(20);
			expect(h.terminal.tape(), "after shrink").toEqual(h.body);
			await h.resize(38);
			const grownTape = h.body;
			expect(h.terminal.tape(), "after grow").toEqual(grownTape);
			h.tui.requestRender(true);
			expect(h.terminal.tape(), "after a follow-up frame").toEqual(grownTape);
			expect(h.terminal.vt.buffer.normal.cursorY).toBe(37);
		} finally {
			h.stop();
		}
	});

	test(`a lone height grow preserves explicit history when the host ${mode === "always" ? "pulls history" : "pads blank rows"}`, async () => {
		const h = startHarness(mode);
		try {
			await h.resize(50);
			const grownTape = h.body;
			expect(h.terminal.tape()).toEqual(grownTape);
			expect(h.terminal.vt.buffer.normal.cursorY).toBe(49);
		} finally {
			h.stop();
		}
	});
}

for (const liveRows of [8, 38]) {
	test(`a shrink and grow inside one resize burst preserves acknowledged rows with a ${liveRows}-row viewport`, async () => {
		const h = startHarness("cursorOnLastRow", { liveRows });
		try {
			h.terminal.resize(54, 20);
			h.terminal.triggerResize();
			h.terminal.resize(54, 38);
			h.terminal.triggerResize();
			await h.scheduler.flush();
			// A resize transaction may finish its cursor probe in a microtask after
			// the last timer; drain the repaint it schedules as well.
			await Promise.resolve();
			await Promise.resolve();
			await h.scheduler.flush();
			const tape = h.terminal.tape();
			const nonblank = tape.filter(row => row.length > 0);
			expect(nonblank, "every semantic row remains exact, ordered, and unique").toEqual(h.body);
			expect(
				h.terminal.screen().slice(-liveRows),
				"the provider viewport remains bottom-anchored after rapid growth",
			).toEqual(h.body.slice(-liveRows));
			expect(new Set(h.provider.acknowledgements).size).toBe(h.provider.acknowledgements.length);
		} finally {
			h.stop();
		}
	});
}

// A grow the host pads (the visible cursor is off the last row) leaves blank
// rows under the frame. The frame holds its place over them, so the next shrink
// discards them below the cursor instead of pushing a blank band into history.
test("visible editor cursor preserves acknowledged history across padded growth", async () => {
	const h = startHarness("cursorOnLastRow", { showHardwareCursor: true, liveRows: 8 });
	try {
		expect(h.terminal.vt.buffer.normal.cursorY).toBe(34);
		for (const [height, frameTop] of [
			[50, 30],
			[20, 12],
			[38, 12],
		] as const) {
			await h.resize(height);
			expect(h.terminal.tape(), `tape at ${height} rows`).toEqual(h.body);
			expect(h.terminal.screen().slice(frameTop, frameTop + 8), `frame at ${height} rows`).toEqual(h.body.slice(-8));
			expect(h.terminal.vt.buffer.normal.cursorY).toBe(frameTop + 4);
		}
	} finally {
		h.stop();
	}
});

// A host can apply a grow after a frame is computed but before its write lands.
// The line feeds meant to scroll the retiring row off then fall mid-screen, so
// the frame sits a row lower than computed; the settled resize must find it
// there instead of repainting over the retired row.
test("a grow that lands before a retiring frame keeps the retired row", async () => {
	const h = startHarness("cursorOnLastRow", { showHardwareCursor: true, liveRows: 38 });
	try {
		h.provider.rows.push("row-late");
		h.terminal.vt.resize(54, 44);
		h.tui.requestRender(true);
		await h.scheduler.flush();
		h.terminal.rows = 44;
		h.terminal.triggerResize();
		await h.scheduler.flush();
		await Promise.resolve();
		await Promise.resolve();
		await h.scheduler.flush();
		expect(h.terminal.tape().filter(row => row !== "")).toEqual([...h.body, "row-late"]);
	} finally {
		h.stop();
	}
});

// The OS reports the new size as soon as the host resizes, but the SIGWINCH
// reaches the event loop later. A frame due in between would paint the grown
// grid at the old geometry, over the history rows the grow pulled into view.
test("a frame due before the resize signal is handled paints at the new size", async () => {
	const h = startHarness("always", { liveRows: 38 });
	try {
		h.terminal.vt.resize(54, 44);
		h.terminal.osSize = { columns: 54, rows: 44 };
		h.provider.rows.push("row-late");
		h.tui.requestRender(true);
		await h.scheduler.flush();
		await Promise.resolve();
		await Promise.resolve();
		await h.scheduler.flush();
		expect(h.terminal.tape().filter(row => row !== "")).toEqual([...h.body, "row-late"]);
		expect(h.terminal.screen().at(-1)).toBe("row-late");
	} finally {
		h.stop();
	}
});

test("padded growth restores an oversized mutable viewport without rewriting acknowledged history", async () => {
	const h = startHarness("cursorOnLastRow", { showHardwareCursor: true, liveRows: 38 });
	try {
		await h.resize(20);
		h.terminal.writes.length = 0;
		await h.resize(38);
		// The host archived 18 mutable rows before delivering the shrink callback.
		// With the visible cursor above the bottom, growth pads instead of pulling
		// those rows back. They are now inaccessible native snapshots, not an
		// acknowledged history batch; do not hide current rows to deduplicate them.
		const committed = h.body.slice(0, ROWS - 38);
		const tape = h.terminal.tape();
		expect(tape.slice(0, committed.length)).toEqual(committed);
		for (const row of committed) expect(tape.filter(candidate => candidate === row)).toHaveLength(1);
		expect(h.terminal.screen()).toEqual(h.body.slice(-38));
		expect(h.provider.acknowledgements).toEqual([1]);
		expect(h.terminal.writes.join("")).not.toContain("\x1b[3J");
		h.tui.requestRender(true);
		await h.scheduler.flush();
		expect(h.terminal.tape()).toEqual(tape);
		h.tui.resetDisplay();
		await h.scheduler.flush();
		expect(h.terminal.tape()).toEqual(h.body);
	} finally {
		h.stop();
	}
});

test("history preservation does not depend on an optional cursor-position report", async () => {
	const h = startHarness("always", { answersCursorPosition: false });
	try {
		await h.resize(20);
		await h.resize(38);
		expect(h.terminal.tape()).toEqual(h.body);
	} finally {
		h.stop();
	}
});

test("changing committed rows during resize requires an explicit replay", async () => {
	const h = startHarness("cursorOnLastRow");
	try {
		const original = [...h.body];
		h.provider.rows = [...h.body.slice(0, 10), ...h.body.slice(15)];
		h.terminal.resize(54, 20);
		h.terminal.triggerResize();
		await h.scheduler.flush();
		const committed = ROWS - 38;
		expect(h.terminal.tape().slice(0, committed)).toEqual(original.slice(0, committed));
		h.tui.resetDisplay();
		await h.scheduler.flush();
		expect(h.terminal.tape()).toEqual(h.provider.rows);
	} finally {
		h.stop();
	}
});

test("rows streamed during a resize burst retire through acknowledged batches exactly once", async () => {
	const h = startHarness("cursorOnLastRow");
	try {
		for (const height of [20, 24]) {
			// Finalize growth while the complete bounded mutable footer is visible,
			// then verify a shrink/grow burst preserves both channels exactly once.
			for (let i = 0; i < 6; i++) h.provider.rows.push(`row-${h.provider.rows.length}`);
			h.tui.requestRender(true);
			await h.scheduler.flush();
			expect(
				h.terminal.tape().filter(row => row.length > 0),
				"after the explicit append transaction",
			).toEqual(h.provider.rows);
			for (const resizedHeight of [height, 38]) {
				h.terminal.resize(54, resizedHeight);
				h.terminal.triggerResize();
				await h.scheduler.flush();
				expect(
					h.terminal.tape().filter(row => row.length > 0),
					`after resizing to ${resizedHeight} rows`,
				).toEqual(h.provider.rows);
				const expectedViewport = h.provider
					.expectedPaddedTape(resizedHeight)
					.slice(-resizedHeight)
					.filter(row => row.length > 0);
				const visible = h.terminal.screen().filter(row => row.length > 0);
				expect(visible.slice(-expectedViewport.length)).toEqual(expectedViewport);
			}
		}
		expect(new Set(h.provider.acknowledgements).size).toBe(h.provider.acknowledgements.length);
	} finally {
		h.stop();
	}
});

/** One composer-shaped frame: blank padding, hairline, editor with the cursor, status. */
function composerViewport(columns: number, rows: number): string[] {
	const wide = [
		"",
		`editor${CURSOR_MARKER} ask anything / for commands`,
		"status-full-width-xxxxxxxxxxxxxxxxxxxx",
		"",
	];
	const tall = ["", "", "hairline", "", `editor${CURSOR_MARKER} ask anything`, "", "status", ""];
	return (rows <= 6 ? wide : tall)
		.slice(-rows)
		.map(row => row.slice(0, columns + (row.includes(CURSOR_MARKER) ? CURSOR_MARKER.length : 0)));
}

function startComposerHarness(options: {
	columns: number;
	rows: number;
	answersCursorPosition?: boolean;
	keepCursorRowOnNarrow?: boolean;
}) {
	const restore = setEnvironment({
		HERDR_ENV: undefined,
		HERDR_PANE_ID: undefined,
		HERDR_TAB_ID: undefined,
		HERDR_WORKSPACE_ID: undefined,
		TMUX: undefined,
		STY: undefined,
		ZELLIJ: undefined,
		CMUX_WORKSPACE_ID: undefined,
		CMUX_SURFACE_ID: undefined,
		CMUX_REMOTE_TRANSPORT: undefined,
		TERM: "xterm-256color",
		PI_NO_SYNC_OUTPUT: "1",
	});
	const terminal = new FakeTerminal(options.columns, options.rows, "cursorOnLastRow");
	terminal.answersCursorPosition = options.answersCursorPosition ?? true;
	terminal.keepCursorRowOnNarrow = options.keepCursorRowOnNarrow ?? false;
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	const history = Array.from({ length: 30 }, (_, index) => `history-${index}`);
	const acknowledgements: number[] = [];
	let committed = false;
	tui.setFrameProvider({
		renderFrame: ({ columns, rows }) => ({
			history: committed ? undefined : { id: 1, rows: history },
			viewport: composerViewport(columns, rows),
			viewportAnchor: "bottom",
		}),
		acknowledgeHistory(id) {
			committed = true;
			acknowledgements.push(id);
		},
	} satisfies TerminalFrameProvider);
	tui.start({ deferInput: true });
	return { terminal, scheduler, tui, history, acknowledgements, restore };
}

test("saved viewport bottom prevents editor ghosts when a native CPR cursor detaches on narrow reflow", async () => {
	const restore = setEnvironment({
		HERDR_ENV: undefined,
		HERDR_PANE_ID: undefined,
		HERDR_TAB_ID: undefined,
		HERDR_WORKSPACE_ID: undefined,
		TMUX: undefined,
		STY: undefined,
		ZELLIJ: undefined,
		CMUX_WORKSPACE_ID: undefined,
		CMUX_SURFACE_ID: undefined,
		CMUX_REMOTE_TRANSPORT: undefined,
		TERM: "xterm-256color",
		PI_NO_SYNC_OUTPUT: "1",
	});
	const terminal = new FakeTerminal(40, 6, "cursorOnLastRow");
	terminal.keepCursorRowOnNarrow = true;
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	let committed = false;
	const history = Array.from({ length: 30 }, (_, index) => `history-${index}`);
	const acknowledgements: number[] = [];
	const provider: TerminalFrameProvider = {
		renderFrame({ columns, rows }) {
			const viewport =
				rows <= 6
					? [
							"",
							`editor${CURSOR_MARKER} ask anything / for commands`,
							"status-full-width-xxxxxxxxxxxxxxxxxxxx",
							"",
						].slice(-rows)
					: [
							"",
							"",
							"hairline",
							"",
							`editor${CURSOR_MARKER} ask anything`.slice(0, columns + CURSOR_MARKER.length),
							"",
							"status",
							"",
						];
			return { history: committed ? undefined : { id: 1, rows: history }, viewport, viewportAnchor: "bottom" };
		},
		acknowledgeHistory(id) {
			committed = true;
			acknowledgements.push(id);
		},
	};
	tui.setFrameProvider(provider);
	tui.start({ deferInput: true });
	await scheduler.flush();
	try {
		terminal.resize(20, 10);
		terminal.triggerResize();
		await scheduler.flush();
		expect(terminal.screen().filter(row => row.includes("editor"))).toHaveLength(1);
		expect(terminal.tape().filter(line => line.startsWith("history-"))).toEqual(history);
		for (const [columns, rows] of [
			[40, 10],
			[20, 10],
			[20, 3],
			[20, 2],
			[20, 1],
			[20, 10],
			[40, 6],
			[20, 10],
		] as const) {
			terminal.resize(columns, rows);
			terminal.triggerResize();
			await scheduler.flush();
			expect(terminal.screen().filter(row => row.includes("editor")).length).toBeLessThanOrEqual(1);
			expect(
				terminal.tape().filter(line => line.startsWith("history-")),
				`${columns}x${rows}`,
			).toEqual(history);
		}
		expect(acknowledgements).toEqual([1]);
	} finally {
		tui.stop();
		restore();
	}
});

for (const answersCursorPosition of [true, false]) {
	const label = answersCursorPosition ? "" : " without a cursor-position report";
	test(`mixed width, height, and combined resizes stay ghost-free and keep history once${label}`, async () => {
		const h = startComposerHarness({ columns: 20, rows: 10, answersCursorPosition });
		await h.scheduler.flush();
		try {
			for (const [columns, rows] of [
				[40, 10],
				[20, 10],
				[20, 6],
				[40, 6],
				[40, 10],
				[20, 10],
				[20, 3],
				[40, 3],
				[20, 3],
				[20, 10],
				[40, 10],
				[20, 10],
			] as const) {
				h.terminal.resize(columns, rows);
				h.terminal.triggerResize();
				await h.scheduler.flush();
				expect(
					h.terminal.tape().filter(line => line.startsWith("history-")),
					`${columns}x${rows}`,
				).toEqual(h.history);
				expect(
					h.terminal.screen().filter(row => row.includes("editor")).length,
					`${columns}x${rows}`,
				).toBeLessThanOrEqual(1);
			}
			expect(h.acknowledgements).toEqual([1]);
		} finally {
			h.tui.stop();
			h.restore();
		}
	});

	test(`one-row and two-row frames keep acknowledged history exactly once${label}`, async () => {
		// A frame shorter than the composer leaves the host no room: the shrink
		// pushes the remaining live rows into native history before SIGWINCH
		// arrives, and a later grow pulls them back onto the screen. Those rows are
		// never retracted (that would erase user scrollback), so these degenerate
		// sizes assert the acknowledged-history contract only.
		const h = startComposerHarness({ columns: 20, rows: 1, answersCursorPosition });
		await h.scheduler.flush();
		try {
			for (const [columns, rows] of [
				[20, 2],
				[20, 1],
				[40, 1],
				[40, 2],
				[20, 2],
				[20, 1],
				[20, 10],
				[20, 1],
				[20, 10],
			] as const) {
				h.terminal.resize(columns, rows);
				h.terminal.triggerResize();
				await h.scheduler.flush();
				expect(
					h.terminal.tape().filter(line => line.startsWith("history-")),
					`${columns}x${rows}`,
				).toEqual(h.history);
			}
			expect(h.acknowledgements).toEqual([1]);
		} finally {
			h.tui.stop();
			h.restore();
		}
	});
}

/** Writes that restore the saved bottom anchor before erasing the live region. */
function savedAnchorErases(writes: string[]): string[] {
	return writes.filter(write => write.startsWith("\x1b[?25l\x1b8"));
}

test("a host that names itself through the identity probe keeps its saved anchor untouched", async () => {
	const h = startComposerHarness({ columns: 40, rows: 10 });
	await h.scheduler.flush();
	try {
		// A direct terminal rewraps the saved cursor with its logical line, so
		// the resize erase restores that anchor.
		h.terminal.writes.length = 0;
		h.terminal.resize(20, 10);
		h.terminal.triggerResize();
		await h.scheduler.flush();
		expect(savedAnchorErases(h.terminal.writes).length).toBeGreaterThan(0);
		expect(h.terminal.tape().filter(line => line.startsWith("history-"))).toEqual(h.history);

		// The same session inside a multiplexer that the environment does not
		// advertise: only the probe reply says so, and it must be enough to stop
		// the writer from trusting an anchor the host never adjusts. This
		// terminal emulates a reflowing xterm, so it can only witness the path
		// switch; that the clipping host then keeps every block is proven
		// against real tmux in the resize integrity runs.
		setReportedTerminalHostIdentity("tmux 3.4");
		for (const [columns, rows] of [
			[40, 10],
			[20, 4],
			[40, 10],
			[20, 2],
			[40, 10],
		] as const) {
			h.terminal.writes.length = 0;
			h.terminal.resize(columns, rows);
			h.terminal.triggerResize();
			await h.scheduler.flush();
			expect(savedAnchorErases(h.terminal.writes), `${columns}x${rows}`).toEqual([]);
		}
		expect(h.acknowledgements).toEqual([1]);
	} finally {
		setReportedTerminalHostIdentity(null);
		h.tui.stop();
		h.restore();
	}
});
