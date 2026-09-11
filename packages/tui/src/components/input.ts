import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { getKeybindings } from "../keybindings";
import { extractPrintableText } from "../keys";
import { KillRing } from "../kill-ring";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	Ellipsis,
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "../utils";

const segmenter = getSegmenter();

interface InputState {
	value: string;
	cursor: number;
	isSimpleValue: boolean;
}

const SIMPLE_VALUE_PATTERN = /^[\x20-\x7e]*$/u;

export class Input implements Component, Focusable {
	#value: string = "";
	#cursor: number = 0;
	#isSimpleValue = true;
	#useTerminalCursor = false;

	prompt = "> ";

	mask = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;

	focused: boolean = false;

	#pasteHandler = new BracketedPasteHandler();

	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	#undoStack: InputState[] = [];

	getValue(): string {
		return this.#value;
	}

	setValue(value: string): void {
		this.#undoStack.length = 0;
		this.#lastAction = null;
		this.#value = value;
		this.#isSimpleValue = SIMPLE_VALUE_PATTERN.test(value);

		this.#cursor = value.length;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	handleInput(data: string): void {
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining);
				}
			}
			return;
		}

		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		if (kb.matches(data, "tui.editor.undo")) {
			this.#undo();
			return;
		}

		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.#value);
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.#handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.#handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.#deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.#deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.#deleteToLineEnd();
			return;
		}

		if (kb.matches(data, "tui.editor.yank")) {
			this.#yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.#yankPop();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#lastAction = null;
			if (this.#cursor > 0) {
				const beforeCursor = this.#value.slice(0, this.#cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.#cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#lastAction = null;
			if (this.#cursor < this.#value.length) {
				const afterCursor = this.#value.slice(this.#cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.#cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#lastAction = null;
			this.#cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#lastAction = null;
			this.#cursor = this.#value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#moveWordForwards();
			return;
		}

		const printableText = extractPrintableText(data);
		if (printableText) {
			this.#insertCharacter(printableText);
		}
	}

	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	#insertCharacter(text: string): void {
		const isWordChunk = [...segmenter.segment(text)].every(seg => getWordNavKind(seg.segment) !== "whitespace");

		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#pushUndo();
		}
		this.#lastAction = "type-word";

		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#isSimpleValue &&= SIMPLE_VALUE_PATTERN.test(text);
		this.#cursor += text.length;
	}

	#handleBackspace(): void {
		this.#lastAction = null;
		if (this.#cursor <= 0) {
			return;
		}

		this.#pushUndo();

		const beforeCursor = this.#value.slice(0, this.#cursor);
		const graphemes = [...segmenter.segment(beforeCursor)];
		const lastGrapheme = graphemes[graphemes.length - 1];
		const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

		this.#value = this.#value.slice(0, this.#cursor - graphemeLength) + this.#value.slice(this.#cursor);
		this.#cursor -= graphemeLength;
	}

	#handleForwardDelete(): void {
		this.#lastAction = null;
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();

		const afterCursor = this.#value.slice(this.#cursor);
		const graphemes = [...segmenter.segment(afterCursor)];
		const firstGrapheme = graphemes[0];
		const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + graphemeLength);
	}

	#deleteToLineStart(): void {
		if (this.#cursor === 0) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(0, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(this.#cursor);
		this.#cursor = 0;
	}

	#deleteToLineEnd(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(this.#cursor);
		this.#killRing.push(deletedText, { prepend: false, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor);
	}

	#deleteWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}

		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordBackwards();
		const deleteFrom = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(deleteFrom, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, deleteFrom) + this.#value.slice(this.#cursor);
		this.#cursor = deleteFrom;
	}

	#deleteWordForward(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordForwards();
		const deleteTo = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(this.#cursor, deleteTo);
		this.#killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(deleteTo);
	}

	#yank(): void {
		const text = this.#killRing.peek();
		if (!text) {
			return;
		}

		this.#pushUndo();
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#isSimpleValue &&= SIMPLE_VALUE_PATTERN.test(text);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) {
			return;
		}

		this.#pushUndo();

		const prevText = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor - prevText.length) + this.#value.slice(this.#cursor);
		this.#cursor -= prevText.length;

		this.#killRing.rotate();
		const text = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#isSimpleValue &&= SIMPLE_VALUE_PATTERN.test(text);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#pushUndo(): void {
		this.#undoStack.push({ value: this.#value, cursor: this.#cursor, isSimpleValue: this.#isSimpleValue });
	}

	#undo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) {
			return;
		}
		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#isSimpleValue = snapshot.isSimpleValue;
		this.#lastAction = null;
	}

	#moveWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordLeft(this.#value, this.#cursor);
	}

	#moveWordForwards(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordRight(this.#value, this.#cursor);
	}

	#handlePaste(pastedText: string): void {
		this.#lastAction = null;
		this.#pushUndo();

		const cleanText = replaceTabs(
			decodeReencodedPasteControls(pastedText).replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, ""),
		)
			.normalize("NFC")
			.replace(/[\x00-\x1F\x7F]/g, "");

		this.#value = this.#value.slice(0, this.#cursor) + cleanText + this.#value.slice(this.#cursor);
		this.#isSimpleValue &&= SIMPLE_VALUE_PATTERN.test(cleanText);
		this.#cursor += cleanText.length;
	}

	invalidate(): void {}

	#sliceSimpleDisplay(start: number, end: number, displayLength: number): string {
		if (start >= displayLength || end <= start) return "";
		const valueEnd = Math.min(this.#value.length, end);
		const valueText = start < valueEnd ? this.#value.slice(start, valueEnd) : "";
		return end > this.#value.length && start <= this.#value.length ? `${valueText} ` : valueText;
	}

	#renderSimple(prompt: string, availableWidth: number): readonly string[] {
		const cursorIndex = this.#cursor;
		const displayLength = this.#value.length + (cursorIndex >= this.#value.length ? 1 : 0);
		const totalCols = displayLength;
		const cursorCols = cursorIndex;

		const maxStart = Math.max(0, totalCols - availableWidth);
		let startCol = 0;
		if (totalCols > availableWidth) {
			const half = Math.floor(availableWidth / 2);
			startCol = Math.max(0, Math.min(maxStart, cursorCols - half));

			const maxCursorRel = Math.max(0, availableWidth - 1);
			const cursorRel = cursorCols - startCol;
			if (cursorRel > maxCursorRel) {
				startCol = Math.max(0, Math.min(maxStart, cursorCols - maxCursorRel));
			}
		}

		const visibleText = this.#sliceSimpleDisplay(startCol, startCol + availableWidth, displayLength);
		const prefixText = cursorCols > startCol ? this.#sliceSimpleDisplay(startCol, cursorCols, displayLength) : "";
		let cursorDisplay = prefixText.length;
		cursorDisplay = Math.max(0, Math.min(cursorDisplay, visibleText.length));

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = visibleText.slice(cursorDisplay, cursorDisplay + 1);
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		const marker = this.focused ? CURSOR_MARKER : "";
		const cursorChar = this.#useTerminalCursor ? atCursor : `\x1b[7m${atCursor || " "}\x1b[27m`;

		const beforeWidth = beforeCursor.length;
		const cursorWidth = this.#useTerminalCursor ? atCursor.length : atCursor.length || 1;
		const remainingAfterWidth = Math.max(0, availableWidth - beforeWidth - cursorWidth);
		const clampedAfterCursor = afterCursor.slice(0, remainingAfterWidth);
		const textWithCursor = beforeCursor + marker + cursorChar + clampedAfterCursor;

		const visualLength = beforeWidth + cursorWidth + clampedAfterCursor.length;
		const pad = padding(Math.max(0, availableWidth - visualLength));
		return [prompt + textWithCursor + pad];
	}

	render(width: number): readonly string[] {
		const prompt = this.prompt;
		const availableWidth = width - visibleWidth(prompt);

		if (availableWidth <= 0) {
			return [truncateToWidth(prompt, width, Ellipsis.Omit)];
		}

		if (this.#isSimpleValue && !this.mask && Number.isSafeInteger(width)) {
			return this.#renderSimple(prompt, availableWidth);
		}

		let cursorIndex = this.#cursor;

		let visibleValue = this.#value;
		if (this.mask) {
			const graphemes = [...segmenter.segment(this.#value)];
			visibleValue = "•".repeat(graphemes.length);
			cursorIndex = graphemes.filter(grapheme => grapheme.index < this.#cursor).length;
		}
		const displayValue = this.#cursor >= this.#value.length ? `${visibleValue} ` : visibleValue;

		const totalCols = visibleWidth(displayValue);
		const cursorCols = visibleWidth(displayValue.slice(0, cursorIndex));

		const cursorIter = segmenter.segment(displayValue.slice(cursorIndex))[Symbol.iterator]();
		const cursorG = cursorIter.next().value?.segment ?? " ";
		const cursorGWidth = visibleWidth(cursorG);

		const maxStart = Math.max(0, totalCols - availableWidth);
		let startCol = 0;
		if (totalCols > availableWidth) {
			const half = Math.floor(availableWidth / 2);
			startCol = Math.max(0, Math.min(maxStart, cursorCols - half));

			const maxCursorRel = Math.max(0, availableWidth - cursorGWidth);
			const cursorRel = cursorCols - startCol;
			if (cursorRel > maxCursorRel) {
				startCol = Math.max(0, Math.min(maxStart, cursorCols - maxCursorRel));
			}
		}

		const visibleText = sliceWithWidth(displayValue, startCol, availableWidth, true).text;
		const prefixText = sliceWithWidth(displayValue, startCol, Math.max(0, cursorCols - startCol), true).text;
		let cursorDisplay = prefixText.length;
		cursorDisplay = Math.max(0, Math.min(cursorDisplay, visibleText.length));

		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? "";
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		const marker = this.focused ? CURSOR_MARKER : "";
		const cursorChar = this.#useTerminalCursor ? atCursor : `\x1b[7m${atCursor || " "}\x1b[27m`;

		const beforeWidth = visibleWidth(beforeCursor);
		const cursorWidth = this.#useTerminalCursor ? visibleWidth(atCursor) : visibleWidth(atCursor || " ");
		const remainingAfterWidth = Math.max(0, availableWidth - beforeWidth - cursorWidth);
		const clampedAfterCursor = sliceWithWidth(afterCursor, 0, remainingAfterWidth, true).text;
		const renderedNoMarker = beforeCursor + cursorChar + clampedAfterCursor;
		const textWithCursor = beforeCursor + marker + cursorChar + clampedAfterCursor;

		const visualLength = visibleWidth(renderedNoMarker);
		const pad = padding(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + pad;
		return [line];
	}
}
