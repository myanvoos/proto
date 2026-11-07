import { afterEach, expect, test } from "bun:test";
import { DEFAULT_MAX_FPS, setMaxFps } from "./frame-rate";
import type { Terminal } from "./terminal";
import { TUI } from "./tui";

afterEach(() => setMaxFps(DEFAULT_MAX_FPS));

interface Scheduled {
	callback: () => void;
	delay: number;
	cancelled: boolean;
}

function harness() {
	const scheduled: Scheduled[] = [];
	const clock = { now: 0 };
	const writes: string[] = [];
	let input: ((data: string) => void) | undefined;
	const terminal = {
		columns: 40,
		rows: 10,
		get pendingOutputBytes() {
			return 0;
		},
		get kittyProtocolActive() {
			return false;
		},
		get kittyEnableSequence() {
			return null;
		},
		get appearance() {
			return undefined;
		},
		start(handler: (data: string) => void) {
			input = handler;
		},
		enableInput() {},
		stop() {},
		async drainInput() {},
		write(data: string) {
			writes.push(data);
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		onAppearanceChange() {},
	} as unknown as Terminal;
	const scheduler = {
		now: () => clock.now,
		scheduleImmediate(callback: () => void) {
			scheduled.push({ callback, delay: 0, cancelled: false });
		},
		scheduleRender(callback: () => void, delay: number) {
			const entry = { callback, delay, cancelled: false };
			scheduled.push(entry);
			return {
				cancel() {
					entry.cancelled = true;
				},
			};
		},
	};
	const ui = new TUI(terminal, false, { renderScheduler: scheduler });
	ui.start({ deferInput: true });
	const focused = {
		render: () => [],
		handleInput: () => {},
		invalidate: () => {},
	};
	ui.addChild(focused);
	ui.setFocus(focused);
	// Let start()'s first frame paint so the scheduler is quiescent before a test drives it.
	for (let i = 0; i < 4; i++) {
		const entries = scheduled.splice(0);
		if (entries.length === 0) break;
		for (const entry of entries) {
			if (entry.cancelled) continue;
			clock.now += entry.delay;
			entry.callback();
		}
	}
	scheduled.length = 0;
	return { ui, scheduled, clock, sendInput: (data: string) => input?.(data) };
}

function runImmediates(scheduled: Scheduled[]): void {
	for (const entry of scheduled.splice(0)) {
		if (!entry.cancelled && entry.delay === 0) entry.callback();
	}
}

function parkedRender(scheduled: Scheduled[]): Scheduled | undefined {
	return scheduled.filter(entry => !entry.cancelled && entry.delay > 0).at(-1);
}

test("ordinary frames land no closer than the tui.maxFps ceiling", () => {
	const { ui, scheduled } = harness();
	try {
		setMaxFps(4);
		ui.requestRender();
		runImmediates(scheduled);
		expect(parkedRender(scheduled)?.delay).toBe(250);
	} finally {
		ui.stop();
	}
});

test("a keystroke repaces a parked animation frame to the input cadence", () => {
	const { ui, scheduled, sendInput } = harness();
	try {
		setMaxFps(1);
		ui.requestRender();
		runImmediates(scheduled);
		const animationFrame = parkedRender(scheduled);
		expect(animationFrame?.delay).toBe(1_000);

		sendInput("x");
		// The animation frame parked a second out is replaced by one a keystroke can ride.
		expect(animationFrame?.cancelled).toBe(true);
		expect(parkedRender(scheduled)?.delay).toBeCloseTo(1_000 / 30, 5);
	} finally {
		ui.stop();
	}
});

test("the input latch clears once a frame paints, so later frames use the ceiling again", () => {
	const { ui, scheduled, clock, sendInput } = harness();
	try {
		setMaxFps(1);
		ui.requestRender();
		runImmediates(scheduled);
		sendInput("x");
		const inputFrame = parkedRender(scheduled);
		expect(inputFrame?.delay).toBeCloseTo(1_000 / 30, 5);

		clock.now = 34;
		inputFrame?.callback();
		scheduled.length = 0;
		ui.requestRender();
		runImmediates(scheduled);
		// Back on the one-second ceiling, not the 30 fps input cadence.
		expect(parkedRender(scheduled)?.delay).toBeGreaterThan(500);
	} finally {
		ui.stop();
	}
});
