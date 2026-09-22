import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { TerminalCursorPosition } from "./terminal";
import {
	CURSOR_MARKER,
	type HistoryBatch,
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
	cursorQueries = 0;
	readonly vt: VTermTerminal;
	queryCursorPosition?: () => Promise<TerminalCursorPosition | undefined>;
	#resizeCallback: (() => void) | undefined;
	constructor(columns: number, rows: number, cursorProbe: boolean) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 500 });
		if (cursorProbe) {
			this.queryCursorPosition = () => {
				this.cursorQueries++;
				const buffer = this.vt.buffer.normal;
				return Promise.resolve({ row: buffer.cursorY, col: buffer.cursorX });
			};
		}
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
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
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
		return this.normalLines().slice(-this.rows);
	}
}

class TestScheduler {
	#pending: Array<{ callback: () => void; cancelled: boolean; at: number }> = [];
	#now = 100;
	delayedCallbacksRun = 0;
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
			if (!entry.cancelled) {
				this.delayedCallbacksRun++;
				entry.callback();
			}
		}
	}
}

const PARAGRAPH =
	"Confirmed live the TUI paints correctly and the welcome line is rendered by getRecentSessions " +
	"the exact function I rewrote status bar git branch context percent MCP connect xdev mounts and " +
	"composer input all render honest limit I could not submit a slash command through the pty " +
	"because synthetic carriage returns do not reach the raw mode key handler the way a real " +
	"terminal sends them so the session picker never opened interactively that is a limitation " +
	"of the harness and not evidence about the product the picker path is covered instead by the " +
	"four hundred thirty two session field by field equivalence proof and the session tests";

function wrap(text: string, width: number): string[] {
	const words = text.split(" ");
	const out: string[] = [];
	let line = "";
	for (const word of words) {
		if (line.length === 0) line = word;
		else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
		else {
			out.push(line);
			line = word;
		}
	}
	if (line.length > 0) out.push(line);
	return out;
}

class ProseFrameProvider implements TerminalFrameProvider {
	text = PARAGRAPH;
	readonly acknowledgements: number[] = [];
	#pending: HistoryBatch[] = [];
	#initialized = false;
	#nextId = 1;
	renderFrame(size: ViewportSize): TerminalFramePlan {
		const rows = wrap(this.text, size.columns);
		if (!this.#initialized) {
			this.#initialized = true;
			const history = rows.slice(0, Math.max(0, rows.length - size.rows));
			if (history.length > 0) this.#pending.push({ id: this.#nextId++, rows: history });
		}
		return { history: this.#pending[0], viewport: rows.slice(-size.rows), viewportAnchor: "bottom" };
	}
	renderResizeFrame(size: ViewportSize): readonly string[] {
		return wrap(this.text, size.columns);
	}
	acknowledgeHistory(id: number): void {
		this.acknowledgements.push(id);
		if (this.#pending[0]?.id === id) this.#pending.shift();
	}
	appendHistory(rows: readonly string[]): void {
		this.#pending.push({ id: this.#nextId++, rows: [...rows] });
	}
}

class FooterFrameProvider implements TerminalFrameProvider {
	prompt = "› ask anything";
	readonly acknowledgements: number[] = [];
	#history: HistoryBatch | undefined;
	constructor(history: readonly string[]) {
		if (history.length > 0) this.#history = { id: 1, rows: [...history] };
	}
	#footer(size: ViewportSize): string[] {
		const promptRows = wrap(this.prompt, size.columns);
		promptRows[promptRows.length - 1] += CURSOR_MARKER;
		return ["─".repeat(size.columns), "", ...promptRows, "", "▫ workspace · main · 97% left"];
	}
	renderFrame(size: ViewportSize): TerminalFramePlan {
		return { history: this.#history, viewport: this.#footer(size).slice(-size.rows), viewportAnchor: "bottom" };
	}
	renderResizeFrame(size: ViewportSize): readonly string[] {
		return this.#footer(size);
	}
	acknowledgeHistory(id: number): void {
		this.acknowledgements.push(id);
		if (this.#history?.id === id) this.#history = undefined;
	}
}

function setResizeEnvironment(inMux: boolean): () => void {
	const keys = ["TMUX", "STY", "ZELLIJ", "HERDR_ENV", "PI_TUI_RESIZE_IN_PLACE", "TERM"] as const;
	const previous = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
	for (const key of keys) delete Bun.env[key];
	Bun.env.TERM = "xterm-256color";
	if (inMux) Bun.env.TMUX = "1";
	return () => {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	};
}

type ResizeStep = readonly [columns: number, rows: number];

async function verifyResizeSequence(options: {
	inMux: boolean;
	cursorProbe: boolean;
	initial: ResizeStep;
	steps: readonly ResizeStep[];
	rapid?: boolean;
}): Promise<void> {
	const restore = setResizeEnvironment(options.inMux);
	const terminal = new FakeTerminal(options.initial[0], options.initial[1], options.cursorProbe);
	const scheduler = new TestScheduler();
	const paints: TuiPaint[] = [];
	const tui = new TUI(terminal, false, { renderScheduler: scheduler, onPaint: paint => paints.push(paint) });
	const provider = new ProseFrameProvider();
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		await scheduler.flush();
		expect(provider.acknowledgements).toEqual([1]);
		terminal.writes.length = 0;
		for (const [columns, rows] of options.steps) {
			terminal.resize(columns, rows);
			terminal.triggerResize();
			if (!options.rapid) await scheduler.flush();
		}
		if (options.rapid) await scheduler.flush();
		tui.requestRender(true);
		await scheduler.flush();

		const tape = terminal.normalLines().join(" ");
		expect(tape.match(/Confirmed live/g)).toHaveLength(1);
		expect(terminal.normalLines().at(-1)).toBe(wrap(PARAGRAPH, terminal.columns).at(-1));
		expect(provider.acknowledgements).toEqual([1]);
		expect(terminal.writes.join(""), "resize preserves native history").not.toContain("\x1b[3J");
		expect(paints.slice(1).every(paint => paint.history.length === 0 && !paint.reset)).toBe(true);
		expect(scheduler.delayedCallbacksRun).toBeGreaterThan(0);
	} finally {
		tui.stop();
		restore();
	}
}

const cases: Array<{ name: string; initial: ResizeStep; steps: ResizeStep[]; rapid?: boolean }> = [
	{ name: "shrink", initial: [100, 6], steps: [[54, 6]] },
	{ name: "grow", initial: [54, 6], steps: [[100, 6]] },
	{ name: "width and height", initial: [100, 6], steps: [[54, 10]] },
	{
		name: "height change after width reflow",
		initial: [100, 6],
		steps: [
			[54, 6],
			[54, 10],
		],
	},
	{
		name: "repeated rapid resizes",
		initial: [100, 6],
		steps: [
			[72, 7],
			[45, 5],
			[100, 6],
		],
		rapid: true,
	},
];

for (const inMux of [false, true]) {
	for (const resizeCase of cases) {
		test(`${inMux ? "mux" : "plain"} ${resizeCase.name} preserves accepted history`, async () => {
			await verifyResizeSequence({
				inMux,
				cursorProbe: true,
				initial: resizeCase.initial,
				steps: resizeCase.steps,
				rapid: resizeCase.rapid,
			});
		});
	}
	test(`${inMux ? "mux" : "plain"} width resize without a cursor probe preserves history`, async () => {
		await verifyResizeSequence({ inMux, cursorProbe: false, initial: [100, 6], steps: [[54, 10]] });
	});
}

for (const inMux of [false, true]) {
	test(`${inMux ? "mux" : "plain"} resize resumes with an explicit new history batch only`, async () => {
		const restore = setResizeEnvironment(inMux);
		const terminal = new FakeTerminal(100, 6, true);
		const scheduler = new TestScheduler();
		const provider = new ProseFrameProvider();
		const tui = new TUI(terminal, false, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		try {
			tui.start({ deferInput: true });
			await scheduler.flush();
			terminal.resize(54, 10);
			terminal.triggerResize();
			await scheduler.flush();
			provider.appendHistory(["unique-after-resize"]);
			tui.requestRender(true);
			await scheduler.flush();
			const tape = terminal.normalLines();
			expect(tape.filter(line => line.includes("Confirmed live"))).toHaveLength(1);
			expect(tape.filter(line => line === "unique-after-resize")).toHaveLength(1);
			expect(provider.acknowledgements).toEqual([1, 2]);
		} finally {
			tui.stop();
			restore();
		}
	});
}

test("mux shrink repaints the provider viewport at the new width and keeps it on screen", async () => {
	const restore = setResizeEnvironment(true);
	const terminal = new FakeTerminal(120, 40, true);
	const scheduler = new TestScheduler();
	const provider = new FooterFrameProvider(Array.from({ length: 50 }, (_value, row) => `history-${row}`));
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		await scheduler.flush();
		for (const [columns, rows] of [
			[80, 24],
			[120, 40],
			[120, 24],
			[60, 20],
		] as const) {
			terminal.resize(columns, rows);
			terminal.triggerResize();
			await scheduler.flush();
			const footerRows = terminal
				.screenRows()
				.filter(line => line.length > 0)
				.slice(-3);
			expect(footerRows).toEqual(["─".repeat(columns), provider.prompt, "▫ workspace · main · 97% left"]);
			provider.prompt = `› typed at ${columns}x${rows}`;
			tui.requestRender();
			await scheduler.flush();
			expect(terminal.screenRows().filter(line => line.startsWith("›"))).toEqual([provider.prompt]);
		}
		expect(provider.acknowledgements).toEqual([1]);
		expect(terminal.normalLines().filter(line => line === "history-0")).toHaveLength(1);
	} finally {
		tui.stop();
		restore();
	}
});

test("a wrapped draft keeps exactly one bottom-anchored separator after shrinking and growing", async () => {
	const restore = setResizeEnvironment(true);
	const terminal = new FakeTerminal(120, 40, true);
	const scheduler = new TestScheduler();
	const provider = new FooterFrameProvider(Array.from({ length: 50 }, (_value, row) => `history-${row}`));
	provider.prompt =
		"› alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	tui.setFrameProvider(provider);
	try {
		tui.start({ deferInput: true });
		await scheduler.flush();
		for (const [columns, rows] of [
			[60, 20],
			[120, 40],
		] as const) {
			terminal.resize(columns, rows);
			terminal.triggerResize();
			await scheduler.flush();
			const screen = terminal.screenRows();
			expect(screen.filter(line => /^─+$/.test(line))).toEqual(["─".repeat(columns)]);
			const separator = screen.indexOf("─".repeat(columns));
			expect(screen.slice(separator + 1).filter(line => line.length > 0)).toEqual([
				...wrap(provider.prompt, columns),
				"▫ workspace · main · 97% left",
			]);
			expect(terminal.normalLines().filter(line => line === "history-0")).toHaveLength(1);
		}
	} finally {
		tui.stop();
		restore();
	}
});
