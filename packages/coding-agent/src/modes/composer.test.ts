import { expect, test } from "bun:test";
import { type Component, type RenderScheduler, type Terminal, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { TranscriptContainer } from "./components/transcript-container";
import { Composer } from "./composer";
import { initThemeSync, theme } from "./theme/theme";

initThemeSync();

class QueuedScheduler implements RenderScheduler {
	readonly #pending: Array<{ callback: () => void; cancelled: boolean }> = [];

	now(): number {
		return 100;
	}

	scheduleImmediate(callback: () => void): void {
		this.#pending.push({ callback, cancelled: false });
	}

	scheduleRender(callback: () => void): { cancel(): void } {
		const entry = { callback, cancelled: false };
		this.#pending.push(entry);
		return { cancel: () => (entry.cancelled = true) };
	}

	flush(): void {
		let iterations = 0;
		while (this.#pending.length > 0) {
			if (++iterations > 10_000) throw new Error("render scheduler did not quiesce");
			const entry = this.#pending.shift()!;
			if (!entry.cancelled) entry.callback();
		}
	}
}

class VTermSink implements Terminal {
	readonly vt: VTermTerminal;
	#onResize: (() => void) | undefined;

	constructor(
		public columns: number,
		public rows: number,
	) {
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 10_000 });
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
	start(_onInput: (data: string) => void, onResize: () => void): void {
		this.#onResize = onResize;
	}
	enableInput(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.vt.write(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
		this.#onResize?.();
	}

	screen(): string[] {
		const lines = this.vt.buffer.normal;
		return Array.from({ length: this.rows }, (_value, row) =>
			stripAnsi(
				lines
					.getLine(lines.baseY + row)
					?.translateToString(true)
					.trimEnd() ?? "",
			),
		);
	}

	tape(): string[] {
		const lines = this.vt.buffer.normal;
		const rows = Array.from({ length: lines.length }, (_value, row) =>
			stripAnsi(lines.getLine(row)?.translateToString(true).trimEnd() ?? ""),
		);
		while (rows.at(-1) === "") rows.pop();
		return rows;
	}
}

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

class WrappingBlock implements Component {
	constructor(readonly source: string) {}
	render(width: number): readonly string[] {
		return wrapTextWithAnsi(this.source, width);
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

/** A live tool-shaped card: tall while it runs, short once it settles. */
class SettlingCard implements Component {
	settled = false;
	constructor(readonly liveRows: number) {}
	render(): readonly string[] {
		return this.settled ? ["settled card"] : Array.from({ length: this.liveRows }, (_v, row) => `live-row-${row}`);
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return this.settled;
	}
}

function stripAnsi(text: string): string {
	return Bun.stripANSI(text);
}

function countContaining(rows: readonly string[], marker: string): number {
	return rows.filter(row => row.includes(marker)).length;
}

function expectTranscriptAbovePrompt(terminal: VTermSink, marker = "transcript-"): void {
	const screen = terminal.screen();
	const hairline = screen.findLastIndex(row => row.length > 0 && row === theme.boxSharp.horizontal.repeat(row.length));
	expect(hairline, "the real composer hairline must be visible").toBeGreaterThanOrEqual(0);
	const contamination = screen.slice(hairline).filter(row => row.includes(marker));
	expect(
		contamination,
		`transcript painted into composer chrome at row ${hairline}: ${JSON.stringify(screen)}`,
	).toEqual([]);
}

function createHarness(
	columns: number,
	rows: number,
	quiet = true,
): {
	composer: Composer;
	terminal: VTermSink;
	scheduler: QueuedScheduler;
	transcript: TranscriptContainer;
} {
	const terminal = new VTermSink(columns, rows);
	const scheduler = new QueuedScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet },
		welcome: quiet
			? undefined
			: { version: "1.2.3", modelName: "opus-5", providerName: "anthropic", recentSessions: [] },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	scheduler.flush();
	return { composer, terminal, scheduler, transcript };
}

function render(composer: Composer, scheduler: QueuedScheduler): void {
	composer.ui.requestRender();
	scheduler.flush();
}

test("reflows an unacknowledged history offer under a new immutable identity", () => {
	const terminal = new VTermSink(72, 12);
	const scheduler = new QueuedScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet: true },
	});
	const transcript = new TranscriptContainer();
	const source =
		"semantic-source alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
	transcript.addChild(new WrappingBlock(source));
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	composer.beginHistoryFlush();
	try {
		const wideOffer = composer.renderFrame({ columns: 72, rows: 12 }).history;
		expect(wideOffer).toBeDefined();
		const wideSnapshot = structuredClone(wideOffer!);

		const narrowOffer = composer.renderFrame({ columns: 24, rows: 12 }).history;
		expect(narrowOffer).toBeDefined();
		expect(narrowOffer).not.toBe(wideOffer);
		expect(narrowOffer!.id).toBeGreaterThan(wideOffer!.id);
		expect(wideOffer, "the withdrawn offer remains byte-for-byte immutable").toEqual(wideSnapshot);
		expect(narrowOffer!.rows).toEqual([...wrapTextWithAnsi(source, 24), ""]);

		composer.acknowledgeHistory(wideOffer!.id);
		expect(composer.renderFrame({ columns: 24, rows: 12 }).history).toBe(narrowOffer);

		composer.acknowledgeHistory(narrowOffer!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(composer.renderFrame({ columns: 24, rows: 12 }).history).toBeUndefined();
		composer.acknowledgeHistory(narrowOffer!.id);
		expect(composer.renderFrame({ columns: 24, rows: 12 }).history).toBeUndefined();
	} finally {
		composer.stop();
	}
});

test("history image admission regenerates a frozen offer before its first write", async () => {
	const source = String.raw`
import { Image, ImageProtocol, setCellDimensions, setKittyGraphics, setTerminalImageProtocol } from "../../../tui/src/index.ts";
import { Composer } from "./composer.ts";
import { TranscriptContainer } from "./components/transcript-container.ts";

setTerminalImageProtocol(ImageProtocol.Kitty);
setKittyGraphics({ unicodePlaceholders: false });
setCellDimensions({ widthPx: 1, heightPx: 1 });
class Queue {
	jobs = [];
	now = () => 100;
	scheduleImmediate(callback) { this.jobs.push({ callback, cancelled: false }); }
	scheduleRender(callback) {
		const job = { callback, cancelled: false };
		this.jobs.push(job);
		return { cancel: () => (job.cancelled = true) };
	}
	flush() {
		let guard = 0;
		while (this.jobs.length) {
			if (++guard > 10000) throw new Error("scheduler did not quiesce");
			const job = this.jobs.shift();
			if (!job.cancelled) job.callback();
		}
	}
}
class Sink {
	columns = 64;
	rows = 12;
	writes = [];
	get pendingOutputBytes() { return 0; }
	get kittyProtocolActive() { return false; }
	get kittyEnableSequence() { return null; }
	get appearance() { return undefined; }
	start() {}
	enableInput() {}
	stop() {}
	async drainInput() {}
	write(data) { this.writes.push(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	onAppearanceChange() {}
}
const terminal = new Sink();
const scheduler = new Queue();
const composer = new Composer({
	terminal,
	tuiOptions: { renderScheduler: scheduler },
	preferences: { quiet: true, maxInlineImages: 1 },
});
const transcript = new TranscriptContainer();
const imageTheme = { fallbackColor: value => value };
const dimensions = { widthPx: 1, heightPx: 1 };
transcript.addChild(new Image("T0xERVI=", "image/png", imageTheme, {
	budget: composer.ui.imageBudget,
	filename: "older.png",
	imageKey: "older",
}, dimensions));
transcript.addChild(new Image("TkVXRVNU", "image/png", imageTheme, {
	budget: composer.ui.imageBudget,
	filename: "newest.png",
	imageKey: "newest",
}, dimensions));
composer.setRuntimeChildren([transcript]);
composer.start({ deferInput: true });
composer.beginHistoryFlush();
composer.ui.requestRender();
scheduler.flush();
composer.stop();
const output = terminal.writes.join("");
console.log(JSON.stringify({
	states: transcript.blockStates(),
	olderFallback: output.includes("[Image: older.png [image/png] 1x1]"),
	newestFallback: output.includes("[Image: newest.png [image/png] 1x1]"),
	olderPayload: output.includes("T0xERVI="),
	newestPayload: output.includes("TkVXRVNU"),
	transmitIds: [...output.matchAll(/a=t,[^\x1b]*i=(\d+)/g)].map(match => Number(match[1])),
}));
`;
	const env: Record<string, string | undefined> = { ...Bun.env, PI_NO_SYNC_OUTPUT: "1" };
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_TUI_SYNC_OUTPUT"]) {
		delete env[key];
	}
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	const result = JSON.parse(stdout) as {
		states: string[];
		olderFallback: boolean;
		newestFallback: boolean;
		olderPayload: boolean;
		newestPayload: boolean;
		transmitIds: number[];
	};
	expect(result.states).toEqual(["committed", "committed"]);
	expect(result.olderFallback).toBe(true);
	expect(result.newestFallback).toBe(false);
	expect(result.olderPayload).toBe(false);
	expect(result.newestPayload).toBe(true);
	expect(new Set(result.transmitIds).size).toBe(1);
});

test("ordinary renders and resizes preserve native history above the actual composer", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(64, 16);
	try {
		for (let block = 0; block < 24; block++) {
			transcript.addChild(new StaticBlock(Array.from({ length: 3 }, (_value, row) => `transcript-${block}-${row}`)));
			render(composer, scheduler);
			expectTranscriptAbovePrompt(terminal);
		}
		const retiredMarker = "transcript-0-0";
		expect(countContaining(terminal.tape(), retiredMarker)).toBe(1);

		for (const [columns, rows] of [
			[48, 11],
			[90, 24],
			[55, 13],
			[64, 16],
		] as const) {
			terminal.resize(columns, rows);
			scheduler.flush();
			render(composer, scheduler);
			expectTranscriptAbovePrompt(terminal);
			expect(countContaining(terminal.tape(), retiredMarker), "resize replayed or cleared retained history").toBe(1);
		}
	} finally {
		composer.stop();
	}
});

test("explicit history replacement replays atomically without duplicate rows", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(58, 12);
	try {
		for (let index = 0; index < 18; index++) transcript.addChild(new StaticBlock([`old-session-${index}`]));
		render(composer, scheduler);
		expect(countContaining(terminal.tape(), "old-session-0")).toBe(1);

		transcript.clear();
		for (let index = 0; index < 20; index++) transcript.addChild(new StaticBlock([`replacement-[${index}]`]));
		composer.beginHistoryReplay();
		render(composer, scheduler);

		const tape = terminal.tape();
		expect(
			tape.some(row => row.includes("old-session-")),
			"destructive replay retained the old session",
		).toBe(false);
		for (let index = 0; index < 20; index++) {
			expect(countContaining(tape, `replacement-[${index}]`), `replacement row ${index}`).toBe(1);
		}
		expectTranscriptAbovePrompt(terminal, "replacement-");
	} finally {
		composer.stop();
	}
});

test("the welcome scene holds the composer against the bottom edge as startup rows clear", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(52, 30, false);
	try {
		composer.setHeaderExtras([], [new StaticBlock(Array.from({ length: 6 }, (_v, row) => `startup-notice-${row}`))]);
		transcript.addChild(new StaticBlock(["session ready"]));
		render(composer, scheduler);
		expect(terminal.screen().at(-1)).toBe("");

		composer.setHeaderExtras([], []);
		render(composer, scheduler);
		const screen = terminal.screen();
		const hairline = screen.findLastIndex(
			row => row.length > 0 && row === theme.boxSharp.horizontal.repeat(row.length),
		);
		expect(hairline).toBeGreaterThan(0);
		expect(screen.slice(hairline + 1).length).toBe(terminal.rows - hairline - 1);
	} finally {
		composer.stop();
	}
});

test("a tall live card settling keeps the real composer on the bottom edge", () => {
	const { composer, terminal, scheduler, transcript } = createHarness(100, 30, false);
	try {
		transcript.addChild(new StaticBlock(["> hello there"]));
		const card = new SettlingCard(35);
		transcript.addChild(card);
		render(composer, scheduler);
		expectTranscriptAbovePrompt(terminal, "live-row-");

		card.settled = true;
		render(composer, scheduler);
		expect(terminal.screen()).toHaveLength(terminal.rows);
		expectTranscriptAbovePrompt(terminal);
		expect(countContaining(terminal.tape(), "settled card")).toBe(1);
	} finally {
		composer.stop();
	}
});
