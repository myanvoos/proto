/**
 * TUI differential-render hot path: full frame compose + emit for
 * streaming-shaped updates, nested Container re-flattening, clipped live
 * regions, and ScrollView setLines/render.
 *
 * Each `run` is exactly one frame (or one setLines+render), so the reported
 * median is ms/frame and opsPerSec is frames/sec for that case.
 */
import { ScrollView } from "../packages/tui/src/components/scroll-view";
import { type Component, Container, TUI } from "../packages/tui/src/tui";
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

/**
 * Transcript-like leaf: every render returns a fresh array whose live tail row
 * is rewritten (the streaming shape — callers rebuild their line array per
 * update while most strings keep identity). With liveRows > 0 the component
 * reports a pinned live region that overflows the viewport, engaging the
 * native-scrollback clip path every frame.
 */
class StreamingTranscript implements Component {
	#rows: string[];
	#liveRows: number;
	#frame = 0;
	constructor(rows: string[], liveRows: number) {
		this.#rows = rows;
		this.#liveRows = liveRows;
	}

	render(_width: number): readonly string[] {
		const lines = this.#rows.slice();
		lines[lines.length - 1] = `live frame ${this.#frame++} ${".".repeat(30)}`;
		return lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#liveRows > 0 ? this.#rows.length - this.#liveRows : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.#liveRows > 0;
	}

	getNativeScrollbackLiveRegionPinnedStart(): number | undefined {
		return this.#liveRows > 0 ? this.#rows.length - this.#liveRows : undefined;
	}

	clipsNativeScrollbackLiveRegion(): boolean {
		return this.#liveRows > 0;
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

function buildTui(rowCount: number, liveRows: number, extra?: (tui: TUI) => void): TuiFixture {
	const terminal = new BenchTerminal(WIDTH, HEIGHT);
	const tui = new TUI(terminal, false, { renderScheduler: immediateScheduler });
	tui.addChild(new StreamingTranscript(buildRows(rowCount), liveRows));
	tui.addChild(new StaticBlock(["$", "editor alpha", "editor beta"]));
	extra?.(tui);
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
	return buildTui(12, 0, tui => {
		const container = new Container();
		const changing = childCount >> 1;
		for (let i = 0; i < childCount; i++) {
			container.addChild(i === changing ? new MutatingBlock(12) : new StaticBlock(buildRows(12)));
		}
		tui.addChild(container);
	});
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

const artifact = await runSuite("tui-render", [...tuiCases, ...containerCases, ...scrollCases], {
	label: labelFromArgv(),
});
console.log(formatArtifact(artifact));
