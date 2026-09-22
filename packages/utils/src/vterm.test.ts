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

test("CSI scroll-up discards screen rows while line feed retains native history", () => {
	for (const [sequence, expected] of [
		["\x1b[2S", ["c", "", ""]],
		["\x1b[3;1H\n\n", ["a", "b", "c", "", ""]],
	] as const) {
		const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 100 });
		try {
			terminal.write(`a\r\nb\r\nc${sequence}`);
			expect(terminalRows(terminal)).toEqual([...expected]);
		} finally {
			terminal.dispose();
		}
	}
});

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
	// The height grow adds a row; native xterm keeps the same buffer length for
	// this resize when the cursor sits off the wrapped line.
	expect(terminalRows(terminal)).toEqual(["ab", "界c", "d!", "", ""]);
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

test("height growth does not discard trailing blank screen rows before pulling history", () => {
	const terminal = new Terminal({ cols: 20, rows: 4, growPullsHistory: "always" });
	try {
		terminal.write(Array.from({ length: 10 }, (_, index) => `row-${index}`).join("\r\n"));
		terminal.write("\x1b[2;1H\x1b[J");
		const before = terminalRows(terminal);
		terminal.resize(20, 6);
		expect(terminalRows(terminal)).toEqual(before);
		expect(terminal.buffer.normal.baseY).toBe(4);
		expect(terminal.buffer.normal.cursorY).toBe(3);
	} finally {
		terminal.dispose();
	}
});

test("height shrink discards no more than the removed screen rows", () => {
	const terminal = new Terminal({ cols: 20, rows: 4, growPullsHistory: "always" });
	try {
		terminal.write(Array.from({ length: 10 }, (_, index) => `row-${index}`).join("\r\n"));
		terminal.write("\x1b[2;1H\x1b[J");
		const before = terminalRows(terminal);
		terminal.resize(20, 3);
		expect(terminalRows(terminal)).toEqual(before.slice(0, -1));
		expect(terminal.buffer.normal.baseY).toBe(6);
		expect(terminal.buffer.normal.cursorY).toBe(1);
	} finally {
		terminal.dispose();
	}
});

test("saved bottom cursor tracks populated xterm width reflow before restoring the editor", () => {
	const terminal = new Terminal({ cols: 40, rows: 6, scrollback: 1000, growPullsHistory: "cursorOnLastRow" });
	try {
		terminal.write(
			Array.from({ length: 30 }, (_, i) => `history-${i}`).join("\r\n") +
				"\r\n\r\neditor ask anything / for commands\r\nstatus-full-width-xxxxxxxxxxxxxxxxxxxx\r\n\x1b[6;1H\x1b7\x1b[4;7H",
		);
		terminal.resize(20, 10);
		terminal.write("\x1b8");
		// Independently measured using the same bytes with native @xterm/headless.
		expect(terminal.buffer.normal.baseY).toBe(30);
		expect(terminal.buffer.normal.cursorY).toBe(5);
		expect(terminalRows(terminal).slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `history-${i}`));
		expect(terminalRows(terminal).slice(30)).toEqual([
			"",
			"editor ask anything ",
			"/ for commands",
			"status-full-width-xx",
			"xxxxxxxxxxxxxxxxxx",
			"",
			"",
			"",
			"",
			"",
		]);
	} finally {
		terminal.dispose();
	}
});
