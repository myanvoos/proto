import { expect, test } from "bun:test";
import { shouldNotifyCompletion } from "./completion-notification";

const LONG = 45_000;
const SHORT = 400;

test("a sub-second turn does not ring the bell", () => {
	expect(
		shouldNotifyCompletion({ elapsedMs: SHORT, minSeconds: 10, focused: undefined, notifyWhenFocused: false }),
	).toBe(false);
});

test("a long turn rings when the terminal is not focused", () => {
	expect(shouldNotifyCompletion({ elapsedMs: LONG, minSeconds: 10, focused: false, notifyWhenFocused: false })).toBe(
		true,
	);
});

test("a long turn stays silent while the terminal holds focus", () => {
	expect(shouldNotifyCompletion({ elapsedMs: LONG, minSeconds: 10, focused: true, notifyWhenFocused: false })).toBe(
		false,
	);
});

test("unknown focus still rings: hosts without DEC 1004 must not lose notifications", () => {
	expect(
		shouldNotifyCompletion({ elapsedMs: LONG, minSeconds: 10, focused: undefined, notifyWhenFocused: false }),
	).toBe(true);
});

test("notifyWhenFocused restores the old always-ring behaviour", () => {
	expect(shouldNotifyCompletion({ elapsedMs: LONG, minSeconds: 10, focused: true, notifyWhenFocused: true })).toBe(
		true,
	);
});

test("a zero threshold notifies on every finished turn", () => {
	expect(shouldNotifyCompletion({ elapsedMs: 0, minSeconds: 0, focused: false, notifyWhenFocused: false })).toBe(true);
});

test("the threshold boundary is inclusive", () => {
	expect(shouldNotifyCompletion({ elapsedMs: 10_000, minSeconds: 10, focused: false, notifyWhenFocused: false })).toBe(
		true,
	);
	expect(shouldNotifyCompletion({ elapsedMs: 9_999, minSeconds: 10, focused: false, notifyWhenFocused: false })).toBe(
		false,
	);
});
