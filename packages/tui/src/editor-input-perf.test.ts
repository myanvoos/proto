import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CombinedAutocompleteProvider, type SlashCommand } from "./autocomplete";
import {
	Editor,
	type EditorInlineReplacement,
	type EditorTheme,
	type EditorWordReplacements,
} from "./components/editor";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "./keybindings";
import { CURSOR_MARKER } from "./tui";
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

test("consecutive typed word characters undo as one step", () => {
	const editor = editorWith();

	editor.handleInput("a");
	editor.handleInput("b");
	editor.handleInput("c");
	expect(editor.getText()).toBe("abc");

	editor.handleInput("\x1f");
	expect(editor.getText()).toBe("");
});

test("inline replacement breaks the following typing undo group", () => {
	const editor = editorWith();
	editor.setAutocompleteProvider({
		async getSuggestions() {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
		trySyncInlineReplace(textBeforeCursor) {
			return textBeforeCursor === "teh" ? { replaceLen: 3, insert: "the" } : null;
		},
	});

	editor.handleInput("t");
	editor.handleInput("e");
	editor.handleInput("h");
	expect(editor.getText()).toBe("the");

	editor.handleInput("x");
	editor.handleInput("\x1f");
	expect(editor.getText()).toBe("the");
});

test("swapping autocomplete providers clears the old completion list", async () => {
	const editor = editorWith();
	let oldApplied = 0;
	const autocompleteShown = Promise.withResolvers<void>();
	editor.onAutocompleteUpdate = () => autocompleteShown.resolve();
	editor.setAutocompleteProvider({
		async getSuggestions() {
			return { items: [{ value: "OLD", label: "OLD" }], prefix: "@" };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			oldApplied++;
			return { lines, cursorLine, cursorCol };
		},
	});

	editor.handleInput("@");
	await autocompleteShown.promise;
	expect(editor.isAutocompleteActive()).toBe(true);

	let newApplied = 0;
	editor.setAutocompleteProvider({
		async getSuggestions() {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			newApplied++;
			return { lines, cursorLine, cursorCol };
		},
	});
	expect(editor.isAutocompleteActive()).toBe(false);

	editor.handleInput("\t");
	await Promise.resolve();
	await Promise.resolve();
	expect(editor.getText()).toBe("@");
	expect(oldApplied).toBe(0);
	expect(newApplied).toBe(0);
});

test("swapping text assist providers clears and invalidates old spelling suggestions", async () => {
	const editor = editorWith("teh");
	const first = Promise.withResolvers<EditorWordReplacements | null>();
	const second = Promise.withResolvers<EditorWordReplacements | null>();
	let calls = 0;
	editor.setTextAssistProvider({
		getWordReplacements() {
			calls++;
			return (calls === 1 ? first : second).promise;
		},
	});

	editor.handleInput("\x1b[27;5;46~");
	first.resolve({ line: 0, startCol: 0, endCol: 3, items: ["old"] });
	await Promise.resolve();
	await Promise.resolve();
	expect(editor.isAutocompleteActive()).toBe(true);

	editor.handleInput("\x1b[27;5;46~");
	editor.setTextAssistProvider({});
	expect(editor.isAutocompleteActive()).toBe(false);
	second.resolve({ line: 0, startCol: 0, endCol: 3, items: ["stale"] });
	await Promise.resolve();
	await Promise.resolve();
	expect(editor.isAutocompleteActive()).toBe(false);
	expect(editor.getText()).toBe("teh");
});

test("swapping text assist providers suppresses old async autocorrection", async () => {
	const editor = editorWith();
	const pending = Promise.withResolvers<EditorInlineReplacement | null>();
	editor.setTextAssistProvider({
		tryAutocorrect() {
			return pending.promise;
		},
	});

	editor.handleInput("x");
	editor.setTextAssistProvider({});
	pending.resolve({ replaceLen: 1, insert: "OLD" });
	await Promise.resolve();
	await Promise.resolve();
	expect(editor.getText()).toBe("x");
});

test("submit resets volatile text bookkeeping before the next draft", () => {
	const editor = editorWith();
	let submitted = "";
	editor.onSubmit = text => {
		submitted = text;
	};

	editor.setVolatileText("abc");
	editor.submit();
	editor.handleInput("new");
	editor.clearVolatileText();

	expect(submitted).toBe("abc");
	expect(editor.getText()).toBe("new");
});

test("undo resets volatile text bookkeeping before the next draft", () => {
	const editor = editorWith();
	editor.insertText("base");
	editor.setVolatileText("abc");
	expect(editor.getText()).toBe("baseabc");

	editor.handleInput("\x1f");
	expect(editor.getText()).toBe("");
	editor.handleInput("new");
	editor.clearVolatileText();

	expect(editor.getText()).toBe("new");
});

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "clear", description: "Clear the conversation context in place, keeping the session" },
	{ name: "model", description: "Switch model for this session" },
];

/** Editor showing the live suggestion list for the slash prefix `text`. */
async function editorWithOpenSlashList(text: string): Promise<{ editor: Editor; submitted: string[] }> {
	const editor = editorWith(text.slice(0, -1));
	const submitted: string[] = [];
	editor.onSubmit = value => {
		submitted.push(value);
	};
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, "/tmp"));
	const listShown = Promise.withResolvers<void>();
	editor.onAutocompleteUpdate = () => listShown.resolve();
	editor.handleInput(text.slice(-1));
	await listShown.promise;
	expect(editor.isAutocompleteActive()).toBe(true);
	return { editor, submitted };
}

test("Enter submits the typed command instead of a description-only match nobody selected", async () => {
	// `/help` matches no command name; `clear` is only a fuzzy hit on its description.
	const { editor, submitted } = await editorWithOpenSlashList("/help");

	editor.handleInput("\r");

	expect(submitted).toEqual(["/help"]);
	expect(editor.isAutocompleteActive()).toBe(false);
	expect(editor.getText()).toBe("");
});

test("Enter accepts a description-only match once the user navigated to it", async () => {
	const { editor, submitted } = await editorWithOpenSlashList("/help");

	editor.handleInput("\x1b[B");
	editor.handleInput("\r");

	expect(submitted).toEqual(["/clear"]);
});

test("Tab still completes the highlighted description-only match", async () => {
	const { editor, submitted } = await editorWithOpenSlashList("/help");

	editor.handleInput("\t");

	expect(editor.getText()).toBe("/clear ");
	expect(submitted).toEqual([]);
});

test("Enter without an open list only auto-completes a name match on submit", () => {
	const editor = editorWith();
	const submitted: string[] = [];
	editor.onSubmit = value => {
		submitted.push(value);
	};
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, "/tmp"));

	editor.setText("/help");
	editor.handleInput("\r");
	editor.setText("/mod");
	editor.handleInput("\r");

	expect(submitted).toEqual(["/help", "/model"]);
});

test("Enter resolves the current slash text instead of accepting an unnavigated stale row", async () => {
	const { editor, submitted } = await editorWithOpenSlashList("/");
	for (const char of "help") editor.handleInput(char);

	// Submit before the debounced refresh replaces the list opened for `/`.
	editor.handleInput("\r");

	expect(submitted).toEqual(["/help"]);
});

test("host row budget keeps input and selected completion visible while resizing", async () => {
	const editor = editorWith();
	editor.focused = true;
	editor.setUseTerminalCursor(true);
	const shown = Promise.withResolvers<void>();
	editor.onAutocompleteUpdate = () => shown.resolve();
	editor.setAutocompleteProvider({
		async getSuggestions() {
			return { items: ["alpha", "beta", "gamma", "delta"].map(value => ({ value, label: value })), prefix: "@" };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	});
	try {
		editor.handleInput("@");
		await shown.promise;
		for (const height of [6, 2, 1, 3, 2, 10]) {
			editor.setViewportHeight(height);
			const rows = editor.render(20);
			expect(rows.length).toBeLessThanOrEqual(height);
			expect(rows.filter(row => row.includes(CURSOR_MARKER))).toHaveLength(1);
			if (height > 1) expect(rows.some(row => row.includes("❯") && row.includes("alpha"))).toBe(true);
		}
		editor.setViewportHeight(2);
		editor.handleInput("\x1b[B");
		const rows = editor.render(20);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toContain("beta");
		expect(rows[1]).toContain("❯");
	} finally {
		editor.dispose();
	}
});

/** Resolve once the popup is open, driven by autocomplete update events. */
async function untilAutocompleteShown(editor: Editor): Promise<void> {
	while (!editor.isShowingAutocomplete()) {
		const update = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = () => update.resolve();
		await update.promise;
	}
}

/** Drain queued microtasks so a chained autocomplete re-trigger reaches the provider. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("accepting an @ directory with Enter reopens the popup on its children", async () => {
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-at-directory-enter-"));
	try {
		fs.mkdirSync(path.join(baseDir, "packages", "tui"), { recursive: true });
		fs.mkdirSync(path.join(baseDir, "packages", "utils"), { recursive: true });
		const editor = editorWith("@pack");
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], baseDir));
		const submitted: string[] = [];
		editor.onSubmit = value => {
			submitted.push(value);
		};

		editor.handleInput("\t");
		await untilAutocompleteShown(editor);
		editor.handleInput("\r");
		expect(editor.getText()).toBe("@packages/");
		await untilAutocompleteShown(editor);

		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(submitted).toEqual([]);
		editor.dispose();
	} finally {
		fs.rmSync(baseDir, { recursive: true, force: true });
	}
});

test("Enter on a slash-command directory argument does not chain into its children", async () => {
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-slash-directory-enter-"));
	try {
		const target = `${baseDir.replace(/\\/g, "/")}/sibling`;
		fs.mkdirSync(path.join(target, "child"), { recursive: true });
		const editor = editorWith(`/move ${target}`);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const suggestionRequests = spyOn(provider, "getSuggestions");
		editor.setAutocompleteProvider(provider);
		const submitted: string[] = [];
		editor.onSubmit = value => {
			submitted.push(value);
		};

		editor.handleInput("\t");
		await untilAutocompleteShown(editor);
		const requestsBeforeAccept = suggestionRequests.mock.calls.length;
		editor.handleInput("\r");
		await drainMicrotasks();
		// Chaining would reopen the popup on the directory's children, so every
		// following Enter descends a level instead of running the command.
		expect(suggestionRequests.mock.calls.length).toBe(requestsBeforeAccept);
		expect(editor.isShowingAutocomplete()).toBe(false);

		editor.handleInput("\r");
		expect(submitted).toHaveLength(1);
		expect(submitted[0]?.startsWith("/move ")).toBe(true);
		editor.dispose();
	} finally {
		fs.rmSync(baseDir, { recursive: true, force: true });
	}
});

test("typing an argument separator re-evaluates a closed slash-command popup", async () => {
	const argumentPrefixes: string[] = [];
	const editor = editorWith();
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			[
				{
					name: "probe",
					getArgumentCompletions(argumentPrefix) {
						argumentPrefixes.push(argumentPrefix);
						return /^\S+\s/.test(argumentPrefix) ? [{ value: "scope", label: "scope" }] : null;
					},
				},
			],
			"/tmp",
		),
	);

	editor.handleInput("/");
	await untilAutocompleteShown(editor);
	for (const char of "probe a") editor.handleInput(char);
	while (editor.isShowingAutocomplete()) {
		const update = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = () => update.resolve();
		await update.promise;
	}
	expect(argumentPrefixes.at(-1)).toBe("a");

	editor.handleInput(" ");
	await untilAutocompleteShown(editor);
	expect(argumentPrefixes.at(-1)).toBe("a ");
	editor.dispose();
});

test("right arrow at end of line accepts the slash popup selection; mid-line it only moves", async () => {
	const open = async (): Promise<Editor> => {
		const editor = editorWith();
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "skills:fix-bug", description: "Fix a bug" }], "/tmp"),
		);
		editor.handleInput("/");
		await untilAutocompleteShown(editor);
		for (const char of "ski") editor.handleInput(char);
		await untilAutocompleteShown(editor);
		return editor;
	};

	const atEnd = await open();
	atEnd.handleInput("\x1b[C");
	expect(atEnd.getText()).toBe("/skills:fix-bug ");
	atEnd.dispose();

	const midLine = await open();
	midLine.handleInput("\x1b[D");
	midLine.handleInput("\x1b[C");
	expect(midLine.getText()).toBe("/ski");
	expect(midLine.getCursor()).toEqual({ line: 0, col: 4 });
	midLine.dispose();
});

test("right arrow accepts an inline word completion only at end of line", () => {
	const completeWeather = {
		getWordCompletion: (lines: string[], line: number, col: number) =>
			(lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null,
	};
	const atEnd = editorWith("The weath");
	atEnd.setTextAssistProvider(completeWeather);
	atEnd.handleInput("\x1b[C");
	expect(atEnd.getText()).toBe("The weather ");
	expect(atEnd.getCursor()).toEqual({ line: 0, col: 12 });

	const midLine = editorWith("The weath end");
	midLine.setTextAssistProvider(completeWeather);
	midLine.handleInput("\x01");
	for (let i = 0; i < 10; i++) midLine.handleInput("\x1b[C");
	expect(midLine.getText()).toBe("The weath end");
	expect(midLine.getCursor()).toEqual({ line: 0, col: 10 });
});
