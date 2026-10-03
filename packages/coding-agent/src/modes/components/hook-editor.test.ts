import { describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { HookEditorComponent } from "./hook-editor";

initThemeSync();

function createPrompt(onSubmit: (value: string) => void, onCancel = vi.fn()): HookEditorComponent {
	const tui = { terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI;
	return new HookEditorComponent(tui, "Custom answer", undefined, onSubmit, onCancel, { promptStyle: true });
}

describe("HookEditorComponent clipboard paste", () => {
	it("holds Enter until a pending clipboard read lands, then submits once", () => {
		const onSubmit = vi.fn();
		const prompt = createPrompt(onSubmit);
		const finish = prompt.beginPaste();

		prompt.handleInput("\r");
		prompt.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();

		expect(finish("clipboard answer")).toBe(true);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("clipboard answer");
	});

	it("drops the queued submit when the clipboard read yields nothing", () => {
		const onSubmit = vi.fn();
		const prompt = createPrompt(onSubmit);
		const finish = prompt.beginPaste();

		prompt.handleInput("\r");
		expect(finish(undefined)).toBe(false);
		expect(onSubmit).not.toHaveBeenCalled();

		prompt.handleInput("typed");
		prompt.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledWith("typed");
	});

	it("rejects a paste that settles after the prompt was cancelled", () => {
		const onCancel = vi.fn();
		const prompt = createPrompt(vi.fn(), onCancel);
		const finish = prompt.beginPaste();

		prompt.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(finish("late text")).toBe(false);
	});
});
