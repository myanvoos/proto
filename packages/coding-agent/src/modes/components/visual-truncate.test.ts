import { expect, test } from "bun:test";
import { truncateToVisualLines } from "./visual-truncate";

test("sanitizes controls while truncating visual lines", () => {
	const result = truncateToVisualLines("safe\r\nbell\x07\x1b[31mred\x1b[0m\ttab", 10, 40);
	const output = result.visualLines.join("\n");
	expect(output).toContain("safe");
	expect(output).toContain("bell");
	expect(output).toContain("red");
	expect(output).toContain("tab");
	expect(output).not.toContain("\r");
	expect(output).not.toContain("\x07");
	expect(output).not.toContain("\x1b[31m");
	expect(output).not.toContain("\t");
});

test("returns no rows for a nonpositive visual-line budget", () => {
	expect(truncateToVisualLines("one\ntwo\nthree", 0, 20)).toEqual({ visualLines: [], skippedCount: 0 });
	expect(truncateToVisualLines("one\ntwo\nthree", -1, 20)).toEqual({ visualLines: [], skippedCount: 0 });
});
