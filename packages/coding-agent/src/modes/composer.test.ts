import { expect, test } from "bun:test";
import { type Component, Container, type RenderScheduler, type Terminal } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "./components/transcript-container";
import { Composer } from "./composer";
import { initThemeSync, theme } from "./theme/theme";

initThemeSync();

class SinkTerminal implements Terminal {
	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	get appearance(): undefined {
		return undefined;
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
}

const IMMEDIATE_SCHEDULER: RenderScheduler = {
	now: () => 100,
	scheduleImmediate(callback): void {
		callback();
	},
	scheduleRender(callback): { cancel(): void } {
		callback();
		return { cancel() {} };
	},
};

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

const HUD_ROWS = ["Todo", " ├─ phase one", " └─────"];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "");
}

function rowsBetweenHudAndHairline(frame: readonly string[]): string[] {
	const rows = frame.map(stripAnsi);
	const hairline = rows.findIndex(row => row.length > 0 && row === theme.boxSharp.horizontal.repeat(row.length));
	const hudEnd = rows.lastIndexOf(HUD_ROWS[HUD_ROWS.length - 1]!);
	expect(hairline).toBeGreaterThan(hudEnd);
	return rows.slice(hudEnd + 1, hairline);
}

test("a transcript rebuild that starts short leaves no blank band between the HUD and the composer", () => {
	const columns = 80;
	const rows = 30;
	const composer = new Composer({
		terminal: new SinkTerminal(columns, rows),
		tuiOptions: { renderScheduler: IMMEDIATE_SCHEDULER },
		preferences: { quiet: true },
	});
	const transcript = new TranscriptContainer();
	transcript.onFirstContent = () => composer.syncHomeAnchor(transcript.children.length);
	const hud = new Container();
	hud.addChild(new StaticBlock(HUD_ROWS));
	composer.setRuntimeChildren([transcript, hud]);
	composer.start({ deferInput: true });
	try {
		composer.syncHomeAnchor(0);
		// First content: a multi-line prompt, then replies that push rows into native scrollback.
		transcript.addChild(new StaticBlock(Array.from({ length: 6 }, (_v, row) => `prompt-row-${row}`)));
		composer.ui.requestRender(true);
		for (let index = 0; index < 3; index++) {
			transcript.addChild(new StaticBlock(Array.from({ length: 15 }, (_v, row) => `reply-${index}-row-${row}`)));
			composer.ui.requestRender(true);
		}
		expect(composer.ui.committedRows).toBeGreaterThan(0);
		expect(rowsBetweenHudAndHairline(composer.ui.render(columns))).toEqual([]);

		// Rebuild after compaction: the container empties and refills synchronously,
		// starting with a one-row summary block.
		transcript.clear();
		transcript.addChild(new StaticBlock(["compaction summary"]));
		transcript.addChild(new StaticBlock(Array.from({ length: 15 }, (_v, row) => `kept-reply-row-${row}`)));
		composer.ui.requestRender(true);
		expect(rowsBetweenHudAndHairline(composer.ui.render(columns))).toEqual([]);

		// The conversation keeps growing afterwards; the band must not persist.
		transcript.addChild(new StaticBlock(Array.from({ length: 15 }, (_v, row) => `next-reply-row-${row}`)));
		composer.ui.requestRender(true);
		expect(rowsBetweenHudAndHairline(composer.ui.render(columns))).toEqual([]);
	} finally {
		composer.stop();
	}
});

/** Blank rows the frame leaves directly above the composer hairline. */
function blankRowsAboveHairline(frame: readonly string[]): number {
	const rows = frame.map(stripAnsi);
	const hairline = rows.findIndex(row => row.length > 0 && row === theme.boxSharp.horizontal.repeat(row.length));
	expect(hairline).toBeGreaterThan(0);
	let blank = 0;
	for (let row = hairline - 1; row >= 0 && rows[row]!.trim().length === 0; row--) blank++;
	return blank;
}

// The welcome scene used to split its slack to centre the banner, which opened
// a blank band between the banner and the editor — the screen looked pushed up,
// and the band grew as the terminal got shorter or narrower.
test.each([
	[60, 30],
	[52, 30],
	[60, 20],
	[100, 30],
])("the welcome banner sits against the composer at %ix%i", (columns, rows) => {
	const composer = new Composer({
		terminal: new SinkTerminal(columns, rows),
		tuiOptions: { renderScheduler: IMMEDIATE_SCHEDULER },
		preferences: { quiet: false },
		welcome: { version: "1.2.3", modelName: "opus-5", providerName: "anthropic", recentSessions: [] },
	});
	composer.start({ deferInput: true });
	try {
		composer.syncHomeAnchor(0);
		// One spacer row belongs to the header; anything beyond it is stranded slack.
		expect(blankRowsAboveHairline(composer.ui.render(columns))).toBeLessThanOrEqual(1);
	} finally {
		composer.stop();
	}
});

// Startup rows — config warnings, MCP connection notices, the changelog block —
// vanish after the one-shot anchor sync has already run. The frame must follow
// them down instead of stranding a blank band beneath the editor and status line.
test("startup rows disappearing after the anchor sync leave no band under the composer", () => {
	const columns = 60;
	const rows = 30;
	const composer = new Composer({
		terminal: new SinkTerminal(columns, rows),
		tuiOptions: { renderScheduler: IMMEDIATE_SCHEDULER },
		preferences: { quiet: false },
		welcome: { version: "1.2.3", modelName: "opus-5", providerName: "anthropic", recentSessions: [] },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	try {
		composer.setHeaderExtras([], [new StaticBlock(Array.from({ length: 6 }, (_v, row) => `startup-notice-${row}`))]);
		transcript.addChild(new StaticBlock(["session ready"]));
		composer.syncHomeAnchor(transcript.children.length);
		expect(composer.ui.render(columns).length).toBe(rows);

		// The notices are cleared; nothing calls syncHomeAnchor again.
		composer.setHeaderExtras([], []);
		expect(composer.ui.render(columns).length).toBe(rows);
	} finally {
		composer.stop();
	}
});
