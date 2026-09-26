import { afterEach, beforeEach, expect, test } from "bun:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { getEditorTheme, initThemeSync } from "../theme/theme";
import { COMPOSER_IMAGE_LIMITS, CustomEditor } from "./custom-editor";

await Settings.init({ inMemory: true });
initThemeSync();
let previous: KeybindingsManager;
const editors: CustomEditor[] = [];
beforeEach(() => {
	previous = getKeybindings();
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(() => {
	setKeybindings(previous);
	for (const editor of editors.splice(0)) editor.dispose();
});
function createEditor(): CustomEditor {
	const editor = new CustomEditor(getEditorTheme());
	editors.push(editor);
	return editor;
}
const START = "\x1b[200~";
const END = "\x1b[201~";
async function nextTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

test("blocked clipboard paste bounds queued input and never replays rejected paste tail as Enter", async () => {
	const editor = createEditor();
	const gate = Promise.withResolvers<boolean>();
	let calls = 0;
	let submitted = false;
	const rejected: string[] = [];
	editor.onPasteImage = () => {
		calls++;
		return gate.promise;
	};
	editor.onSubmit = () => {
		submitted = true;
	};
	editor.onInputRejected = reason => rejected.push(reason);
	editor.handleInput(`${START}${END}`);
	editor.handleInput("before ");
	editor.handleInput(`${START}${"x".repeat(256 * 1024 + 1)}`);
	gate.resolve(true);
	await nextTurn();
	editor.handleInput(`\r${END}\r`);
	expect(submitted).toBe(false);
	expect(calls).toBe(1);
	expect(editor.getText()).toBe("before ");
	expect(rejected.length).toBeGreaterThan(0);
	editor.handleInput("after");
	expect(editor.getText()).toBe("before after");
});

test("disposing an editor discards queued keystrokes before a clipboard operation settles", async () => {
	const editor = createEditor();
	const gate = Promise.withResolvers<boolean>();
	editor.onPasteImage = () => gate.promise;
	editor.handleInput(`${START}${END}`);
	editor.handleInput("should not return");
	editor.dispose();
	gate.resolve(true);
	await nextTurn();
	expect(editor.getText()).toBe("");
});

test("draft-image materialization coalesces replacements and cannot attach stale links", async () => {
	const editor = createEditor();
	const gate = Promise.withResolvers<(string | undefined)[]>();
	const calls: string[] = [];
	editor.draftImageLinkMaterializer = images => {
		calls.push(images[0].data);
		return calls.length === 1 ? gate.promise : Promise.resolve([images[0].data]);
	};
	const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
	editor.setDraft("first", [image("first")]);
	editor.setDraft("middle", [image("middle")]);
	editor.setDraft("latest", [image("latest")]);
	expect(calls).toEqual(["first"]);
	gate.resolve(["stale"]);
	await nextTurn();
	expect(calls).toEqual(["first", "latest"]);
	expect(editor.pendingImageLinks).toEqual(["latest"]);
});

test("oversized draft-image replacement preserves the existing draft and attachments", () => {
	const editor = createEditor();
	const image = { type: "image" as const, data: "data", mimeType: "image/png" };
	editor.setDraft("saved", [image]);
	let rejected = false;
	editor.onInputRejected = () => {
		rejected = true;
	};
	editor.setDraft(
		"too many",
		Array.from({ length: COMPOSER_IMAGE_LIMITS.count + 1 }, () => image),
	);
	expect(rejected).toBe(true);
	expect(editor.getText()).toBe("saved");
	expect(editor.pendingImages).toHaveLength(1);
	expect(() => {
		editor.pendingImages = [{ ...image, data: "x".repeat(COMPOSER_IMAGE_LIMITS.bytes + 1) }];
	}).toThrow(RangeError);
	expect(editor.pendingImages[0].data).toBe("data");
});
