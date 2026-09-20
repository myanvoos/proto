import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { TerminalCursorPosition } from "./terminal";
import { CURSOR_MARKER, TUI } from "./tui";

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
		return {
			cancel: () => {
				entry.cancelled = true;
			},
		};
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

/** Prose whose logical row boundaries differ from the terminal's hard reflow. */
class WrappedProse {
	text = PARAGRAPH;
	constructor(private readonly terminal: FakeTerminal) {}
	render(): readonly string[] {
		return wrap(this.text, this.terminal.columns);
	}
}

function setResizeEnvironment(inPlace: boolean): () => void {
	const keys = ["TMUX", "STY", "ZELLIJ", "HERDR_ENV", "PI_TUI_RESIZE_IN_PLACE", "TERM"] as const;
	const previous = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
	for (const key of keys) delete Bun.env[key];
	Bun.env.TERM = "xterm-256color";
	if (inPlace) Bun.env.TMUX = "1";
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
	inPlace: boolean;
	cursorProbe: boolean;
	initial: ResizeStep;
	steps: readonly ResizeStep[];
	rapid?: boolean;
}): Promise<void> {
	const restore = setResizeEnvironment(options.inPlace);
	const terminal = new FakeTerminal(options.initial[0], options.initial[1], options.cursorProbe);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.addChild(new WrappedProse(terminal) as never);

	try {
		tui.start({ deferInput: true });
		await scheduler.flush();
		expect(tui.committedRows).toBeGreaterThan(0);
		const redraws = tui.fullRedraws;
		const viewportPaints = tui.resizeViewportPaints;
		const writes = terminal.writes.length;

		let hostReflow: string[] = [];
		for (const [columns, rows] of options.steps) {
			terminal.resize(columns, rows);
			hostReflow = terminal.normalLines();
			terminal.triggerResize();
			if (!options.rapid) {
				await scheduler.flush();
				expect(terminal.normalLines()).toEqual(hostReflow);
			}
		}
		if (options.rapid) await scheduler.flush();
		tui.requestRender(true);
		await scheduler.flush();

		// Observable contract: a width resize may not add, erase, or replay any
		// native-buffer row. The buffer after the renderer settles is exactly the
		// host's own reflow, including scrollback.
		expect(terminal.normalLines()).toEqual(hostReflow);
		expect(tui.committedRows).toBe(Math.max(0, wrap(PARAGRAPH, terminal.columns).length - terminal.rows));
		expect(terminal.writes.length, "no welcome/full-frame replay").toBe(writes);
		expect(tui.fullRedraws, "no spurious full repaint").toBe(redraws);
		expect(tui.resizeViewportPaints, "width resize bypasses the plain viewport painter").toBe(viewportPaints);
		expect(scheduler.delayedCallbacksRun).toBeGreaterThan(0);
		expect(terminal.cursorQueries).toBe(options.cursorProbe ? options.steps.length : 0);
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

for (const inPlace of [false, true]) {
	for (const resizeCase of cases) {
		test(`${inPlace ? "in-place" : "plain"} ${resizeCase.name} preserves host-reflowed scrollback`, async () => {
			await verifyResizeSequence({
				inPlace,
				cursorProbe: true,
				initial: resizeCase.initial,
				steps: resizeCase.steps,
				rapid: resizeCase.rapid,
			});
		});
	}

	test(`${inPlace ? "in-place" : "plain"} width resize without a cursor probe never guesses an alignment`, async () => {
		await verifyResizeSequence({ inPlace, cursorProbe: false, initial: [100, 6], steps: [[54, 10]] });
	});
}

for (const inPlace of [false, true]) {
	test(`${inPlace ? "in-place" : "plain"} closed width epoch resumes with new tail rows only`, async () => {
		const restore = setResizeEnvironment(inPlace);
		const terminal = new FakeTerminal(100, 6, true);
		const scheduler = new TestScheduler();
		const tui = new TUI(terminal, false, { renderScheduler: scheduler });
		const prose = new WrappedProse(terminal);
		tui.addChild(prose as never);
		try {
			tui.start({ deferInput: true });
			await scheduler.flush();
			terminal.resize(54, 10);
			terminal.triggerResize();
			await scheduler.flush();

			const sentinel = "exact function I rewrote status bar git branch context";
			expect(terminal.normalLines().filter(line => line === sentinel)).toHaveLength(1);
			prose.text += " unique-after-resize alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
			tui.requestRender(true);
			await scheduler.flush();

			const afterAppend = terminal.normalLines();
			expect(
				afterAppend.filter(line => line === sentinel),
				"closed rows are never replayed",
			).toHaveLength(1);
			expect(afterAppend.join(" ")).toContain("unique-after-resize");
		} finally {
			tui.stop();
			restore();
		}
	});
}

/** Composer-style live region: hairline, prompt, status line — width-dependent rows the host cannot reflow. */
class LiveFooter {
	prompt = "› ask anything";
	constructor(private readonly terminal: FakeTerminal) {}
	render(): readonly string[] {
		const promptRows = wrap(this.prompt, this.terminal.columns);
		promptRows[promptRows.length - 1] += CURSOR_MARKER;
		return ["─".repeat(this.terminal.columns), "", ...promptRows, "", "▫ workspace · main · 97% left"];
	}
	getNativeScrollbackLiveRegionStart(): number {
		return 0;
	}
}

test("in-place shrink repaints the live region at the new width and keeps it on screen", async () => {
	const restore = setResizeEnvironment(true);
	const terminal = new FakeTerminal(120, 40, true);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const footer = new LiveFooter(terminal);
	tui.addChild(new WrappedProse(terminal) as never);
	tui.addChild(footer as never);
	const screen = (): string[] => terminal.normalLines().slice(-terminal.rows);
	try {
		tui.start({ deferInput: true });
		await scheduler.flush();
		terminal.resize(80, 24);
		terminal.triggerResize();
		await scheduler.flush();

		// The host wrapped the 120-wide hairline into two rows; the settled
		// screen shows exactly the composed footer at 80 columns instead.
		const footerRows = screen()
			.filter(line => line.length > 0)
			.slice(-3);
		expect(footerRows).toEqual(["─".repeat(80), "› ask anything", "▫ workspace · main · 97% left"]);
		expect(screen().filter(line => line === "─".repeat(40))).toHaveLength(0);

		// Grow, height-only shrink and another width shrink must preserve the
		// live tail too. Input always lands on the repainted prompt row.
		for (const [columns, rows] of [
			[120, 40],
			[120, 24],
			[60, 20],
		] as const) {
			terminal.resize(columns, rows);
			terminal.triggerResize();
			await scheduler.flush();
			expect(
				screen()
					.filter(line => line.length > 0)
					.slice(-3),
			).toEqual(["─".repeat(columns), footer.prompt, "▫ workspace · main · 97% left"]);
			footer.prompt = `› typed at ${columns}x${rows}`;
			tui.invalidate();
			tui.requestRender();
			await scheduler.flush();
			expect(screen().filter(line => line.startsWith("›"))).toEqual([footer.prompt]);
		}
	} finally {
		tui.stop();
		restore();
	}
});

test("a wrapped draft keeps exactly one separator after shrinking and growing", async () => {
	const restore = setResizeEnvironment(true);
	const terminal = new FakeTerminal(120, 40, true);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const footer = new LiveFooter(terminal);
	footer.prompt =
		"› alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
	tui.addChild({ render: () => Array.from({ length: 50 }, (_v, row) => `history-${row}`) });
	tui.addChild(footer as never);
	try {
		tui.start({ deferInput: true });
		await scheduler.flush();
		for (const [columns, rows] of [
			[60, 20],
			[120, 40],
		] as const) {
			terminal.resize(columns, rows);
			const hostRows = terminal.normalLines();
			const hostHistory = hostRows.slice(
				0,
				hostRows.findIndex(line => /^─+$/.test(line)),
			);
			terminal.triggerResize();
			await scheduler.flush();
			const allRows = terminal.normalLines();
			expect(
				allRows.slice(
					0,
					allRows.findIndex(line => /^─+$/.test(line)),
				),
			).toEqual(hostHistory);
			const screen = allRows.slice(-rows);
			expect(screen.filter(line => /^─+$/.test(line))).toEqual(["─".repeat(columns)]);
			expect(screen.slice(screen.indexOf("─".repeat(columns)) + 1).filter(line => line.length > 0)).toEqual([
				...wrap(footer.prompt, columns),
				"▫ workspace · main · 97% left",
			]);
		}
	} finally {
		tui.stop();
		restore();
	}
});
