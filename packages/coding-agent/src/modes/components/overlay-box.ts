import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

function paint(s: string): string {
	return theme.fg("border", s);
}

export function topBorder(width: number, title: string): string {
	const box = theme.boxRound;
	if (width <= 0) return "";
	if (width === 1) return paint(box.topLeft);
	if (width === 2) return paint(box.topLeft + box.topRight);
	const inner = Math.max(0, width - 2);
	if (!title) return paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

export function divider(width: number): string {
	const box = theme.boxRound;
	if (width <= 1) return paint(box.horizontal.repeat(Math.max(0, width)));
	return paint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number): string {
	const box = theme.boxRound;
	if (width <= 1) return paint(box.horizontal.repeat(Math.max(0, width)));
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

export function row(content: string, width: number): string {
	const box = theme.boxRound;
	if (width <= 0) return "";
	if (width === 1) return paint(box.vertical);
	if (width === 2) return paint(box.vertical + box.vertical);
	if (width === 3) return `${paint(box.vertical)} ${paint(box.vertical)}`;
	return `${paint(box.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(box.vertical)}`;
}

function splitDividerCol(sidebarWidth: number): number {
	return sidebarWidth + 3;
}

export function splitBodyWidth(width: number, sidebarWidth: number): number {
	return Math.max(0, width - sidebarWidth - 7);
}

export function topBorderSplit(width: number, title: string, sidebarWidth: number): string {
	const box = theme.boxRound;
	// Mirror topBorder's narrow degradation: below four cells there is no
	// room for the three fixed glyphs plus content, so fall back to the
	// plain (unsplit) border shape.
	if (width <= 0) return "";
	if (width === 1) return paint(box.topLeft);
	if (width === 2) return paint(box.topLeft + box.topRight);
	if (width === 3 && title) return paint(box.topLeft + box.horizontal + box.topRight);
	const dividerCol = splitDividerCol(sidebarWidth);
	// Three fixed cells (left corner, tee, right corner) are always emitted,
	// so the dashes must fit width - 3 for the row to stay within width.
	const leftLen = Math.max(0, Math.min(dividerCol - 1, width - 3));
	const rightLen = Math.max(0, width - 3 - leftLen);
	let left: string;
	if (!title) {
		left = paint(box.topLeft + box.horizontal.repeat(leftLen));
	} else {
		const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
		const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
		left =
			paint(box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(box.horizontal.repeat(fillWidth));
	}
	return left + paint(box.teeDown + box.horizontal.repeat(rightLen) + box.topRight);
}

export function dividerSplit(width: number, sidebarWidth: number): string {
	const box = theme.boxRound;
	// Mirror the top-border narrow degradation (three fixed glyphs).
	if (width <= 0) return "";
	if (width === 1) return paint(box.teeRight);
	if (width === 2) return paint(box.teeRight + box.teeLeft);
	const dividerCol = splitDividerCol(sidebarWidth);
	// Three fixed cells (left corner, tee, right corner) are always emitted,
	// so the dashes must fit width - 3 for the row to stay within width.
	const leftLen = Math.max(0, Math.min(dividerCol - 1, width - 3));
	const rightLen = Math.max(0, width - 3 - leftLen);
	return paint(
		box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
	);
}

export function splitRow(sidebar: string, body: string, width: number, sidebarWidth: number): string {
	const box = theme.boxRound;
	const bar = paint(box.vertical);
	// Chrome costs bar+space on each side of each cell (7 cells). Below that
	// the full frame cannot fit: shrink the cells, and degrade to a clamped
	// row when even the chrome does not fit.
	const cellBudget = Math.max(0, width - 7);
	const sidebarCell = Math.min(sidebarWidth, cellBudget);
	const bodyCell = Math.max(0, Math.min(splitBodyWidth(width, sidebarWidth), cellBudget - sidebarCell));
	const row = `${bar} ${fit(sidebar, sidebarCell)} ${bar} ${fit(body, bodyCell)} ${bar}`;
	return width < 7 ? truncateToWidth(row, Math.max(1, width)) : row;
}

export class PanelDivider implements Component {
	render(): readonly string[] {
		return [];
	}
}

const NO_LINES: readonly string[] = [];

interface OverlayPanelMemo {
	width: number;
	title: string;
	children: Component[];
	childLines: (readonly string[])[];
	result: string[];
}

function collapseTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

export class OverlayPanel implements Component {
	children: Component[] = [];
	#title: string;
	#memo: OverlayPanelMemo | undefined;

	constructor(title = "") {
		this.#title = collapseTitle(title);
	}

	get title(): string {
		return this.#title;
	}

	set title(value: string) {
		const next = collapseTitle(value);
		if (next === this.#title) return;
		this.#title = next;
		this.#memo = undefined;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.#memo = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;
		this.children.splice(index, 1);
		this.#memo = undefined;
	}

	clear(): void {
		this.children = [];
		this.#memo = undefined;
	}

	invalidate(): void {
		this.#memo = undefined;
		for (const child of this.children) child.invalidate?.();
	}

	dispose(): void {
		for (const child of this.children) child.dispose?.();
	}

	setIgnoreTight(ignore: boolean): this {
		for (const child of this.children) child.setIgnoreTight?.(ignore);
		return this;
	}

	renderContent(width: number): string[] {
		const result: string[] = [];
		for (const child of this.children) {
			if (child instanceof PanelDivider) continue;
			result.push(...child.render(width));
		}
		return result;
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);

		const childLines = this.children.map(child =>
			child instanceof PanelDivider ? NO_LINES : child.render(innerWidth),
		);
		const memo = this.#memo;
		if (
			memo !== undefined &&
			memo.width === width &&
			memo.title === this.#title &&
			memo.children.length === this.children.length &&
			this.children.every((child, i) => memo.children[i] === child && memo.childLines[i] === childLines[i])
		) {
			return memo.result;
		}
		const result: string[] = [topBorder(width, this.#title)];
		for (let i = 0; i < this.children.length; i++) {
			if (this.children[i] instanceof PanelDivider) {
				result.push(divider(width));
				continue;
			}
			for (const line of childLines[i] ?? NO_LINES) result.push(row(line, width));
		}
		result.push(bottomBorder(width));
		this.#memo = { width, title: this.#title, children: [...this.children], childLines, result };
		return result;
	}
}
