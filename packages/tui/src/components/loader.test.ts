import { afterEach, expect, test, vi } from "bun:test";
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
