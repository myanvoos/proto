import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	PREVIEW_LIMITS,
	sanitizeDisplayLines,
	sanitizeDisplayWarnings,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	wrapCodeFrameLine,
} from "./render-utils";

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

test("embedded home paths shorten even when the home directory contains spaces", () => {
	expect(shortenEmbeddedPaths("/Users/Jane Smith/.proto/WATCHDOG.yml: failed", "/Users/Jane Smith")).toBe(
		"~/.proto/WATCHDOG.yml: failed",
	);
	const sibling = "/Users/Jane2/.proto/WATCHDOG.yml: failed";
	expect(shortenEmbeddedPaths(sibling, "/Users/Jane")).toBe(sibling);
});

test("display warnings are flattened, capped in count, and truncated in width", () => {
	const warnings = Array.from({ length: PREVIEW_LIMITS.COLLAPSED_ITEMS + 2 }, (_, index) => `bad\r\nentry ${index}`);
	const displayed = sanitizeDisplayWarnings(warnings);
	expect(displayed).toHaveLength(PREVIEW_LIMITS.COLLAPSED_ITEMS + 1);
	expect(displayed[0]).toBe("bad entry 0");
	expect(displayed.at(-1)).toBe("… 2 more warnings");
	const [long] = sanitizeDisplayWarnings(["warning ".repeat(TRUNCATE_LENGTHS.LONG)]);
	expect(visibleWidth(long!)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LONG);
});

test("sanitizeDisplayLines splits CRLF, keeps the last carriage-return overwrite, and expands tabs", () => {
	const lines = sanitizeDisplayLines("ssh: connect failed\r\n10%\r50%\r100% done\n\tindented\x1b[31m");
	expect(lines[0]).toBe("ssh: connect failed");
	expect(lines[1]).toBe("100% done");
	expect(lines[2]?.startsWith(" ")).toBe(true);
	for (const line of lines) expect(line).not.toMatch(/[\r\t\x1b]/);
});
