import { expect, test } from "bun:test";
import { wrapTextWithAnsi } from "./utils";

test("mutating a wrapTextWithAnsi result must not corrupt later wraps of the same text", () => {
	// Longer than the width, so the text takes the memoized native path rather than
	// the short plain-ASCII fast path.
	const text =
		"wrap cache entries are shared across every component render — appended rows would leak into later frames";
	const width = 32;
	const pristine = wrapTextWithAnsi(text, width).join("\n");

	const first = wrapTextWithAnsi(text, width);
	first.push("POISONED ROW");

	expect(wrapTextWithAnsi(text, width).join("\n")).toBe(pristine);
	expect(wrapTextWithAnsi(text, width)).not.toContain("POISONED ROW");
});

test("each wrapTextWithAnsi call returns an independent array", () => {
	const text = "two callers appending to their own results must not observe each other's rows in any frame";
	const width = 24;
	const a = wrapTextWithAnsi(text, width);
	const b = wrapTextWithAnsi(text, width);
	expect(a).toEqual(b);
	expect(a).not.toBe(b);
	a.push("A-ONLY ROW");
	expect(b).not.toContain("A-ONLY ROW");
});
