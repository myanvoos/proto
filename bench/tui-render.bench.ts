/**
 * TUI differential-render hot path: full frame compose + emit for
 * streaming-shaped updates, explicit history transactions, nested Container
 * re-flattening, bounded viewports, and ScrollView setLines/render.
 *
 * Each `run` is exactly one frame (or one setLines+render), so the reported
 * median is ms/frame and opsPerSec is frames/sec for that case.
 */

import { ScrollView } from "../packages/tui/src/components/scroll-view";
import {
	type Component,
	Container,
	type HistoryBatch,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "../packages/tui/src/tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../packages/tui/src/utils";
import { Terminal as VTermTerminal } from "../packages/utils/src/vterm";
import { formatArtifact, labelFromArgv, runSuite } from "./harness";

const WIDTH = 100;
const HEIGHT = 30;
const LIVE_ROWS = 60; // live region overflows the 30-row viewport -> clip engages every frame

class BenchTerminal {
	columns = WIDTH;
	rows = HEIGHT;
	writes: string[] = [];
	constructor(width: number, height: number) {
		this.columns = width;
		this.rows = height;
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
	enableInput(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
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
}

/**
 * Deferred scheduler: callbacks queue and run when `flushSchedules()` drains
 * them, so a synchronous callback never re-enters the scheduling call that
 * spawned it (the TUI assigns its timer handle from scheduleRender's return).
 */
const scheduled: (() => void)[] = [];
const immediateScheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void): void {
		scheduled.push(callback);
	},
	scheduleRender(callback: () => void): { cancel(): void } {
		scheduled.push(callback);
		return { cancel: () => {} };
	},
};

function flushSchedules(): void {
	while (scheduled.length > 0) scheduled.shift()!();
}

/** Deterministic pseudo-random transcript-like rows (mixed widths, some SGR). */
function buildRows(count: number): string[] {
	const rows: string[] = [];
	let seed = 0x9e3779b9;
	const next = (): number => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed;
	};
	for (let i = 0; i < count; i++) {
		const kind = next() % 4;
		const words = 3 + (next() % 12);
		let text = `row ${i}:`;
		for (let w = 0; w < words; w++) text += ` word${next() % 997}`;
		if (kind === 0) rows.push(text);
		else if (kind === 1) rows.push(`\x1b[32m${text}\x1b[0m`);
		else if (kind === 2) rows.push(`  ${text}`);
		else rows.push(text.slice(0, 40));
	}
	return rows;
}

/** Streaming provider: stable rows retire once, while the live tail remains viewport-only. */
class StreamingFrameProvider implements TerminalFrameProvider {
	#rows: string[];
	#liveRows: number;
	#frame = 0;
	#pending: HistoryBatch | undefined;
	#extra: Component | undefined;

	constructor(rows: string[], liveRows: number, extra?: Component) {
		this.#rows = rows;
		this.#liveRows = liveRows;
		this.#extra = extra;
		const stableTo = Math.max(0, rows.length - Math.max(1, liveRows));
		if (stableTo > 0) this.#pending = { id: 1, rows: rows.slice(0, stableTo) };
	}

	renderFrame(size: ViewportSize): { history?: HistoryBatch; viewport: readonly string[] } {
		const transcript = this.#rows.slice();
		transcript[transcript.length - 1] = `live frame ${this.#frame++} ${".".repeat(30)}`;
		const extra = this.#extra?.render(size.columns) ?? [];
		const composed = [
			...transcript.slice(-Math.max(1, this.#liveRows)),
			"$",
			"editor alpha",
			"editor beta",
			...extra,
		];
		return { history: this.#pending, viewport: composed.slice(-size.rows) };
	}

	acknowledgeHistory(id: number): void {
		if (this.#pending?.id === id) this.#pending = undefined;
	}
}

class StaticBlock implements Component {
	#lines: readonly string[];
	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}
	render(_width: number): readonly string[] {
		return this.#lines;
	}
}

interface TuiFixture {
	terminal: BenchTerminal;
	tui: TUI;
}

function buildTui(rowCount: number, liveRows: number, extra?: Component, width = WIDTH, height = HEIGHT): TuiFixture {
	const terminal = new BenchTerminal(width, height);
	const tui = new TUI(terminal, false, { renderScheduler: immediateScheduler });
	tui.setFrameProvider(new StreamingFrameProvider(buildRows(rowCount), liveRows, extra));
	tui.start({ deferInput: true });
	flushSchedules();
	terminal.writes.length = 0;
	return { terminal, tui };
}

function frame(fixture: TuiFixture): void {
	fixture.tui.requestRender();
	flushSchedules();
	fixture.terminal.writes.length = 0;
}

/** One child of the nested container re-renders per frame (streaming block). */
class MutatingBlock implements Component {
	#rows: string[];
	#frame = 0;
	constructor(rowCount: number) {
		this.#rows = Array.from({ length: rowCount }, (_value, index) => `block row ${index} ${"y".repeat(24)}`);
	}
	render(_width: number): readonly string[] {
		const lines = this.#rows.slice();
		lines[lines.length - 1] = `block frame ${this.#frame++}`;
		return lines;
	}
}

function buildContainerTui(childCount: number): TuiFixture {
	const container = new Container();
	const changing = childCount >> 1;
	for (let i = 0; i < childCount; i++) {
		container.addChild(i === changing ? new MutatingBlock(12) : new StaticBlock(buildRows(12)));
	}
	return buildTui(12, 0, container);
}

interface ScrollViewFixture {
	view: ScrollView;
	lines: string[];
	tick: number;
}

function buildScrollView(lineCount: number): ScrollViewFixture {
	const lines = buildRows(lineCount);
	const view = new ScrollView(lines, { height: HEIGHT });
	view.setScrollOffset(Math.max(0, lineCount - 100));
	return { lines, tick: 0, view };
}

function scrollTick(fixture: ScrollViewFixture): void {
	const lines = fixture.lines.slice();
	lines[lines.length - 1] = `tail ${fixture.tick++}`;
	fixture.view.setLines(lines);
	fixture.view.render(WIDTH);
}

const scrollCases = [1_000, 10_000, 50_000].map(lineCount => ({
	name: `scrollview-${lineCount}`,
	setup: () => buildScrollView(lineCount),
	run: (fixture: ScrollViewFixture) => scrollTick(fixture),
}));

const tuiCases = [1_000, 10_000, 50_000].flatMap(rowCount => [
	{
		name: `stream-${rowCount}`,
		setup: () => buildTui(rowCount, 0),
		run: (fixture: TuiFixture) => frame(fixture),
	},
	{
		name: `clip-${rowCount}`,
		setup: () => buildTui(rowCount, LIVE_ROWS),
		run: (fixture: TuiFixture) => frame(fixture),
	},
]);

const containerCases = [8, 64, 256].map(childCount => ({
	name: `container-${childCount}`,
	setup: () => buildContainerTui(childCount),
	run: (fixture: TuiFixture) => frame(fixture),
}));

const geometryCases = [
	[2, 1],
	[20, 6],
	[240, 100],
].map(([width, height]) => ({
	name: `geometry-${width}x${height}`,
	setup: () => buildTui(1_000, LIVE_ROWS, undefined, width, height),
	run: (fixture: TuiFixture) => frame(fixture),
}));

// Exercise the same parser/reflow surface used by TUI regression fixtures, not
// just a write sink. Retention is bounded even as the producer keeps appending.
const reflowCases = [500, 5_000].map(scrollback => ({
	name: `vterm-reflow-${scrollback}`,
	setup: () => {
		const terminal = new VTermTerminal({ cols: 80, rows: 24, scrollback });
		terminal.write(Array.from({ length: scrollback }, (_, row) => `row-${row} 界`).join("\r\n"));
		return terminal;
	},
	run: (terminal: VTermTerminal) => {
		terminal.write("\r\nstream 界");
		for (const [width, height] of [
			[12, 1],
			[240, 100],
			[80, 24],
		])
			terminal.resize(width!, height!);
	},
}));

// bun bench/tui-render.bench.ts --stress: fixed-capacity terminal plus cache
// churn, with post-GC measurements rather than a flaky heap-size test threshold.
function stressMemory(): void {
	const terminal = new VTermTerminal({ cols: 80, rows: 24, scrollback: 500 });
	try {
		for (let epoch = 0; epoch < 6; epoch++) {
			const start = performance.now();
			for (let n = 0; n < 10_000; n++) {
				const id = epoch * 10_000 + n;
				const text = `\x1b[32mrow-${id} 界 é 👩‍💻 ${"text ".repeat(40)}\x1b[0m`;
				terminal.write(`row-${id} 界\r\n`);
				wrapTextWithAnsi(text, 2 + (id % 239));
				truncateToWidth(text, 2 + (id % 239));
				visibleWidth(`界-${id}`);
				if (n % 1_000 === 999) {
					for (const [width, height] of [
						[12, 1],
						[240, 100],
						[80, 24],
					])
						terminal.resize(width!, height!);
					if (terminal.buffer.normal.length > 524) throw new Error("scrollback exceeded retention limit");
				}
			}
			Bun.gc(true);
			console.log(
				JSON.stringify({
					epoch,
					rows: terminal.buffer.normal.length,
					heapMiB: process.memoryUsage().heapUsed / 1_048_576,
					rssMiB: process.memoryUsage().rss / 1_048_576,
					milliseconds: performance.now() - start,
				}),
			);
		}
	} finally {
		terminal.dispose();
	}
}

if (Bun.argv.includes("--stress")) {
	stressMemory();
} else {
	const artifact = await runSuite(
		"tui-render",
		[...tuiCases, ...containerCases, ...scrollCases, ...geometryCases, ...reflowCases],
		{ label: labelFromArgv() },
	);
	console.log(formatArtifact(artifact));
}
