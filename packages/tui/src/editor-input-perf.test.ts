import { expect, test } from "bun:test";
import { Editor, type EditorTheme } from "./components/editor";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "./keybindings";
import { getHangulCompatibilityJamoWidth, setHangulCompatibilityJamoWidth, visibleWidth } from "./utils";

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

function editorWith(text = ""): Editor {
	const editor = new Editor(theme);
	editor.setPromptGutter("");
	editor.setText(text);
	return editor;
}

test("single printable input keeps control and navigation keys on their existing path", () => {
	const editor = editorWith("abc");

	editor.handleInput("x");
	expect(editor.getText()).toBe("abcx");

	editor.handleInput("\x1b[D");
	expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
	editor.handleInput("\x03");
	editor.handleInput("\x1b");
	expect(editor.getText()).toBe("abcx");
	expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
});

test("configured autocomplete still triggers after direct printable insertion", async () => {
	const editor = editorWith();
	let calls = 0;
	const autocompleteUpdate = Promise.withResolvers<void>();
	editor.onAutocompleteUpdate = () => autocompleteUpdate.resolve();
	editor.setAutocompleteProvider({
		async getSuggestions(lines, cursorLine, cursorCol) {
			calls++;
			expect(lines).toEqual(["@"]);
			expect(cursorLine).toBe(0);
			expect(cursorCol).toBe(1);
			return { items: [{ value: "@file", label: "@file" }], prefix: "@" };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});

	editor.handleInput("@");
	await autocompleteUpdate.promise;
	expect(calls).toBe(1);
	expect(editor.isAutocompleteActive()).toBe(true);
});

test("multiline edits and paste undo back to the exact prior states", () => {
	const editor = editorWith("one\ntwo");
	const initialCursor = editor.getCursor();

	editor.insertText("!");
	editor.pasteText("\nthree");
	expect(editor.getText()).toBe("one\ntwo!\nthree");

	editor.handleInput("\x1f");
	expect(editor.getText()).toBe("one\ntwo!");
	expect(editor.getCursor()).toEqual({ line: 1, col: 4 });

	editor.handleInput("\x1f");
	expect(editor.getText()).toBe("one\ntwo");
	expect(editor.getCursor()).toEqual(initialCursor);
});

test("visibleWidth invalidates on width changes and remains correct through FIFO eviction", () => {
	const previousWidth = getHangulCompatibilityJamoWidth();
	try {
		const jamo = "\u3131";
		setHangulCompatibilityJamoWidth("unicode");
		const unicodeWidth = visibleWidth(jamo);
		setHangulCompatibilityJamoWidth(1);
		const narrowWidth = visibleWidth(jamo);
		expect(narrowWidth).toBe(unicodeWidth - 1);
		setHangulCompatibilityJamoWidth(2);
		expect(visibleWidth(jamo)).toBe(unicodeWidth);

		const values = Array.from({ length: 2_200 }, (_, index) => `entry-${index}-界`);
		const expected = values.map(value => visibleWidth(value));
		for (let index = 0; index < values.length; index++) {
			expect(visibleWidth(values[index]!)).toBe(expected[index]);
		}
	} finally {
		setHangulCompatibilityJamoWidth(previousWidth);
	}
});

test("single-char fast path defers to custom bindings on printable keys", () => {
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteWordBackward": "z" }));
		const editor = editorWith("hello world");
		editor.handleInput("z");
		expect(editor.getText()).toBe("hello ");
		expect(editor.getText()).not.toContain("z");
	} finally {
		setKeybindings(previous);
	}
});

test("single-char fast path inserts when no printable-char binding exists", () => {
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const editor = editorWith("");
		editor.handleInput("z");
		expect(editor.getText()).toBe("z");
	} finally {
		setKeybindings(previous);
	}
});

test("dispose aborts autocomplete and suppresses late updates", async () => {
	const editor = editorWith();
	let calls = 0;
	let updates = 0;
	editor.onAutocompleteUpdate = () => {
		updates++;
	};
	editor.setAutocompleteProvider({
		async getSuggestions(_lines, _cursorLine, _cursorCol, signal) {
			calls++;
			await Promise.resolve();
			if (signal?.aborted) return null;
			return { items: [{ value: "@file", label: "@file" }], prefix: "@" };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});

	editor.handleInput("@");
	editor.dispose();
	await Promise.resolve();
	await Promise.resolve();

	expect(calls).toBe(1);
	expect(updates).toBe(0);
});
