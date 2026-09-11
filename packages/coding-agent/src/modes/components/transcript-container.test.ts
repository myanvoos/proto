import { expect, test } from "bun:test";
import { type Component, Container, type RenderScheduler, type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "./transcript-container";

class TrackedBlock implements Component {
	lines: readonly string[];
	#listener?: () => void;
	#version = 0;
	#finalized: boolean;
	committedRows = -1;

	constructor(lines: readonly string[], finalized = true) {
		this.lines = lines;
		this.#finalized = finalized;
	}

	render(_width: number): readonly string[] {
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
	}

	setLines(lines: readonly string[], finalized = this.#finalized): void {
		this.lines = lines;
		this.#finalized = finalized;
		this.#version++;
		this.#listener?.();
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

class PinnedLiveBlock extends TrackedBlock {
	isDisplaceableBlock(): boolean {
		return true;
	}

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

test("deferred empty-slot frame stays exact in both scrollback modes", () => {
	const tailRows = Array.from({ length: 12 }, (_value, index) => `tail-${index}`);
	const expected = ["poll", "", ...tailRows];
	for (const scrollbackRebuild of [false, true]) {
		const terminal = new CaptureTerminal();
		const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
		const empty = new DisplaceableBlock([], false);
		const tail = new TrackedBlock(tailRows, true);
		const transcript = new TranscriptContainer();
		transcript.addChild(empty);
		transcript.addChild(tail);
		tui.addChild(transcript);
		tui.setScrollbackRebuild(scrollbackRebuild);
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
		expect(tail.committedRows, "the finalized tail remains deferred in both modes").toBe(0);

		empty.seal();
		tui.requestRender(true);
		terminal.writes.length = 0;
		empty.setLines(["P2"], true);
		tui.requestRender(true);
		const finalizedEditOutput = terminal.writes.join("");
		expect(transcript.render(20)).toEqual(["P2", "", ...tailRows]);
		expect(finalizedEditOutput).toContain("P2");
		expect(finalizedEditOutput).toContain("tail-11");
		expect(finalizedEditOutput.includes("\x1b[3J"), "rebuild mode erases stale native history").toBe(
			scrollbackRebuild,
		);
		tui.stop();
	}
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

test("rebuild mode retracts a tail when a pinned interior block becomes live", () => {
	const terminal = new CaptureTerminal();
	const tui = new TUI(terminal, false, { renderScheduler: IMMEDIATE_SCHEDULER });
	const live = new PinnedLiveBlock(["live"], true);
	const tail = new TrackedBlock(Array.from({ length: 12 }, (_value, index) => `tail-${index}`));
	const transcript = new TranscriptContainer();
	transcript.addChild(live);
	transcript.addChild(tail);
	tui.addChild(transcript);
	tui.setScrollbackRebuild(true);
	tui.start({ deferInput: true });
	expect(tail.committedRows).toBeGreaterThan(0);
	terminal.writes.length = 0;

	live.setLines(["live"], false);
	tui.requestRender(true);

	expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);
	expect(transcript.getNativeScrollbackLiveRegionPinnedStart()).toBe(0);
	expect(tail.committedRows).toBe(0);
	expect(terminal.writes.join(""), "rebuild mode must erase history beyond the new pinned seam").toContain("\x1b[3J");
	tui.stop();
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
	expect(transcript.getNativeScrollbackLiveRegionPinnedStart()).toBe(3);

	live.setLines(["live-0", "live-1"], false);
	expect(transcript.render(40)).toEqual(["history", "", "live-0", "live-1", "", "tail-0", "tail-1"]);
	expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);
	expect(transcript.getNativeScrollbackLiveRegionPinnedStart()).toBe(4);
});
