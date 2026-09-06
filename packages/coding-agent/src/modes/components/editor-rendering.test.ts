import { expect, test } from "bun:test";
import { CURSOR_MARKER, Editor, visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { getEditorTheme, initThemeSync } from "../theme/theme";

await Settings.init();
initThemeSync();

function editorWith(text: string): Editor {
	const editor = new Editor(getEditorTheme());
	editor.setPromptGutter("");
	editor.setUseTerminalCursor(true);
	editor.focused = true;
	editor.setText(text);
	return editor;
}

test("wrapped editor text retains its source indentation and shows cursor movement within it", () => {
	const editor = editorWith("  abcde");
	expect(editor.render(4)[0]).toBe("  ab");
	editor.handleInput("\x01");
	editor.handleInput("\x1b[C");
	expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	expect(editor.render(4)[0]).toBe(` ${CURSOR_MARKER} ab`);
	editor.handleInput("\x7f");
	expect(editor.getText()).toBe(" abcde");
	expect(editor.render(4)[0]).toBe(`${CURSOR_MARKER} abc`);
});

test("indentation wider than the viewport remains visible and navigable across wrapped rows", () => {
	const editor = editorWith("      abc");
	const rows = editor.render(4);
	expect(rows[0]).toBe("    ");
	expect(rows[1]).toBe("    ");
	expect(rows[2]).toContain("abc");
	editor.handleInput("\x01");
	for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
	expect(editor.render(4)[1]).toBe(` ${CURSOR_MARKER}   `);
	expect(editor.render(4).every(line => visibleWidth(line) <= 4)).toBe(true);
});
