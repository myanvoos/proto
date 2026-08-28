export interface CellAttributes {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strikethrough: boolean;
	overline: boolean;
	fgMode: 0 | 1 | 2;
	fg: number;
	bgMode: 0 | 1 | 2;
	bg: number;
}

export interface CellData {
	chars: string;
	width: number;
	attrs: CellAttributes;
}

export function defaultAttributes(): CellAttributes {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		inverse: false,
		strikethrough: false,
		overline: false,
		fgMode: 0,
		fg: 0,
		bgMode: 0,
		bg: 0,
	};
}

function cloneAttributes(attrs: CellAttributes): CellAttributes {
	return { ...attrs };
}

export function blankCell(attrs: CellAttributes = defaultAttributes()): CellData {
	return { chars: "", width: 1, attrs: cloneAttributes(attrs) };
}

export class BufferCell {
	#cell: CellData = blankCell();

	setFrom(cell: CellData): this {
		this.#cell = cell;
		return this;
	}

	getChars(): string {
		return this.#cell.chars;
	}

	getWidth(): number {
		return this.#cell.width;
	}

	getFgColor(): number {
		return this.#cell.attrs.fg;
	}

	getBgColor(): number {
		return this.#cell.attrs.bg;
	}

	isBold(): number {
		return Number(this.#cell.attrs.bold);
	}

	isDim(): number {
		return Number(this.#cell.attrs.dim);
	}

	isItalic(): number {
		return Number(this.#cell.attrs.italic);
	}

	isUnderline(): number {
		return Number(this.#cell.attrs.underline);
	}

	isInverse(): number {
		return Number(this.#cell.attrs.inverse);
	}

	isStrikethrough(): number {
		return Number(this.#cell.attrs.strikethrough);
	}

	isOverline(): number {
		return Number(this.#cell.attrs.overline);
	}

	isFgRGB(): boolean {
		return this.#cell.attrs.fgMode === 2;
	}

	isBgRGB(): boolean {
		return this.#cell.attrs.bgMode === 2;
	}

	isFgPalette(): boolean {
		return this.#cell.attrs.fgMode === 1;
	}

	isBgPalette(): boolean {
		return this.#cell.attrs.bgMode === 1;
	}
}

export class BufferLine {
	cells: CellData[];
	isWrapped = false;

	constructor(columns: number, attrs: CellAttributes = defaultAttributes()) {
		this.cells = Array.from({ length: columns }, () => blankCell(attrs));
	}

	get length(): number {
		return this.cells.length;
	}

	getCell(column: number, cell = new BufferCell()): BufferCell | undefined {
		const value = this.cells[column];
		return value ? cell.setFrom(value) : undefined;
	}

	translateToString(trimRight = false, startColumn = 0, endColumn = this.cells.length): string {
		const start = Math.max(0, startColumn);
		let end = Math.min(endColumn, this.cells.length);
		if (trimRight) {
			while (end > start && !this.cells[end - 1]!.chars) end--;
		}
		let text = "";
		for (let column = start; column < end; column++) {
			const cell = this.cells[column]!;
			if (cell.width !== 0) text += cell.chars || " ";
		}
		return text;
	}
}

export interface BufferState {
	lines: BufferLine[];
	baseY: number;
	viewportY: number;
	cursorX: number;
	cursorY: number;
}

export class BufferView {
	constructor(private readonly state: () => BufferState) {}

	get length(): number {
		return this.state().lines.length;
	}

	get baseY(): number {
		return this.state().baseY;
	}

	get viewportY(): number {
		return this.state().viewportY;
	}

	get cursorX(): number {
		return this.state().cursorX;
	}

	get cursorY(): number {
		return this.state().cursorY;
	}

	getLine(row: number): BufferLine | undefined {
		return this.state().lines[row];
	}

	getNullCell(): BufferCell {
		return new BufferCell();
	}
}
