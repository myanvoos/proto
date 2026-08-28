import { Editor, type Focusable, matchesKey, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesAppFollowUp,
	matchesAppInterrupt,
} from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
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

	focused = false;

	constructor(
		tui: TUI,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: HookEditorOptions,
	) {
		const [titleLine = "", ...detailLines] = title.split("\n");
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

		const hint = this.#promptStyle
			? "enter or ctrl+q submit  esc cancel  ctrl+g external editor"
			: "ctrl+q/ctrl+enter submit  esc cancel  ctrl+g external editor";
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
		if (this.#promptStyle) {
			this.#handlePromptStyleInput(keyData);
		} else {
			this.#handleHookStyleInput(keyData);
		}
	}

	#submitCurrentText(): void {
		this.#onSubmitCallback(this.#editor.getExpandedText());
	}

	pasteText(text: string): void {
		this.#editor.pasteText(text);
	}

	#handlePromptStyleInput(keyData: string): void {
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
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
			this.#onCancelCallback();
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
			if (result !== null) {
				this.#editor.setText(result);
			}
		} finally {
			this.#tui.start();
			this.#tui.requestRender(true);
		}
	}
}
