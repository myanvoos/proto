import { afterEach, beforeEach, expect, test } from "bun:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../keybindings";
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
const SHIFT_ALT_LEFT = "\x1b[1;4D";
const SHIFT_HOME = "\x1b[1;2H";
const UNDO = "\x1f";
const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

let previous: KeybindingsManager | undefined;
beforeEach(() => {
	previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => {
	if (previous) setKeybindings(previous);
});

function editorWith(text = ""): Editor {
	const editor = new Editor(theme);
	editor.setPromptGutter("");
	editor.setUseTerminalCursor(true);
	editor.focused = true;
	editor.setText(text);
	return editor;
}

const WIDE = "A界B🇯🇵C👨‍👩‍👧‍👦D🏳️‍🌈E";

test("typing over a selection undoes in one step, for typed, pasted and wide-grapheme text", () => {
	for (const seed of ["ABCDE", WIDE]) {
		for (const select of [[SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT], [SHIFT_ALT_LEFT], [SHIFT_HOME]]) {
			for (const entry of [
				(editor: Editor) => editor.handleInput("Z"),
				(editor: Editor) => editor.handleInput(PASTE("Z")),
			]) {
				const editor = editorWith(seed);
				for (const key of select) editor.handleInput(key);
				const removed = editor.getSelectedText();
				expect(removed.length).toBeGreaterThan(0);
				entry(editor);
				const replaced = editor.getText();
				expect(replaced).toBe(`${seed.slice(0, seed.length - removed.length)}Z`);
				editor.handleInput(UNDO);
				expect(editor.getText()).toBe(seed);
				expect(editor.hasSelection()).toBe(false);
			}
		}
	}
});

test("a typing run that replaces a selection stays one undo group; a word break starts the next", () => {
	const run = editorWith("ABCDE");
	for (let i = 0; i < 3; i++) run.handleInput(SHIFT_LEFT);
	run.handleInput("Z");
	run.handleInput("Y");
	run.handleInput("X");
	expect(run.getText()).toBe("ABZYX");
	run.handleInput(UNDO);
	expect(run.getText()).toBe("ABCDE");

	const broken = editorWith("ABCDE");
	for (let i = 0; i < 3; i++) broken.handleInput(SHIFT_LEFT);
	broken.handleInput("Z");
	broken.handleInput(" ");
	broken.handleInput("W");
	expect(broken.getText()).toBe("ABZ W");
	broken.handleInput(UNDO);
	expect(broken.getText()).toBe("ABZ ");
	broken.handleInput(UNDO);
	expect(broken.getText()).toBe("ABZ");
	broken.handleInput(UNDO);
	expect(broken.getText()).toBe("ABCDE");
});

test("non-selection undo paths keep their existing granularity", () => {
	const typing = editorWith("");
	typing.handleInput("hello");
	typing.handleInput(" ");
	typing.handleInput("world");
	expect(typing.getText()).toBe("hello world");
	typing.handleInput(UNDO);
	expect(typing.getText()).toBe("hello ");
	typing.handleInput(UNDO);
	expect(typing.getText()).toBe("hello");
	typing.handleInput(UNDO);
	expect(typing.getText()).toBe("");

	const deleting = editorWith("hello");
	deleting.handleInput("\x7f");
	expect(deleting.getText()).toBe("hell");
	deleting.handleInput(UNDO);
	expect(deleting.getText()).toBe("hello");

	const pasting = editorWith("start ");
	pasting.handleInput(PASTE("pasted"));
	expect(pasting.getText()).toBe("start pasted");
	pasting.handleInput(UNDO);
	expect(pasting.getText()).toBe("start ");

	const newline = editorWith("ab");
	newline.handleInput("\x1b\r");
	expect(newline.getText()).toBe("ab\n");
	newline.handleInput(UNDO);
	expect(newline.getText()).toBe("ab");

	const newlineOverSelection = editorWith("ABCDE");
	for (let i = 0; i < 3; i++) newlineOverSelection.handleInput(SHIFT_LEFT);
	newlineOverSelection.handleInput("\x1b\r");
	expect(newlineOverSelection.getText()).toBe("AB\n");
	newlineOverSelection.handleInput(UNDO);
	expect(newlineOverSelection.getText()).toBe("ABCDE");

	const backspaceOverSelection = editorWith("ABCDE");
	for (let i = 0; i < 3; i++) backspaceOverSelection.handleInput(SHIFT_LEFT);
	backspaceOverSelection.handleInput("\x7f");
	expect(backspaceOverSelection.getText()).toBe("AB");
	backspaceOverSelection.handleInput(UNDO);
	expect(backspaceOverSelection.getText()).toBe("ABCDE");
});
