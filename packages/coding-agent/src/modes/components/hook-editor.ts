import { Editor, type Focusable, matchesKey, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesAppFollowUp,
	matchesAppInterrupt,
} from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { editorKey } from "./keybinding-hints";
import { OverlayPanel } from "./overlay-box";

interface HookEditorOptions {
	promptStyle?: boolean;

	maxHeight?: number;
}

export class HookEditorComponent extends OverlayPanel implements Focusable {
	#editor: Editor;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#tui: TUI;
	#promptStyle: boolean;
	#pastePending = false;
	#submitQueued = false;
	#disposed = false;

	focused = false;

	constructor(
		tui: TUI,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: HookEditorOptions,
	) {
		const sanitizedTitle = sanitizeText(title);
		const [titleLine = "", ...detailLines] = sanitizedTitle.split("\n");
		super(titleLine);

		this.#tui = tui;
		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#promptStyle = options?.promptStyle ?? false;

		this.addChild(new Spacer(1));
		if (detailLines.length > 0) {
			for (const line of detailLines) this.addChild(new Text(theme.fg("accent", line), 0, 0));
			this.addChild(new Spacer(1));
		}

		this.#editor = new Editor(getEditorTheme());
		if (this.#promptStyle) {
			this.#editor.setBorderVisible(false);
			this.#editor.setPromptGutter("> ");
			this.#editor.disableSubmit = true;
		}

		const termRows = this.#tui.terminal?.rows ?? process.stdout.rows ?? 40;
		this.#editor.setMaxHeight(options?.maxHeight ?? Math.max(3, termRows - 12));
		this.#editor.setScrollbarVisible(true);
		if (prefill) {
			this.#editor.setText(prefill);
		}
		this.addChild(this.#editor);

		this.addChild(new Spacer(1));

		const submitKeys = editorKey("app.message.followUp") || "ctrl+enter/ctrl+q";
		const cancelKeys = editorKey("app.interrupt") || "esc";
		const externalEditorKeys = editorKey("app.editor.external") || "ctrl+g";
		const hint = `${this.#promptStyle ? "enter or " : ""}${submitKeys} submit  ${cancelKeys} cancel  ${externalEditorKeys} external editor`;
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
		this.addChild(new Spacer(1));
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		if (this.#editor.getUseTerminalCursor() === useTerminalCursor) return;
		this.#editor.setUseTerminalCursor(useTerminalCursor);
	}

	override render(width: number): readonly string[] {
		this.#editor.focused = this.focused;
		return super.render(width);
	}

	handleInput(keyData: string): void {
		if (this.#disposed) return;
		if (this.#promptStyle) {
			this.#handlePromptStyleInput(keyData);
		} else {
			this.#handleHookStyleInput(keyData);
		}
	}

	#submitCurrentText(requireText = false): void {
		if (this.#disposed) return;
		if (this.#pastePending) {
			this.#submitQueued = true;
			return;
		}
		const text = this.#editor.getExpandedText();
		if (requireText && text.trim().length === 0) return;
		this.dispose();
		this.#onSubmitCallback(text);
	}

	/**
	 * Reserves the editor for an async clipboard read: a submit arriving meanwhile waits for the text. The returned
	 * completion inserts nonempty text once (then runs the deferred submit) or releases the reservation on `undefined`;
	 * it returns whether the text landed.
	 */
	beginPaste(): (text: string | undefined) => boolean {
		if (this.#disposed) return () => false;
		this.#pastePending = true;
		let settled = false;
		return text => {
			if (this.#disposed || settled) return false;
			settled = true;
			this.#pastePending = false;
			if (text) this.#editor.pasteText(text);
			else this.#submitQueued = false;
			if (this.#submitQueued) {
				this.#submitQueued = false;
				this.#submitCurrentText(true);
			}
			return !!text;
		};
	}

	pasteText(text: string): void {
		if (this.#disposed) return;
		this.#editor.pasteText(text);
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#pastePending = false;
		this.#submitQueued = false;
		super.dispose();
	}

	#cancel(): void {
		this.dispose();
		this.#onCancelCallback();
	}

	#handlePromptStyleInput(keyData: string): void {
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesAppInterrupt(keyData)) {
			this.#cancel();
			return;
		}

		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			this.#submitCurrentText();
			return;
		}

		this.#editor.handleInput(keyData);
	}

	#handleHookStyleInput(keyData: string): void {
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#editor.handleInput("\n");
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			this.#cancel();
			return;
		}

		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		this.#editor.handleInput(keyData);
	}

	async #openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) return;

		const currentText = this.#editor.getExpandedText();
		try {
			this.#tui.stop();
			const result = await openInEditor(editorCmd, currentText);
			if (!this.#disposed && result !== null) {
				this.#editor.setText(result);
			}
		} finally {
			this.#tui.start();
			this.#tui.requestRender(true);
		}
	}
}
