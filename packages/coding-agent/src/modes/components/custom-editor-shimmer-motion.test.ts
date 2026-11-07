import { afterEach, expect, test, vi } from "bun:test";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { Settings } from "../../config/settings";
import { getEditorTheme, initThemeSync } from "../theme/theme";
import { CustomEditor } from "./custom-editor";

await Settings.init();
initThemeSync();

afterEach(() => {
	setMotionEffects(true);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function litKeyword(): CustomEditor {
	const editor = new CustomEditor(getEditorTheme());
	editor.magicKeywordsEnabledOverride = true;
	editor.focused = true;
	editor.setText("please ultrathink this");
	return editor;
}

function decorate(editor: CustomEditor): string {
	const text = editor.getText();
	return editor.decorateText(text, { line: 0, startCol: 0, endCol: text.length });
}

test("motion effects on arms the magic-keyword sweep", () => {
	vi.useFakeTimers();
	setMotionEffects(true);
	const editor = litKeyword();
	const repaint = vi.fn();
	editor.setShimmerRepaintHandler(repaint);
	try {
		expect(decorate(editor)).not.toBe(editor.getText());
		vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS);
		expect(repaint).toHaveBeenCalledTimes(1);
	} finally {
		editor.setShimmerRepaintHandler(undefined);
		editor.dispose();
	}
});

test("motion effects off keeps the keyword highlighted but arms no sweep", () => {
	vi.useFakeTimers();
	setMotionEffects(false);
	const editor = litKeyword();
	const repaint = vi.fn();
	editor.setShimmerRepaintHandler(repaint);
	try {
		// The static gradient still marks the keyword; only the sweep is gone.
		expect(decorate(editor)).not.toBe(editor.getText());
		vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS * 4);
		expect(repaint).toHaveBeenCalledTimes(0);
	} finally {
		editor.setShimmerRepaintHandler(undefined);
		editor.dispose();
	}
});

test("a live switch to effects-off cancels a running sweep and settles the keyword", () => {
	vi.useFakeTimers();
	setMotionEffects(true);
	const editor = litKeyword();
	const repaint = vi.fn();
	editor.setShimmerRepaintHandler(repaint);
	try {
		decorate(editor); // arms a frame
		setMotionEffects(false); // live switch: cancels the pending frame, repaints once to settle
		repaint.mockClear();
		vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS * 4);
		expect(repaint).toHaveBeenCalledTimes(0);
	} finally {
		editor.setShimmerRepaintHandler(undefined);
		editor.dispose();
	}
});
