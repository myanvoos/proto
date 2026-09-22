import {
	Container,
	Ellipsis,
	extractPrintableText,
	fuzzyFilter,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, type ThemeColor, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { bottomBorder, divider, getDialogViewport, OverlayPanel, row, topBorder } from "./overlay-box";
import { renderSegmentTrack } from "./segment-track";

interface HookSelectorSliderSegment {
	label: string;

	detail?: string;
}

export interface HookSelectorSlider {
	caption?: string;
	segments: HookSelectorSliderSegment[];

	index: number;

	onChange?: (index: number) => void;
}

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	onTimeoutStart?: () => void;
	onTimeoutReset?: () => void;
	initialIndex?: number;
	outline?: boolean;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	slider?: HookSelectorSlider;

	disabledIndices?: readonly number[];

	selectionMarker?: "radio" | "checkbox";

	checkedIndices?: readonly number[];

	markableCount?: number;

	/** False when a host panel already draws the border and footer. */
	framed?: boolean;
}

interface HookSelectorOption {
	label: string;
	description?: string;
}

type HookSelectorOptionInput = string | HookSelectorOption;

function normalizeHookSelectorOption(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	if (option.description?.trim()) {
		return { label: option.label, description: option.description.trim() };
	}
	return { label: option.label };
}

function sanitizeSliderText(value: string): string {
	return replaceTabs(sanitizeText(value.replace(/[\r\n]+/g, " ")));
}

function splitLeadingSpacesForWrap(line: string, width: number): { indent: string; body: string } {
	let indentLength = 0;
	while (indentLength < line.length && line.charCodeAt(indentLength) === 32) {
		indentLength += 1;
	}
	const maxIndentLength = Math.max(0, width - 1);
	const clampedIndentLength = Math.min(indentLength, maxIndentLength);
	return {
		indent: line.slice(0, clampedIndentLength),
		body: line.slice(indentLength),
	};
}

type SelectorRow = { text: string; highlight: boolean };

function paintSelectedRow(content: string): string {
	return theme.bg("selectedBg", content);
}

class OutlinedList extends Container {
	#rows: SelectorRow[] = [];

	setLines(rows: readonly SelectorRow[]): void {
		this.#rows = rows.slice();
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxRound.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const content: string[] = [];
		for (const row of this.#rows) {
			const normalized = replaceTabs(row.text);
			const { indent, body } = splitLeadingSpacesForWrap(normalized, innerWidth);
			const wrapped = wrapTextWithAnsi(body, Math.max(1, innerWidth - visibleWidth(indent)));
			for (const wrappedBody of wrapped.length > 0 ? wrapped : [""]) {
				const wrappedLine = `${indent}${wrappedBody}`;
				const pad = Math.max(0, innerWidth - visibleWidth(wrappedLine));
				const filled = `${wrappedLine}${padding(pad)}`;
				const painted = row.highlight ? paintSelectedRow(filled) : filled;
				content.push(`${borderColor(theme.boxRound.vertical)}${painted}${borderColor(theme.boxRound.vertical)}`);
			}
		}
		return [horizontal, ...content, horizontal];
	}
}

type FilteredOption = { option: HookSelectorOption; index: number };

export class HookSelectorComponent extends OverlayPanel {
	#viewportHeight = Number.POSITIVE_INFINITY;

	override setMaxHeight(rows: number): void {
		this.#viewportHeight = Math.max(1, Math.trunc(rows));
	}

	#options: HookSelectorOption[];
	#filteredOptions: FilteredOption[];
	#searchQuery = "";
	#selectedIndex: number;
	#disabledIndices: Set<number>;
	#selectionMarker: "radio" | "checkbox" | undefined;
	#checkedIndices: Set<number>;
	#markableCount: number;
	#maxVisible: number;
	#listContainer: Container | undefined;
	#outlinedList: OutlinedList | undefined;
	#onSelectCallback: (option: string) => void;
	#onCancelCallback: () => void;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#onLeftCallback: (() => void) | undefined;
	#onRightCallback: (() => void) | undefined;
	#onExternalEditorCallback: (() => void) | undefined;
	#onTimeoutResetCallback: (() => void) | undefined;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number = 0;
	#sliderComponent: Text | undefined;
	#lastRenderWidth: number | undefined;
	#choiceExposed = true;
	#detailLines: string[];
	constructor(
		title: string,
		options: HookSelectorOptionInput[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		const sanitizedTitle = sanitizeText(title);
		super(sanitizedTitle.split(/\r?\n/, 1)[0] ?? "");

		this.setFramed(opts?.framed !== false);
		this.#detailLines = sanitizedTitle.split(/\r?\n/).slice(1);
		this.#options = options.map(normalizeHookSelectorOption);
		this.#filteredOptions = this.#options.map((option, index) => ({ option, index }));
		this.#disabledIndices = new Set(
			(opts?.disabledIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#selectionMarker = opts?.selectionMarker;
		this.#checkedIndices = new Set(
			(opts?.checkedIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#markableCount = Math.max(0, Math.min(opts?.markableCount ?? this.#options.length, this.#options.length));
		this.#selectedIndex = this.#coerceSelectedIndex(opts?.initialIndex ?? 0);
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = this.title;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;
		this.#onTimeoutResetCallback = opts?.onTimeoutReset;
		if (opts?.slider && opts.slider.segments.length > 0) {
			// Segment labels are interpolated inside renderSegmentTrack's styling;
			// sanitize once at this boundary rather than after ANSI has been added.
			this.#slider = {
				...opts.slider,
				caption: opts.slider.caption === undefined ? undefined : sanitizeSliderText(opts.slider.caption),
				segments: opts.slider.segments.map(segment => ({
					...segment,
					label: sanitizeSliderText(segment.label),
					detail: segment.detail === undefined ? undefined : sanitizeSliderText(segment.detail),
				})),
			};
			this.#sliderIndex = Math.max(0, Math.min(this.#slider.index, this.#slider.segments.length - 1));
		}

		this.addChild(new Spacer(1));
		for (const line of this.#detailLines) {
			this.addChild(new Text(theme.fg("accent", line), 0, 0));
		}
		this.addChild(new Spacer(1));

		if (this.#slider) {
			this.#sliderComponent = new Text(this.#renderSliderLine(), 0, 0);
			this.addChild(this.#sliderComponent);
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			opts.onTimeoutStart?.();
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => (this.title = `${this.#baseTitle} (${s}s)`),
				() => {
					opts?.onTimeout?.();

					const selected = this.#filteredOptions[this.#selectedIndex];
					if (selected && !this.#isDisabled(selected.index)) {
						this.#onSelectCallback(selected.option.label);
					} else {
						this.#onCancelCallback();
					}
				},
			);
		}

		if (opts?.outline) {
			this.#outlinedList = new OutlinedList();
			this.addChild(this.#outlinedList);
		} else {
			this.#listContainer = new Container();
			this.addChild(this.#listContainer);
		}
		if (this.framed) {
			this.addChild(new Spacer(1));
			const controlsHint = opts?.helpText ?? "up/down navigate  enter select  esc cancel";
			this.addChild(new Text(theme.fg("dim", sanitizeText(controlsHint)), 0, 0));
			this.addChild(new Spacer(1));
		}

		this.#updateList();
	}

	#isDisabled(index: number): boolean {
		return this.#disabledIndices.has(index);
	}

	#coerceSelectedIndex(index: number): number {
		if (this.#filteredOptions.length === 0) return -1;
		const maxIndex = this.#filteredOptions.length - 1;
		const clamped = Math.max(0, Math.min(index, maxIndex));
		const clampedOption = this.#filteredOptions[clamped];
		if (clampedOption && !this.#isDisabled(clampedOption.index)) return clamped;
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const option = this.#filteredOptions[i];
			if (option && !this.#isDisabled(option.index)) return i;
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const option = this.#filteredOptions[i];
			if (option && !this.#isDisabled(option.index)) return i;
		}
		return clamped;
	}

	#moveSelection(delta: number): void {
		if (this.#filteredOptions.length === 0) return;
		const maxIndex = this.#filteredOptions.length - 1;
		let index = this.#selectedIndex;
		while (true) {
			const next = Math.max(0, Math.min(index + delta, maxIndex));
			if (next === index) return;
			index = next;
			const option = this.#filteredOptions[index];
			if (option && !this.#isDisabled(option.index)) {
				this.#selectedIndex = index;
				this.#updateList();
				return;
			}
		}
	}

	#renderOptionLines(
		option: HookSelectorOption,
		isSelected: boolean,
		isDisabled: boolean,
		mdTheme: MarkdownTheme,
		descRows: number | "full",
		renderWidth?: number,
		index?: number,
	): string[] {
		const textColor = isDisabled ? "dim" : isSelected ? "accent" : "text";
		const prefixColor = isDisabled ? "dim" : "accent";
		const label = renderInlineMarkdown(sanitizeText(option.label), mdTheme, t => theme.fg(textColor, t));
		const marker = index !== undefined ? this.#renderMarkerPrefix(index, isSelected, isDisabled) : undefined;
		const prefix = marker ?? (isSelected ? theme.fg(prefixColor, `${theme.nav.cursor} `) : "  ");
		const lines = [prefix + label];
		if (option.description && descRows !== 0) {
			const descriptionColor: ThemeColor = isDisabled ? "dim" : "muted";
			if (descRows === "full") {
				const description = renderInlineMarkdown(sanitizeText(option.description), mdTheme, t =>
					theme.fg(descriptionColor, t),
				);
				lines.push(`    ${description}`);
			} else {
				lines.push(
					...this.#wrapDescriptionRows(option.description, descRows, descriptionColor, mdTheme, renderWidth),
				);
			}
		}
		return lines;
	}

	#renderMarkerPrefix(index: number, isSelected: boolean, isDisabled: boolean): string | undefined {
		if (this.#selectionMarker === undefined || index >= this.#markableCount) return undefined;
		if (this.#selectionMarker === "radio") {
			const glyph = isSelected ? theme.radio.selected : theme.radio.unselected;
			const color = isDisabled ? "dim" : isSelected ? "accent" : "dim";
			return theme.fg(color, `${glyph} `);
		}
		const checked = this.#checkedIndices.has(index);
		const glyph = checked ? theme.checkbox.checked : theme.checkbox.unchecked;
		const color = isDisabled ? "dim" : isSelected ? "accent" : checked ? "success" : "dim";
		return theme.fg(color, `${glyph} `);
	}

	#wrapDescriptionRows(
		description: string,
		maxRows: number,
		color: ThemeColor,
		mdTheme: MarkdownTheme,
		renderWidth = this.#lastRenderWidth,
	): string[] {
		if (maxRows <= 0) return [];
		const indent = "    ";
		const innerWidth = Math.max(1, (renderWidth ?? 80) - 2);
		const bodyWidth = Math.max(1, innerWidth - indent.length);
		const colored = renderInlineMarkdown(sanitizeText(description), mdTheme, t => theme.fg(color, t));
		const wrapped = wrapTextWithAnsi(colored, bodyWidth);
		if (wrapped.length <= maxRows) return wrapped.map(row => indent + row);
		const kept = wrapped.slice(0, maxRows);
		kept[maxRows - 1] = truncateToWidth(wrapped.slice(maxRows - 1).join(" "), bodyWidth, Ellipsis.Unicode);
		return kept.map(row => indent + row);
	}

	#renderedLineRowCount(line: string, renderWidth: number): number {
		const normalized = replaceTabs(line);
		if (this.#outlinedList) {
			const innerWidth = Math.max(1, renderWidth - 2);
			const { indent, body } = splitLeadingSpacesForWrap(normalized, innerWidth);
			const wrapped = wrapTextWithAnsi(body, Math.max(1, innerWidth - visibleWidth(indent)));
			return Math.max(1, wrapped.length);
		}
		const wrapped = wrapTextWithAnsi(normalized, Math.max(1, renderWidth - 2));
		return Math.max(1, wrapped.length);
	}

	#optionRowCount(
		option: HookSelectorOption,
		renderWidth: number | undefined,
		isSelected: boolean,
		mdTheme: MarkdownTheme,
		descRows: number | "full",
	): number {
		if (renderWidth === undefined) return option.description && descRows !== 0 ? 2 : 1;
		let rows = 0;
		for (const line of this.#renderOptionLines(option, isSelected, false, mdTheme, descRows, renderWidth)) {
			rows += this.#renderedLineRowCount(line, renderWidth);
		}
		return rows;
	}

	#totalOptionRows(options: HookSelectorOption[], renderWidth?: number, mdTheme?: MarkdownTheme): number {
		const themeForRows = mdTheme ?? getMarkdownTheme();
		let rows = 0;
		for (const option of options) {
			rows += this.#optionRowCount(option, renderWidth, false, themeForRows, "full");
		}
		return rows;
	}

	#getVisibleOptionRange(
		total: number,
		renderWidth?: number,
		mdTheme: MarkdownTheme = getMarkdownTheme(),
		compact = false,
	): { startIndex: number; endIndex: number } {
		if (total === 0) return { startIndex: 0, endIndex: 0 };

		const descMode: number | "full" = compact ? 0 : "full";
		const rowBudget = Math.max(1, this.#maxVisible);
		const selectedIndex = Math.max(0, Math.min(this.#selectedIndex, total - 1));
		let startIndex = selectedIndex;
		let endIndex = selectedIndex + 1;
		let rows = this.#optionRowCount(
			this.#filteredOptions[selectedIndex]!.option,
			renderWidth,
			true,
			mdTheme,
			descMode,
		);
		let beforeRows = 0;
		const targetBeforeRows = Math.max(0, Math.floor((rowBudget - rows) / 2));

		while (startIndex > 0) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[startIndex - 1]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (beforeRows + cost > targetBeforeRows || rows + cost > rowBudget) break;
			startIndex--;
			beforeRows += cost;
			rows += cost;
		}

		while (endIndex < total) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[endIndex]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (rows + cost > rowBudget) break;
			endIndex++;
			rows += cost;
		}

		while (startIndex > 0) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[startIndex - 1]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (rows + cost > rowBudget) break;
			startIndex--;
			rows += cost;
		}

		return { startIndex, endIndex };
	}

	#updateList(renderWidth = this.#lastRenderWidth): void {
		const rows: SelectorRow[] = [];
		const total = this.#filteredOptions.length;
		const mdTheme = getMarkdownTheme();

		const compact = this.#isSearchEnabled(renderWidth, mdTheme);
		const { startIndex, endIndex } = this.#getVisibleOptionRange(total, renderWidth, mdTheme, compact);

		let selectedDescRows = 0;
		if (compact && renderWidth !== undefined) {
			let labelRows = 0;
			for (let i = startIndex; i < endIndex; i++) {
				const filtered = this.#filteredOptions[i];
				if (filtered === undefined) continue;
				labelRows += this.#optionRowCount(filtered.option, renderWidth, i === this.#selectedIndex, mdTheme, 0);
			}

			selectedDescRows = Math.max(0, Math.max(1, this.#maxVisible) - labelRows - 1);
		}

		for (let i = startIndex; i < endIndex; i++) {
			const filtered = this.#filteredOptions[i];
			if (filtered === undefined) continue;
			const isSelected = i === this.#selectedIndex;
			const isDisabled = this.#isDisabled(filtered.index);
			const descMode: number | "full" = compact ? (isSelected ? selectedDescRows : 0) : "full";

			const highlight = isSelected && !isDisabled;
			for (const text of this.#renderOptionLines(
				filtered.option,
				isSelected,
				isDisabled,
				mdTheme,
				descMode,
				renderWidth,
				filtered.index,
			)) {
				rows.push({ text, highlight });
			}
		}

		if (total === 0) {
			rows.push({ text: theme.fg("dim", "  No matching options"), highlight: false });
		}

		if (startIndex > 0 || endIndex < total || this.#shouldRenderSearchStatus(renderWidth, mdTheme)) {
			rows.push({ text: this.#renderStatusLine(total), highlight: false });
		}
		if (this.#outlinedList) {
			this.#outlinedList.setLines(rows);
			return;
		}
		this.#listContainer?.clear();
		for (const row of rows) {
			const bgFn = row.highlight ? paintSelectedRow : undefined;
			this.#listContainer?.addChild(new Text(row.text, 1, 0, bgFn));
		}
	}

	#renderSliderLine(): string {
		const slider = this.#slider;
		if (!slider) return "";
		const segments = slider.segments;
		const active = this.#sliderIndex;
		const track = renderSegmentTrack(segments, active);

		const leftArrow = theme.fg(active > 0 ? "accent" : "dim", "◂");
		const rightArrow = theme.fg(active < segments.length - 1 ? "accent" : "dim", "▸");
		const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
		const trackLine = `${caption}${leftArrow}  ${track}  ${rightArrow}`;
		const detail = segments[active]?.detail;
		if (!detail) return trackLine;
		return `${trackLine}\n  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`;
	}

	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, this.#sliderIndex + delta));
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		this.#sliderComponent?.setText(this.#renderSliderLine());
		slider.onChange?.(next);
	}

	#isSearchEnabled(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#totalOptionRows(this.#options, renderWidth, mdTheme) > this.#maxVisible;
	}

	#shouldRenderSearchStatus(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#isSearchEnabled(renderWidth, mdTheme) || this.#searchQuery.length > 0;
	}

	#renderStatusLine(total: number): string {
		const selectedCount = total === 0 ? 0 : this.#selectedIndex + 1;
		const count =
			this.#searchQuery.trim() && total !== this.#options.length
				? `${selectedCount}/${total} of ${this.#options.length}`
				: `${selectedCount}/${total}`;
		const suffix = this.#searchQuery.trim() ? `  Search: ${this.#searchQuery}` : "  Type to search";
		return theme.fg("dim", `  (${count})${suffix}`);
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		const indexedOptions = this.#options.map((option, index) => ({ option, index }));
		this.#filteredOptions = query.trim()
			? fuzzyFilter(indexedOptions, query, item => `${item.option.label} ${item.option.description ?? ""}`)
			: indexedOptions;
		this.#selectedIndex = this.#coerceSelectedIndex(0);
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	handleInput(keyData: string): void {
		if (this.#countdown) {
			this.#countdown.reset();
			this.#onTimeoutResetCallback?.();
		}

		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (matchesSelectUp(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "k"))) {
			this.#moveSelection(-1);
		} else if (matchesSelectDown(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "j"))) {
			this.#moveSelection(1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			// Never activate a choice the last frame could not show: approving a
			// dialog the terminal hid would be a blind, possibly destructive, yes.
			if (!this.#choiceExposed) return;
			const selected = this.#filteredOptions[this.#selectedIndex];
			if (selected && !this.#isDisabled(selected.index)) this.#onSelectCallback(selected.option.label);
		} else if (
			matchesKey(keyData, "left") ||
			(this.#slider && !this.#isSearchEnabled() && matchesKey(keyData, "h"))
		) {
			if (this.#slider) this.#moveSlider(-1);
			else this.#onLeftCallback?.();
		} else if (
			matchesKey(keyData, "right") ||
			(this.#slider && !this.#isSearchEnabled() && matchesKey(keyData, "l"))
		) {
			if (this.#slider) this.#moveSlider(1);
			else this.#onRightCallback?.();
		} else if (this.#onExternalEditorCallback && matchesAppExternalEditor(keyData)) {
			this.#onExternalEditorCallback();
		}
	}

	/** One row that still names the pending choice and proves alternatives exist. */
	#inlineChoices(
		renderWidth: number,
		mdTheme: MarkdownTheme,
	): { line: string; selectedShown: boolean; alternativesShown: boolean } {
		const total = this.#filteredOptions.length;
		if (total === 0) {
			return { line: theme.fg("muted", "No matching options"), selectedShown: false, alternativesShown: false };
		}
		const separator = " · ";
		const selected = Math.max(0, Math.min(this.#selectedIndex, total - 1));
		const plain: string[] = [];
		const painted: string[] = [];
		const render = (index: number): { plain: string; painted: string } => {
			const entry = this.#filteredOptions[index]!;
			const isSelected = index === selected;
			const label = sanitizeText(entry.option.label);
			const text = isSelected ? `${theme.nav.cursor} ${label}` : label;
			const color = this.#isDisabled(entry.index) ? "dim" : isSelected ? "accent" : "text";
			return {
				plain: text,
				painted: renderInlineMarkdown(text, mdTheme, part =>
					isSelected ? theme.bold(theme.fg(color, part)) : theme.fg(color, part),
				),
			};
		};
		const fits = (candidate: string[], shown: number): boolean =>
			visibleWidth(candidate.join(separator)) + (total - shown > 0 ? visibleWidth(` +${total - shown}`) : 0) <=
			renderWidth;
		// Grow outward from the selected row but keep the list in its natural
		// order, so moving the cursor never reshuffles the alternatives.
		let first = selected;
		let last = selected;
		const head = render(selected);
		plain.push(head.plain);
		painted.push(head.painted);
		while (last + 1 < total || first > 0) {
			const forward = last + 1 < total ? render(last + 1) : undefined;
			if (forward && fits([...plain, forward.plain], plain.length + 1)) {
				plain.push(forward.plain);
				painted.push(forward.painted);
				last += 1;
				continue;
			}
			const backward = first > 0 ? render(first - 1) : undefined;
			if (backward && fits([backward.plain, ...plain], plain.length + 1)) {
				plain.unshift(backward.plain);
				painted.unshift(backward.painted);
				first -= 1;
				continue;
			}
			break;
		}
		const hidden = total - plain.length;
		const suffix = hidden > 0 ? ` +${hidden}` : "";
		const plainLine = plain.join(separator) + suffix;
		const clipped = visibleWidth(plainLine) > renderWidth;
		const line = truncateToWidth(
			painted.join(theme.fg("dim", separator)) + (hidden > 0 ? theme.fg("dim", suffix) : ""),
			renderWidth,
			Ellipsis.Unicode,
		);
		// Once the row is clipped only the selected label may have survived, so
		// the alternatives are no longer proven to be on screen.
		return {
			line,
			selectedShown: clipped ? visibleWidth(plain[0] ?? "") + 1 <= renderWidth : plain.length > 0,
			alternativesShown: !clipped && (total === 1 || plain.length > 1 || hidden > 0),
		};
	}

	override render(width: number): readonly string[] {
		// Embedded in a host frame: every row belongs to the question and its choices.
		const layout = this.framed
			? getDialogViewport(this.#viewportHeight)
			: {
					titleRows: 0,
					bodyRows: Math.max(1, Math.trunc(this.#viewportHeight)),
					dividerRows: 0,
					footerRows: 0,
					bottomRows: 0,
				};
		const renderWidth = Math.max(1, layout.titleRows ? width - 4 : width);
		if (Number.isFinite(this.#viewportHeight)) {
			this.#lastRenderWidth = renderWidth;
			this.#updateList(renderWidth);
			const natural = super.render(width);
			if (natural.length <= this.#viewportHeight) {
				this.#choiceExposed = true;
				return natural;
			}
			const framed = layout.titleRows > 0;
			const mdTheme = getMarkdownTheme();
			const lines: string[] = [];
			// A single row must still carry both identity and choice, so the title
			// shares that row with the collapsed option list.
			const sharedRow = !framed && layout.bodyRows <= 1;
			const titleWidth = sharedRow ? Math.max(0, Math.floor(renderWidth / 2) - 1) : renderWidth;
			const titleText = truncateToWidth(this.title, titleWidth, Ellipsis.Unicode);
			const titleShown = titleText.trim().length > 0;
			if (framed) lines.push(topBorder(width, this.title));
			else if (!sharedRow) lines.push(row(theme.bold(theme.fg("accent", titleText)), width, false));
			let bodyRows = framed || sharedRow ? layout.bodyRows : layout.bodyRows - 1;
			// A destructive question must keep naming its target before alternatives
			// are collapsed, so identity detail outranks the spare option rows.
			const detail = this.#detailLines
				.slice(0, Math.max(0, bodyRows - 1))
				.map(line => truncateToWidth(theme.fg("accent", line), renderWidth, Ellipsis.Unicode));
			if (!sharedRow) {
				for (const line of detail) lines.push(row(line, width, framed));
				bodyRows -= detail.length;
			}
			const choiceWidth = sharedRow ? Math.max(1, renderWidth - visibleWidth(titleText) - 1) : renderWidth;
			let selectedShown = false;
			let alternativesShown = false;
			if (bodyRows >= this.#filteredOptions.length && this.#filteredOptions.length > 0) {
				for (let i = 0; i < this.#filteredOptions.length; i++) {
					const option = this.#filteredOptions[i]!;
					const content =
						this.#renderOptionLines(
							option.option,
							i === this.#selectedIndex,
							this.#isDisabled(option.index),
							mdTheme,
							0,
							renderWidth,
						)[0] ?? "";
					lines.push(row(truncateToWidth(content, renderWidth), width, framed));
				}
				selectedShown = true;
				alternativesShown = true;
			} else if (bodyRows > 0) {
				// Scarce rows: collapse the list so the pending choice and its
				// alternatives stay on screen instead of a lone bare option.
				const inline = this.#inlineChoices(choiceWidth, mdTheme);
				const content = sharedRow ? `${theme.bold(theme.fg("accent", titleText))} ${inline.line}` : inline.line;
				lines.push(row(content, width, framed));
				selectedShown = inline.selectedShown;
				alternativesShown = inline.alternativesShown;
			}
			if (layout.dividerRows) lines.push(divider(width));
			if (layout.footerRows) {
				lines.push(row(theme.fg("dim", "↑/↓ select · Enter confirm · Esc back"), width, framed));
			}
			if (layout.bottomRows) lines.push(bottomBorder(width));
			this.#choiceExposed = titleShown && selectedShown && alternativesShown;
			return lines;
		}

		if (this.#lastRenderWidth !== renderWidth) {
			this.#lastRenderWidth = renderWidth;
			this.#updateList(renderWidth);
		}
		this.#choiceExposed = true;
		return super.render(width);
	}

	override dispose(): void {
		this.#countdown?.dispose();
	}
}
