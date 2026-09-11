import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getMarkdownTheme, highlightCode, type Theme } from "../modes/theme/theme";
import {
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	replaceTabs,
} from "../tools/render-utils";
import { outputBlockContentWidth, renderOutputBlock } from "./output-block";
import type { State } from "./types";

interface CodeCellOptions {
	code: string;
	language?: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	codeMaxLines?: number;

	codeTail?: boolean;
	expanded?: boolean;

	showLanguage?: boolean;
	width: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
	preRenderedCodeLines?: string[];
	codeVariant?: string;
	extraSections?: Array<{ label?: string; lines: readonly string[] }>;
}

function getState(status?: CodeCellOptions["status"]): State | undefined {
	if (!status) return undefined;
	if (status === "complete") return "success";
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	if (status === "running") return "running";
	return "pending";
}

function formatHeader(options: CodeCellOptions, theme: Theme): { title: string; meta?: string } {
	const { index, total, title, status, spinnerFrame, duration, language, showLanguage, codeVariant } = options;
	const parts: string[] = [];
	if (showLanguage && language) {
		const langIcon = theme.getLangIconStyled(language);
		if (langIcon) parts.push(langIcon);
	}
	if (status) {
		const icon = formatStatusIcon(
			status === "complete"
				? "done"
				: status === "error"
					? "error"
					: status === "warning"
						? "warning"
						: status === "running"
							? "running"
							: "pending",
			theme,
			spinnerFrame,
		);
		if (status === "pending" || status === "running") {
			parts.push(`${icon} ${theme.fg("muted", status)}`);
		} else {
			parts.push(icon);
		}
	}
	if (index !== undefined && total !== undefined && total > 1) {
		parts.push(theme.fg("accent", `[${index + 1}/${total}]`));
	}
	if (title) {
		parts.push(theme.fg("toolTitle", title));
	}
	const headerTitle = parts.length > 0 ? parts.join(" ") : theme.fg("toolTitle", "Code");

	const metaParts: string[] = [];
	if (codeVariant) {
		metaParts.push(theme.fg("dim", codeVariant));
	}
	if (duration !== undefined) {
		metaParts.push(theme.fg("dim", `(${formatDuration(duration)})`));
	}
	if (metaParts.length === 0) return { title: headerTitle };
	return { title: headerTitle, meta: metaParts.join(theme.fg("dim", theme.sep.dot)) };
}

function sanitizeTerminalLines(text: string): string[] {
	return text.split(/\r?\n/).map(collapseCarriageReturns);
}

function collapseCarriageReturns(line: string): string {
	const idx = line.lastIndexOf("\r");
	return idx < 0 ? line : line.slice(idx + 1);
}
export function renderCodeCell(options: CodeCellOptions, theme: Theme): string[] {
	const {
		code,
		language,
		output,
		expanded = false,
		outputMaxLines = 6,
		codeMaxLines = 12,
		width,
		codeStartLine,
		codeLineNumbers,
	} = options;
	const { title, meta } = formatHeader(options, theme);
	const state = getState(options.status);

	const overrideLines = options.preRenderedCodeLines;
	const rawCodeLines = overrideLines ?? sanitizeTerminalLines(replaceTabs(code ?? ""));
	const maxCodeLines = expanded ? rawCodeLines.length : Math.min(rawCodeLines.length, codeMaxLines);
	const hiddenCodeLines = rawCodeLines.length - maxCodeLines;
	const tail = options.codeTail === true && !expanded && hiddenCodeLines > 0;
	const startIndex = tail ? rawCodeLines.length - maxCodeLines : 0;
	const visibleSlice = rawCodeLines.slice(startIndex, startIndex + maxCodeLines);
	const codeLines = overrideLines ? visibleSlice.slice() : highlightCode(visibleSlice.join("\n"), language);

	let visibleLineNumbers: Array<number | null> | undefined;
	let lineNumberWidth = 0;
	if (codeLineNumbers) {
		visibleLineNumbers = codeLineNumbers.slice(startIndex, startIndex + maxCodeLines);
	} else if (codeStartLine !== undefined) {
		visibleLineNumbers = Array.from({ length: maxCodeLines }, (_, i) => codeStartLine + startIndex + i);
	}

	if (visibleLineNumbers) {
		const validLineNums = visibleLineNumbers.filter((n): n is number => n !== null && n !== undefined);
		const maxVal = validLineNums.length > 0 ? Math.max(...validLineNums) : 0;
		if (maxVal > 0) {
			lineNumberWidth = Math.max(2, String(maxVal).length);
		}
	}

	if (lineNumberWidth > 0 && visibleLineNumbers) {
		for (let i = 0; i < codeLines.length; i++) {
			const lineNum = visibleLineNumbers[i];
			const gutter =
				lineNum !== null && lineNum !== undefined
					? String(lineNum).padStart(lineNumberWidth, " ")
					: " ".repeat(lineNumberWidth);
			codeLines[i] = theme.fg("dim", `${gutter} `) + codeLines[i];
		}
	}

	if (hiddenCodeLines > 0) {
		const hint = formatExpandHint(theme, expanded, hiddenCodeLines > 0);
		const gutterPad = lineNumberWidth > 0 ? " ".repeat(lineNumberWidth + 1) : "";
		if (tail) {
			const earlier = `… ${hiddenCodeLines} earlier line${hiddenCodeLines === 1 ? "" : "s"}${hint ? ` ${hint}` : ""}`;
			codeLines.unshift(theme.fg("dim", gutterPad + earlier));
		} else {
			const moreLine = `${formatMoreItems(hiddenCodeLines, "line")}${hint ? ` ${hint}` : ""}`;
			codeLines.push(theme.fg("dim", gutterPad + moreLine));
		}
	}

	const outputLines: string[] = [];
	if (output?.trim()) {
		const rawLines = sanitizeTerminalLines(output);
		const maxLines = expanded ? rawLines.length : Math.min(rawLines.length, outputMaxLines);
		const displayLines = rawLines
			.slice(0, maxLines)
			.map(line => (line.includes("\x1b[") ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))));
		outputLines.push(...displayLines);
		const remaining = rawLines.length - maxLines;
		if (remaining > 0) {
			const hint = formatExpandHint(theme, expanded, remaining > 0);
			const moreLine = `${formatMoreItems(remaining, "line")}${hint ? ` ${hint}` : ""}`;
			outputLines.push(theme.fg("dim", moreLine));
		}
	}

	const sections: Array<{ label?: string; lines: string[] }> = [{ lines: codeLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: outputLines });
	}
	for (const section of options.extraSections ?? []) {
		if (section.lines.length > 0) sections.push({ label: section.label, lines: [...section.lines] });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}

interface MarkdownCellOptions {
	content: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	contentMaxLines?: number;
	expanded?: boolean;
	width: number;
}

export function renderMarkdownCell(options: MarkdownCellOptions, theme: Theme): string[] {
	const { content, output, expanded = false, outputMaxLines = 6, contentMaxLines = 12, width } = options;
	const codeOptions: CodeCellOptions = {
		code: "",
		index: options.index,
		total: options.total,
		title: options.title,
		status: options.status,
		spinnerFrame: options.spinnerFrame,
		duration: options.duration,
		width,
	};
	const { title, meta } = formatHeader(codeOptions, theme);
	const state = getState(options.status);

	const innerWidth = Math.max(20, outputBlockContentWidth(width));
	const allLines = content.trim() ? new Markdown(content, 0, 0, getMarkdownTheme()).render(innerWidth) : [];
	const maxContentLines = expanded ? allLines.length : Math.min(allLines.length, contentMaxLines);
	const contentLines = allLines.slice(0, maxContentLines);
	const hiddenContentLines = allLines.length - maxContentLines;
	if (hiddenContentLines > 0) {
		const hint = formatExpandHint(theme, expanded, hiddenContentLines > 0);
		const moreLine = `${formatMoreItems(hiddenContentLines, "line")}${hint ? ` ${hint}` : ""}`;
		contentLines.push(theme.fg("dim", moreLine));
	}

	const outputLines: string[] = [];
	if (output?.trim()) {
		const rawLines = sanitizeTerminalLines(output);
		const maxLines = expanded ? rawLines.length : Math.min(rawLines.length, outputMaxLines);
		const displayLines = rawLines
			.slice(0, maxLines)
			.map(line => (line.includes("\x1b[") ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))));
		outputLines.push(...displayLines);
		const remaining = rawLines.length - maxLines;
		if (remaining > 0) {
			const hint = formatExpandHint(theme, expanded, remaining > 0);
			const moreLine = `${formatMoreItems(remaining, "line")}${hint ? ` ${hint}` : ""}`;
			outputLines.push(theme.fg("dim", moreLine));
		}
	}

	const sections: Array<{ label?: string; lines: string[] }> = [{ lines: contentLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}
