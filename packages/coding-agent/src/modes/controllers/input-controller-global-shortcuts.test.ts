import { describe, expect, it, vi } from "bun:test";
import { Container, type KeyId, matchesKey, Text, type TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { AskDialogComponent } from "../components/ask-dialog";
import { HookEditorComponent } from "../components/hook-editor";
import { initThemeSync } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { InputController } from "./input-controller";
import { SelectorController } from "./selector-controller";

await Settings.init({ inMemory: true });
initThemeSync();

const KEYS: Record<string, KeyId[]> = {
	"app.thinking.toggle": ["ctrl+t"],
	"app.history.search": ["ctrl+r"],
	"app.editor.external": ["ctrl+g"],
	"app.display.reset": ["alt+l"],
};

function setup(options: { overlay?: boolean } = {}) {
	const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	let focused: unknown;
	const editor = {
		getText: () => "",
		setText: () => {},
		setActionKeys: () => {},
		clearCustomKeyHandlers: () => {},
		setCustomKeyHandler: () => {},
		composerChips: () => [],
		pasteText: () => {},
	};
	const ctx = {
		editor,
		session: { isStreaming: false, isBashRunning: false, isEvalRunning: false, extensionRunner: undefined },
		viewSession: { isCompacting: false, isRetrying: false, isStreaming: false },
		focusedAgentId: undefined,
		mcpTestEscapeHandlers: new Set<() => void>(),
		hasActiveSideQuestion: () => false,
		keybindings: {
			getKeys: (action: string) => KEYS[action] ?? [],
			matches: (data: string, action: string) => (KEYS[action] ?? []).some(key => matchesKey(data, key)),
		},
		ui: {
			addInputListener: (listener: (data: string) => { consume?: boolean } | undefined) => listeners.push(listener),
			addStartListener: () => {},
			hasOverlay: () => options.overlay ?? false,
			getFocused: () => focused,
			requestRender: () => {},
			terminal: { write: () => {} },
		},
		toggleThinkingBlockVisibility: vi.fn(),
		showHistorySearch: vi.fn(),
		resetDisplayAfterAppearanceRefresh: vi.fn(),
		showStatus: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	const openExternalEditor = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
	controller.setupKeyHandlers();
	const dispatch = (data: string) => {
		for (const listener of listeners) {
			const result = listener(data);
			if (result?.consume) return result;
		}
		return undefined;
	};
	return { ctx, dispatch, openExternalEditor, setFocused: (component: unknown) => (focused = component) };
}

function askDialog(): AskDialogComponent {
	return new AskDialogComponent([{ id: "q", question: "Pick?", options: [{ label: "A" }] }], {
		onSubmit: () => {},
		onCancel: () => {},
		onPrompt: async () => undefined,
	});
}

describe("InputController global editor shortcuts", () => {
	it("runs transcript and editor shortcuts while an Ask dialog holds focus", () => {
		const { ctx, dispatch, openExternalEditor, setFocused } = setup();
		setFocused(askDialog());

		expect(dispatch("\x14")).toEqual({ consume: true });
		expect(ctx.toggleThinkingBlockVisibility).toHaveBeenCalledTimes(1);
		expect(dispatch("\x12")).toEqual({ consume: true });
		expect(ctx.showHistorySearch).toHaveBeenCalledTimes(1);
		expect(dispatch("\x07")).toEqual({ consume: true });
		expect(openExternalEditor).toHaveBeenCalledTimes(1);
		expect(dispatch("\x1bl")).toEqual({ consume: true });
		expect(ctx.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("leaves external editing to a focused prompt editor and everything to overlays", () => {
		const focusedPrompt = setup();
		const tui = { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
		focusedPrompt.setFocused(
			new HookEditorComponent(
				tui,
				"Answer",
				undefined,
				() => {},
				() => {},
			),
		);
		expect(focusedPrompt.dispatch("\x07")).toBeUndefined();
		expect(focusedPrompt.openExternalEditor).not.toHaveBeenCalled();

		const overlay = setup({ overlay: true });
		expect(overlay.dispatch("\x14")).toBeUndefined();
		expect(overlay.ctx.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
	});
});

describe("SelectorController.showSelector", () => {
	it("restores an Ask dialog's editor slot and focus when a nested selector finishes", () => {
		const dialog = askDialog();
		const editorContainer = new Container();
		editorContainer.addChild(dialog);
		let focused: unknown = dialog;
		const ctx = {
			editor: {},
			editorContainer,
			ui: {
				getFocused: () => focused,
				setFocus: (component: unknown) => (focused = component),
				requestRender: () => {},
			},
		} as unknown as InteractiveModeContext;
		let finish = () => {};
		const selector = new Text("history");

		new SelectorController(ctx).showSelector(done => {
			finish = done;
			return { component: selector, focus: selector };
		});
		expect(focused).toBe(selector);
		finish();

		expect(editorContainer.children).toEqual([dialog]);
		expect(focused).toBe(dialog);
	});
});
