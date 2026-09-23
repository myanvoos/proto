import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import {
	CURSOR_MARKER,
	coalesceAdjacentSgr,
	type HistoryBatch,
	type TerminalFrameProvider,
	TUI,
	type TuiPaint,
	type ViewportSize,
} from "./tui";

type ResizeCallback = () => void;

class FakeTerminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	pendingBytes = 0;
	readonly vt: VTermTerminal;
	#resizeCallback: ResizeCallback | undefined;
	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 200 });
	}
	get pendingOutputBytes(): number {
		return this.pendingBytes;
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
	start(_input: (data: string) => void, resize: ResizeCallback): void {
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
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
	}
	triggerResize(): void {
		this.#resizeCallback?.();
	}
	normalLines(): string[] {
		const lines = this.vt.buffer.normal;
		return Array.from({ length: lines.length }, (_value, index) =>
			(lines.getLine(index)?.translateToString(true) ?? "").trimEnd(),
		);
	}
	screenRows(): string[] {
		const lines = this.vt.buffer.active;
		return Array.from({ length: this.rows }, (_value, index) =>
			(lines.getLine(lines.viewportY + index)?.translateToString(true) ?? "").trimEnd(),
		);
	}
}

class TestScheduler {
	#pending: Array<{ callback: () => void; cancelled: boolean }> = [];
	now(): number {
		return 100;
	}
	scheduleImmediate(callback: () => void): void {
		callback();
	}
	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const entry = { callback, cancelled: false };
		this.#pending.push(entry);
		return { cancel: () => (entry.cancelled = true) };
	}
	flushOne(): void {
		const entry = this.#pending.shift();
		if (entry && !entry.cancelled) entry.callback();
	}
	flush(): void {
		while (this.#pending.length > 0) this.flushOne();
	}
}

class FrameFixture implements TerminalFrameProvider {
	viewport: string[] = [];
	ledger: string[] = [];
	readonly acknowledgements: number[] = [];
	replayRequests = 0;
	flushRequests = 0;
	#nextId = 1;
	#pending: HistoryBatch[] = [];
	#flushRows: string[][] = [];
	renderFrame(size: ViewportSize): { history?: HistoryBatch; viewport: readonly string[] } {
		return { history: this.#pending[0], viewport: this.viewport.slice(-size.rows) };
	}
	acknowledgeHistory(id: number): void {
		this.acknowledgements.push(id);
		if (this.#pending[0]?.id === id) this.#pending.shift();
		if (this.flushRequests > 0 && this.#pending.length === 0) this.#enqueueNextFlush();
	}
	append(rows: readonly string[]): number {
		this.ledger.push(...rows);
		const id = this.#nextId++;
		this.#pending.push({ id, rows: [...rows] });
		return id;
	}
	replaceLedger(rows: readonly string[]): void {
		this.ledger = [...rows];
	}
	beginHistoryReplay(): void {
		this.replayRequests++;
		this.#pending = [{ id: this.#nextId++, rows: [...this.ledger], kind: "replay" }];
	}
	queueForStop(...batches: readonly string[][]): void {
		this.#flushRows.push(...batches.map(rows => [...rows]));
	}
	beginHistoryFlush(): void {
		this.flushRequests++;
		this.#enqueueNextFlush();
	}
	#enqueueNextFlush(): void {
		const rows = this.#flushRows.shift();
		if (rows !== undefined) this.append(rows);
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

test("keeps an astral character whole in the frame write", () => {
	const terminal = new FakeTerminal(5_000, 1);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.addChild({ render: () => ["a".repeat(1_005) + String.fromCodePoint(0x1f600) + "b".repeat(2_000)] });
	try {
		tui.start({ deferInput: true });
		const frameWrites = terminal.writes.filter(write => write.includes("a".repeat(50)));
		expect(frameWrites).toHaveLength(1);
		expect(frameWrites[0]).toContain(String.fromCodePoint(0x1f600));
		expect(frameWrites[0]).toContain(`${"a".repeat(1_005)}${String.fromCodePoint(0x1f600)}`);
	} finally {
		tui.stop();
	}
});

test("does not coalesce an incomplete colon extended-color SGR", () => {
	const terminal = new FakeTerminal(10, 1);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.addChild({ render: () => ["\x1b[38:5m\x1b[1mX"] });
	try {
		expect(coalesceAdjacentSgr("\x1b[38:5m\x1b[1mX")).toBe("\x1b[38:5m\x1b[1mX");
		tui.start({ deferInput: true });
		const cell = terminal.vt.buffer.normal.getLine(0)?.getCell(0);
		expect(cell?.getChars()).toBe("X");
		expect(cell?.isBold()).toBe(1);
		expect(cell?.isFgPalette()).toBe(false);
	} finally {
		tui.stop();
	}
});

test("child fallback paints only the bounded viewport and never infers history", () => {
	const terminal = new FakeTerminal(12, 3);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	let rows = ["old-0", "old-1", "live-0", "live-1", "live-2"];
	tui.addChild({ render: () => rows });
	try {
		tui.start({ deferInput: true });
		expect(terminal.normalLines()).toEqual(["live-0", "live-1", "live-2"]);
		terminal.writes.length = 0;
		rows = [...rows, "live-3"];
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["live-1", "live-2", "live-3"]);
		expect(terminal.writes.join("")).not.toContain("old-0");
	} finally {
		tui.stop();
	}
});

test("accepts ordered history batches once and acknowledges each completed write", () => {
	const terminal = new FakeTerminal(20, 3);
	const scheduler = new TestScheduler();
	const paints: TuiPaint[] = [];
	const tui = new TUI(terminal, false, { renderScheduler: scheduler, onPaint: paint => paints.push(paint) });
	const provider = new FrameFixture();
	provider.viewport = ["reply", "prompt"];
	provider.append(["h0", "h1"]);
	provider.append(["h2"]);
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		expect(provider.acknowledgements).toEqual([1, 2]);
		expect(paints.filter(paint => paint.history.length > 0).map(paint => paint.history)).toEqual([
			["h0", "h1"],
			["h2"],
		]);
		expect(terminal.normalLines()).toEqual(["h0", "h1", "h2", "reply", "prompt"]);
	} finally {
		tui.stop();
	}
});

test("does not acknowledge or consume history while output is backpressured", () => {
	const terminal = new FakeTerminal(20, 3);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const provider = new FrameFixture();
	provider.viewport = ["prompt"];
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		terminal.writes.length = 0;
		provider.append(["held"]);
		terminal.pendingBytes = 300_000;
		tui.requestRender();
		scheduler.flushOne();
		expect(provider.acknowledgements).toEqual([]);
		expect(terminal.writes).toEqual([]);
		terminal.pendingBytes = 0;
		scheduler.flush();
		expect(provider.acknowledgements).toEqual([1]);
		expect(terminal.normalLines().slice(0, 2)).toEqual(["held", "prompt"]);
	} finally {
		tui.stop();
	}
});

test("viewport rewrites do not replay or erase accepted history", () => {
	const terminal = new FakeTerminal(14, 3);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const provider = new FrameFixture();
	provider.append(["settled-0", "settled-1"]);
	provider.viewport = ["run 0", "prompt"];
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		terminal.writes.length = 0;
		for (let frame = 1; frame <= 12; frame++) {
			provider.viewport = [`run ${frame}`, "prompt"];
			tui.requestRender(true);
		}
		expect(provider.acknowledgements).toEqual([1]);
		expect(terminal.normalLines()).toEqual(["settled-0", "settled-1", "run 12", "prompt"]);
		expect(terminal.writes.join("")).not.toContain("\x1b[3J");
	} finally {
		tui.stop();
	}
});

test("resetDisplay requests one complete replay and replaces stale history transactionally", () => {
	const terminal = new FakeTerminal(30, 4);
	const scheduler = new TestScheduler();
	const paints: TuiPaint[] = [];
	const tui = new TUI(terminal, false, { renderScheduler: scheduler, onPaint: paint => paints.push(paint) });
	const provider = new FrameFixture();
	provider.viewport = ["reply", "prompt"];
	provider.append(["tool", "collapsed"]);
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		provider.replaceLedger(["tool", "detail one", "detail two"]);
		tui.resetDisplay();
		scheduler.flush();
		expect(provider.replayRequests).toBe(1);
		expect(provider.acknowledgements).toEqual([1, 2]);
		expect(terminal.normalLines()).toEqual(["tool", "detail one", "detail two", "reply", "prompt"]);
		expect(paints.at(-1)).toMatchObject({ reset: true, viewport: ["detail one", "detail two", "reply", "prompt"] });
		expect(terminal.writes.at(-1)).toContain("\x1b[3J");
	} finally {
		tui.stop();
	}
});

test("a multiplexer that ignores ED3 still receives a complete replay at the tail", () => {
	const restore = setEnvironment({ TMUX: undefined, STY: "1", TERM: "screen", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(30, 4);
	const originalWrite = terminal.write.bind(terminal);
	terminal.write = data => originalWrite(data.replaceAll("\x1b[3J", ""));
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const provider = new FrameFixture();
	provider.viewport = ["reply", "prompt"];
	provider.append(["tool", "collapsed"]);
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		provider.replaceLedger(["tool", "detail one", "detail two", "detail three"]);
		tui.resetDisplay();
		scheduler.flush();
		expect(terminal.normalLines().slice(-6)).toEqual([
			"tool",
			"detail one",
			"detail two",
			"detail three",
			"reply",
			"prompt",
		]);
	} finally {
		tui.stop();
		restore();
	}
});

test("stop flushes all provider-eligible history before returning", () => {
	const terminal = new FakeTerminal(20, 3);
	const scheduler = new TestScheduler();
	const provider = new FrameFixture();
	provider.viewport = ["prompt"];
	provider.queueForStop(["late-0"], ["late-1", "late-2"]);
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	tui.start({ deferInput: true });
	tui.stop();
	expect(provider.flushRequests).toBe(1);
	expect(provider.acknowledgements).toEqual([1, 2]);
	expect(terminal.normalLines().slice(0, 4)).toEqual(["late-0", "late-1", "late-2", "prompt"]);
});

test("parks the cursor in the provider viewport after a history append", () => {
	const terminal = new FakeTerminal(20, 4);
	const scheduler = new TestScheduler();
	const provider = new FrameFixture();
	provider.append(["h0", "h1", "h2"]);
	provider.viewport = ["editor", `input${CURSOR_MARKER}`, "status"];
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		expect(terminal.screenRows().slice(-3)).toEqual(["editor", "input", "status"]);
		expect(terminal.vt.buffer.active.cursorY).toBe(2);
		expect(terminal.vt.buffer.active.cursorX).toBe(5);
	} finally {
		tui.stop();
	}
});

test.skipIf(Bun.stringWidth("\u2630", { ambiguousIsNarrow: true }) !== 1)(
	"keeps ambiguous-is-narrow overlay glyphs when the measured line fits",
	() => {
		const terminal = new FakeTerminal(4, 1);
		const scheduler = new TestScheduler();
		const tui = new TUI(terminal, false, { renderScheduler: scheduler });
		tui.addChild({ render: () => ["abcd"] });
		try {
			tui.start({ deferInput: true });
			terminal.writes.length = 0;
			tui.showOverlay({ render: () => ["☰"] }, { width: 1, col: 0, row: 0 });
			scheduler.flush();
			expect(terminal.screenRows()[0]).toBe("☰bcd");
		} finally {
			tui.stop();
		}
	},
);

test("replays accepted history once across a width and height resize", () => {
	const restore = setEnvironment({ TMUX: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(8, 2);
	const scheduler = new TestScheduler();
	const provider = new FrameFixture();
	provider.append(["A", "B"]);
	provider.viewport = ["C"];
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		terminal.resize(14, 3);
		terminal.triggerResize();
		scheduler.flush();
		expect(provider.replayRequests).toBe(1);
		expect(provider.acknowledgements).toEqual([1, 2]);
		expect(terminal.normalLines()).toEqual(["A", "B", "C"]);
	} finally {
		tui.stop();
		restore();
	}
});

test.each([
	["combining mark", "e\u0301", 1],
	["variation selector", "\u2665\ufe0e", 1],
	["ZWJ emoji continuation", "\u{1f469}\u200d\u{1f4bb}", 2],
])("keeps a %s in one grapheme while fitting an oversized row", (_label, grapheme, width) => {
	const terminal = new FakeTerminal(width, 1);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.addChild({ render: () => [`${grapheme}${"x".repeat(5_000)}`] });
	try {
		tui.start({ deferInput: true });
		expect(terminal.writes.join("")).toContain(grapheme);
	} finally {
		tui.stop();
	}
});

test.each([
	["DCS", "\x1bP"],
	["APC", "\x1b_"],
	["SOS", "\x1bX"],
	["PM", "\x1b^"],
])("skips an oversized row's complete %s string control atomically", (_label, introducer) => {
	const terminal = new FakeTerminal(1, 1);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const control = `${introducer}q-control-payload\x1b\\`;
	tui.addChild({ render: () => [`${control}V${"x".repeat(5_000)}`] });
	try {
		tui.start({ deferInput: true });
		const stream = terminal.writes.join("");
		expect(stream).toContain("V");
		expect(stream).not.toContain("q-control-payload");
	} finally {
		tui.stop();
	}
});
