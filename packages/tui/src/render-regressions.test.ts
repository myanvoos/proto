import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { type Component, Container, coalesceAdjacentSgr, findCommittedPrefixResync, TUI } from "./tui";

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
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 200 });
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
		return Array.from(
			{ length: lines.length },
			(_value, index) => lines.getLine(index)?.translateToString(true) ?? "",
		);
	}

	screenText(): string {
		const lines = this.vt.buffer.normal;
		return lines.getLine(lines.baseY)?.translateToString(true) ?? "";
	}
}

class ProtocolRows {
	rows: string[];
	dirtyRow: number | undefined;
	liveStart: number | undefined;
	pinned = false;
	pinnedStart: number | undefined;

	constructor(rows: string[]) {
		this.rows = rows;
		this.dirtyRow = undefined;
		this.liveStart = undefined;
		this.pinnedStart = undefined;
	}

	render(): readonly string[] {
		return this.rows;
	}

	getNativeScrollbackCommittedDirtyFromRow(): number | undefined {
		return this.dirtyRow;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.liveStart;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.pinned;
	}

	getNativeScrollbackLiveRegionPinnedStart(): number | undefined {
		return this.pinnedStart;
	}
}

class JoinedRows implements Component {
	children: Component[] = [];
	#liveStart: number | undefined;

	addChild(component: Component): void {
		this.children.push(component);
	}

	render(width: number): readonly string[] {
		const rows: string[] = [];
		this.#liveStart = undefined;
		for (const child of this.children) {
			const childRows = child.render(width);
			if (rows.length > 0) rows.push("");
			const childLiveStart = (
				child as Component & { getNativeScrollbackLiveRegionStart?: () => number | undefined }
			).getNativeScrollbackLiveRegionStart?.();
			if (this.#liveStart === undefined && childLiveStart !== undefined) {
				this.#liveStart =
					rows.length + (Number.isFinite(childLiveStart) ? Math.max(0, childLiveStart) : childRows.length);
			}
			rows.push(...childRows);
		}
		return rows;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#liveStart;
	}
}

class UnfinalizedRows implements Component {
	constructor(public rows: string[]) {}

	render(): readonly string[] {
		return this.rows;
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
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

test("keeps an astral character whole when a frame write reaches the chunk cap", () => {
	const terminal = new FakeTerminal(5_000, 1);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tui.addChild({ render: () => ["a".repeat(1_005) + String.fromCodePoint(0x1f600) + "b".repeat(2_000)] });

	try {
		tui.start({ deferInput: true });
		const split = terminal.writes.findIndex((write, index) => {
			const next = terminal.writes[index + 1];
			if (!next || write.length === 0 || next.length === 0) return false;
			const last = write.charCodeAt(write.length - 1);
			const first = next.charCodeAt(0);
			return last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
		});

		expect(split).toBe(-1);
		expect(terminal.writes.every(write => write.length <= 1_024)).toBe(true);
		expect(terminal.writes.join("")).toContain(String.fromCodePoint(0x1f600));
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

test("reanchors when a blank row shifts the committed prefix boundary", () => {
	const terminal = new FakeTerminal(20, 3);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	let rows = ["A", "", "", "B", "tail1", "tail2", "tail3"];
	tui.addChild({ render: () => rows.slice() });

	try {
		tui.start({ deferInput: true });
		terminal.writes.length = 0;
		rows = ["A", "", "", "", "B", "tail1", "tail2", "tail3"];
		expect(
			findCommittedPrefixResync(rows, ["A", "", "", "B"], {
				auditFrom: 4,
				finalTo: 4,
				tailPolicy: "sample-one-edit",
			}),
		).toBe(3);
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["A", "", "", "B", "", "B", "tail1", "tail2", "tail3"]);
	} finally {
		tui.stop();
	}
});

test("committed prefix audit resyncs on a single style-only change beyond the sampled lookback", () => {
	const rows = ["A", "B", "\x1b[31mone", "C"];
	const prefix = ["A", "B", "\x1b[32mone", "C"];
	// Exact policy (width-epoch path): the style-only change must resync even
	// though it sits far above any sampled tail window.
	expect(findCommittedPrefixResync(rows, prefix, { auditFrom: 0, finalTo: 4, tailPolicy: "exact" })).toBe(2);
});

test("committed prefix audit resyncs on an ordinary change beyond the sampled lookback", () => {
	const rows = ["A", "X", "C"];
	const prefix = ["A", "B", "C"];
	expect(findCommittedPrefixResync(rows, prefix, { auditFrom: 0, finalTo: 3, tailPolicy: "exact" })).toBe(1);
	// The sampled policy still tolerates a single ordinary edit in the tail
	// window it actually samples (insertion heuristic unchanged).
	expect(findCommittedPrefixResync(rows, prefix, { auditFrom: 3, finalTo: 3, tailPolicy: "sample-one-edit" })).toBe(
		-1,
	);
});

test("accounts for rows pushed by a mux height shrink before appending", () => {
	const restore = setEnvironment({ TMUX: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(8, 4);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	let rows = ["A", "B", "C", "D", "E", "F", "G", "H"];
	tui.addChild({ render: () => rows.slice() });

	try {
		tui.start({ deferInput: true });
		terminal.resize(8, 2);
		terminal.triggerResize();
		scheduler.flush();
		rows = [...rows, "I", "J", "K"];
		tui.invalidate();
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]);
	} finally {
		tui.stop();
		restore();
	}
});

// Bun 1.4.2 classifies U+2621 as Wide despite East Asian Width = Ambiguous,
// so the "measured line fits" premise only holds when the platform width
// table honors ambiguous-is-narrow.
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
			expect(terminal.screenText()).toBe("☰bcd");
		} finally {
			tui.stop();
		}
	},
);

test("preserves a frozen row and appends its corrected form without erasing history", () => {
	const terminal = new FakeTerminal(8, 2);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const component = new ProtocolRows(["A0", "B0", "C0", "D0"]);
	tui.addChild(component);

	try {
		tui.start({ deferInput: true });
		component.rows = ["A0", "B1", "C0", "D0"];
		component.dirtyRow = 1;
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["A0", "B0", "B1", "C0", "D0"]);
		expect(terminal.writes.join(""), "correcting a frozen row must not erase scrollback").not.toContain("\x1b[3J");
	} finally {
		tui.stop();
	}
});

test("keeps the seam pinned when the content tail moves above it without a geometry change", () => {
	const terminal = new FakeTerminal(8, 2);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const component = new ProtocolRows(["A", "B", "C"]);
	tui.addChild(component);

	try {
		tui.start({ deferInput: true });
		component.rows = ["A", "B"];
		tui.requestRender(true);
		// "A" is already in native scrollback, so repainting it onto the screen
		// would leave a duplicate seam row in history.
		expect(terminal.normalLines()).toEqual(["A", "B", ""]);
	} finally {
		tui.stop();
	}
});

test("scrolls an unpinned live region into history but keeps finalized rows below it viewport-local", () => {
	const terminal = new FakeTerminal(20, 4);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const prior = new ProtocolRows(["P0", "P1", "P2"]);
	const live = new ProtocolRows([]);
	const tail = new ProtocolRows(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
	live.liveStart = 0;
	tui.addChild(prior);
	tui.addChild(live);
	tui.addChild(tail);

	try {
		tui.start({ deferInput: true });
		for (let n = 1; n <= 8; n++) {
			live.rows = Array.from({ length: n }, (_value, index) => `L-${index}`);
			tui.requestRender(true);
		}
		// The live rows that outgrew the viewport are in history; the finalized
		// tail below the live segment never entered the committed seam.
		const liveRows = Array.from({ length: 8 }, (_value, index) => `L-${index}`);
		expect(terminal.normalLines()).toEqual(["P0", "P1", "P2", ...liveRows, "T4", "T5", "T6", "T7"]);

		live.liveStart = undefined;
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual([
			"P0",
			"P1",
			"P2",
			...liveRows,
			"T0",
			"T1",
			"T2",
			"T3",
			"T4",
			"T5",
			"T6",
			"T7",
		]);
	} finally {
		tui.stop();
	}
});

test("pushes the head of a joined live block into history before trailing chrome", () => {
	const terminal = new FakeTerminal(20, 5);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new JoinedRows();
	transcript.addChild({ render: () => ["U0"] });
	const stream = new ProtocolRows([]);
	stream.liveStart = 0;
	transcript.addChild(stream);
	const chrome = new ProtocolRows(["editor", "status"]);
	tui.addChild(transcript);
	tui.addChild(chrome);

	try {
		tui.start({ deferInput: true });
		const body = Array.from({ length: 12 }, (_value, index) => `S-${index}`);
		for (let n = 1; n <= body.length; n++) {
			stream.rows = body.slice(0, n);
			tui.requestRender(true);
		}
		const lines = terminal.normalLines();
		expect(lines.slice(0, 2)).toEqual(["U0", ""]);
		for (const row of body) expect(lines).toContain(row);
		expect(lines.filter(line => line === "editor")).toHaveLength(1);
		expect(lines.slice(-2)).toEqual(["editor", "status"]);

		stream.liveStart = undefined;
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["U0", "", ...body, "editor", "status"]);
	} finally {
		tui.stop();
	}
});

test("a scrollback-clearing repaint keeps live rows that sit above the viewport", () => {
	const terminal = new FakeTerminal(20, 5);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new JoinedRows();
	transcript.addChild({ render: () => ["U0"] });
	const stream = new ProtocolRows(Array.from({ length: 12 }, (_value, index) => `S-${index}`));
	stream.liveStart = 0;
	transcript.addChild(stream);
	tui.addChild(transcript);
	tui.addChild(new ProtocolRows(["editor"]));

	try {
		tui.start({ deferInput: true });
		// Rebuilding the transcript mid-stream (compaction) clears scrollback and
		// repaints; the head of the still-live block must be repainted too, not
		// dropped between the commit ceiling and the viewport top.
		tui.requestRender(true, { clearScrollback: true });
		expect(terminal.normalLines()).toEqual(["U0", "", ...stream.rows, "editor"]);
	} finally {
		tui.stop();
	}
});

test("clamps an unpinned nested container at its live start", () => {
	const terminal = new FakeTerminal(20, 3);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	class LiveContainer extends Container {
		liveStart: number | undefined;
		getNativeScrollbackLiveRegionStart(): number | undefined {
			return this.liveStart;
		}
	}
	const nested = new LiveContainer();
	const slot = new ProtocolRows([]);
	const innerTail = new ProtocolRows(["I0", "I1", "I2", "I3"]);
	nested.addChild(new ProtocolRows(["H0"]));
	nested.addChild(slot);
	nested.addChild(innerTail);
	nested.liveStart = 1;
	tui.addChild(nested);
	tui.addChild(new ProtocolRows(["editor"]));

	try {
		tui.start({ deferInput: true });
		// The root cannot see that I0..I3 are finalized rows inside the
		// container, so nothing past the live start may enter history.
		expect(terminal.normalLines()).toEqual(["H0", "I2", "I3", "editor"]);
		slot.rows = ["S0", "S1"];
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["H0", "I2", "I3", "editor"]);
		nested.liveStart = undefined;
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["H0", "S0", "S1", "I0", "I1", "I2", "I3", "editor"]);
	} finally {
		tui.stop();
	}
});

test("does not erase scrollback during streaming growth", () => {
	const terminal = new FakeTerminal(40, 4);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const component = new ProtocolRows(["seed-0", "seed-1", "seed-2", "prompt"]);
	tui.addChild(component);

	try {
		tui.start({ deferInput: true });
		terminal.writes.length = 0;
		component.rows = [...Array.from({ length: 30 }, (_value, index) => `stream-${index}`), "prompt"];
		tui.requestRender(true);

		expect(terminal.writes.join(""), "live growth must not wipe existing scrollback").not.toContain("\x1b[3J");
		expect(terminal.normalLines().slice(-4)).toEqual(["stream-27", "stream-28", "stream-29", "prompt"]);
	} finally {
		tui.stop();
	}
});

test("keeps all current result rows when a provisional preview finalizes", () => {
	const terminal = new FakeTerminal(20, 4);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const root = new ProtocolRows([]);
	root.liveStart = 0;
	tui.addChild(root);

	try {
		tui.start({ deferInput: true });
		terminal.writes.length = 0;
		root.rows = Array.from({ length: 10 }, (_value, index) => `preview-${index}`);
		tui.requestRender(true);
		root.rows = Array.from({ length: 9 }, (_value, index) => `result-${index}`);
		root.liveStart = undefined;
		tui.requestRender(true);

		const lines = terminal.normalLines();
		for (const row of Array.from({ length: 9 }, (_value, index) => `result-${index}`)) {
			expect(lines).toContain(row);
		}
		expect(terminal.writes.join(""), "default finalization must not erase scrollback").not.toContain("\x1b[3J");
	} finally {
		tui.stop();
	}
});

test("keeps inserted rows and a live tail after a frozen progress header", () => {
	const terminal = new FakeTerminal(21, 2);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new JoinedRows();
	transcript.addChild({ render: () => ["A0", "A1"] });
	const progress = new UnfinalizedRows(["progress", "p1", "waiting"]);
	tui.addChild(transcript);
	tui.addChild(progress);

	try {
		tui.start({ deferInput: true });
		transcript.children.splice(1, 0, { render: () => ["B0", "B1"] });
		tui.requestRender(true);
		expect(terminal.normalLines().slice(-6)).toEqual(["", "B0", "B1", "progress", "p1", "waiting"]);
		expect(terminal.writes.join(""), "insertion must not erase frozen history").not.toContain("\x1b[3J");
	} finally {
		tui.stop();
	}
});

test("replays a committed tool header after insertion inside a live container", () => {
	const terminal = new FakeTerminal(50, 4);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const transcript = new JoinedRows();
	transcript.addChild({ render: () => ["A0", "A1"] });
	const tool = new ProtocolRows(["progress", "p1", "waiting"]);
	tool.liveStart = 0;
	transcript.addChild(tool);
	tui.addChild(transcript);

	try {
		tui.start({ deferInput: true });
		transcript.children.splice(1, 0, { render: () => ["B0", "B1"] });
		tui.requestRender(true);
		expect(terminal.normalLines()).toEqual(["A0", "A1", "", "B0", "B1", "", "progress", "p1", "waiting"]);
	} finally {
		tui.stop();
	}
});

test("keeps inserted rows after a frozen pinned prefix", () => {
	const terminal = new FakeTerminal(20, 4);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const before = new ProtocolRows(["A0", "A1"]);
	const pinned = new ProtocolRows(["s0", "s1", "s2", "s3", "s4", "mutable"]);
	pinned.liveStart = 5;
	pinned.pinned = true;
	pinned.pinnedStart = 5;
	const tail = new ProtocolRows(["tail0", "tail1", "tail2", "tail3", "tail4", "tail5"]);
	tui.addChild(before);
	tui.addChild(pinned);
	tui.addChild(tail);

	try {
		tui.start({ deferInput: true });
		tui.children.splice(1, 0, { render: () => ["B0", "B1"] });
		tui.requestRender(true);
		expect(terminal.normalLines().slice(-11)).toEqual([
			"B0",
			"B1",
			"s0",
			"s1",
			"s2",
			"s3",
			"s4",
			"tail2",
			"tail3",
			"tail4",
			"tail5",
		]);
		expect(terminal.writes.join(""), "insertion must not erase frozen history").not.toContain("\x1b[3J");
	} finally {
		tui.stop();
	}
});

test("keeps current rows when a committed live block is removed", () => {
	const terminal = new FakeTerminal(27, 2);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const live = new ProtocolRows(["r1x1y0 live"]);
	const body = new ProtocolRows(["r2x0y0 zero", "r2x0y1 one", "r2x0y2 two", "r2x0y3 three"]);
	const progress = new ProtocolRows(["progress", "p1", "p2"]);
	progress.liveStart = 0;
	tui.addChild(live);
	tui.addChild(body);
	tui.addChild(progress);

	try {
		tui.start({ deferInput: true });
		tui.removeChild(live);
		tui.requestRender(true);
		const lines = terminal.normalLines();
		expect(lines.slice(-2)).toEqual(["p1", "p2"]);
		for (const row of ["r2x0y0 zero", "r2x0y1 one", "r2x0y2 two", "r2x0y3 three"]) {
			expect(lines).toContain(row);
		}

		// The frozen live header is reconciled once the block settles differently.
		progress.rows = ["done", "d1"];
		progress.liveStart = undefined;
		tui.requestRender(true);
		expect(terminal.normalLines().slice(-2)).toEqual(["done", "d1"]);
	} finally {
		tui.stop();
	}
});

test("a live block rewriting its scrolled-off head does not respray native scrollback", () => {
	const terminal = new FakeTerminal(14, 6);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	// A streaming tool card: two settled rows, then a live run whose head rows
	// (spinner, elapsed time) are rewritten on every frame. The run is pinned at
	// its end, so rows scrolling above the viewport commit as frozen visual
	// snapshots, and the container reports the card's start as committed-dirty
	// because those committed rows did change.
	const block = new ProtocolRows([]);
	block.liveStart = 2;
	block.pinned = true;
	const paint = (frame: number): void => {
		block.rows = ["settled-0", "settled-1", `run ${frame}`, `elapsed ${frame}`, "c-a", "c-b", "c-c", "o-a", "o-b"];
		block.pinnedStart = block.rows.length;
		block.dirtyRow = 2;
		tui.requestRender(true);
	};
	tui.addChild(block);

	try {
		tui.start({ deferInput: true });
		paint(1);
		const committed = terminal.normalLines().length;
		for (let frame = 2; frame <= 12; frame++) paint(frame);

		// The frozen head keeps its first snapshot (duplication never loss) and the
		// tape never grows: re-auditing frozen rows used to re-anchor the seam every
		// frame and append the live head to history again.
		expect(terminal.normalLines().length).toBe(committed);
		expect(terminal.normalLines().map(line => line.trimEnd())).toEqual([
			"settled-0",
			"settled-1",
			"run 1",
			"elapsed 12",
			"c-a",
			"c-b",
			"c-c",
			"o-a",
			"o-b",
		]);
	} finally {
		tui.stop();
	}
});

test("keeps the exact mux tape after a width and height resize", () => {
	const restore = setEnvironment({ TMUX: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(8, 2);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const component = new ProtocolRows(["A", "B", "C"]);
	tui.addChild(component);

	try {
		tui.start({ deferInput: true });
		terminal.resize(14, 3);
		terminal.triggerResize();
		scheduler.flush();
		expect(terminal.normalLines()).toEqual(["A", "B", "C"]);
	} finally {
		tui.stop();
		restore();
	}
});

test("clears mux tape for an explicit scrollback clear", () => {
	const restore = setEnvironment({ TMUX: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(10, 2);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const component = new ProtocolRows(["r1a", "r1b", "r1c", "r1d"]);
	tui.addChild(component);

	try {
		tui.start({ deferInput: true });
		component.rows = [];
		tui.requestRender(true, { clearScrollback: true });
		expect(terminal.normalLines()).toEqual(["", ""]);
	} finally {
		tui.stop();
		restore();
	}
});

test("recommits current rows after a mux width epoch before a live progress tail", () => {
	const restore = setEnvironment({ TMUX: "1", TERM: "xterm-256color", PI_NO_SYNC_OUTPUT: "1" });
	const terminal = new FakeTerminal(8, 3);
	const scheduler = new TestScheduler();
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	const body = new ProtocolRows(["y0", "y1", "y2", "y3", "y4"]);
	const progress = new ProtocolRows(["progress", "p1", ""]);
	progress.liveStart = 0;
	tui.addChild(body);

	try {
		tui.start({ deferInput: true });
		terminal.resize(14, 5);
		terminal.triggerResize();
		scheduler.flush();
		tui.addChild(progress);
		tui.requestRender(true);
		const lines = terminal.normalLines().map(line => line.trimEnd());
		for (const row of ["y0", "y1", "y2"]) expect(lines).toContain(row);
		expect(lines.slice(-5)).toEqual(["y3", "y4", "progress", "p1", ""]);
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
