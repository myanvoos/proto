import { expect, test } from "bun:test";
import { type Component, Container, type RenderScheduler, type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { TranscriptContainer } from "./transcript-container";

class TrackedBlock implements Component {
	lines: readonly string[];
	#listener?: () => void;
	#version = 0;
	#finalized: boolean;
	committedRows = -1;
	commitCalls = 0;
	renderCalls = 0;

	constructor(lines: readonly string[], finalized = true) {
		this.lines = lines;
		this.#finalized = finalized;
	}

	render(_width: number): readonly string[] {
		this.renderCalls++;
		return this.lines;
	}

	setTranscriptBlockChangeListener(listener: (() => void) | undefined): void {
		this.#listener = listener;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.committedRows = rows;
		this.commitCalls++;
	}

	setLines(lines: readonly string[], finalized = this.#finalized): void {
		this.lines = lines;
		this.#finalized = finalized;
		this.#version++;
		this.#listener?.();
	}
}

/**
 * A live block that streams append-only rows, like an assistant reply: every
 * row but the one still being written is byte-final and may enter history. A
 * plain `TrackedBlock` models the other kind of live block — a tool card, which
 * redraws rows it already emitted and therefore settles nothing until it ends.
 */
class SettlingBlock extends TrackedBlock {
	getTranscriptBlockSettledRows(): number {
		return Math.max(0, this.lines.length - 1);
	}
}

class CaptureTerminal implements Terminal {
	columns = 20;
	rows = 4;
	writes: string[] = [];

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

	stop(): void {}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

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

	onAppearanceChange(_callback: (appearance: "dark" | "light", requestToken?: number) => void): void {}

	onPrivateModeReport(_callback: (mode: number, supported: boolean, confirmed?: boolean) => void): void {}
}

class BufferTerminal extends CaptureTerminal {
	readonly vt = new VTermTerminal({ cols: this.columns, rows: this.rows, scrollback: 1_000 });

	override write(data: string): void {
		super.write(data);
		this.vt.write(data);
	}

	normalLines(): string[] {
		const lines = this.vt.buffer.normal;
		return Array.from(
			{ length: lines.length },
			(_value, index) => lines.getLine(index)?.translateToString(true) ?? "",
		);
	}
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

class DisplaceableBlock extends TrackedBlock {
	#sealed = false;

	isDisplaceableBlock(): boolean {
		return !this.#sealed;
	}

	seal(): void {
		if (this.#sealed) return;
		this.#sealed = true;
		this.setLines(this.lines, true);
	}

	get sealed(): boolean {
		return this.#sealed;
	}
}

class PinnedDisplaceableBlock extends DisplaceableBlock {
	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}
}

test("generic Container observes TranscriptContainer render revisions", () => {
	const block = new TrackedBlock(["before"]);
	const transcript = new TranscriptContainer();
	const wrapper = new Container();
	transcript.addChild(block);
	wrapper.addChild(transcript);

	expect(wrapper.render(40)).toEqual(["before"]);
	block.setLines(["after"]);

	expect(wrapper.render(40), "a wrapper must not reuse a stale persistent transcript array").toEqual(["after"]);
});

test("committed finalized mutations expose their earliest dirty row", () => {
	const first = new TrackedBlock(["first"]);
	const second = new TrackedBlock(["second"]);
	const transcript = new TranscriptContainer();
	transcript.addChild(first);
	transcript.addChild(second);

	transcript.render(40);
	transcript.setNativeScrollbackCommittedRows(2);
	first.setLines([]);
	transcript.render(40);

	expect(transcript.getNativeScrollbackCommittedDirtyFromRow()).toBe(0);
	transcript.render(40);
	expect(transcript.getNativeScrollbackCommittedDirtyFromRow()).toBeUndefined();
});

test("empty displaceable blocks defer trailing-tail commitment until they seal", () => {
	const empty = new DisplaceableBlock([], false);
	const tail = new TrackedBlock(["tail-0", "tail-1", "tail-2"], true);
	const transcript = new TranscriptContainer();
	transcript.addChild(empty);
	transcript.addChild(tail);

	expect(transcript.render(40)).toEqual(["tail-0", "tail-1", "tail-2"]);
	// The empty live slot owns the commit boundary, so a normal streaming
	// frame must leave the finalized tail out of native scrollback.
	transcript.setNativeScrollbackCommittedRows(0);
	empty.setLines(["poll"], false);
	expect(transcript.render(40)).toEqual(["poll", "", "tail-0", "tail-1", "tail-2"]);
	expect(empty.sealed).toBe(false);
	expect(tail.committedRows, "tail rows remain deferred while the slot can still grow").toBe(0);

	empty.seal();
	expect(transcript.render(40)).toEqual(["poll", "", "tail-0", "tail-1", "tail-2"]);
	expect(empty.isTranscriptBlockFinalized()).toBe(true);
	transcript.setNativeScrollbackCommittedRows(5);
	transcript.render(40);
	expect(tail.committedRows, "the finalized tail becomes eligible after the slot seals").toBe(3);
});

test("deferred empty-slot frame stays exact without rewriting scrollback", () => {
	const tailRows = Array.from({ length: 12 }, (_value, index) => `tail-${index}`);
	const expected = ["poll", "", ...tailRows];
	const terminal = new CaptureTerminal();
	const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
	const empty = new DisplaceableBlock([], false);
	const tail = new TrackedBlock(tailRows, true);
	const transcript = new TranscriptContainer();
	transcript.addChild(empty);
	transcript.addChild(tail);
	tui.addChild(transcript);
	tui.start({ deferInput: true });
	expect(tail.committedRows, "the empty displaceable slot owns the initial commit boundary").toBe(0);
	terminal.writes.length = 0;

	empty.setLines(["poll"], false);
	tui.requestRender(true);
	expect(transcript.render(20)).toEqual(expected);
	// The live slot stays retractable, so finalized tail rows remain outside
	// native history while the slot can still grow.
	for (const row of tailRows.slice(-4)) expect(terminal.writes.join("")).toContain(row);
	expect(empty.sealed, "the live slot stays retractable while no rows crossed its boundary").toBe(false);
	expect(tail.committedRows, "the finalized tail remains deferred").toBe(0);

	empty.seal();
	tui.requestRender(true);
	terminal.writes.length = 0;
	empty.setLines(["P2"], true);
	tui.requestRender(true);
	const finalizedEditOutput = terminal.writes.join("");
	expect(transcript.render(20)).toEqual(["P2", "", ...tailRows]);
	expect(finalizedEditOutput).toContain("P2");
	expect(finalizedEditOutput).toContain("tail-11");
	expect(finalizedEditOutput, "settling a slot must not erase terminal history").not.toContain("\x1b[3J");
	tui.stop();
});
test("an explicitly pinned displaceable interior block keeps the tail out of the seam", () => {
	const live = new PinnedDisplaceableBlock(["live"], false);
	const tail = new TrackedBlock(["tail-0", "tail-1"]);
	const transcript = new TranscriptContainer();
	transcript.addChild(live);
	transcript.addChild(tail);

	expect(transcript.render(40)).toEqual(["live", "", "tail-0", "tail-1"]);
	expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);
	expect(transcript.getNativeScrollbackLiveRegionPinnedStart()).toBe(0);
});

test("a live run pins before a finalized trailing tail", () => {
	const history = new TrackedBlock(["history"]);
	const live = new TrackedBlock(["live-0"], false);
	const tail = new TrackedBlock(["tail-0", "tail-1"]);
	const transcript = new TranscriptContainer();
	transcript.addChild(history);
	transcript.addChild(live);
	transcript.addChild(tail);

	expect(transcript.render(40)).toEqual(["history", "", "live-0", "", "tail-0", "tail-1"]);
	expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);
	expect(transcript.getNativeScrollbackLiveRegionPinnedStart()).toBe(2);

	live.setLines(["live-0", "live-1"], false);
	expect(transcript.render(40)).toEqual(["history", "", "live-0", "live-1", "", "tail-0", "tail-1"]);
	expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);
	expect(
		transcript.getNativeScrollbackLiveRegionPinnedStart(),
		"a live block that settles nothing keeps the boundary at its first row as it grows",
	).toBe(2);
});

test("a reply crosses the seam while an earlier displaceable block remains live", () => {
	const terminal = new BufferTerminal();
	const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
	const transcript = new TranscriptContainer();
	const poll = new PinnedDisplaceableBlock(["polling"], false);
	const reply = new SettlingBlock([], false);
	transcript.addChild(poll);
	transcript.addChild(reply);
	tui.addChild(transcript);
	tui.addChild(new TrackedBlock(["checklist", "editor"]));
	tui.start({ deferInput: true });

	const response = Array.from({ length: 12 }, (_value, index) => `stream-${index}`);
	for (let count = 1; count <= response.length; count++) {
		reply.setLines(response.slice(0, count), false);
		tui.requestRender(true);
	}

	expect(reply.committedRows, "the active reply enters native history before it finalizes").toBeGreaterThan(0);
	const lines = terminal.normalLines();
	for (const row of response) expect(lines).toContain(row);
	expect(lines.slice(-2)).toEqual(["checklist", "editor"]);
	tui.stop();
});

test("a completed tall tool block remains in scrollback while the next reply streams", () => {
	const terminal = new BufferTerminal();
	const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
	const transcript = new TranscriptContainer();
	transcript.addChild(new TrackedBlock(["thinking-before"]));
	const tool = new TrackedBlock([], false);
	transcript.addChild(tool);
	tui.addChild(transcript);
	tui.addChild(new TrackedBlock(["checklist", "editor"]));
	tui.start({ deferInput: true });

	const preview = Array.from({ length: 12 }, (_value, index) => `tool-preview-${index}`);
	for (let count = 1; count <= preview.length; count++) {
		tool.setLines(preview.slice(0, count), false);
		tui.requestRender(true);
	}
	expect(
		tool.committedRows,
		"a card that still redraws itself puts nothing in scrollback the terminal could not repaint",
	).toBe(0);

	const result = Array.from({ length: 9 }, (_value, index) => `tool-result-${index}`);
	tool.setLines(result, true);
	tui.requestRender(true);
	const reply = new SettlingBlock([], false);
	transcript.addChild(reply);
	const response = Array.from({ length: 12 }, (_value, index) => `reply-${index}`);
	for (let count = 1; count <= response.length; count++) {
		reply.setLines(response.slice(0, count), false);
		tui.requestRender(true);
	}

	const lines = terminal.normalLines();
	const resultStart = lines.indexOf(result[0]!);
	expect(resultStart, "the settled tool block remains in native scrollback").toBeGreaterThanOrEqual(0);
	expect(lines.slice(resultStart, resultStart + result.length)).toEqual(result);
	expect(
		lines.filter(line => line.startsWith("tool-preview-")),
		"the running form of the card never reaches scrollback, so it cannot survive next to the finished one",
	).toEqual([]);
	expect(
		lines.filter(line => line === result[0]),
		"the finished card is appended once rather than resprayed",
	).toEqual([result[0]!]);
	for (const row of response.slice(0, -1)) expect(lines).toContain(row);
	expect(lines.slice(-2)).toEqual(["checklist", "editor"]);
	tui.stop();
});

test("streamed rows do not republish the unchanged committed transcript prefix", () => {
	const history = Array.from({ length: 1_000 }, (_value, index) => new TrackedBlock([`history-${index}`]));
	const live = new SettlingBlock(["stream-0"], false);
	const transcript = new TranscriptContainer();
	for (const block of history) transcript.addChild(block);
	transcript.addChild(live);
	transcript.render(80);
	transcript.setNativeScrollbackCommittedRows(1_999);
	for (const block of [...history, live]) block.commitCalls = 0;

	live.setLines(["stream-0", "stream-1"], false);
	const incremental = transcript.render(80);
	transcript.setNativeScrollbackCommittedRows(2_000);

	const rebuilt = new TranscriptContainer();
	for (const block of history) rebuilt.addChild(new TrackedBlock(block.lines));
	rebuilt.addChild(new SettlingBlock(live.lines, false));
	expect(incremental, "incremental watermark publication preserves the rebuilt frame exactly").toEqual(
		rebuilt.render(80),
	);
	expect(
		history.reduce((calls, block) => calls + block.commitCalls, 0),
		"settled history receives no callbacks when only the live tail crosses the watermark",
	).toBe(0);
	expect(live.commitCalls, "the crossed live interval receives the new watermark").toBe(1);
});

test("appending a transcript block preserves the frame without rerendering settled history", () => {
	const history = Array.from({ length: 1_000 }, (_value, index) => new TrackedBlock([`history-${index}`]));
	const transcript = new TranscriptContainer();
	for (const block of history) transcript.addChild(block);
	transcript.render(80);
	for (const block of history) block.renderCalls = 0;
	transcript.addChild(new TrackedBlock(["new-tail"]));
	const incremental = transcript.render(80);

	const rebuilt = new TranscriptContainer();
	for (const block of history) rebuilt.addChild(new TrackedBlock(block.lines));
	rebuilt.addChild(new TrackedBlock(["new-tail"]));
	expect(incremental, "append-only prefix reuse preserves the rebuilt frame exactly").toEqual(rebuilt.render(80));
	expect(
		history.reduce((calls, block) => calls + block.renderCalls, 0),
		"settled blocks are not rerendered when a new tail block is appended",
	).toBe(0);
});
