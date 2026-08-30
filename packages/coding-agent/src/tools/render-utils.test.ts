import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { wrapCodeFrameLine } from "./render-utils";

test("wrapCodeFrameLine aligns wrapped continuation rows under the content column", () => {
	const line = " 42│const total = computeSomethingVeryLong(argumentOne, argumentTwo, argumentThree, argumentFour);";
	const rows = wrapCodeFrameLine(line, 24);
	expect(rows.length).toBeGreaterThan(1);

	const separatorColumns = rows.map(row => row.indexOf("│"));
	expect(new Set(separatorColumns).size).toBe(1);

	for (const row of rows) {
		expect(visibleWidth(row)).toBeLessThanOrEqual(24);
	}

	expect(rows[0]!.startsWith(" 42│")).toBe(true);
	for (const row of rows.slice(1)) {
		expect(row).toMatch(/^ +│/);
	}
});

test("wrapCodeFrameLine preserves leading ANSI color across wrapped rows", () => {
	const color = "\x1b[31m";
	const reset = "\x1b[39m";
	const line = `${color} 7│some long line of content that will definitely wrap past the width budget${reset}`;
	const rows = wrapCodeFrameLine(line, 20);
	expect(rows.length).toBeGreaterThan(1);
	for (const row of rows) {
		expect(row.startsWith(color)).toBe(true);
		expect(visibleWidth(row)).toBeLessThanOrEqual(20);
	}
});

test("wrapCodeFrameLine wraps gutter-less lines via plain ANSI wrapping", () => {
	const rows = wrapCodeFrameLine("plain status line that is quite long and needs wrapping to fit", 20);
	expect(rows.length).toBeGreaterThan(1);
	for (const row of rows) {
		expect(visibleWidth(row)).toBeLessThanOrEqual(20);
		expect(row).not.toContain("│");
	}
});
