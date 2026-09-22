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
