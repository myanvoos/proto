import { type Component, Ellipsis, Input, matchesKey, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import type { HistoryEntry, HistoryStorage } from "../../session/history-storage";
import { rawKeyHint } from "./keybinding-hints";
import { bottomBorder, getDialogViewport, row, topBorder } from "./overlay-box";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

const MAX_VISIBLE = 10;

function queryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(tok => tok.length > 0);
}

function highlightTokens(text: string, tokens: string[]): string {
	if (tokens.length === 0) return text;

	const lower = text.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const tok of tokens) {
		let from = lower.indexOf(tok);
		while (from !== -1) {
			ranges.push([from, from + tok.length]);
			from = lower.indexOf(tok, from + tok.length);
		}
	}
	if (ranges.length === 0) return text;

	ranges.sort((a, b) => a[0] - b[0]);
	let out = "";
	let pos = 0;
	for (const [start, end] of ranges) {
		if (end <= pos) continue;
		const from = Math.max(start, pos);
		if (from > pos) out += text.slice(pos, from);
		out += theme.fg("accent", text.slice(from, end));
		pos = end;
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

function relativeTime(epochSeconds: number): string {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

class HistoryResultsList implements Component {
	#results: HistoryEntry[] = [];
	#tokens: string[] = [];
	#selectedIndex = 0;
	#maxVisible = MAX_VISIBLE;

	setResults(results: HistoryEntry[], selectedIndex: number, tokens: string[]): void {
		this.#results = results;
		this.#selectedIndex = selectedIndex;
		this.#tokens = tokens;
	}

	setMaxHeight(rows: number): void {
		this.#maxVisible = Math.max(1, Math.min(MAX_VISIBLE, rows));
	}

	setSelectedIndex(selectedIndex: number): void {
		this.#selectedIndex = selectedIndex;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		if (this.#results.length === 0) {
			const message = this.#tokens.length > 0 ? "No matching history" : "No history yet";
			lines.push(truncateToWidth(theme.fg("muted", `${theme.status.info} ${message}`), width));
			return lines;
		}

		const cursorSymbol = `${theme.nav.cursor} `;
		const gutterWidth = visibleWidth(cursorSymbol);

		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#results.length, this.#maxVisible);

		const rowWidth = contentRowWidth(width, this.#results.length, this.#maxVisible);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.#results[i];
			const isSelected = i === this.#selectedIndex;

			const timeStr = relativeTime(entry.created_at);
			const timeWidth = visibleWidth(timeStr);
			const showTime = rowWidth >= gutterWidth + 24 + timeWidth + 1;

			const promptBudget = Math.max(4, rowWidth - gutterWidth - (showTime ? timeWidth + 1 : 0));
			const normalized = entry.prompt.replace(/\s+/g, " ").trim();
			const plain = truncateToWidth(normalized, promptBudget);
			const highlighted = highlightTokens(plain, this.#tokens);

			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(gutterWidth);
			let line = cursor + (isSelected ? theme.bold(highlighted) : highlighted);

			if (showTime) {
				line = `${truncateToWidth(line, rowWidth - timeWidth - 1, Ellipsis.Unicode, true)} ${theme.fg("dim", timeStr)}`;
			}

			rows.push(
				isSelected
					? theme.bg("selectedBg", truncateToWidth(line, rowWidth, Ellipsis.Omit, true))
					: truncateToWidth(line, rowWidth),
			);
		}

		lines.push(...renderScrollableList(rows, { width, totalRows: this.#results.length, scrollOffset: startIndex }));
		return lines;
	}
}

export class HistorySearchComponent implements Component {
	#historyStorage: HistoryStorage;
	#searchInput: Input;
	#results: HistoryEntry[] = [];
	#selectedIndex = 0;
	#resultsList: HistoryResultsList;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;
	#maxHeight = MAX_VISIBLE + 5;
	#visibleRows = MAX_VISIBLE;
	#hint: string;

	constructor(historyStorage: HistoryStorage, onSelect: (prompt: string) => void, onCancel: () => void) {
		this.#historyStorage = historyStorage;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;

		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
		};
		this.#searchInput.onEscape = () => {
			this.#onCancel();
		};

		this.#resultsList = new HistoryResultsList();

		const dot = theme.fg("dim", theme.sep.dot);
		this.#hint = [rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "select"), rawKeyHint("esc", "cancel")].join(dot);

		this.#updateResults();
	}

	setMaxHeight(rows: number): void {
		this.#maxHeight = Math.max(1, Math.trunc(rows));
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		// Reserve the query separately: both query and selected result outrank borders/hints.
		const queryRows = this.#maxHeight >= 2 ? 1 : 0;
		const layout = getDialogViewport(this.#maxHeight - queryRows);
		const innerWidth = Math.max(0, layout.titleRows ? width - 4 : width);
		this.#visibleRows = Math.min(MAX_VISIBLE, layout.bodyRows + layout.dividerRows);
		this.#resultsList.setMaxHeight(this.#visibleRows);
		const lines: string[] = [];
		if (layout.titleRows) lines.push(topBorder(width, "History"));
		if (queryRows)
			lines.push(row(this.#searchInput.render(Math.max(1, innerWidth))[0] ?? "", width, layout.titleRows > 0));
		for (const line of this.#resultsList.render(innerWidth)) lines.push(row(line, width, layout.titleRows > 0));
		if (layout.footerRows) lines.push(row(width < 40 ? "↑↓ · Enter pick" : this.#hint, width, layout.titleRows > 0));
		if (layout.bottomRows) lines.push(bottomBorder(width));
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectDown(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectPageUp(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#visibleRows);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectPageDown(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + this.#visibleRows);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "home")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = 0;
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "end")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = this.#results.length - 1;
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			this.#onCancel();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#updateResults();
	}

	#updateResults(): void {
		const query = this.#searchInput.getValue().trim();
		this.#results = query
			? this.#historyStorage.search(query, this.#resultLimit)
			: this.#historyStorage.getRecent(this.#resultLimit);
		this.#selectedIndex = 0;
		this.#resultsList.setResults(this.#results, this.#selectedIndex, query ? queryTokens(query) : []);
	}
}
