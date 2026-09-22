import type { Theme, ThemeColor } from "../modes/theme/theme";
import type { ToolUIStatus } from "../tools/render-utils";
import { formatStatusIcon } from "../tools/render-utils";

interface StatusLineOptions {
	icon?: ToolUIStatus;

	iconOverride?: string;
	spinnerFrame?: number;
	title: string;
	titleColor?: ThemeColor;
	description?: string;
	badge?: { label: string; color: ThemeColor };
	meta?: string[];
}

function flattenForHeader(text: string): string {
	return text.replace(/\r\n?|\n/g, " ");
}

export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
	const icon =
		options.iconOverride ?? (options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "");
	const titleColor = options.titleColor ?? "accent";
	const title = theme.fg(titleColor, flattenForHeader(options.title));
	let line = icon ? `${icon} ${title}` : title;

	if (options.description) {
		line += `: ${theme.fg("muted", flattenForHeader(options.description))}`;
	}

	if (options.badge) {
		const { label, color } = options.badge;
		line += ` ${theme.fg(color, `${theme.format.bracketLeft}${flattenForHeader(label)}${theme.format.bracketRight}`)}`;
	}

	const meta = options.meta?.map(flattenForHeader).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		// Meta is a separate clause from the title, so it takes the same separator that already
		// divides meta entries; a bare space ran the two together ("Fleet peers no other agents").
		line += theme.fg("dim", `${theme.sep.dot}${meta.join(theme.sep.dot)}`);
	}

	return line;
}
