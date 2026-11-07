import { afterEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_SPINNER_INTERVAL_MS,
	parseSpinnerInterval,
	SPINNER_INTERVAL_STATIC,
	setSpinnerInterval,
	sharedSpinnerFrame,
	spinnerAnimated,
	spinnerInterval,
	spinnerTickDelay,
} from "./spinner-clock";

afterEach(() => setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS));

describe("shared spinner clock", () => {
	test("a live interval moves every consumer's phase and a static one pins frame 0", () => {
		setSpinnerInterval(1000);
		expect(sharedSpinnerFrame(4, 2_999)).toBe(2);
		expect(sharedSpinnerFrame(4, 3_000)).toBe(3);
		setSpinnerInterval(SPINNER_INTERVAL_STATIC);
		expect(spinnerAnimated()).toBe(false);
		expect(sharedSpinnerFrame(4, 12_345)).toBe(0);
		expect(spinnerInterval()).toBe(SPINNER_INTERVAL_STATIC);
	});

	test("tick delays land on the next clock boundary, never in the past", () => {
		// 1000 is exactly four periods: the next tick is a full period away, not 1 ms.
		expect(spinnerTickDelay(250, 1_000)).toBe(250);
		expect(spinnerTickDelay(250, 1_120)).toBe(130);
		expect(spinnerTickDelay(80, 1_000)).toBe(40);
	});

	test("parses 0 (static) and whole milliseconds from 50 up, rejecting everything else", () => {
		expect(parseSpinnerInterval(0)).toBe(0);
		expect(parseSpinnerInterval(50)).toBe(50);
		expect(parseSpinnerInterval("250")).toBe(250);
		for (const value of [-1, 10, 80.5, "fast", ""]) {
			expect(() => parseSpinnerInterval(value)).toThrow();
		}
	});
});
