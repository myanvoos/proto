import { matchesKey } from "../keys";
import type { Component } from "../tui";
import { Ellipsis, replaceTabs, truncateToWidth, visibleWidth } from "../utils";

const DEFAULT_TRACK = "│";
const DEFAULT_THUMB = "█";

type ScrollbarMode = "auto" | "always" | "never";

export interface ScrollViewTheme {
	track?: (text: string) => string;
	thumb?: (text: string) => string;
}

export interface ScrollViewOptions {
	height: number;

	scrollbar?: ScrollbarMode | boolean;

	totalRows?: number;
	theme?: ScrollViewTheme;
	trackChar?: string;
	thumbChar?: string;

	ellipsis?: Ellipsis;

	fastScrollLines?: number;
}

export interface ScrollViewSetLinesOptions {
	/** Keep the same visible content row at the same viewport position when possible. */
	preserveAnchor?: boolean;
}

function normalizeScrollbarMode(scrollbar: ScrollViewOptions["scrollbar"]): ScrollbarMode {
	if (scrollbar === true) return "auto";
	if (scrollbar === false) return "never";
	return scrollbar ?? "auto";
}

function firstCellGlyph(value: string, fallback: string): string {
	const glyph = Array.from(value)[0] ?? fallback;
	return visibleWidth(glyph) === 1 ? glyph : fallback;
}

export class ScrollView implements Component {
	#lines: readonly string[];
	#height: number;
	#scrollOffset = 0;
	#totalRows: number | undefined;
	#scrollbar: ScrollbarMode;
	#theme: Required<ScrollViewTheme>;
	#trackChar: string;
	#thumbChar: string;
	#ellipsis: Ellipsis;
	#fastScrollLines: number;

	constructor(lines: readonly string[], options: ScrollViewOptions) {
		// The array is adopted, not copied: callers hand over freshly built
		// line arrays and must not mutate them afterwards.
		this.#lines = lines;
		this.#height = Number.isFinite(options.height) ? Math.max(0, Math.trunc(options.height)) : 0;
		this.#totalRows = options.totalRows === undefined ? undefined : Math.max(0, Math.trunc(options.totalRows));
		this.#scrollbar = normalizeScrollbarMode(options.scrollbar);
		this.#theme = {
			track: options.theme?.track ?? (text => text),
			thumb: options.theme?.thumb ?? (text => text),
		};
		this.#trackChar = firstCellGlyph(options.trackChar ?? DEFAULT_TRACK, DEFAULT_TRACK);
		this.#thumbChar = firstCellGlyph(options.thumbChar ?? DEFAULT_THUMB, DEFAULT_THUMB);
		this.#ellipsis = options.ellipsis ?? Ellipsis.Unicode;
		this.#fastScrollLines = Math.max(1, Math.trunc(options.fastScrollLines ?? 5));
		this.#clampScrollOffset();
	}

	setLines(lines: readonly string[], options: ScrollViewSetLinesOptions = {}): void {
		const previousLines = this.#lines;
		const previousOffset = this.#scrollOffset;
		// Adopted without a copy (see the constructor): streaming callers rebuild
		// the full line array per update and a spread copy would touch every row.
		this.#lines = lines;
		if (options.preserveAnchor !== false && this.#totalRows === undefined) {
			const anchoredOffset = this.#findAnchoredOffset(previousLines, previousOffset);
			if (anchoredOffset !== undefined) this.#scrollOffset = anchoredOffset;
		}
		this.#clampScrollOffset();
	}

	setTotalRows(totalRows: number | undefined): void {
		this.#totalRows = totalRows === undefined ? undefined : Math.max(0, Math.trunc(totalRows));
		this.#clampScrollOffset();
	}

	setHeight(height: number): void {
		this.#height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
		this.#clampScrollOffset();
	}

	setScrollbar(scrollbar: ScrollViewOptions["scrollbar"]): void {
		this.#scrollbar = normalizeScrollbarMode(scrollbar);
	}

	getScrollOffset(): number {
		return this.#scrollOffset;
	}

	getMaxScrollOffset(): number {
		const rowCount = this.#totalRows ?? this.#lines.length;
		return Math.max(0, rowCount - this.#height);
	}

	setScrollOffset(offset: number): void {
		this.#scrollOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
		this.#clampScrollOffset();
	}

	scroll(delta: number): void {
		this.setScrollOffset(this.#scrollOffset + (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	page(delta: number): void {
		const step = Math.max(1, this.#height - 1);
		this.scroll(step * (Number.isFinite(delta) ? Math.trunc(delta) : 0));
	}

	scrollToTop(): void {
		this.#scrollOffset = 0;
	}

	scrollToBottom(): void {
		this.#scrollOffset = this.getMaxScrollOffset();
	}

	handleScrollKey(data: string): boolean {
		if (matchesKey(data, "shift+up")) {
			this.scroll(-this.#fastScrollLines);
			return true;
		}
		if (matchesKey(data, "shift+down")) {
			this.scroll(this.#fastScrollLines);
			return true;
		}
		if (matchesKey(data, "up")) {
			this.scroll(-1);
			return true;
		}
		if (matchesKey(data, "down")) {
			this.scroll(1);
			return true;
		}
		if (matchesKey(data, "pageUp")) {
			this.page(-1);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.page(1);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.scrollToTop();
			return true;
		}
		if (matchesKey(data, "end")) {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		this.#clampScrollOffset();
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		if (this.#height === 0) return [];
		const showScrollbar = safeWidth > 0 && this.#shouldRenderScrollbar();
		const contentWidth = Math.max(0, safeWidth - (showScrollbar ? 1 : 0));
		const thumb = showScrollbar ? this.#thumbRange() : undefined;
		const lines: string[] = [];
		for (let row = 0; row < this.#height; row++) {
			const sourceIndex = this.#totalRows === undefined ? this.#scrollOffset + row : row;
			const source = this.#lines[sourceIndex] ?? "";
			const truncated = truncateToWidth(replaceTabs(source), contentWidth, this.#ellipsis);
			if (!showScrollbar) {
				lines.push(truncated);
				continue;
			}
			const content = `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
			const barGlyph = thumb && row >= thumb.start && row < thumb.end ? this.#thumbChar : this.#trackChar;
			const styledBar =
				thumb && row >= thumb.start && row < thumb.end ? this.#theme.thumb(barGlyph) : this.#theme.track(barGlyph);
			lines.push(`${content}${styledBar}`);
		}
		return lines;
	}

	#clampScrollOffset(): void {
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, this.getMaxScrollOffset()));
	}

	#findAnchoredOffset(previousLines: readonly string[], previousOffset: number): number | undefined {
		const visibleRows = Math.min(this.#height, Math.max(0, previousLines.length - previousOffset));
		if (visibleRows === 0 || this.#lines.length === 0) return undefined;

		const anchorRows = new Map<string, number[]>();
		for (let row = 0; row < visibleRows; row++) {
			const line = previousLines[previousOffset + row];
			if (line === undefined || !/\S/.test(line)) continue;
			const rows = anchorRows.get(line);
			if (rows) rows.push(row);
			else anchorRows.set(line, [row]);
		}
		if (anchorRows.size === 0) return undefined;

		const maxOffset = Math.max(0, this.#lines.length - this.#height);
		const lines = this.#lines;
		const candidates = new Set<number>();
		for (let index = 0; index < lines.length; index++) {
			const rows = anchorRows.get(lines[index] ?? "");
			if (!rows) continue;
			for (const row of rows) candidates.add(Math.max(0, Math.min(index - row, maxOffset)));
		}

		// Score candidates nearest the previous offset first. Ties resolve by
		// (score, distance, first-seen index) exactly as the previous
		// insertion-order scan did — the stable sort keeps first-seen order among
		// equal distances — and two admissible bounds skip scoring that cannot
		// change the winner: once a candidate matches every visible row, no
		// farther candidate can win, and a candidate whose remaining rows cannot
		// beat (or tie at a smaller distance than) the running best is dropped at
		// its first mismatch.
		const ordered = [...candidates].sort((a, b) => Math.abs(a - previousOffset) - Math.abs(b - previousOffset));
		let bestOffset: number | undefined;
		let bestScore = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const candidate of ordered) {
			const distance = Math.abs(candidate - previousOffset);
			if (visibleRows <= bestScore) break;
			let score = 0;
			for (let row = 0; row < visibleRows; row++) {
				if (previousLines[previousOffset + row] === lines[candidate + row]) {
					score++;
				} else if (score + (visibleRows - row - 1) <= bestScore) {
					break;
				}
			}
			if (score > bestScore || (score === bestScore && distance < bestDistance)) {
				bestOffset = candidate;
				bestScore = score;
				bestDistance = distance;
			}
		}
		return bestOffset;
	}

	#shouldRenderScrollbar(): boolean {
		if (this.#height <= 0) return false;
		if (this.#scrollbar === "never") return false;
		if (this.#scrollbar === "always") return true;
		return (this.#totalRows ?? this.#lines.length) > this.#height;
	}

	#thumbRange(): { start: number; end: number } {
		if (this.#height <= 0) return { start: 0, end: 0 };
		const rowCount = this.#totalRows ?? this.#lines.length;
		if (rowCount <= this.#height) return { start: 0, end: this.#height };
		const thumbSize = Math.max(1, Math.min(Math.floor((this.#height * this.#height) / rowCount), this.#height));
		const travel = this.#height - thumbSize;
		const maxOffset = this.getMaxScrollOffset();
		const start = maxOffset === 0 ? 0 : Math.round((this.#scrollOffset / maxOffset) * travel);
		return { start, end: start + thumbSize };
	}
}
