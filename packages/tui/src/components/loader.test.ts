import { afterEach, expect, test, vi } from "bun:test";
import { DEFAULT_SPINNER_INTERVAL_MS, SPINNER_INTERVAL_STATIC, setSpinnerInterval } from "../spinner-clock";
import type { TUI } from "../tui";
import { Loader } from "./loader";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Capture Loader tick scheduling and drive a controllable clock. */
function harness(lastFrameCostMs = 0) {
	const scheduled: Array<{ callback: () => void; delay: number }> = [];
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
		scheduled.push({ callback, delay });
		return { unref() {} };
	}) as unknown as typeof setTimeout);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
	const clock = { now: 1_000 };
	vi.spyOn(performance, "now").mockImplementation(() => clock.now);
	const ui = { requestComponentRender() {}, synchronizedOutput: false, lastFrameCostMs } as unknown as TUI;
	return { scheduled, clock, ui };
}

test("a function message is re-evaluated on each spinner tick", () => {
	const { scheduled, clock, ui } = harness();
	let remaining = 5;
	const loader = new Loader(
		ui,
		spinner => spinner,
		text => text,
		() => `wait ${remaining}s`,
		["-", "+"],
	);
	expect(loader.render(40).join("")).toContain("wait 5s");

	remaining = 4;
	clock.now += 100;
	scheduled.at(-1)?.callback();
	expect(loader.render(40).join("")).toContain("wait 4s");
	loader.stop();
});

test("a pathological frame cost backs the spinner off by a bounded amount", () => {
	const { scheduled, clock, ui } = harness(5_000);
	const loader = new Loader(
		ui,
		spinner => spinner,
		text => text,
		"working",
		["-", "+"],
	);
	clock.now += 100;
	scheduled.at(-1)?.callback();
	// Nine times the completed frame cost, capped at 200 ms of cost.
	expect(scheduled.at(-1)?.delay).toBe(1_800);
	loader.stop();
});

test("follows the shared spinner clock and pins frame 0 when the interval goes static", () => {
	const { scheduled, clock, ui } = harness();
	try {
		setSpinnerInterval(500);
		const loader = new Loader(
			ui,
			spinner => spinner,
			text => text,
			"working",
			["0", "1", "2", "3"],
		);
		// The row shows the clock's glyph at start (1000 ms / 500 ms = frame 2).
		expect(loader.render(40).join("")).toContain("2 working");

		// A tick that does not cross a boundary leaves the glyph alone.
		clock.now += 100;
		scheduled.at(-1)?.callback();
		expect(loader.render(40).join("")).toContain("2 working");

		// Crossing the next boundary advances to the clock's glyph, not a private counter.
		clock.now += 400;
		scheduled.at(-1)?.callback();
		expect(loader.render(40).join("")).toContain("3 working");

		// A live switch to static pins frame 0 at once instead of waiting out the old timer.
		setSpinnerInterval(SPINNER_INTERVAL_STATIC);
		expect(loader.render(40).join("")).toContain("0 working");
		loader.stop();
	} finally {
		setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
	}
});
