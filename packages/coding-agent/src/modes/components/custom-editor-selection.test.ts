import { expect, test } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import { Settings } from "../../config/settings";
import { getEditorTheme, initThemeSync } from "../theme/theme";
import { CustomEditor } from "./custom-editor";

await Settings.init();
initThemeSync();

function promptBox(): CustomEditor {
	const editor = new CustomEditor(getEditorTheme());
	editor.setPromptGutter("❯ ");
	editor.setUseTerminalCursor(true);
	editor.focused = true;
	return editor;
}

test("shift+arrows select in the prompt box with composer decorations active", () => {
	setKeybindings(new KeybindingsManager());
	const editor = promptBox();
	editor.setText("hello world");
	// setText leaves the cursor at the end; select "world" backwards.
	for (let i = 0; i < 5; i++) editor.handleInput("\x1b[1;2D"); // shift+left
	expect(editor.getSelectedText()).toBe("world");

	const rows = editor.render(40);
	expect(rows.join("\n")).toContain("\x1b[7mworld\x1b[27m");

	// typing replaces through the full composer stack
	editor.handleInput("there");
	expect(editor.getText()).toBe("hello there");
	expect(editor.hasSelection()).toBe(false);
});

test("shift+up extends the selection instead of dequeuing; alt+up still dequeues", () => {
	setKeybindings(new KeybindingsManager());
	const editor = promptBox();
	let dequeues = 0;
	editor.onDequeue = () => dequeues++;

	editor.setText("say hi");
	editor.handleInput("\x1b[1;2A"); // shift+up extends to the buffer start
	expect(dequeues).toBe(0);
	expect(editor.getSelectedText()).toBe("say hi");

	editor.clearSelection();
	editor.handleInput("\x1b[1;3A"); // alt+up still dequeues
	expect(dequeues).toBe(1);
});

test("ctrl+c copies a visible selection and clears the draft without one", () => {
	setKeybindings(new KeybindingsManager());
	const editor = promptBox();
	const copied: string[] = [];
	editor.onCopySelection = text => copied.push(text);
	let clears = 0;
	editor.onClear = () => {
		clears++;
		editor.setText("");
	};

	editor.setText("say hi");
	editor.handleInput("\x03"); // no selection: still clears the draft
	expect(copied).toEqual([]);
	expect(clears).toBe(1);
	expect(editor.getText()).toBe("");

	editor.setText("say hi");
	editor.handleInput("\x1b[1;2D"); // shift+left selects "i"
	editor.handleInput("\x03");
	expect(copied).toEqual(["i"]);
	expect(clears).toBe(1);
	expect(editor.hasSelection()).toBe(false);
	// The selection is gone, so the next Ctrl+C clears again.
	editor.handleInput("\x03");
	expect(clears).toBe(2);
});
