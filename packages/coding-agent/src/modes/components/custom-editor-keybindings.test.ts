import { expect, test } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../config/keybindings";
import { Settings } from "../../config/settings";
import { getEditorTheme, initThemeSync } from "../theme/theme";
import { CustomEditor } from "./custom-editor";

await Settings.init();
initThemeSync();

const CTRL_D = "\x04";

function composer(text: string): { editor: CustomEditor; exits: () => number } {
	setKeybindings(new KeybindingsManager());
	const editor = new CustomEditor(getEditorTheme());
	let exits = 0;
	editor.onExit = () => exits++;
	editor.setText(text);
	return { editor, exits: () => exits };
}

test("ctrl+d forward-deletes inside a draft instead of exiting", () => {
	const { editor, exits } = composer("abc");
	editor.handleInput("\x1b[D");
	editor.handleInput("\x1b[D");
	editor.handleInput(CTRL_D);
	expect(editor.getText()).toBe("ac");
	expect(exits()).toBe(0);
});

test("ctrl+d on an empty prompt still exits", () => {
	const { editor, exits } = composer("");
	editor.handleInput(CTRL_D);
	expect(exits()).toBe(1);
});
