import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Ellipsis } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { getKeybindings, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { SGR_FG_RESET } from "@oh-my-pi/pi-tui/ansi";
import { formatMoreLines, pluralize } from "@oh-my-pi/pi-utils";
import { formatKeyHints, type KeyId } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import type { Theme } from "../modes/theme/theme";
import { Hasher } from "../tui/utils";
import { formatDimensionNote, type ResizedImage } from "../utils/image-resize";

export { Ellipsis } from "@oh-my-pi/pi-natives";
export { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

export function resolveImageOptions(): { maxWidthCells: number; maxHeightCells?: number } {
	const activeSettings = isSettingsInitialized() ? settings : undefined;
	const maxWidthCells = activeSettings?.get("tui.maxInlineImageColumns") ?? getDefault("tui.maxInlineImageColumns");
	const rowSetting = Math.max(
		0,
		activeSettings?.get("tui.maxInlineImageRows") ?? getDefault("tui.maxInlineImageRows"),
	);
	const viewportRows = process.stdout.rows;
	const viewportFraction = viewportRows ? Math.floor(viewportRows * 0.6) : 0;
	let maxHeightCells: number | undefined;
	if (rowSetting === 0) {
		maxHeightCells = viewportFraction || undefined;
	} else if (viewportFraction > 0) {
		maxHeightCells = Math.min(rowSetting, viewportFraction);
	} else {
		maxHeightCells = rowSetting;
	}
	return { maxWidthCells, maxHeightCells };
}

export const PREVIEW_LIMITS = {
	COLLAPSED_LINES: 3,

	EXPANDED_LINES: 12,

	COLLAPSED_ITEMS: 8,

	OUTPUT_COLLAPSED: 3,

	OUTPUT_EXPANDED: 10,

	COMPUTER_CODE_COLLAPSED: 10,

	DIFF_COLLAPSED_HUNKS: 8,

	DIFF_COLLAPSED_LINES: 40,
} as const;

export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

export const TRUNCATE_LENGTHS = {
	TITLE: 60,

	CONTENT: 80,

	LONG: 100,

	LINE: 110,

	SHORT: 40,

	RECAP: 280,
} as const;

const EXPAND_ACTION = "app.tools.expand";

const DEFAULT_EXPAND_KEY: KeyId = "ctrl+o";

export function expandKeyHint(): string {
	const keys = getKeybindings().getKeys(EXPAND_ACTION);
	return formatKeyHints(keys.length > 0 ? keys : [DEFAULT_EXPAND_KEY]);
}

export function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis?: Ellipsis): string[] {
	const lines = text.split("\n").filter(l => l.trim());
	return lines.slice(0, maxLines).map(l => truncateToWidth(l.trim(), maxLineLen, ellipsis));
}

export function previewLine(text: string, maxWidth: number, ellipsis?: Ellipsis): string {
	return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxWidth, ellipsis);
}

export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export { formatAge, formatBytes, formatCount, formatDuration, pluralize } from "@oh-my-pi/pi-utils";

export function formatStatusIcon(status: ToolUIStatus, theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "success":
			return theme.styledSymbol("status.success", "success");
		case "done":
			return theme.styledSymbol("status.done", "success");
		case "error":
			return theme.styledSymbol("status.error", "error");
		case "warning":
			return theme.styledSymbol("status.warning", "warning");
		case "info":
			return theme.styledSymbol("status.info", "accent");
		case "pending":
			return theme.styledSymbol("status.pending", "muted");
		case "running":
			if (spinnerFrame !== undefined) {
				const frames = theme.spinnerFrames;
				return frames[spinnerFrame % frames.length];
			}
			return theme.styledSymbol("status.running", "accent");
		case "aborted":
			return theme.styledSymbol("status.aborted", "error");
	}
}

export function formatExpandHint(theme: Theme, expanded?: boolean, hasMore?: boolean): string {
	if (expanded) return "";
	if (hasMore === false) return "";
	const chevron = theme.nav?.expand ?? "▸";
	return theme.fg("dim", `${chevron} ${expandKeyHint()} expand`);
}

export function formatBadge(label: string, color: ToolUIColor, theme: Theme): string {
	const left = theme.format.bracketLeft;
	const right = theme.format.bracketRight;
	return theme.fg(color, `${left}${label}${right}`);
}

export function formatMoreItems(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

const PREVIEW_WINDOW_RESERVED_ROWS = 20;

const PREVIEW_WINDOW_MIN_LINES = 6;

const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

export function previewWindowRows(): number {
	const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

export function capPreviewLines(
	lines: string[],
	theme: Theme,
	options: { max?: number; expanded?: boolean; prefix?: string; expandHint?: boolean } = {},
): string[] {
	if (options.expanded) return lines;
	const max = options.max ?? previewWindowRows();
	if (lines.length <= max) return lines;
	const visible = max <= 1 ? [] : lines.slice(lines.length - (max - 1));
	const hidden = lines.length - visible.length;
	const hint = options.expandHint === false ? "" : formatExpandHint(theme, false, true);
	const marker = `… ${hidden} earlier ${pluralize("line", hidden)}${hint ? ` ${hint}` : ""}`;
	return [`${options.prefix ?? ""}${theme.fg("dim", marker)}`, ...visible];
}

export function formatMeta(meta: string[], theme: Theme): string {
	return meta.length > 0 ? ` ${theme.fg("muted", meta.join(theme.sep.dot))}` : "";
}

function sanitizeErrorText(message: string | undefined): string {
	const clean = (message ?? "").replace(/^Error:\s*/, "").trim();
	return clean ? replaceTabs(truncateToWidth(clean, TRUNCATE_LENGTHS.LINE)) : "Unknown error";
}

export function formatErrorMessage(message: string | undefined, theme: Theme): string {
	return `${theme.styledSymbol("status.error", "error")} ${theme.fg("error", `Error: ${sanitizeErrorText(message)}`)}`;
}

export function formatErrorDetail(message: string | undefined, theme: Theme): string {
	return `  ${theme.fg("error", sanitizeErrorText(message))}`;
}

export function formatEmptyMessage(message: string, theme: Theme): string {
	return `${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", message)}`;
}

export type CodeFrameMarker = "" | " " | "*" | "+" | "-" | ">";

export function formatCodeFrameLine(
	marker: CodeFrameMarker,
	lineNumber: string | number,
	content: string,
	lineNumberWidth: number,
): string {
	const markerText = marker.trim();
	const lineNumberText = String(lineNumber).trim();
	const gutterText = markerText && lineNumberText ? `${markerText}${lineNumberText}` : lineNumberText || markerText;
	return `${gutterText.padStart(lineNumberWidth + 1, " ")}│${content}`;
}

export function wrapCodeFrameLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith(SGR_FG_RESET) ? bodyWithReset.slice(0, -SGR_FG_RESET.length) : bodyWithReset;

	const diffMatch = /^(\s*[+-]?\s*\d*)([|│])(.*)$/s.exec(body);

	if (!diffMatch || diffMatch[1].length === 0 || (diffMatch[2] === "|" && !/^[+\-\s]\s*\d+$/.test(diffMatch[1]))) {
		return wrapTextWithAnsi(line, width);
	}

	const [, gutter, separator, content] = diffMatch;
	const prefix = `${gutter}${separator}`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}${separator}`;
	const wrappedContent = wrapTextWithAnsi(content ?? "", contentWidth);

	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[27m\x1b[39m`,
	);
}

export function formatDiffTruncationHint(hiddenHunks: number, hiddenLines: number, theme: Theme): string | undefined {
	const remainder: string[] = [];
	if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more ${pluralize("hunk", hiddenHunks)}`);
	if (hiddenLines > 0) remainder.push(formatMoreLines(hiddenLines));
	if (remainder.length === 0) return undefined;
	return theme.fg("toolOutput", `… (${remainder.join(", ")}) ${formatExpandHint(theme)}`);
}

export type ToolUIStatus = "success" | "done" | "error" | "warning" | "info" | "pending" | "running" | "aborted";
export type ToolUIColor = "success" | "error" | "warning" | "accent" | "muted";

interface ToolUITitleOptions {
	bold?: boolean;
}

export function formatTitle(label: string, theme: Theme, options?: ToolUITitleOptions): string {
	const content = options?.bold === false ? label : theme.bold(label);
	return theme.fg("toolTitle", content);
}

interface ParsedDiagnostic {
	filePath: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	source?: string;
	message: string;
	code?: string;
}

function sanitizeDiagnosticDisplayText(text: string): string {
	return replaceTabs(text);
}

function getSeverityRank(severity: ParsedDiagnostic["severity"]): number {
	switch (severity) {
		case "error":
			return 0;
		case "warning":
			return 1;
		case "info":
			return 2;
		case "hint":
			return 3;
	}
}

function parseDiagnosticMessage(msg: string): ParsedDiagnostic | null {
	const match = msg.match(/^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/);
	if (!match) return null;
	return {
		filePath: sanitizeDiagnosticDisplayText(match[1]),
		line: parseInt(match[2], 10),
		col: parseInt(match[3], 10),
		severity: match[4] as ParsedDiagnostic["severity"],
		source: match[5] ? sanitizeDiagnosticDisplayText(match[5]) : undefined,
		message: sanitizeDiagnosticDisplayText(match[6]),
		code: match[7] ? sanitizeDiagnosticDisplayText(match[7]) : undefined,
	};
}

export function formatDiagnostics(
	diag: { errored: boolean; summary: string; messages: string[] },
	expanded: boolean,
	theme: Theme,
	getLangIcon: (filePath: string) => string,
	options?: { title?: string },
): string {
	if (diag.messages.length === 0) return "";

	const byFile = new Map<string, ParsedDiagnostic[]>();
	const unparsed: string[] = [];

	for (const msg of diag.messages) {
		const parsed = parseDiagnosticMessage(msg);
		if (parsed) {
			const existing = byFile.get(parsed.filePath) ?? [];
			existing.push(parsed);
			byFile.set(parsed.filePath, existing);
		} else {
			unparsed.push(sanitizeDiagnosticDisplayText(msg));
		}
	}

	for (const diagnostics of byFile.values()) {
		diagnostics.sort((a, b) => {
			const severityCompare = getSeverityRank(a.severity) - getSeverityRank(b.severity);
			if (severityCompare !== 0) return severityCompare;
			if (a.line !== b.line) return a.line - b.line;
			if (a.col !== b.col) return a.col - b.col;
			return a.message.localeCompare(b.message);
		});
	}

	const headerIcon = diag.errored
		? theme.styledSymbol("status.error", "error")
		: theme.styledSymbol("status.warning", "warning");
	const summary = sanitizeDiagnosticDisplayText(diag.summary);
	const summaryTag = summary ? ` ${theme.fg("dim", `(${summary})`)}` : "";
	let output = `\n\n${headerIcon} ${theme.fg("toolTitle", options?.title ?? "Diagnostics")}${summaryTag}`;

	const maxDiags = expanded ? diag.messages.length : 5;
	let diagsShown = 0;

	const files = Array.from(byFile.entries());

	const totalParsedDiags = files.reduce((sum, [, diags]) => sum + diags.length, 0);
	const totalDiags = totalParsedDiags + unparsed.length;

	const isTreeEnd = (fileIdx: number, diagIdx: number | null, unparsedIdx: number | null): boolean => {
		const willShowMore = totalDiags > diagsShown + 1;
		if (willShowMore) return false;

		if (unparsedIdx !== null) {
			return unparsedIdx === unparsed.length - 1;
		}
		if (diagIdx !== null) {
			const isLastDiagInFile = diagIdx === files[fileIdx][1].length - 1;
			const isLastFile = fileIdx === files.length - 1;
			return isLastDiagInFile && isLastFile && unparsed.length === 0;
		}

		return false;
	};

	for (let fi = 0; fi < files.length && diagsShown < maxDiags; fi++) {
		const [filePath, diagnostics] = files[fi];

		const remainingDiagsInFile = diagnostics.length;
		const remainingDiagsAfter = files.slice(fi + 1).reduce((sum, [, d]) => sum + d.length, 0) + unparsed.length;
		const willShowAllRemaining = diagsShown + remainingDiagsInFile + remainingDiagsAfter <= maxDiags;
		const isLastFileNode = fi === files.length - 1 && unparsed.length === 0 && willShowAllRemaining;
		const fileBranch = isLastFileNode ? theme.tree.last : theme.tree.branch;

		const fileIcon = theme.fg("muted", getLangIcon(filePath));
		output += `\n ${theme.fg("dim", fileBranch)} ${fileIcon} ${theme.fg("accent", filePath)}`;

		for (let di = 0; di < diagnostics.length && diagsShown < maxDiags; di++) {
			const d = diagnostics[di];
			const isLastDiagInFile = di === diagnostics.length - 1;

			const atDisplayLimit = diagsShown + 1 >= maxDiags;
			const isLastVisibleInFile = isLastDiagInFile || atDisplayLimit;

			const isVeryLast = isTreeEnd(fi, di, null);
			const diagBranch = isLastFileNode
				? isLastVisibleInFile || isVeryLast
					? `  ${theme.tree.last}`
					: `  ${theme.tree.branch}`
				: isLastVisibleInFile || isVeryLast
					? `${theme.tree.vertical} ${theme.tree.last}`
					: `${theme.tree.vertical} ${theme.tree.branch}`;

			const sevIcon =
				d.severity === "error"
					? theme.styledSymbol("status.error", "error")
					: d.severity === "warning"
						? theme.styledSymbol("status.warning", "warning")
						: theme.styledSymbol("status.info", "muted");
			const location = theme.fg("dim", `:${d.line}:${d.col}`);
			const codeTag = d.code ? theme.fg("dim", ` (${d.code})`) : "";
			const msgColor = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "toolOutput";

			output += `\n ${theme.fg("dim", diagBranch)} ${sevIcon}${location} ${theme.fg(msgColor, d.message)}${codeTag}`;
			diagsShown++;
		}
	}

	for (let ui = 0; ui < unparsed.length && diagsShown < maxDiags; ui++) {
		const msg = unparsed[ui];
		const isVeryLast = isTreeEnd(-1, null, ui);
		const branch = isVeryLast ? theme.tree.last : theme.tree.branch;
		const color = msg.includes("[error]") ? "error" : msg.includes("[warning]") ? "warning" : "dim";
		output += `\n ${theme.fg("dim", branch)} ${theme.fg(color, msg)}`;
		diagsShown++;
	}

	if (totalDiags > diagsShown) {
		const remaining = totalDiags - diagsShown;
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
			"muted",
			`… ${remaining} more`,
		)} ${formatExpandHint(theme)}`;
	}

	return output;
}

export interface DiffStats {
	added: number;
	removed: number;
	hunks: number;
	lines: number;
}

export function getDiffStats(diffText: string): DiffStats {
	const lines = diffText ? diffText.split("\n") : [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;

	for (const line of lines) {
		const isAdded = line.startsWith("+");
		const isRemoved = line.startsWith("-");
		const isChange = isAdded || isRemoved;

		if (isAdded) added++;
		if (isRemoved) removed++;

		if (isChange && !inHunk) {
			hunks++;
			inHunk = true;
		} else if (!isChange) {
			inHunk = false;
		}
	}

	return { added, removed, hunks, lines: lines.length };
}

interface DiffSegment {
	lines: string[];
	isChange: boolean;
	isEllipsis: boolean;
}

function parseDiffSegments(lines: string[]): DiffSegment[] {
	const segments: DiffSegment[] = [];
	let current: DiffSegment | null = null;

	for (const line of lines) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		const isEllipsis = line.trimStart().startsWith("...") || line.trim().length === 0;

		if (isEllipsis) {
			if (current) segments.push(current);
			segments.push({ lines: [line], isChange: false, isEllipsis: true });
			current = null;
		} else if (!current || current.isChange !== isChange) {
			if (current) segments.push(current);
			current = { lines: [line], isChange, isEllipsis: false };
		} else {
			current.lines.push(line);
		}
	}

	if (current) segments.push(current);
	return segments;
}

export function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
	options?: { fromTail?: boolean },
): { text: string; hiddenHunks: number; hiddenLines: number } {
	if (options?.fromTail) {
		const reversed = (diffText ?? "").split("\n").reverse().join("\n");
		const result = truncateDiffByHunk(reversed, maxHunks, maxLines);
		return {
			text: result.text.split("\n").reverse().join("\n"),
			hiddenHunks: result.hiddenHunks,
			hiddenLines: result.hiddenLines,
		};
	}
	const lines = diffText ? diffText.split("\n") : [];
	const totalStats = getDiffStats(diffText);

	if (lines.length <= maxLines && totalStats.hunks <= maxHunks) {
		return { text: diffText, hiddenHunks: 0, hiddenLines: 0 };
	}

	const segments = parseDiffSegments(lines);

	const changeSegments = segments.filter(s => s.isChange);
	const changeLineCount = changeSegments.reduce((sum, s) => sum + s.lines.length, 0);

	if (changeLineCount > maxLines) {
		const kept: string[] = [];
		let keptHunks = 0;

		for (const seg of segments) {
			if (kept.length >= maxLines) break;
			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			const take = Math.min(seg.lines.length, maxLines - kept.length);
			for (let i = 0; i < take; i++) {
				kept.push(seg.lines[i]!);
			}
		}

		return {
			text: kept.join("\n"),
			hiddenHunks: Math.max(0, totalStats.hunks - keptHunks),
			hiddenLines: Math.max(0, lines.length - kept.length),
		};
	}

	const contextBudget = maxLines - changeLineCount;
	const contextSegments = segments.filter(s => !s.isChange);
	const totalContextLines = contextSegments.reduce((sum, s) => sum + s.lines.length, 0);

	const kept: string[] = [];
	let keptHunks = 0;
	let keptSourceLines = 0;

	if (totalContextLines <= contextBudget) {
		for (const seg of segments) {
			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			kept.push(...seg.lines);
			keptSourceLines += seg.lines.length;
		}
	} else {
		const contextRatio = totalContextLines > 0 ? contextBudget / totalContextLines : 0;
		let remainingContextBudget = contextBudget;

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			if (seg.isChange) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
				kept.push(...seg.lines);
				keptSourceLines += seg.lines.length;
				continue;
			}
			if (remainingContextBudget <= 0) continue;

			const allowedLines = Math.min(
				remainingContextBudget,
				Math.max(1, Math.floor(seg.lines.length * contextRatio)),
			);
			const outputStart = kept.length;
			let sourceLinesAdded = 0;

			if (seg.isEllipsis || seg.lines.length <= allowedLines) {
				for (let j = 0; j < allowedLines; j++) {
					kept.push(seg.lines[j]!);
				}
				sourceLinesAdded = allowedLines;
			} else {
				const isBeforeChange = segments[i + 1]?.isChange;
				const isAfterChange = segments[i - 1]?.isChange;

				if (isBeforeChange && isAfterChange) {
					if (allowedLines >= 3) {
						const sourceBudget = allowedLines - 1;
						const firstCount = Math.ceil(sourceBudget / 2);
						const lastCount = sourceBudget - firstCount;
						kept.push(...seg.lines.slice(0, firstCount));
						kept.push("");
						if (lastCount > 0) kept.push(...seg.lines.slice(-lastCount));
						sourceLinesAdded = sourceBudget;
					} else {
						const firstCount = Math.ceil(allowedLines / 2);
						const lastCount = allowedLines - firstCount;
						kept.push(...seg.lines.slice(0, firstCount));
						if (lastCount > 0) kept.push(...seg.lines.slice(-lastCount));
						sourceLinesAdded = allowedLines;
					}
				} else if (isBeforeChange) {
					kept.push(...seg.lines.slice(-allowedLines));
					sourceLinesAdded = allowedLines;
				} else if (isAfterChange) {
					kept.push(...seg.lines.slice(0, allowedLines));
					sourceLinesAdded = allowedLines;
				} else {
					const take = Math.min(allowedLines, 2);
					kept.push(...seg.lines.slice(0, take));
					sourceLinesAdded = take;
				}
			}

			keptSourceLines += sourceLinesAdded;
			remainingContextBudget -= kept.length - outputStart;
		}
	}

	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, totalStats.hunks - keptHunks),
		hiddenLines: Math.max(0, lines.length - keptSourceLines),
	};
}

export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") {
		return "";
	}
	const home = homeDir ?? os.homedir();
	if (home && filePath.startsWith(home)) {
		const suffix = filePath.slice(home.length);

		if (suffix === "" || suffix.startsWith("/") || suffix.startsWith("\\")) {
			return `~${suffix.replaceAll("\\", "/")}`;
		}
	}
	return filePath;
}

export function formatToolWorkingDirectory(workdir: string | undefined, projectDir: string): string | undefined {
	if (!workdir) return undefined;
	const resolvedProjectDir = path.resolve(projectDir);
	const resolvedWorkdir = path.resolve(projectDir, workdir);
	if (resolvedWorkdir === resolvedProjectDir) {
		return undefined;
	}
	const relativePath = path.relative(resolvedProjectDir, resolvedWorkdir);
	const isWithinProject =
		relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
	const displayWorkdir = isWithinProject ? relativePath : shortenPath(resolvedWorkdir);
	return replaceTabs(displayWorkdir);
}

export function formatScreenshot(opts: {
	saveFullRes: boolean;
	savedMimeType: string;
	savedByteLength: number;
	dest: string;
	resized: ResizedImage;
}): string[] {
	const lines = ["Screenshot captured"];
	if (opts.saveFullRes) {
		lines.push(
			`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`,
		);
		lines.push(
			`Model: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`,
		);
	} else {
		lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB)`);
		lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
	}
	if (opts.resized.decodeFailed) {
		lines.push("Resize: image decoder failed; using original image bytes");
	}
	const dimensionNote = formatDimensionNote(opts.resized);
	if (dimensionNote) {
		lines.push(dimensionNote);
	}
	return lines;
}

export function wrapBrackets(text: string, theme: Theme): string {
	return `${theme.format.bracketLeft}${text}${theme.format.bracketRight}`;
}

export const PARSE_ERRORS_LIMIT = 20;

export function dedupeParseErrors(errors: string[] | undefined): string[] {
	if (!errors || errors.length === 0) return [];
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const error of errors) {
		if (seen.has(error)) continue;
		seen.add(error);
		deduped.push(error);
	}
	return deduped;
}

export function formatParseErrors(errors: string[], total?: number): string[] {
	const deduped = dedupeParseErrors(errors);
	if (deduped.length === 0) return [];
	const fullCount = total ?? deduped.length;
	const capped = deduped.slice(0, PARSE_ERRORS_LIMIT);
	const header = fullCount > capped.length ? `Parse issues (${capped.length} / ${fullCount}):` : "Parse issues:";
	return [header, ...capped.map(err => `- ${err}`)];
}

export function capParseErrors(
	errors: string[] | undefined,
	limit: number = PARSE_ERRORS_LIMIT,
): { errors: string[]; total: number } {
	const deduped = dedupeParseErrors(errors);
	return { errors: deduped.slice(0, limit), total: deduped.length };
}

export function createCachedComponent(
	getExpanded: () => boolean,
	compute: (width: number, expanded: boolean) => string[],
	options: { paddingX?: number } = {},
): Component {
	let cached: { key: bigint; lines: string[] } | undefined;
	return {
		render(width: number): readonly string[] {
			const expanded = getExpanded();
			const key = new Hasher().bool(expanded).u32(width).digest();
			if (cached?.key === key) return cached.lines;
			const paddingX = Math.max(0, options.paddingX ?? 0);
			const innerWidth = Math.max(1, width - paddingX * 2);
			const lines = compute(innerWidth, expanded);
			const pad = paddingX === 0 ? "" : " ".repeat(paddingX);
			const paddedLines = paddingX === 0 ? lines : lines.map(line => `${pad}${line}${pad}`);
			cached = { key, lines: paddedLines };
			return paddedLines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

export interface RenderedStringCache {
	theme: Theme | null;
	expanded: boolean;
	salt: string;
	content: string;
	value: string;
}

export function createRenderedStringCache(): RenderedStringCache {
	return { theme: null, expanded: false, salt: "", content: "", value: "" };
}

export function invalidateRenderedStringCache(cache: RenderedStringCache): void {
	cache.theme = null;
}

export function cachedRenderedString(
	cache: RenderedStringCache | undefined,
	theme: Theme,
	expanded: boolean,
	salt: string,
	content: string,
	render: () => string,
): string {
	if (
		cache !== undefined &&
		cache.theme === theme &&
		cache.expanded === expanded &&
		cache.salt === salt &&
		cache.content === content
	) {
		return cache.value;
	}
	const value = render();
	if (cache !== undefined) {
		cache.theme = theme;
		cache.expanded = expanded;
		cache.salt = salt;
		cache.content = content;
		cache.value = value;
	}
	return value;
}

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

export interface LspBatchRequest {
	id: string;
	flush: boolean;
}

export function getLspBatchRequest(toolCall: ToolCallContext | undefined): LspBatchRequest | undefined {
	if (!toolCall) {
		return undefined;
	}
	const hasOtherWrites = toolCall.toolCalls.some(
		(call, index) => index !== toolCall.index && LSP_BATCH_TOOLS.has(call.name),
	);
	if (!hasOtherWrites) {
		return undefined;
	}
	const hasLaterWrites = toolCall.toolCalls.slice(toolCall.index + 1).some(call => LSP_BATCH_TOOLS.has(call.name));
	return { id: toolCall.batchId, flush: !hasLaterWrites };
}
