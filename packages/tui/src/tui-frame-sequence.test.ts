import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { type Component, CURSOR_MARKER, TUI } from "./tui";

type ResizeCallback = () => void;

class FakeTerminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	readonly vt: VTermTerminal;
	#resizeCallback: ResizeCallback | undefined;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 500 });
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

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
	}

	triggerResize(): void {
		this.#resizeCallback?.();
	}

	screenRows(): string[] {
		const lines = this.vt.buffer.normal;
		const rows: string[] = [];
		for (let row = 0; row < this.rows; row++) {
			rows.push(lines.getLine(lines.baseY + row)?.translateToString(true) ?? "");
		}
		return rows;
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
		return {
			cancel: () => {
				entry.cancelled = true;
			},
		};
	}

	flush(): void {
		while (this.#pending.length > 0) {
			const entry = this.#pending.shift()!;
			if (!entry.cancelled) entry.callback();
		}
	}
}

function pinRenderEnvironment(): () => void {
	const keys = [
		"PI_NO_SYNC_OUTPUT",
		"PI_TUI_SYNC_OUTPUT",
		"TERM_FEATURES",
		"COLORTERM",
		"TMUX",
		"STY",
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"HERDR_WORKSPACE_ID",
	];
	const previous = new Map<string, string | undefined>();
	for (const key of keys) previous.set(key, Bun.env[key]);
	Bun.env.PI_NO_SYNC_OUTPUT = "1";
	Bun.env.TERM = "xterm-256color";
	for (const key of keys) {
		if (key === "PI_NO_SYNC_OUTPUT") continue;
		delete Bun.env[key];
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	};
}

/**
 * Transcript-like block: renders a fresh array per frame (the streaming shape)
 * and reports a pinned live region that overflows the viewport, so the
 * native-scrollback clip path engages on every frame.
 */
class FixtureTranscript implements Component {
	#rows: string[] = [];
	#liveRows: number;
	#rewrite = 0;

	constructor(liveRows: number) {
		this.#liveRows = liveRows;
	}

	appendRows(count: number): void {
		for (let i = 0; i < count; i++) {
			this.#rows.push(`history line ${this.#rows.length} ${"content".repeat(2)}`);
		}
	}

	rewriteTail(): void {
		this.#rewrite++;
		this.#rows[this.#rows.length - 1] = `live tail rewrite ${this.#rewrite}`;
	}

	rowCount(): number {
		return this.#rows.length;
	}

	render(_width: number): readonly string[] {
		return this.#rows.slice();
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return Math.max(0, this.#rows.length - this.#liveRows);
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}

	getNativeScrollbackLiveRegionPinnedStart(): number | undefined {
		return Math.max(0, this.#rows.length - this.#liveRows);
	}

	clipsNativeScrollbackLiveRegion(): boolean {
		return true;
	}
}

class FixtureEditor implements Component {
	#rows: readonly string[];
	constructor(marker = false) {
		this.#rows = marker ? ["editor:", `input${CURSOR_MARKER}`, "(hints)"] : ["editor:", "input", "(hints)"];
	}
	render(_width: number): readonly string[] {
		return this.#rows;
	}
}

test("frame sequence emits byte-identical output across appends, child changes, resize, and clipped live region", () => {
	const restore = pinRenderEnvironment();
	const terminal = new FakeTerminal(70, 12);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new FixtureTranscript(14);
	transcript.appendRows(26);
	tui.addChild(transcript);
	tui.addChild(new FixtureEditor());

	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		terminal.writes.length = 0;

		// content appended while the live region stays pinned and clipped
		transcript.appendRows(6);
		tui.requestRender();
		scheduler.flush();
		const afterAppend = terminal.screenRows();
		expect(afterAppend[afterAppend.length - 1]).toBe("(hints)");
		expect(afterAppend.some(row => row.includes("history line 31"))).toBe(true);

		// a sibling child changes
		tui.addChild(new FixtureEditor());
		tui.requestRender();
		scheduler.flush();

		// the live tail rewrites across two frames
		transcript.rewriteTail();
		tui.requestRender();
		scheduler.flush();
		transcript.rewriteTail();
		tui.requestRender();
		scheduler.flush();

		// resize narrower and shorter, then keep appending
		terminal.resize(60, 10);
		terminal.triggerResize();
		tui.requestRender();
		scheduler.flush();
		const resized = terminal.screenRows();
		expect(resized.every(row => row.length <= 60)).toBe(true);
		expect(resized.some(row => row.includes("editor:"))).toBe(true);

		transcript.appendRows(4);
		tui.requestRender();
		scheduler.flush();

		// resize back
		terminal.resize(70, 12);
		terminal.triggerResize();
		tui.requestRender();
		scheduler.flush();

		const emitted = terminal.writes.join("");
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(emitted);
		const digest = hasher.digest("hex");
		expect(digest).toBe("e474a58fc5250b2acfa8775a0e77c4a99fe1c87da1d32fc73c0519265115a213");
		// semantic anchors: the transcript and editor content all landed on screen
		const screen = terminal.screenRows();
		expect(screen[screen.length - 1]).toBe("(hints)");
		const normal = terminal.vt.buffer.normal;
		const allRows: string[] = [];
		for (let i = 0; i < normal.length; i++) allRows.push(normal.getLine(i)?.translateToString(true) ?? "");
		expect(allRows.some(row => row.includes("history line 35"))).toBe(true);
	} finally {
		tui.stop();
		restore();
	}
});

test("parks the hardware cursor on the editor marker row when the live region is clipped", () => {
	const restore = pinRenderEnvironment();
	const terminal = new FakeTerminal(80, 10);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new FixtureTranscript(12);
	transcript.appendRows(22);
	tui.addChild(transcript);
	tui.addChild(new FixtureEditor(true));

	try {
		tui.start({ deferInput: true });
		scheduler.flush();
		terminal.writes.length = 0;

		// 22 transcript rows + 3 editor rows = 25 logical rows; the pinned live
		// region starts at row 10 and strands 5 rows above the 10-row viewport,
		// so the editor marker at logical row 23 lands at clipped row 18 and
		// screen row 8 (col 5, after "input").
		transcript.rewriteTail();
		tui.requestRender();
		scheduler.flush();

		const screen = terminal.screenRows();
		expect(screen[8].startsWith("input")).toBe(true);
		expect(terminal.vt.buffer.active.cursorY).toBe(8);
		expect(terminal.vt.buffer.active.cursorX).toBe(5);
	} finally {
		tui.stop();
		restore();
	}
});
