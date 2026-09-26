import { afterEach, beforeEach, expect, test } from "bun:test";
import { EDITOR_LIMITS } from "../editor-limits";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../keybindings";
import { KILL_RING_MAX_BYTES, KillRing } from "../kill-ring";
import { Editor, type EditorTheme } from "./editor";
import { Input } from "./input";

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

let previous: KeybindingsManager;
const editors: Array<Editor | Input> = [];
beforeEach(() => {
	previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => {
	setKeybindings(previous);
	for (const editor of editors.splice(0)) editor.dispose();
});
function editorWith(text = ""): Editor {
	const editor = new Editor(theme);
	editors.push(editor);
	editor.setText(text);
	return editor;
}

test("oversized replacements preserve the draft and report rejection before inserting", () => {
	const editor = editorWith("saved draft");
	const rejected: string[] = [];
	editor.onInputRejected = reason => rejected.push(reason);
	editor.setText("😀".repeat(EDITOR_LIMITS.draftBytes / 4 + 1));
	expect(editor.getText()).toBe("saved draft");
	expect(rejected).toHaveLength(1);
	editor.setText("a".repeat(EDITOR_LIMITS.draftBytes));
	editor.insertText("b");
	expect(editor.getText().length).toBe(EDITOR_LIMITS.draftBytes);
	expect(rejected).toHaveLength(2);
});

test("history evicts oldest byte-heavy entries before its count limit", () => {
	const editor = editorWith();
	const entryBytes = 2 * 1024 * 1024;
	const prompts = Array.from({ length: 6 }, (_, i) => `${i}\n${"x".repeat(entryBytes - 2)}`);
	editor.setHistoryStorage({ getRecent: () => prompts.map(prompt => ({ prompt })), add: async () => {} });
	for (let i = 0; i < 6; i++) editor.handleInput("\x1b[A");
	expect(editor.getText().slice(0, 2)).toBe("3\n");
});

test("undo retains recent full edits while evicting byte-heavy oldest snapshots", () => {
	const base = "x".repeat(2 * 1024 * 1024);
	const editor = editorWith(base);
	for (let i = 0; i < 10; i++) editor.insertText(" ");
	for (let i = 0; i < 100; i++) editor.handleInput("\x1f");
	expect(editor.getText()).toBe(`${base}   `);
});

test("attachment admission rejects overflow without destroying earlier expansions or undo", () => {
	const editor = editorWith();
	const content = "x".repeat(4 * 1024 * 1024);
	for (let i = 0; i < 4; i++) editor.insertPaste(content);
	const accepted = editor.getText();
	let rejected = false;
	editor.onInputRejected = () => {
		rejected = true;
	};
	editor.insertPaste("overflow");
	expect(rejected).toBe(true);
	expect(editor.getText()).toBe(accepted);
	editor.handleInput("\x1f");
	expect(editor.getExpandedText().length).toBe(content.length * 3);
	editor.setText("");
	editor.insertPaste("new draft");
	expect(editor.getExpandedText()).toBe("new draft");
});

test("repeated atoms cannot amplify submission beyond its expanded byte ceiling", () => {
	const editor = editorWith();
	editor.registerAtom("[blob]", "x".repeat(2 * 1024 * 1024));
	editor.setText("[blob]".repeat(9));
	let submitted = false;
	let rejected = false;
	editor.onSubmit = () => {
		submitted = true;
	};
	editor.onInputRejected = () => {
		rejected = true;
	};
	editor.submit();
	expect(submitted).toBe(false);
	expect(rejected).toBe(true);
	expect(editor.getText()).toBe("[blob]".repeat(9));
});

test("kill-ring byte eviction preserves whole yank entries and bounded accumulation", () => {
	const ring = new KillRing();
	const half = "é".repeat(KILL_RING_MAX_BYTES / 4);
	ring.push(half, { prepend: false });
	ring.push(half, { prepend: false });
	ring.push("new", { prepend: false });
	expect(ring.length).toBe(2);
	ring.rotate();
	expect(ring.peek()).toBe(half);
	ring.push("x".repeat(KILL_RING_MAX_BYTES), { prepend: false, accumulate: true });
	expect(ring.length).toBe(1);
	expect(ring.peek()?.length).toBe(KILL_RING_MAX_BYTES);
	ring.clear();
	expect(ring.peek()).toBeUndefined();
});

test("single-line input bounds edits and undo independently of editor component", () => {
	const input = new Input();
	editors.push(input);
	const base = "x".repeat(2 * 1024 * 1024);
	input.setValue(base);
	for (let i = 0; i < 10; i++) input.pasteText(" ");
	for (let i = 0; i < 100; i++) input.handleInput("\x1f");
	expect(input.getValue()).toBe(`${base}   `);
	input.setValue("x".repeat(EDITOR_LIMITS.draftBytes + 1));
	expect(input.getValue()).toBe(`${base}   `);
});

test("expanded submissions remain durable without bypassing arrow-history draft admission", () => {
	const editor = editorWith();
	const persisted: string[] = [];
	editor.setHistoryStorage({
		getRecent: () => [],
		add: async prompt => {
			persisted.push(prompt);
		},
	});
	const expanded = "x".repeat(EDITOR_LIMITS.draftBytes + 1);
	editor.addToHistory(expanded);
	expect(persisted).toEqual([expanded]);
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe("");
});
