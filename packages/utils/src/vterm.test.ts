import { expect, test } from "bun:test";
import { Terminal } from "./vterm";

test("alternate-screen resize restores the normal cursor on its logical line", () => {
	const terminal = new Terminal({ cols: 54, rows: 38, scrollback: 2_000, growPullsHistory: "cursorOnLastRow" });
	try {
		const rows = Array.from({ length: 180 }, (_, index) => `row-${index}`);
		terminal.write(rows.join("\r\n"));
		terminal.resize(54, 20);
		terminal.write("\x1b[?1049hpreview");
		terminal.resize(54, 38);
		terminal.write("\x1b[?1049l!");
		expect(terminal.buffer.normal.cursorY).toBe(37);
		expect(
			Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
				terminal.buffer.normal.getLine(index)?.translateToString(true),
			),
		).toEqual([...rows.slice(0, -1), "row-179!"]);
	} finally {
		terminal.dispose();
	}
});

function terminalRows(terminal: Terminal): string[] {
	return Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
		terminal.buffer.normal.getLine(index)!.translateToString(true),
	);
}

test("height resize preserves pending wrap instead of overwriting the last cell", () => {
	const terminal = new Terminal({ cols: 4, rows: 3 });
	terminal.write("abcd");
	terminal.resize(4, 4);
	terminal.write("!");
	expect(terminalRows(terminal)).toEqual(["abcd", "!", "", ""]);
	terminal.dispose();
});

test("wide-cell reflow maps the cursor to the actual packed row", () => {
	const terminal = new Terminal({ cols: 6, rows: 3 });
	terminal.write("ab界cd");
	terminal.resize(3, 4);
	terminal.write("!");
	expect(terminalRows(terminal)).toEqual(["ab", "界c", "d!", ""]);
	terminal.dispose();
});

test("repeated wide reflow does not turn wrapping padding into transcript spaces", () => {
	const terminal = new Terminal({ cols: 6, rows: 4 });
	terminal.write("ab界cd");
	for (let i = 0; i < 20; i++) {
		terminal.resize(3, 4);
		terminal.resize(6, 4);
	}
	terminal.write("!");
	expect(terminalRows(terminal)).toEqual(["ab界cd", "!", "", ""]);
	terminal.dispose();
});

test("scrollback remains bounded and ordered across large append and resize cycles", () => {
	const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 500 });
	try {
		for (let batch = 0; batch < 20; batch++) {
			for (let row = 0; row < 1_000; row++) terminal.write(`r${batch * 1_000 + row}界\r\n`);
			for (const [columns, rows] of [
				[8, 1],
				[240, 100],
				[20, 3],
				[80, 24],
			]) {
				terminal.resize(columns!, rows!);
				expect(terminal.buffer.normal.length).toBeLessThanOrEqual(500 + rows!);
				const ids = terminalRows(terminal)
					.filter(row => row.startsWith("r"))
					.map(row => Number.parseInt(row.slice(1), 10));
				expect(ids).toEqual([...ids].sort((a, b) => a - b));
				expect(new Set(ids).size).toBe(ids.length);
				expect(ids.at(-1)).toBe(batch * 1_000 + 999);
			}
		}
	} finally {
		terminal.dispose();
	}
});

test("reflow keeps wide glyph continuations at full row boundaries", () => {
	const terminal = new Terminal({ cols: 4, rows: 4 });
	terminal.write("界界界界界");
	terminal.resize(6, 4);
	expect(terminalRows(terminal)).toEqual(["界界界", "界界", "", ""]);
	terminal.dispose();
});
