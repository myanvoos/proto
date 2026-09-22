import { type Component, Editor, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/** Allocate scarce rows to the focused body before optional dialog chrome. */
export function getDialogViewport(height: number, requestedHeaderRows = 0) {
	const rows = Number.isFinite(height) ? Math.max(1, Math.trunc(height)) : 40;
	const titleRows = rows >= 3 ? 1 : 0;
	const bottomRows = rows >= 3 ? 1 : 0;
	const footerRows = rows >= 4 ? 1 : 0;
	const remaining = rows - titleRows - bottomRows - footerRows;
	const headerRows = remaining - requestedHeaderRows >= 3 ? requestedHeaderRows : 0;
	const dividerRows = remaining - headerRows >= 4 ? 1 : 0;
	return {
		titleRows,
		headerRows,
		bodyRows: remaining - headerRows - dividerRows,
		dividerRows,
		footerRows,
		bottomRows,
	};
}

/**
 * Physical rows a wrapping tab strip may take inside a dialog. Tab labels are
 * text, so a narrow terminal wraps the strip over many rows; the strip scrolls
 * inside this budget with the active tab visible instead of either eating the
 * dialog or being dropped whole. The body keeps its three-row floor, and the
 * strip never claims more than a third of the dialog, which is what makes
 * mid-height terminals usable rather than a wall of tabs.
 */
export function getTabStripRows(viewport: { bodyRows: number; dividerRows: number }, chromeRows = 1): number {
	const inner = viewport.bodyRows + viewport.dividerRows;
	return Math.max(1, Math.min(Math.ceil(inner / 3), inner - 3 - chromeRows));
}

/** Keep a form's focused control visible; descriptions and previews yield first. */
export function renderDialogContent(
	children: readonly Component[],
	active: Component,
	width: number,
	height: number,
): { lines: string[]; activeRow: number } {
	const budget = Math.max(1, Math.trunc(height));
	const index = children.indexOf(active);
	const before = children.slice(0, Math.max(0, index)).flatMap(child => [...child.render(width)]);
	const after = children.slice(index + 1).flatMap(child => [...child.render(width)]);
	// Reserve a title when possible, but never displace the input/selected row.
	const titleRows = before.length > 0 && budget > 1 ? 1 : 0;
	const hintRows = after.length > 0 && budget > 2 ? 1 : 0;
	const activeRows = Math.max(1, budget - titleRows - hintRows);
	if (active instanceof Editor) active.setViewportHeight(activeRows);
	else active.setMaxHeight?.(activeRows);
	const activeLines = [...active.render(width)].slice(0, budget - titleRows);
	const spare = budget - activeLines.length;
	const beforeCount = Math.min(before.length, Math.max(titleRows, spare - Math.min(after.length, hintRows)));
	const afterCount = Math.max(0, spare - beforeCount);
	return {
		lines: [
			...before.slice(0, beforeCount),
			...activeLines,
			...(afterCount >= after.length ? after : after.filter(line => line.trim() !== "").slice(0, afterCount)),
		],
		activeRow: beforeCount,
	};
}

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

export function row(content: string, width: number, framed = true): string {
	if (!framed) return fit(content, width);
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

/** Leading, trailing and repeated blank rows are decoration, never content. */
export function trimBlankEdges(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	const result: string[] = [];
	for (const line of lines.slice(start, end)) {
		const blank = line.trim() === "";
		if (blank && (result.at(-1) ?? "x").trim() === "") continue;
		result.push(line);
	}
	return result;
}

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
	#maxHeight = Number.POSITIVE_INFINITY;
	#framed = true;

	setMaxHeight(rows: number): void {
		this.#maxHeight = Math.max(1, Math.trunc(rows));
		this.#memo = undefined;
	}

	/**
	 * A panel embedded in an already-framed host draws no rails of its own: the
	 * host owns the single border and footer while the child keeps its identity.
	 */
	setFramed(framed: boolean): void {
		if (this.#framed === framed) return;
		this.#framed = framed;
		this.#memo = undefined;
	}

	get framed(): boolean {
		return this.#framed;
	}

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
		let innerWidth = Math.max(1, width - 4);
		if (!this.#framed) {
			innerWidth = Math.max(1, width);
			const rows = Number.isFinite(this.#maxHeight) ? this.#maxHeight : Number.POSITIVE_INFINITY;
			// With a single row the focused control outranks the panel's own title.
			const title = this.#title && rows >= 2 ? [theme.bold(theme.fg("accent", this.#title))] : [];
			const budget = Math.max(1, (Number.isFinite(rows) ? rows : 0) - title.length);
			const active = this.children.find(child => child.handleInput !== undefined);
			const rendered = active
				? renderDialogContent(this.children, active, innerWidth, budget).lines
				: this.renderContent(innerWidth);
			// Decorative spacing is the first thing to go: an embedded panel must
			// never spend one of a handful of rows on a blank line.
			const trimmed = trimBlankEdges(rendered);
			const content = trimmed.length > budget ? trimmed.filter(line => line.trim() !== "") : trimmed;
			return [...title, ...(Number.isFinite(this.#maxHeight) ? content.slice(0, budget) : content)].map(line =>
				row(line, width, false),
			);
		}
		if (Number.isFinite(this.#maxHeight)) {
			const layout = getDialogViewport(this.#maxHeight);
			innerWidth = Math.max(1, layout.titleRows ? width - 4 : width);
			const bodyRows = layout.bodyRows + layout.footerRows + layout.dividerRows;
			const active = this.children.find(child => child.handleInput !== undefined);
			const content = active
				? renderDialogContent(this.children, active, innerWidth, bodyRows).lines
				: this.renderContent(innerWidth)
						.filter(line => line.trim() !== "")
						.slice(0, bodyRows);
			return [
				...(layout.titleRows ? [topBorder(width, this.#title)] : []),
				...content.map(line => row(line, width, layout.titleRows > 0)),
				...(layout.bottomRows ? [bottomBorder(width)] : []),
			];
		}

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
