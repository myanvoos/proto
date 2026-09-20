import { expect, test } from "bun:test";
import { KeybindingsManager } from "./keybindings";

test("dequeue no longer claims shift+up, which now extends the editor selection", () => {
	const manager = KeybindingsManager.inMemory({});
	expect(manager.getKeys("app.message.dequeue")).toEqual(["alt+up"]);
	expect(manager.getEffectiveConfig()["app.message.dequeue"]).toEqual("alt+up");
});

test("an explicit user binding can still put shift+up on dequeue", () => {
	const manager = KeybindingsManager.inMemory({ "app.message.dequeue": "shift+up" });
	expect(manager.getKeys("app.message.dequeue")).toContain("shift+up");
	expect(manager.getEffectiveConfig()["app.message.dequeue"]).toEqual("shift+up");
});

test("editor selection bindings resolve from the shared keybinding definitions", () => {
	const manager = KeybindingsManager.inMemory({});
	expect(manager.getKeys("tui.editor.cursorSelectLeft")).toEqual(["shift+left"]);
	expect(manager.getKeys("tui.editor.cursorSelectRight")).toEqual(["shift+right"]);
	expect(manager.getKeys("tui.editor.cursorSelectUp")).toEqual(["shift+up"]);
	expect(manager.getKeys("tui.editor.cursorSelectDown")).toEqual(["shift+down"]);
});
