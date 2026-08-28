import { extractPrintableText, matchesKey, ScrollView } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

export function renderScrollableList(
	rows: readonly string[],
	options: { width: number; totalRows: number; scrollOffset: number },
): readonly string[] {
	const sv = new ScrollView(rows, {
		height: rows.length,
		scrollbar: "auto",
		totalRows: options.totalRows,
		theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
	});
	sv.setScrollOffset(options.scrollOffset);
	return sv.render(options.width);
}

export function centeredWindow(
	selectedIndex: number,
	total: number,
	maxVisible: number,
): { startIndex: number; endIndex: number } {
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, total);
	return { startIndex, endIndex };
}

export function contentRowWidth(width: number, total: number, maxVisible: number): number {
	const overflow = total > maxVisible;
	return Math.max(0, width - (overflow ? 1 : 0));
}

export function clampSelection(
	selectedIndex: number,
	scrollOffset: number,
	total: number,
	maxVisible: number,
): { selectedIndex: number; scrollOffset: number } {
	if (total === 0) {
		return { selectedIndex: 0, scrollOffset: 0 };
	}

	const selected = Math.max(0, Math.min(selectedIndex, total - 1));

	let scroll = scrollOffset;
	if (selected < scroll) {
		scroll = selected;
	} else if (selected >= scroll + maxVisible) {
		scroll = selected - maxVisible + 1;
	}

	return { selectedIndex: selected, scrollOffset: scroll };
}

export function searchableChar(data: string): string | null {
	const printableText = extractPrintableText(data);
	if (printableText && printableText.length === 1) {
		const printableCharCode = printableText.charCodeAt(0);
		if (printableCharCode > 32 && printableCharCode < 127) {
			if (printableText === "j" || printableText === "k") {
				return null;
			}
			return printableText;
		}
	}
	return null;
}

export function handleTabSwitchKey(data: string, switchTab: (direction: 1 | -1) => void): boolean {
	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		switchTab(1);
		return true;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
		switchTab(-1);
		return true;
	}
	return false;
}
