import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { TerminalCursorPosition } from "./terminal";
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

test("visible editor cursor preserves acknowledged history across padded growth", async () => {
	const h = startHarness("cursorOnLastRow", { showHardwareCursor: true, liveRows: 8 });
	try {
		expect(h.terminal.vt.buffer.normal.cursorY).toBe(34);
		for (const height of [50, 20, 38]) {
			await h.resize(height);
			expect(
				h.terminal.tape().filter(row => row !== ""),
				`semantic tape at ${height} rows`,
			).toEqual(h.body);
			expect(h.terminal.screen().slice(-8), `viewport at ${height} rows`).toEqual(h.body.slice(-8));
			expect(h.terminal.vt.buffer.normal.cursorY).toBe(height - 4);
		}
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
