import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { formatHiddenLinesNotice } from "../modes/components/execution-shared";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { getMarkdownTheme, highlightCode, type Theme } from "../modes/theme/theme";
import { renderCodeCell } from "../tui/code-cell";
import { markFramedBlockComponent, outputBlockContentWidth } from "../tui/output-block";
import { formatEvalCodeForDisplay } from "./eval-format";
import { renderJavaScriptAstLines } from "./eval-format/javascript-ast";
import { renderPythonAstLines } from "./eval-format/python-ast";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import {
	formatBadge,
	formatDuration,
	formatStatusIcon,
	formatTitle,
	getDiffStats,
	PREVIEW_LIMITS,
	previewWindowRows,
	replaceTabs,
	sanitizeSingleLine,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
	wrapBrackets,
	wrapCodeFrameLine,
} from "./render-utils";
export const EVAL_DEFAULT_PREVIEW_LINES = 10;

function languageForHighlighter(language: EvalLanguage | undefined): "python" | "javascript" {
	if (language === "js") return "javascript";
	return "python";
}

interface EvalRenderCellArg {
	language?: string;
	code?: string;
	title?: string;
}

interface EvalRenderArgs {
	language?: string;
	code?: string;
	title?: string;
	cells?: EvalRenderCellArg[];
	__partialJson?: string;
}

interface EvalRenderContext {
	output?: string;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}

interface EvalRenderCell {
	language: EvalLanguage;
	code: string;
	title?: string;
}

function normalizeRenderLanguage(value: string | undefined): EvalLanguage {
	if (value === "js") return "js";
	return "python";
}

function getRenderCells(args: EvalRenderArgs | undefined): EvalRenderCell[] {
	if (!args) return [];
	const raw = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
	const out: EvalRenderCell[] = [];
	for (const cell of raw) {
		if (!cell || typeof cell !== "object") continue;
		const language = normalizeRenderLanguage(typeof cell.language === "string" ? cell.language : undefined);
		const code = typeof cell.code === "string" ? cell.code : "";
		out.push({
			language,
			code,
			title: typeof cell.title === "string" ? cell.title : undefined,
		});
	}
	return out;
}

type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "aborted";

function eventString(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const cleaned = sanitizeText(value);
	return cleaned.length > 0 ? cleaned : undefined;
}

function statusLineText(value: unknown): string {
	return replaceTabs(sanitizeText(String(value ?? ""))).replace(/[\r\n]+/gu, " ");
}

function statusFirstLine(value: unknown, maxWidth: number = TRUNCATE_LENGTHS.LINE): string {
	const firstLine = sanitizeText(String(value ?? "")).split("\n")[0] ?? "";
	return truncateToWidth(replaceTabs(firstLine), maxWidth);
}

function statusValue(value: unknown, maxWidth: number = TRUNCATE_LENGTHS.LINE): string {
	return truncateToWidth(statusLineText(value), maxWidth);
}

function statusPath(value: unknown): string {
	return statusValue(shortenPath(String(value ?? "")));
}

function statusEventDetailValue(event: EvalStatusEvent): unknown {
	const { op, ...data } = event;
	if (data.error !== undefined && data.error !== null) return data.error;
	if (op === "log") return data.message;
	if (op === "phase") return data.title;
	return undefined;
}

function statusEventDetailLines(event: EvalStatusEvent): string[] {
	const value = statusEventDetailValue(event);
	if (value === undefined) return [];
	const rawLines = sanitizeText(String(value)).split("\n");
	const maxLines = PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const lines = rawLines.slice(1, maxLines).map(line => truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE));
	if (rawLines.length > maxLines) {
		lines.push(`… ${rawLines.length - maxLines} more lines`);
	}
	return lines;
}

function eventNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function agentEventStatus(value: unknown): AgentEventStatus {
	switch (value) {
		case "pending":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
			return value;
		default:
			return "running";
	}
}

function formatAgentStats(event: EvalStatusEvent, theme: Theme): string {
	let line = "";
	const toolCount = eventNumber(event.toolCount);
	if (toolCount > 0) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(toolCount)} ${theme.icon.extensionTool}`)}`;
	}
	const contextTokens = eventNumber(event.contextTokens);
	if (contextTokens > 0) {
		const contextWindow = eventNumber(event.contextWindow);
		const ctx = contextWindow > 0 ? formatContextUsage(contextTokens, contextWindow) : formatNumber(contextTokens);
		line += `${theme.sep.dot}${theme.fg("dim", ctx)}`;
	}
	const cost = eventNumber(event.cost);
	if (cost > 0) {
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${cost.toFixed(2)}`)}`;
	}
	const model = eventString(event.model);
	if (model && settings.get("orchestrator.showResolvedModelBadge")) {
		line += `${theme.sep.dot}${theme.fg("dim", truncateToWidth(replaceTabs(model), 30))}`;
	}
	return line;
}

function renderAgentProgressEvents(events: EvalStatusEvent[], theme: Theme, spinnerFrame?: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const isLast = i === events.length - 1;
		const prefix = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

		const status = agentEventStatus(event.status);
		const iconStatus =
			status === "completed"
				? "done"
				: status === "failed"
					? "error"
					: status === "aborted"
						? "aborted"
						: status === "pending"
							? "pending"
							: "running";
		const iconColor =
			status === "completed" ? "success" : status === "failed" || status === "aborted" ? "error" : "accent";
		const icon =
			status === "completed"
				? theme.styledSymbol("tool.eval", "accent")
				: theme.fg(iconColor, formatStatusIcon(iconStatus, theme, status === "running" ? spinnerFrame : undefined));

		const id = eventString(event.id) ?? "agent";
		let line = `${prefix} ${icon} ${theme.fg("accent", theme.bold(id))}`;

		if (status === "failed" || status === "aborted") {
			line += ` ${formatBadge(status, iconColor, theme)}`;
		}

		const currentTool = eventString(event.currentTool);
		const lastIntent = eventString(event.lastIntent);
		if (status === "running" && !currentTool && !lastIntent) {
			const preview = eventString(event.taskPreview);
			if (preview) line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(preview), 48))}`;
		}

		line += formatAgentStats(event, theme);
		if (status === "completed" || status === "failed" || status === "aborted") {
			const durationMs = eventNumber(event.durationMs);
			if (durationMs > 0) line += `${theme.sep.dot}${theme.fg("dim", formatDuration(durationMs))}`;
		}
		lines.push(line);

		if (status === "running") {
			if (currentTool) {
				let toolLine = `${cont}${theme.tree.hook} ${theme.fg("muted", currentTool)}`;
				const detail = lastIntent ?? eventString(event.currentToolArgs);
				if (detail) toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(detail), 48))}`;
				lines.push(toolLine);
			} else if (lastIntent) {
				lines.push(`${cont}${theme.tree.hook} ${theme.fg("dim", truncateToWidth(replaceTabs(lastIntent), 48))}`);
			}
		}
	}
	return lines;
}

function formatDiffStatsSuffix(diff: string, theme: Theme): string {
	const { added, removed } = getDiffStats(diff);
	if (added === 0 && removed === 0) return "";
	const stats = [
		added > 0 ? theme.fg("toolDiffAdded", `+${added}`) : undefined,
		removed > 0 ? theme.fg("toolDiffRemoved", `-${removed}`) : undefined,
	].filter(value => value !== undefined);
	return ` ${theme.fg("dim", theme.format.bracketLeft)}${stats.join(theme.fg("dim", "/"))}${theme.fg("dim", theme.format.bracketRight)}`;
}

function hasEventDiff(event: EvalStatusEvent): boolean {
	return event.op === "write" && typeof event.diff === "string" && event.diff.length > 0;
}

function formatStatusEvent(event: EvalStatusEvent, theme: Theme): string {
	const { op, ...data } = event;
	const displayOp = statusFirstLine(op);

	type AvailableIcon = "icon.file" | "icon.folder" | "icon.git" | "icon.package";
	const opIcons: Record<string, AvailableIcon> = {
		read: "icon.file",
		write: "icon.file",
		cat: "icon.file",
		touch: "icon.file",
		ls: "icon.folder",
		cd: "icon.folder",
		pwd: "icon.folder",
		mkdir: "icon.folder",
		git_status: "icon.git",
		git_diff: "icon.git",
		git_log: "icon.git",
		git_show: "icon.git",
		git_branch: "icon.git",
		git_file_at: "icon.git",
		git_has_changes: "icon.git",
		run: "icon.package",
		sh: "icon.package",
		env: "icon.package",
		batch: "icon.package",
		completion: "icon.package",
		log: "icon.package",
		phase: "icon.package",
	};

	const iconKey = opIcons[op] ?? "icon.file";
	const icon = theme.styledSymbol(iconKey, "muted");

	const parts: string[] = [];

	if (data.error) {
		return `${icon} ${theme.fg("warning", displayOp)}: ${theme.fg("dim", statusFirstLine(data.error))}`;
	}

	switch (op) {
		case "read":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`from ${statusPath(data.path)}`);
			break;
		case "write":
			if (typeof data.diff === "string" && data.diff.length > 0) {
				if (data.path) parts.push(statusPath(data.path));
			} else {
				const unit = data.chars === undefined && data.bytes !== undefined ? "bytes" : "chars";
				parts.push(`${data.chars ?? data.bytes ?? 0} ${unit}`);
				if (data.path) parts.push(`to ${statusPath(data.path)}`);
			}
			break;
		case "delete":
			if (data.path) parts.push(statusPath(data.path));
			break;
		case "revert":
			if (data.path) parts.push(`${statusPath(data.path)} restored to pre-cell content`);
			break;
		case "files":
			if (typeof data.count === "number") {
				parts.push(`${data.count} more file${data.count !== 1 ? "s" : ""} changed`);
			} else {
				parts.push("changed-file list truncated");
			}
			break;
		case "cat":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""}`);
			parts.push(`${data.chars} chars`);
			break;
		case "ls":
			parts.push(`${data.count} entr${(data.count as number) !== 1 ? "ies" : "y"}`);
			break;
		case "env":
			if (data.action === "set") {
				parts.push(
					`set ${statusValue(data.key, TRUNCATE_LENGTHS.SHORT)}=${statusValue(data.value, TRUNCATE_LENGTHS.CONTENT)}`,
				);
			} else if (data.action === "get") {
				parts.push(
					`${statusValue(data.key, TRUNCATE_LENGTHS.SHORT)}=${statusValue(data.value, TRUNCATE_LENGTHS.CONTENT)}`,
				);
			} else {
				parts.push(`${data.count} variable${(data.count as number) !== 1 ? "s" : ""}`);
			}
			break;
		case "git_status":
			if (data.clean) {
				parts.push("clean");
			} else {
				const statusParts: string[] = [];
				if (data.staged) statusParts.push(`${data.staged} staged`);
				if (data.modified) statusParts.push(`${data.modified} modified`);
				if (data.untracked) statusParts.push(`${data.untracked} untracked`);
				parts.push(statusParts.join(", ") || "unknown");
			}
			if (data.branch) parts.push(`on ${statusValue(data.branch)}`);
			break;
		case "git_log":
			parts.push(`${data.commits} commit${(data.commits as number) !== 1 ? "s" : ""}`);
			break;
		case "git_diff":
			parts.push(`${data.lines} line${(data.lines as number) !== 1 ? "s" : ""}`);
			if (data.staged) parts.push("(staged)");
			break;
		case "batch":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""} processed`);
			break;
		case "completion":
			if (data.model) parts.push(statusValue(data.model));
			if (data.tier && data.tier !== data.model) parts.push(`(${statusValue(data.tier)})`);
			parts.push(`${data.chars ?? 0} chars`);
			break;
		case "wc":
			parts.push(`${data.lines}L ${data.words}W ${data.chars}C`);
			break;
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(statusPath(data.path));
			break;
		case "log":
			parts.push(statusFirstLine(data.message));
			break;
		case "phase":
			parts.push(statusFirstLine(data.title));
			break;
		default:
			if (data.count !== undefined) {
				parts.push(String(data.count));
			}
			if (data.path) {
				parts.push(statusPath(data.path));
			}
	}

	const desc = parts.length > 0 ? parts.join(" · ") : "";
	const statsSuffix = hasEventDiff(event) ? formatDiffStatsSuffix(event.diff as string, theme) : "";
	return `${icon} ${theme.fg("muted", displayOp)}${desc ? ` ${theme.fg("dim", desc)}` : ""}${statsSuffix}`;
}

function formatStatusEventExpanded(event: EvalStatusEvent, theme: Theme): string[] {
	const lines: string[] = [];
	const { op, ...data } = event;

	lines.push(formatStatusEvent(event, theme));

	const addItems = (items: unknown[], formatter: (item: unknown) => string, max = 5) => {
		const arr = Array.isArray(items) ? items : [];
		for (let i = 0; i < Math.min(arr.length, max); i++) {
			lines.push(`   ${theme.fg("dim", statusValue(formatter(arr[i])))}`);
		}
		if (arr.length > max) {
			lines.push(`   ${theme.fg("dim", `… ${arr.length - max} more`)}`);
		}
	};

	const addPreview = (preview: string, maxLines = PREVIEW_LIMITS.OUTPUT_COLLAPSED) => {
		const safePreview = sanitizeText(String(preview));
		const previewLines = safePreview.split("\n").slice(0, maxLines);
		for (const line of previewLines) {
			lines.push(`   ${theme.fg("toolOutput", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE))}`);
		}
		const totalLines = safePreview.split("\n").length;
		if (totalLines > maxLines) {
			lines.push(`   ${theme.fg("dim", `… ${totalLines - maxLines} more lines`)}`);
		}
	};

	switch (op) {
		case "ls":
			if (data.items) addItems(data.items as unknown[], m => String(m));
			break;
		case "env":
			if (data.keys) addItems(data.keys as unknown[], k => String(k), 10);
			break;
		case "git_log":
			if (data.entries) {
				addItems(data.entries as unknown[], e => {
					const entry = e as { sha: string; subject: string };
					return `${entry.sha} ${truncateToWidth(entry.subject, 50)}`;
				});
			}
			break;
		case "git_status":
			if (data.files) addItems(data.files as unknown[], f => String(f));
			break;
		case "git_branch":
			if (data.branches) addItems(data.branches as unknown[], b => String(b));
			break;
		case "read":
		case "cat":
		case "head":
		case "tail":
		case "git_diff":
		case "sh":
			if (data.preview) addPreview(String(data.preview));
			break;
	}

	return lines;
}

function widthAwareText(build: (width: number) => string[]): Component {
	let cachedWidth: number | undefined;
	let cachedLines: readonly string[] | undefined;
	return {
		render: (width: number): readonly string[] => {
			if (cachedLines === undefined || cachedWidth !== width) {
				cachedLines = build(width);
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate: () => {
			cachedLines = undefined;
			cachedWidth = undefined;
		},
	};
}

const STATUS_COLLAPSED_MAX_EVENTS = 3;
const STATUS_TREE_INDENT = 3;

function isFileOpEvent(event: EvalStatusEvent): boolean {
	return event.op === "write" || event.op === "delete";
}

// Wrapped hunk rows are memoized per event object: streaming updates re-spread
// the status event array on every output chunk while the event objects stay
// identical, and re-rendering a capped 32k-char diff per chunk would dominate
// stream latency. Entries die with their event.
const eventHunkRowCache = new WeakMap<
	EvalStatusEvent,
	{ width: number; theme: Theme; diff: string; diffTruncated: boolean; rows: string[] }
>();

function renderEventHunkRows(event: EvalStatusEvent, theme: Theme, width: number): string[] {
	const diff = typeof event.diff === "string" ? sanitizeText(event.diff) : "";
	const diffTruncated = event.diffTruncated === true;
	const cached = eventHunkRowCache.get(event);
	if (
		cached &&
		cached.width === width &&
		cached.theme === theme &&
		cached.diff === diff &&
		cached.diffTruncated === diffTruncated
	) {
		return cached.rows;
	}

	const rows: string[] = [];
	if (diff) {
		for (const diffLine of renderDiffColored(diff, { theme }).split("\n")) {
			rows.push(...wrapCodeFrameLine(diffLine, width));
		}
	}
	if (diffTruncated) rows.push(theme.fg("dim", "… diff truncated"));
	eventHunkRowCache.set(event, { width, theme, diff, diffTruncated, rows });
	return rows;
}

// One tree entry per visible event: summary line, expanded detail lines, error
// detail, then its diff hunk under the rail. Collapsed, the earliest non-file
// events hide behind a "… N earlier" marker; file events and their hunks
// always render in full.
function renderStatusEvents(events: EvalStatusEvent[], theme: Theme, expanded: boolean, width: number): string[] {
	if (events.length === 0) return [];
	const nonFileOpIndexes: number[] = [];
	for (let i = 0; i < events.length; i++) {
		if (!isFileOpEvent(events[i])) nonFileOpIndexes.push(i);
	}
	const hiddenCount = expanded ? 0 : Math.max(0, nonFileOpIndexes.length - STATUS_COLLAPSED_MAX_EVENTS);
	const hiddenIndexes = new Set(nonFileOpIndexes.slice(0, hiddenCount));
	const visible = events.filter((_, i) => !hiddenIndexes.has(i));

	const lines: string[] = [];
	if (hiddenCount > 0) {
		lines.push(
			...wrapTextWithAnsi(
				`${theme.fg("dim", theme.tree.branch)} ${theme.fg("dim", `… ${hiddenCount} earlier`)}`,
				width,
			),
		);
	}
	const bodyWidth = Math.max(1, width - STATUS_TREE_INDENT);
	for (let i = 0; i < visible.length; i++) {
		const event = visible[i]!;
		const isLast = i === visible.length - 1;
		const branch = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? " ".repeat(STATUS_TREE_INDENT) : `${theme.fg("dim", theme.tree.vertical)}  `;
		const withDiff = hasEventDiff(event);
		const [head, ...rest] =
			expanded && !withDiff ? formatStatusEventExpanded(event, theme) : [formatStatusEvent(event, theme)];
		lines.push(...wrapTextWithAnsi(`${branch} ${head}`, width));
		for (const line of rest) lines.push(...wrapTextWithAnsi(`${cont}${line}`, width));
		for (const line of statusEventDetailLines(event)) {
			lines.push(...wrapTextWithAnsi(`${cont}${theme.fg("dim", line)}`, width));
		}
		if (!withDiff) continue;
		for (const row of renderEventHunkRows(event, theme, bodyWidth)) lines.push(`${cont}${row}`);
	}
	return lines;
}

function formatCellOutputLines(
	cell: EvalCellResult,
	expanded: boolean,
	previewLines: number,
	theme: Theme,
	width: number,
): { lines: readonly string[]; hiddenCount: number } {
	if (!cell.output) {
		return { lines: [], hiddenCount: 0 };
	}

	const safeOutput = sanitizeText(cell.output);
	const innerWidth = outputBlockContentWidth(width);

	if (cell.hasMarkdown && cell.status !== "error") {
		const md = new Markdown(safeOutput, 0, 0, getMarkdownTheme());
		const allLines = md.render(innerWidth);
		const displayLines = expanded ? allLines : allLines.slice(-previewLines);
		const hiddenCount = allLines.length - displayLines.length;
		return { lines: displayLines, hiddenCount };
	}

	const styledOutput = safeOutput
		.split("\n")
		.map(line => {
			const cleaned = replaceTabs(line);
			return cell.status === "error" ? theme.fg("error", cleaned) : theme.fg("toolOutput", cleaned);
		})
		.join("\n");
	if (expanded) {
		return { lines: styledOutput.split("\n"), hiddenCount: 0 };
	}
	const { visualLines, skippedCount } = truncateToVisualLines(styledOutput, previewLines, innerWidth);
	return { lines: visualLines, hiddenCount: skippedCount };
}

/** Captioned outlines sit one step in from the shell lines that surround them. */
const OUTLINE_INDENT = "  ";

function astPreviewLines(code: string, language: string, theme: Theme, width: number): string[] | undefined {
	if (language === "python") return renderPythonAstLines(code, theme, width) ?? undefined;
	if (language === "js") return renderJavaScriptAstLines(code, theme, width) ?? undefined;
	return undefined;
}

/** A kernel cell embedded in an enclosing shell source, by code offsets. */
export interface EvalDisplayCell {
	start: number;
	end: number;
	code: string;
	language: EvalLanguage;
	/**
	 * Names what the outline summarizes, for cells whose body is not obviously code from the
	 * surrounding shell line (a heredoc-written file). Captioned outlines are also indented, so the
	 * summary cannot be misread as commands the shell ran.
	 */
	label?: string;
}

// Shell chunks keep the newline that separated them from the cell body; drop
// it so heredoc delimiter lines sit flush against the outline, and trim the
// partial line around a `-c` word so `python -c` / `&& echo` read as lines.
function shellChunkLines(chunk: string, shellLanguage: string, theme: Theme, highlight = true): string[] {
	const text = chunk
		.replace(/^\r?\n/, "")
		.replace(/\r?\n$/, "")
		.trim();
	if (text.length === 0) return [];
	return highlight ? highlightCode(replaceTabs(text), shellLanguage, theme) : replaceTabs(text).split("\n");
}

// Settled view of a mixed bash call: the shell source with each display cell's
// code region (kernel cell body, heredoc-written source file) replaced by its
// AST outline (or the cell language's highlighted source when it does not
// parse), so the block reads as shell around an outlined code block instead of
// one flat bash listing. `highlight` syntax-colors the shell source and any
// cell code that has no AST outline; the committed bash card passes false so
// scrollback keeps the plain literal source.
export function renderShellWithCellOutlines(
	source: string,
	cells: readonly EvalDisplayCell[],
	shellLanguage: string,
	theme: Theme,
	width: number,
	highlight = true,
): { lines: string[]; outlined: boolean } | undefined {
	if (cells.length === 0) return undefined;
	const lines: string[] = [];
	let outlined = false;
	let cursor = 0;
	for (const cell of cells) {
		if (cell.start < cursor || cell.end < cell.start || cell.end > source.length) return undefined;
		lines.push(...shellChunkLines(source.slice(cursor, cell.start), shellLanguage, theme, highlight));
		const ast = astPreviewLines(cell.code, cell.language, theme, width - (cell.label ? OUTLINE_INDENT.length : 0));
		if (ast) {
			if (cell.label) {
				lines.push(theme.fg("dim", `${OUTLINE_INDENT}\u22ee outline of ${cell.label}`));
				for (const line of ast) lines.push(`${OUTLINE_INDENT}${line}`);
			} else {
				lines.push(...ast);
			}
			outlined = true;
		} else {
			const cellLines = highlight
				? highlightCode(replaceTabs(cell.code), languageForHighlighter(cell.language), theme)
				: replaceTabs(cell.code).split("\n");
			lines.push(...cellLines);
		}
		cursor = cell.end;
	}
	lines.push(...shellChunkLines(source.slice(cursor), shellLanguage, theme, highlight));
	return { lines, outlined };
}

/** A region of shell source written in another language (a heredoc body), by code offsets. */
export interface EmbeddedCodeRegion {
	start: number;
	end: number;
	/** Highlighter language for the region's source. */
	language: string;
}

// The shell grammar paints a heredoc body as one string token, so a 40-line
// Python (or Markdown, or Rust) body arrives as a single green block. Recolor
// those bodies with their own grammar: the shell source is highlighted whole —
// keeping every redirect, delimiter and trailing command exactly as the shell
// pass colors them — and then each region's lines are swapped for the region
// language's highlighting. Only lines a region covers end to end are swapped,
// so an inline `python -c '…'` word keeps the shell coloring: splitting a line
// mid-token would hand both halves to a parser as unbalanced fragments.
// Offsets index the raw source; tabs are expanded here, not by the caller.
export function highlightShellWithEmbeddedCode(
	source: string,
	regions: readonly EmbeddedCodeRegion[],
	shellLanguage: string,
	theme: Theme,
): string[] {
	const text = replaceTabs(source);
	const lines = highlightCode(text, shellLanguage, theme);
	const sourceLines = source.split("\n");
	// A highlighter that reflowed would desynchronize the overlay from the source.
	if (regions.length === 0 || lines.length !== sourceLines.length) return lines;
	const displayLines = text.split("\n");

	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of sourceLines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}

	for (const region of regions) {
		let first = -1;
		let last = -1;
		for (let i = 0; i < sourceLines.length; i++) {
			const lineStart = lineStarts[i]!;
			if (lineStart < region.start || lineStart + sourceLines[i]!.length > region.end) continue;
			if (first === -1) first = i;
			last = i;
		}
		if (first === -1) continue;
		const body = displayLines.slice(first, last + 1);
		const highlighted = highlightCode(body.join("\n"), region.language, theme);
		if (highlighted.length !== body.length) continue;
		for (let i = 0; i < highlighted.length; i++) lines[first + i] = highlighted[i]!;
	}
	return lines;
}

/**
 * Render one kernel cell (header + code preview + output + Status hunks + JSON
 * display trees) exactly as the eval tool's per-cell path does. Shared so the
 * bash `python`/`node`/`bun` bridge renders a routed cell identically to the `eval`
 * tool — same primitives, so the two can never drift.
 */
export function renderKernelCellLines(
	cell: EvalCellResult,
	jsonOutputs: readonly unknown[],
	theme: Theme,
	opts: {
		expanded: boolean;
		isPartial: boolean;
		spinnerFrame?: number;
		previewLines: number;
		width: number;
		index?: number;
		total?: number;
		/** Use an enclosing tool source instead of the kernel code for display. */
		displayCode?: string;
		displayLanguage?: string;
		/** Kernel cells embedded in `displayCode`; each renders as an outline inside the shell source when settled. */
		displayCells?: readonly EvalDisplayCell[];
		/** Embedded-language regions of `displayCode`; each keeps its own syntax coloring while the cell is live. */
		displayRegions?: readonly EmbeddedCodeRegion[];
		/**
		 * Trailing notices (elision, truncation recovery) for the whole call. They render as a final
		 * section of this card so they sit on the rail with the output they describe instead of
		 * trailing the card as loose text.
		 */
		noticeLines?: readonly string[];
	},
): string[] {
	const { expanded, isPartial, spinnerFrame, previewLines, width } = opts;
	const language = cell.language ?? "python";
	const hasDisplayCode = opts.displayCode !== undefined;
	const displayLanguage = opts.displayLanguage ?? languageForHighlighter(language);
	const cellLive = isPartial || cell.status === "running" || cell.status === "pending";
	const safeCode = sanitizeText(opts.displayCode ?? cell.code);
	const code = cellLive || hasDisplayCode ? safeCode : formatEvalCodeForDisplay(safeCode, language);
	const allEvents = cell.statusEvents ?? [];
	const agentEvents = allEvents.filter(e => e.op === "agent");
	const otherEvents = agentEvents.length > 0 ? allEvents.filter(e => e.op !== "agent") : allEvents;
	const agentLines = agentEvents.length > 0 ? renderAgentProgressEvents(agentEvents, theme, spinnerFrame) : [];

	const treeDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
	const treeLineCap = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
	const treeScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
	const labelOutputs = jsonOutputs.length > 1;
	const jsonLines = jsonOutputs.flatMap((value, index) => {
		const tree = renderJsonTreeLines(value, theme, treeDepth, treeLineCap, treeScalarLen, width);
		const body = tree.truncated ? [...tree.lines, theme.fg("dim", "…")] : tree.lines;
		return labelOutputs ? [theme.fg("dim", `display[${index + 1}]`), ...body] : body;
	});

	const outputContent = formatCellOutputLines(cell, expanded, previewLines, theme, width);
	const outputLines = [...outputContent.lines];
	if (!expanded && outputContent.hiddenCount > 0) {
		outputLines.unshift(formatHiddenLinesNotice(outputContent.hiddenCount, theme));
	}
	const statusLines = renderStatusEvents(otherEvents, theme, expanded, outputBlockContentWidth(width));

	let preRenderedCodeLines: string[] | undefined;
	let codeVariant: string | undefined;
	if (cellLive) {
		// Live shell source: a kernel body inside it is code, not a shell string.
		if (hasDisplayCode && opts.displayRegions && opts.displayRegions.length > 0) {
			preRenderedCodeLines = highlightShellWithEmbeddedCode(code, opts.displayRegions, displayLanguage, theme);
		}
	} else if (!expanded) {
		if (hasDisplayCode) {
			const composite = renderShellWithCellOutlines(
				code,
				opts.displayCells ?? [],
				displayLanguage,
				theme,
				width,
				false,
			);
			preRenderedCodeLines = composite?.lines;
			codeVariant = composite?.outlined ? "ast" : undefined;
		} else {
			preRenderedCodeLines = astPreviewLines(code, language, theme, width);
			codeVariant = preRenderedCodeLines ? "ast" : undefined;
		}
	} else if (hasDisplayCode) {
		// Expanded committed bash card: the full literal shell source, plain —
		// a committed command never re-highlights (code-cell would).
		preRenderedCodeLines = replaceTabs(code).split("\n");
	}

	const extraSections: Array<{ label?: string; lines: readonly string[] }> = [];
	if (statusLines.length > 0) extraSections.push({ label: theme.fg("toolTitle", "Status"), lines: statusLines });
	const noticeLines = (opts.noticeLines ?? []).filter(line => line.length > 0);
	if (noticeLines.length > 0) extraSections.push({ lines: noticeLines });
	const cellLines = renderCodeCell(
		{
			code,
			language: displayLanguage,
			showLanguage: true,
			index: opts.index ?? 0,
			total: opts.total ?? 1,
			title: typeof cell.title === "string" ? sanitizeSingleLine(cell.title) : undefined,
			status: cell.status,
			spinnerFrame,
			output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
			outputTrusted: true,
			outputMaxLines: outputLines.length,
			extraSections,
			codeTail: true,
			codeMaxLines: previewWindowRows(),
			expanded,
			width,
			preRenderedCodeLines,
			codeVariant,
		},
		theme,
	);

	const lines = [...cellLines, ...agentLines];
	if (jsonLines.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...jsonLines);
	}
	return lines;
}

export const evalToolRenderer = {
	animatedPendingPreview: true,
	animatedPartialResult: true,
	renderCall(args: EvalRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const cells = getRenderCells(args);

		if (cells.length === 0) {
			const promptSym = uiTheme.fg("accent", ">>>");
			const text = formatTitle(`${promptSym} …`, uiTheme);
			return new Text(text, 0, 0);
		}

		let cached: { key: string; width: number; result: string[] } | undefined;

		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const key = `${options.expanded ? 1 : 0}|${options.spinnerFrame ?? "-"}|${previewWindowRows()}|${cells.map(c => `${c.language}:${c.title ?? ""}:${c.code.length}:${Bun.hash(c.code)}`).join("|")}`;
				if (cached && cached.key === key && cached.width === width) {
					return cached.result;
				}

				const lines: string[] = [];
				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const cellLines = renderCodeCell(
						{
							code: sanitizeText(cell.code),
							language: languageForHighlighter(cell.language),
							showLanguage: true,
							index: i,
							total: cells.length,
							title: typeof cell.title === "string" ? sanitizeSingleLine(cell.title) : undefined,
							status: options.spinnerFrame !== undefined ? "running" : "pending",
							spinnerFrame: options.spinnerFrame,
							width,

							codeTail: true,
							codeMaxLines: previewWindowRows(),
							expanded: options.expanded,
						},
						uiTheme,
					);
					lines.push(...cellLines);
					if (i < cells.length - 1) {
						lines.push("");
					}
				}
				cached = { key, width, result: lines };
				return lines;
			},
			invalidate: () => {
				cached = undefined;
			},
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EvalToolDetails },
		options: RenderResultOptions & { renderContext?: EvalRenderContext },
		uiTheme: Theme,
		_args?: EvalRenderArgs,
	): Component {
		const details = result.details;
		// Captured at build time; every isPartial flip rebuilds this component
		// (tool-execution keys its display on isPartial), so this stays accurate.
		const isPartialResult = options.isPartial === true;

		const rawOutput = sanitizeText(
			options.renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "",
		).trimEnd();

		const output = stripOutputNotice(rawOutput, details?.meta).trimEnd();

		const jsonOutputs = details?.jsonOutputs ?? [];
		const treeExpanded = options.renderContext?.expanded ?? options.expanded;
		const treeDepth = treeExpanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
		const treeLineCap = treeExpanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
		const treeScalarLen = treeExpanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
		const labelOutputs = jsonOutputs.length > 1;
		const renderJsonLines = (width: number): string[] =>
			jsonOutputs.flatMap((value, index) => {
				const tree = renderJsonTreeLines(value, uiTheme, treeDepth, treeLineCap, treeScalarLen, width);
				const body = tree.truncated ? [...tree.lines, uiTheme.fg("dim", "…")] : tree.lines;
				return labelOutputs ? [truncateToWidth(uiTheme.fg("dim", `display[${index + 1}]`), width), ...body] : body;
			});

		let warningLine: string | undefined;
		if (details?.meta?.truncation) {
			warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
		}
		const noticeLine = details?.notice
			? uiTheme.fg("dim", wrapBrackets(statusValue(details.notice), uiTheme))
			: undefined;

		const cellResults = details?.cells;
		if (cellResults && cellResults.length > 0) {
			const displayCells = cellResults.map(cell => ({
				cell: { ...cell, language: (cell.language ?? details?.language ?? "python") as EvalLanguage },
			}));
			let cached: { key: string; width: number; result: string[] } | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const expanded = options.renderContext?.expanded ?? options.expanded;
					const previewLines = Math.min(
						options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES,
						previewWindowRows(),
					);
					const key = `${expanded}|${previewLines}|${options.spinnerFrame}|${previewWindowRows()}`;
					if (cached && cached.key === key && cached.width === width) {
						return cached.result;
					}

					const lines: string[] = [];
					const trailingNotices = [noticeLine, warningLine].filter((line): line is string => line !== undefined);
					for (let i = 0; i < displayCells.length; i++) {
						const { cell } = displayCells[i];
						// Shared with the bash kernel bridge so the two surfaces can
						// never drift.
						lines.push(
							...renderKernelCellLines(cell, [], uiTheme, {
								expanded,
								isPartial: isPartialResult,
								spinnerFrame: options.spinnerFrame,
								previewLines,
								width,
								index: i,
								total: cellResults.length,
								noticeLines: i === displayCells.length - 1 ? trailingNotices : undefined,
							}),
						);
						if (i < cellResults.length - 1) {
							lines.push("");
						}
					}
					const jsonLines = renderJsonLines(width);
					if (jsonLines.length > 0) {
						if (lines.length > 0) {
							lines.push("");
						}
						lines.push(...jsonLines);
					}
					cached = { key, width, result: lines };
					return lines;
				},
				invalidate: () => {
					cached = undefined;
				},
			});
		}

		const displayOutput = output;
		const hasOutput = displayOutput.length > 0 || jsonOutputs.length > 0;
		const combinedOutput = (width: number): string =>
			[displayOutput, ...renderJsonLines(width)].filter(Boolean).join("\n");

		const statusEvents = details?.statusEvents ?? [];
		const hasStatusEvents = statusEvents.length > 0;
		const expandedStatus = options.renderContext?.expanded ?? options.expanded;

		if (!hasOutput && !hasStatusEvents) {
			const lines = [noticeLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!hasOutput && hasStatusEvents) {
			return widthAwareText(width => {
				const lines = [
					uiTheme.fg("dim", "Status"),
					...renderStatusEvents(statusEvents, uiTheme, expandedStatus, width),
					noticeLine,
					warningLine,
				].filter(Boolean) as string[];
				return lines;
			});
		}

		if (options.renderContext?.expanded ?? options.expanded) {
			return widthAwareText(width => {
				const styledOutput = combinedOutput(width)
					.split("\n")
					.map(line => uiTheme.fg("toolOutput", line));
				const statusLines = renderStatusEvents(statusEvents, uiTheme, expandedStatus, width);
				const lines = [
					...styledOutput,
					...(statusLines.length > 0 ? [uiTheme.fg("dim", "Status"), ...statusLines] : []),
					noticeLine,
					warningLine,
				].filter(Boolean) as string[];
				return lines;
			});
		}

		let cachedWidth: number | undefined;
		let cachedLines: readonly string[] | undefined;
		let cachedSkipped: number | undefined;
		let cachedPreviewLines: number | undefined;

		return {
			render: (width: number): readonly string[] => {
				const previewLines = Math.min(
					options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES,
					previewWindowRows(),
				);
				if (cachedLines === undefined || cachedWidth !== width || cachedPreviewLines !== previewLines) {
					const styledOutput = combinedOutput(width)
						.split("\n")
						.map(line => uiTheme.fg("toolOutput", line))
						.join("\n");
					const result = truncateToVisualLines(`\n${styledOutput}`, previewLines, width);
					cachedLines = result.visualLines;
					cachedSkipped = result.skippedCount;
					cachedWidth = width;
					cachedPreviewLines = previewLines;
				}
				const outputLines: string[] = [];
				if (cachedSkipped && cachedSkipped > 0) {
					outputLines.push("");
					const skippedLine = formatHiddenLinesNotice(cachedSkipped, uiTheme);
					outputLines.push(truncateToWidth(skippedLine, width));
				}
				outputLines.push(...cachedLines);
				if (hasStatusEvents) {
					const statusLines = renderStatusEvents(statusEvents, uiTheme, expandedStatus, width);
					outputLines.push(uiTheme.fg("dim", "Status"));
					outputLines.push(...statusLines);
				}
				if (noticeLine) {
					outputLines.push(truncateToWidth(noticeLine, width));
				}
				if (warningLine) {
					outputLines.push(truncateToWidth(warningLine, width));
				}
				return outputLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
				cachedSkipped = undefined;
				cachedPreviewLines = undefined;
			},
		};
	},

	mergeCallAndResult: true,
	inline: true,
};
