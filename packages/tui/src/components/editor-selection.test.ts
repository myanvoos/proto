import { afterEach, beforeEach, expect, test } from "bun:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../keybindings";
import { CURSOR_MARKER } from "../tui";
import { Editor, type EditorTheme } from "./editor";

const identity = (text: string): string => text;
const symbols = {
	cursor: "❯",
	inputCursor: "▌",
	boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	boxSharp: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		teeDown: "┬",
		teeUp: "┴",
		teeLeft: "┤",
		teeRight: "├",
		cross: "┼",
	},
	table: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		teeDown: "┬",
		teeUp: "┴",
		teeLeft: "┤",
		teeRight: "├",
		cross: "┼",
	},
	quoteBorder: "│",
	hrChar: "─",
	spinnerFrames: ["|"],
};

const theme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
		symbols,
	},
	symbols,
};

const SHIFT_LEFT = "\x1b[1;2D";
const SHIFT_RIGHT = "\x1b[1;2C";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const SHIFT_HOME = "\x1b[1;2H";
const SHIFT_END = "\x1b[1;2F";
const SHIFT_ALT_LEFT = "\x1b[1;4D";
const SHIFT_ALT_RIGHT = "\x1b[1;4C";

let previousKeybindings: KeybindingsManager | undefined;

beforeEach(() => {
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

afterEach(() => {
	if (previousKeybindings) setKeybindings(previousKeybindings);
});

function editorWith(text = ""): Editor {
	const editor = new Editor(theme);
	editor.setPromptGutter("");
	editor.setUseTerminalCursor(true);
	editor.focused = true;
	editor.setText(text);
	return editor;
}

test("shift+left/right extend a selection and report the text between anchor and cursor", () => {
	const editor = editorWith("hello");
	editor.handleInput("\x1b[H"); // home
	editor.handleInput("\x1b[C");
	editor.handleInput("\x1b[C"); // cursor after "he"
	editor.handleInput(SHIFT_RIGHT);
	editor.handleInput(SHIFT_RIGHT);
	expect(editor.getSelectedText()).toBe("ll");
	expect(editor.getCursor()).toEqual({ line: 0, col: 4 });

	editor.handleInput(SHIFT_LEFT);
	expect(editor.getSelectedText()).toBe("l");
	// Collapsing back onto the anchor keeps it alive so the selection can
	// re-extend from the same origin on the other side.
	editor.handleInput(SHIFT_LEFT);
	expect(editor.getSelectedText()).toBe("");
	editor.handleInput(SHIFT_LEFT);
	expect(editor.getSelectedText()).toBe("e");
});

test("plain cursor movement collapses the selection", () => {
	const editor = editorWith("hello");
	editor.handleInput(SHIFT_LEFT);
	expect(editor.hasSelection()).toBe(true);
	editor.handleInput("\x1b[D");
	expect(editor.hasSelection()).toBe(false);
	expect(editor.getText()).toBe("hello");
});

test("typing replaces the selected range", () => {
	const editor = editorWith("hello");
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput("X");
	expect(editor.getText()).toBe("helX");
	expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
	expect(editor.hasSelection()).toBe(false);
});

test("backspace and forward delete remove the whole selection", () => {
	const editor = editorWith("hello");
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput("\x7f");
	expect(editor.getText()).toBe("hel");

	const editor2 = editorWith("hello");
	editor2.handleInput(SHIFT_LEFT);
	editor2.handleInput(SHIFT_LEFT);
	editor2.handleInput("\x1b[3~");
	expect(editor2.getText()).toBe("hel");
});

test("undo restores the text removed by a selection delete", () => {
	const editor = editorWith("hello");
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput("\x7f");
	expect(editor.getText()).toBe("hel");
	editor.handleInput("\x1f");
	expect(editor.getText()).toBe("hello");
});

test("shift+up/down build multi-line selections across rows", () => {
	const editor = editorWith("one\ntwo\nthree");
	editor.handleInput("\x1b[H"); // home on the last line
	editor.handleInput(SHIFT_UP);
	editor.handleInput(SHIFT_UP);
	expect(editor.getSelectedText()).toBe("one\ntwo\n");
	editor.handleInput(SHIFT_DOWN);
	expect(editor.getSelectedText()).toBe("two\n");
	editor.handleInput(SHIFT_DOWN);
	expect(editor.getSelectedText()).toBe("");
});

test("shift+up on the first line extends to the buffer start without touching history", () => {
	const editor = editorWith("hi");
	editor.addToHistory("previously");
	editor.handleInput(SHIFT_LEFT); // anchor at end, head after "h"
	editor.handleInput(SHIFT_UP);
	expect(editor.getSelectedText()).toBe("hi");
	expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	// Navigating history would have replaced the buffer text.
	expect(editor.getText()).toBe("hi");
});

test("shift+down on the last line extends to the buffer end without touching history", () => {
	const editor = editorWith("one\ntwo");
	editor.addToHistory("previously");
	editor.handleInput("\x1b[H"); // home on the last line
	editor.handleInput(SHIFT_DOWN);
	expect(editor.getSelectedText()).toBe("two");
	expect(editor.getCursor()).toEqual({ line: 1, col: 3 });
	expect(editor.getText()).toBe("one\ntwo");
});

test("shift+home/end select to the line boundaries", () => {
	const editor = editorWith("hello");
	editor.handleInput("\x1b[H");
	editor.handleInput(SHIFT_END);
	expect(editor.getSelectedText()).toBe("hello");

	const editor2 = editorWith("hello");
	editor2.handleInput(SHIFT_HOME);
	expect(editor2.getSelectedText()).toBe("hello");
});

test("shift+alt+arrows extend by word", () => {
	const editor = editorWith("foo bar baz");
	editor.handleInput(SHIFT_ALT_LEFT);
	expect(editor.getSelectedText()).toBe("baz");
	editor.handleInput(SHIFT_ALT_LEFT);
	expect(editor.getSelectedText()).toBe("bar baz");
	editor.handleInput(SHIFT_ALT_RIGHT);
	expect(editor.getSelectedText()).toBe(" baz");
	editor.handleInput(SHIFT_ALT_RIGHT);
	expect(editor.getSelectedText()).toBe("");
});

test("ctrl+c reports the selection to the copy handler and is inert without one", () => {
	const editor = editorWith("hello");
	const copied: string[] = [];
	editor.onCopySelection = text => copied.push(text);

	editor.handleInput("\x03");
	expect(copied).toEqual([]);

	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput("\x03");
	expect(copied).toEqual(["lo"]);
});

test("kill commands remove the selection into the kill ring and yank restores it", () => {
	const editor = editorWith("foo bar");
	editor.handleInput(SHIFT_ALT_LEFT);
	editor.handleInput("\x17"); // ctrl+w
	expect(editor.getText()).toBe("foo ");
	editor.handleInput("\x19"); // ctrl+y
	expect(editor.getText()).toBe("foo bar");
});

test("paste replaces the selection", () => {
	const editor = editorWith("hello");
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	editor.pasteText("Z!");
	expect(editor.getText()).toBe("helZ!");
});

test("rendering highlights the selected span with reverse video", () => {
	const editor = editorWith("hello");
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	const rows = editor.render(20);
	expect(rows[0]).toBe(`hel${CURSOR_MARKER}\x1b[7mlo\x1b[27m               `);

	// Clearing the selection must not leave stale highlight from the render cache.
	editor.clearSelection();
	const cleared = editor.render(20);
	expect(cleared[0]).toBe(`hel${CURSOR_MARKER}lo               `);
});

test("rendering reverse-pads lines whose newline is inside the selection", () => {
	const editor = editorWith("one\ntwo\nthree");
	editor.handleInput("\x1b[A"); // up to the end of "two"
	editor.handleInput(SHIFT_UP); // head at end of "one", anchor at (1,3)
	const rows = editor.render(10);
	// Line 0: selection starts at EOL; the trailing pad shows the covered newline.
	expect(rows[0]).toBe(`one${CURSOR_MARKER}\x1b[7m       \x1b[27m`);
	// Line 1: fully covered text.
	expect(rows[1]).toBe(`\x1b[7mtwo\x1b[27m       `);
});

test("rendering reverse-pads empty lines strictly inside a multi-line selection", () => {
	const editor = editorWith("a\n\nb");
	editor.setText("a\n\nb");
	editor.moveToMessageEnd(); // cursor after "b"
	editor.handleInput(SHIFT_UP);
	editor.handleInput(SHIFT_UP);
	const rows = editor.render(5);
	expect(rows[0]).toBe(`a${CURSOR_MARKER}\x1b[7m    \x1b[27m`);
	expect(rows[1]).toBe(`\x1b[7m     \x1b[27m`);
	expect(rows[2]).toBe(`\x1b[7mb\x1b[27m    `);
});

test("selection survives text width that equals the wrapped layout boundary", () => {
	const editor = editorWith("abcdefgh");
	editor.handleInput(SHIFT_LEFT);
	editor.handleInput(SHIFT_LEFT);
	const rows = editor.render(4);
	expect(rows[0]).toBe("abcd");
	expect(rows[1]).toBe(`ef${CURSOR_MARKER}\x1b[7mgh\x1b[27m`);
});

test("a single-row history entry opens at its end for both arrows", () => {
	const editor = editorWith("");
	editor.addToHistory("older prompt");
	editor.addToHistory("recent prompt");

	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 0, col: "recent prompt".length });
	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 0, col: "older prompt".length });
	editor.handleInput("\x1b[B");
	expect(editor.getText()).toBe("recent prompt");
	expect(editor.getCursor()).toEqual({ line: 0, col: "recent prompt".length });
	editor.handleInput("\x1b[B");
	expect(editor.getText()).toBe("");
});

test("a history entry that wraps past the layout width keeps its top anchor on Up", () => {
	const editor = editorWith("");
	const wrapped = "word ".repeat(40).trim();
	editor.addToHistory("older");
	editor.addToHistory(wrapped);

	editor.handleInput("\x1b[A");
	expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe("older");
});

test("end-of-line and on-last-character cursors render differently on a full row", () => {
	const atEnd = editorWith("abc");
	const onLast = editorWith("abc");
	onLast.handleInput("\x1b[D");

	const [endRow] = atEnd.render(3);
	const [onRow] = onLast.render(3);
	expect(endRow).not.toBe(onRow);
	expect(endRow).toBe(`ab\x1b[4mc\x1b[0m${CURSOR_MARKER}`);
});
