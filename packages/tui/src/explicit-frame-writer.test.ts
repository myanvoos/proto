import { afterEach, beforeEach, expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import {
	type Component,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TuiPaint,
	type ViewportSize,
} from "./tui";

class FakeTerminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	pendingOutputBytes = 0;
	stopped = false;
	readonly vt: VTermTerminal;
	#input: ((data: string) => void) | undefined;
	#resize: (() => void) | undefined;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 500 });
	}

	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): null {
		return null;
	}
	get appearance(): undefined {
		return undefined;
	}
	start(input: (data: string) => void, resize: () => void): void {
		this.#input = input;
		this.#resize = resize;
	}
	enableInput(): void {}
	stop(): void {
		this.stopped = true;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
		this.vt.write(data);
		const probe = data.match(/\x1b\[(\d+)G\x1b\[6n/u);
		if (probe?.[1]) this.#input?.(`\x1b[${this.vt.buffer.active.cursorY + 1};${probe[1]}R`);
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
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
	}
	triggerResize(): void {
		this.#resize?.();
	}
	screenRows(): string[] {
		const buffer = this.vt.buffer.normal;
		return Array.from(
			{ length: this.rows },
			(_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
		);
	}
	allNormalRows(): string[] {
		const buffer = this.vt.buffer.normal;
		return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "");
	}
}

class Scheduler {
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
		return {
			cancel: () => {
				entry.cancelled = true;
			},
		};
	}
	flushOne(): boolean {
		const entry = this.#pending.shift();
		if (!entry) return false;
		if (!entry.cancelled) entry.callback();
		return true;
	}
	flush(): void {
		let guard = 100;
		while (this.flushOne() && --guard > 0) {}
		if (guard === 0) throw new Error("scheduler did not settle");
	}
}

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan = { viewport: [], viewportAnchor: "bottom" };
	acks: number[] = [];
	replays = 0;
	flushes = 0;
	onReplay: (() => void) | undefined;
	onFlush: (() => void) | undefined;
	onAck: ((id: number) => void) | undefined;
	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}
	acknowledgeHistory(id: number): void {
		this.acks.push(id);
		this.onAck?.(id);
		if (this.plan.history?.id === id) this.plan = { ...this.plan, history: undefined };
	}
	beginHistoryReplay(): void {
		this.replays++;
		this.onReplay?.();
	}
	beginHistoryFlush(): void {
		this.flushes++;
		this.onFlush?.();
	}
}

const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
	for (const key of [
		"PI_NO_SYNC_OUTPUT",
		"PI_TUI_SYNC_OUTPUT",
		"PI_TUI_RESIZE_IN_PLACE",
		"TERM_FEATURES",
		"TMUX",
		"STY",
		"HERDR_ENV",
	]) {
		savedEnv.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	Bun.env.PI_NO_SYNC_OUTPUT = "1";
	Bun.env.TERM = "xterm-256color";
});
afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	savedEnv.clear();
});

function makeTui(
	rows = 6,
	onPaint?: (paint: TuiPaint) => void,
): {
	terminal: FakeTerminal;
	scheduler: Scheduler;
	provider: Provider;
	tui: TUI;
} {
	const terminal = new FakeTerminal(40, rows);
	const scheduler = new Scheduler();
	const provider = new Provider();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler, onPaint });
	tui.setFrameProvider(provider);
	return { terminal, scheduler, provider, tui };
}

function countRow(rows: readonly string[], value: string): number {
	return rows.filter(row => row === value).length;
}

test("writes ordered history once and acknowledges only after the physical write", () => {
	const { terminal, scheduler, provider, tui } = makeTui();
	provider.plan = { viewport: ["live"], viewportAnchor: "bottom" };
	let writesAtAck = 0;
	provider.onAck = () => {
		writesAtAck = terminal.writes.length;
	};
	tui.start({ deferInput: true });
	scheduler.flush();

	provider.plan = { history: { id: 1, rows: ["h1", "h2"] }, viewport: ["live"], viewportAnchor: "bottom" };
	const writesBefore = terminal.writes.length;
	tui.requestRender();
	scheduler.flush();
	expect(provider.acks).toEqual([1]);
	expect(writesAtAck).toBeGreaterThan(writesBefore);

	// A stale re-offer cannot duplicate bytes or receive a second acknowledgement.
	provider.plan = { history: { id: 1, rows: ["h1", "h2"] }, viewport: ["live"], viewportAnchor: "bottom" };
	tui.requestRender();
	scheduler.flush();
	provider.plan = { history: { id: 2, rows: ["h3"] }, viewport: ["live"], viewportAnchor: "bottom" };
	tui.requestRender();
	scheduler.flush();
	expect(provider.acks).toEqual([1, 2]);
	const rows = terminal.allNormalRows();
	expect(countRow(rows, "h1")).toBe(1);
	expect(countRow(rows, "h2")).toBe(1);
	expect(countRow(rows, "h3")).toBe(1);
	tui.stop();
});

test("a frame that scrolls committed history keeps it when the host grew before the write landed", () => {
	const { terminal, scheduler, provider, tui } = makeTui();
	provider.plan = { history: { id: 1, rows: ["h1", "h2", "h3"] }, viewport: ["v1"], viewportAnchor: "bottom" };
	tui.start({ deferInput: true });
	scheduler.flush();

	// The pane grows, but the next frame is already computed for the old height.
	terminal.resize(40, 9);
	terminal.rows = 6;
	provider.plan = { viewport: ["v1", "v2", "v3"], viewportAnchor: "bottom" };
	tui.requestRender();
	scheduler.flush();

	const rows = terminal.allNormalRows();
	for (const row of ["h1", "h2", "h3", "v1", "v2", "v3"]) expect(countRow(rows, row), row).toBe(1);
	expect(rows.indexOf("h3")).toBeLessThan(rows.indexOf("v1"));
	tui.stop();
});

test("bottom anchored viewport grows and shrinks without archiving stale mutable rows", () => {
	const { terminal, scheduler, provider, tui } = makeTui();
	provider.plan = { history: { id: 1, rows: ["history"] }, viewport: ["old-a", "old-b"], viewportAnchor: "bottom" };
	tui.start({ deferInput: true });
	scheduler.flush();

	provider.plan = { viewport: ["grow-a", "grow-b", "grow-c", "grow-d"], viewportAnchor: "bottom" };
	tui.requestRender();
	scheduler.flush();
	expect(terminal.screenRows().slice(-4)).toEqual(["grow-a", "grow-b", "grow-c", "grow-d"]);
	expect(terminal.allNormalRows().some(row => row === "old-a" || row === "old-b")).toBe(false);

	provider.plan = { viewport: ["small"], viewportAnchor: "bottom" };
	tui.requestRender();
	scheduler.flush();
	expect(terminal.screenRows().at(-1)).toBe("small");
	expect(terminal.screenRows().some(row => row.startsWith("grow-"))).toBe(false);
	expect(countRow(terminal.allNormalRows(), "history")).toBe(1);

	// Retirement fills the blank space created by the shrink before it scrolls
	// retained visible history away.
	provider.plan = {
		history: { id: 2, rows: ["new-history-1", "new-history-2"] },
		viewport: ["small"],
		viewportAnchor: "bottom",
	};
	tui.requestRender();
	scheduler.flush();
	expect(terminal.screenRows()).toContain("history");
	expect(terminal.screenRows().slice(-3)).toEqual(["new-history-1", "new-history-2", "small"]);
	tui.stop();
});

test("large retired tool tails and interruption markers survive growing chrome and the next turn", () => {
	const { terminal, scheduler, provider, tui } = makeTui(10);
	const chrome = Array.from({ length: 8 }, (_, index) => `chrome-${index}`);
	const toolRows = [...Array.from({ length: 30 }, (_, index) => `tool-${index}`), "tool final wrapped tail", ""];
	provider.plan = { history: { id: 1, rows: toolRows }, viewport: chrome, viewportAnchor: "bottom" };
	tui.start({ deferInput: true });
	scheduler.flush();
	try {
		for (let height = 9; height <= 10; height++) {
			provider.plan = {
				viewport: Array.from({ length: height }, (_, index) => `working-${index}`),
				viewportAnchor: "bottom",
			};
			tui.requestRender();
			scheduler.flush();
		}
		expect(countRow(terminal.allNormalRows(), "tool final wrapped tail")).toBe(1);
		provider.plan = {
			history: { id: 2, rows: ["cancelled streamed text", "", "∎ Interrupted", ""] },
			viewport: chrome,
			viewportAnchor: "bottom",
		};
		tui.requestRender();
		scheduler.flush();
		provider.plan = {
			history: { id: 3, rows: ["next user turn", ""] },
			viewport: ["next answer", ...chrome],
			viewportAnchor: "bottom",
		};
		tui.requestRender();
		scheduler.flush();
		const tape = terminal.allNormalRows();
		for (const row of [...toolRows.filter(Boolean), "cancelled streamed text", "∎ Interrupted", "next user turn"]) {
			expect(countRow(tape, row)).toBe(1);
		}
		expect(provider.acks).toEqual([1, 2, 3]);
		expect(tape.some(row => row.startsWith("working-"))).toBe(false);
	} finally {
		tui.stop();
	}
});

test("fullscreen overlays defer provider history and restore the normal buffer", () => {
	const { terminal, scheduler, provider, tui } = makeTui();
	provider.plan = { viewport: ["normal"], viewportAnchor: "bottom" };
	tui.start({ deferInput: true });
	scheduler.flush();
	const overlay: Component = { render: () => ["modal"] };
	const handle = tui.showOverlay(overlay, { fullscreen: true });
	scheduler.flush();

	provider.plan = { history: { id: 1, rows: ["retired"] }, viewport: ["normal-2"], viewportAnchor: "bottom" };
	tui.requestRender();
	scheduler.flush();
	expect(provider.acks).toEqual([]);
	expect(terminal.writes.join("")).toContain("\x1b[?1049h");
	handle.hide();
	scheduler.flush();
	expect(provider.acks).toEqual([1]);
	expect(terminal.writes.join("")).toContain("\x1b[?1049l");
	expect(terminal.screenRows().at(-1)).toBe("normal-2");
	expect(countRow(terminal.allNormalRows(), "retired")).toBe(1);
	tui.stop();
});

test("resize reanchors and repaints only the mutable viewport without replaying history", () => {
	Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
	const { terminal, scheduler, provider, tui } = makeTui(6);
	provider.plan = {
		history: { id: 1, rows: ["keep-1", "keep-2"] },
		viewport: ["live-a", "live-b"],
		viewportAnchor: "bottom",
	};
	tui.start({ deferInput: true });
	scheduler.flush();
	terminal.writes.length = 0;

	terminal.resize(32, 8);
	terminal.triggerResize();
	scheduler.flush();
	expect(provider.replays).toBe(0);
	expect(terminal.writes.join("")).not.toContain("\x1b[3J");
	expect(terminal.screenRows().slice(-2)).toEqual(["live-a", "live-b"]);
	expect(countRow(terminal.allNormalRows(), "keep-1")).toBe(1);
	expect(countRow(terminal.allNormalRows(), "keep-2")).toBe(1);
	tui.stop();
});

test("explicit replay clears and bottom-splits history atomically", () => {
	const paints: TuiPaint[] = [];
	const { terminal, scheduler, provider, tui } = makeTui(4, paint => paints.push(paint));
	provider.plan = { history: { id: 1, rows: ["old"] }, viewport: ["old-live"], viewportAnchor: "bottom" };
	tui.start({ deferInput: true });
	scheduler.flush();
	provider.onReplay = () => {
		provider.plan = {
			history: { id: 2, kind: "replay", rows: ["r1", "r2", "r3", "r4", "r5"] },
			viewport: ["new-live"],
			viewportAnchor: "bottom",
		};
	};
	terminal.writes.length = 0;
	tui.resetDisplay();
	scheduler.flush();

	expect(provider.replays).toBe(1);
	expect(provider.acks).toEqual([1, 2]);
	const replayWrite = terminal.writes.find(write => write.includes("\x1b[3J"));
	expect(replayWrite).toBeDefined();
	for (const row of ["r1", "r2", "r3", "r4", "r5", "new-live"]) expect(replayWrite).toContain(row);
	expect(terminal.screenRows()).toEqual(["r3", "r4", "r5", "new-live"]);
	expect(paints.at(-1)).toMatchObject({
		reset: true,
		history: ["r1", "r2"],
		viewport: ["r3", "r4", "r5", "new-live"],
	});
	tui.stop();
});

test("output backlog defers history and stop flushes the final eligible batch", () => {
	const { terminal, scheduler, provider, tui } = makeTui();
	provider.plan = { viewport: ["live"], viewportAnchor: "bottom" };
	tui.start({ deferInput: true });
	scheduler.flush();
	terminal.writes.length = 0;
	provider.plan = { history: { id: 1, rows: ["deferred"] }, viewport: ["live"], viewportAnchor: "bottom" };
	terminal.pendingOutputBytes = 300_000;
	tui.requestRender();
	scheduler.flushOne();
	expect(provider.acks).toEqual([]);
	expect(terminal.writes).toEqual([]);
	terminal.pendingOutputBytes = 0;
	scheduler.flush();
	expect(provider.acks).toEqual([1]);

	provider.onFlush = () => {
		provider.plan = { history: { id: 2, rows: ["at-shutdown"] }, viewport: ["live"], viewportAnchor: "bottom" };
	};
	tui.stop();
	expect(provider.flushes).toBe(1);
	expect(provider.acks).toEqual([1, 2]);
	expect(terminal.stopped).toBe(true);
	expect(countRow(terminal.allNormalRows(), "at-shutdown")).toBe(1);
});

for (const [columns, rows] of [
	[2, 1],
	[3, 2],
	[20, 6],
	[240, 80],
]) {
	test(`stream growth/shrink and overlays preserve history at ${columns}x${rows}`, () => {
		const { terminal, scheduler, provider, tui } = makeTui(rows);
		terminal.resize(columns!, rows!);
		const expected: string[] = [];
		try {
			tui.start({ deferInput: true });
			scheduler.flush();
			for (let tick = 1; tick <= 80; tick++) {
				const history = String.fromCharCode(0x4e00 + tick);
				expected.push(history);
				const viewport = Array.from({ length: tick % (rows! + 1) }, () => "\x1b[31mL\x1b[0m");
				provider.plan = { history: { id: tick, rows: [history] }, viewport, viewportAnchor: "bottom" };
				const overlay = tick % 9 === 0 ? tui.showOverlay({ render: () => ["M"] }, { fullscreen: true }) : undefined;
				tui.requestRender();
				scheduler.flush();
				if (overlay) {
					expect(provider.acks.length).toBe(tick - 1);
					overlay.hide();
					scheduler.flush();
				}
				expect(terminal.allNormalRows().filter(row => /[\u4e00-\u4eff]/u.test(row))).toEqual(expected);
				expect(terminal.allNormalRows().slice(0, terminal.vt.buffer.normal.baseY)).not.toContain("L");
				if (viewport.length > 0) {
					expect(terminal.screenRows().slice(-viewport.length)).toEqual(viewport.map(() => "L"));
				}
				terminal.writes.length = 0;
			}
			expect(provider.acks).toEqual(Array.from({ length: 80 }, (_, index) => index + 1));
		} finally {
			tui.stop();
			terminal.vt.dispose();
		}
	});
}
