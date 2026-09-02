import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import { markFramedBlockComponent, outputBlockContentWidth, renderCodeCell } from "../tui";
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
	capPreviewLines,
	formatBadge,
	formatDuration,
	formatStatusIcon,
	formatTitle,
	getDiffStats,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	truncateToWidth,
	wrapBrackets,
	wrapCodeFrameLine,
} from "./render-utils";
export const EVAL_DEFAULT_PREVIEW_LINES = 10;

// Per-section row cap for cells rendered while the tool call is still
// partial. A live block re-renders inside the terminal's live region; if it
// outgrows the viewport its top rows scroll off and are committed to native
// scrollback mid-stream. The finalized render then differs from that
// committed prefix (spinner header → done header, trimmed output), which
// forces a re-emit of the whole block — duplicating it in scrollback.
//
// Diff hunks are withheld entirely while the result is partial — even for
// cells that already completed (a cell can finish executing while later args
// still stream; its full hunk would land in the live region, overflow, and
// re-emit on settle, printing the hunk twice). Live renders show only the
// per-file ⟦+N/-M⟧ stats line; hunks appear once the call settles, so the
// committed transcript keeps complete diffs exactly once.
const EVAL_STREAMING_SECTION_LINES = 12;

// Ctrl+O expansion is deferred for the same reason: an expanded live block
// would outgrow the viewport again. The toggle sticks and applies on settle.
const EXPANSION_DEFERRED_NOTE = "… expanded view once the cell settles";

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
			code: formatEvalCodeForDisplay(code, language),
			title: typeof cell.title === "string" ? cell.title : undefined,
		});
	}
	return out;
}

type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const id = event.id;
		const idx = events.findIndex(e => e.op === "agent" && e.id === id);
		if (idx >= 0) {
			events[idx] = event;
			return;
		}
	}
	events.push(event);
}

function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
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

function renderEventDiff(event: EvalStatusEvent, theme: Theme): string[] {
	const diff = typeof event.diff === "string" ? event.diff : "";
	if (!diff) return [];
	const filePath = typeof event.path === "string" ? event.path : undefined;
	const lines = renderDiffColored(diff, { filePath }).split("\n");
	if (event.diffTruncated === true) {
		lines.push(theme.fg("dim", "… diff truncated"));
	}
	return lines;
}

function formatStatusEvent(event: EvalStatusEvent, theme: Theme): string {
	const { op, ...data } = event;

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
		return `${icon} ${theme.fg("warning", op)}: ${theme.fg("dim", String(data.error))}`;
	}

	switch (op) {
		case "read":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
			if (typeof data.diff === "string" && data.diff.length > 0) {
				if (data.path) parts.push(shortenPath(String(data.path)));
			} else {
				const unit = data.chars === undefined && data.bytes !== undefined ? "bytes" : "chars";
				parts.push(`${data.chars ?? data.bytes ?? 0} ${unit}`);
				if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			}
			break;
		case "delete":
			if (data.path) parts.push(shortenPath(String(data.path)));
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
				parts.push(`set ${data.key}=${truncateToWidth(String(data.value ?? ""), 30)}`);
			} else if (data.action === "get") {
				parts.push(`${data.key}=${truncateToWidth(String(data.value ?? ""), 30)}`);
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
			if (data.branch) parts.push(`on ${data.branch}`);
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
			if (data.model) parts.push(String(data.model));
			if (data.tier && data.tier !== data.model) parts.push(`(${data.tier})`);
			parts.push(`${data.chars ?? 0} chars`);
			break;
		case "wc":
			parts.push(`${data.lines}L ${data.words}W ${data.chars}C`);
			break;
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		case "log":
			parts.push(String(data.message ?? ""));
			break;
		case "phase":
			parts.push(String(data.title ?? ""));
			break;
		default:
			if (data.count !== undefined) {
				parts.push(String(data.count));
			}
			if (data.path) {
				parts.push(shortenPath(String(data.path)));
			}
	}

	const desc = parts.length > 0 ? parts.join(" · ") : "";
	const statsSuffix = hasEventDiff(event) ? formatDiffStatsSuffix(event.diff as string, theme) : "";
	return `${icon} ${theme.fg("muted", op)}${desc ? ` ${theme.fg("dim", desc)}` : ""}${statsSuffix}`;
}

function formatStatusEventExpanded(event: EvalStatusEvent, theme: Theme): string[] {
	const lines: string[] = [];
	const { op, ...data } = event;

	lines.push(formatStatusEvent(event, theme));

	const addItems = (items: unknown[], formatter: (item: unknown) => string, max = 5) => {
		const arr = Array.isArray(items) ? items : [];
		for (let i = 0; i < Math.min(arr.length, max); i++) {
			lines.push(`   ${theme.fg("dim", formatter(arr[i]))}`);
		}
		if (arr.length > max) {
			lines.push(`   ${theme.fg("dim", `… ${arr.length - max} more`)}`);
		}
	};

	const addPreview = (preview: string, maxLines = 3) => {
		const previewLines = String(preview).split("\n").slice(0, maxLines);
		for (const line of previewLines) {
			lines.push(`   ${theme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}`);
		}
		const totalLines = String(preview).split("\n").length;
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

export function renderStatusEvents(
	events: EvalStatusEvent[],
	theme: Theme,
	expanded: boolean,
	width: number,
	options: { suppressDiffs?: boolean } = {},
): string[] {
	if (events.length === 0) return [];

	const nonFileOpIndexes: number[] = [];
	for (let i = 0; i < events.length; i++) {
		if (!isFileOpEvent(events[i])) nonFileOpIndexes.push(i);
	}
	const hiddenCount = expanded ? 0 : Math.max(0, nonFileOpIndexes.length - STATUS_COLLAPSED_MAX_EVENTS);
	const hiddenIndexes = new Set(nonFileOpIndexes.slice(0, hiddenCount));
	const visible = events.filter((_, i) => !hiddenIndexes.has(i));
	const bodyWidth = Math.max(1, width - STATUS_TREE_INDENT);

	const lines: string[] = [];
	const pushText = (line: string): void => {
		lines.push(...wrapTextWithAnsi(line, width));
	};
	if (hiddenCount > 0) {
		pushText(`${theme.fg("dim", theme.tree.branch)} ${theme.fg("dim", `… ${hiddenCount} earlier`)}`);
	}
	for (let i = 0; i < visible.length; i++) {
		const event = visible[i];
		const isLast = i === visible.length - 1;
		const branch = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? " ".repeat(STATUS_TREE_INDENT) : `${theme.fg("dim", theme.tree.vertical)}  `;
		const withDiff = hasEventDiff(event);
		const [head, ...rest] =
			expanded && !withDiff ? formatStatusEventExpanded(event, theme) : [formatStatusEvent(event, theme)];
		pushText(`${branch} ${head}`);
		for (const line of rest) pushText(`${cont}${line}`);
		// The head line already carries the ⟦+N/-M⟧ stats; the hunk body is
		// deferred until the call settles (see EVAL_STREAMING_SECTION_LINES).
		if (!withDiff || options.suppressDiffs) continue;
		for (const diffLine of renderEventDiff(event, theme)) {
			for (const row of wrapCodeFrameLine(diffLine, bodyWidth)) {
				lines.push(`${cont}${row}`);
			}
		}
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

	const innerWidth = outputBlockContentWidth(width);

	if (cell.hasMarkdown && cell.status !== "error") {
		const md = new Markdown(cell.output, 0, 0, getMarkdownTheme());
		const allLines = md.render(innerWidth);
		const displayLines = expanded ? allLines : allLines.slice(-previewLines);
		const hiddenCount = allLines.length - displayLines.length;
		return { lines: displayLines, hiddenCount };
	}

	const styledOutput = cell.output
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

export function astPreviewLines(code: string, language: string, theme: Theme, width: number): string[] | undefined {
	if (language === "python") return renderPythonAstLines(code, theme, width) ?? undefined;
	if (language === "js") return renderJavaScriptAstLines(code, theme, width) ?? undefined;
	return undefined;
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

				// The call phase is always live (mergeCallAndResult replaces it once a
				// result arrives), so expansion is deferred here too: the streaming
				// block must stay within the viewport (see EVAL_STREAMING_SECTION_LINES).
				const lines: string[] = [];
				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const astLines = astPreviewLines(cell.code, cell.language, uiTheme, width);
					const cellLines = renderCodeCell(
						{
							code: cell.code,
							language: languageForHighlighter(cell.language),
							showLanguage: true,
							index: i,
							total: cells.length,
							title: cell.title,
							status: options.spinnerFrame !== undefined ? "running" : "pending",
							spinnerFrame: options.spinnerFrame,
							width,

							codeTail: true,
							codeMaxLines: previewWindowRows(),
							expanded: false,
							preRenderedCodeLines: astLines,
							codeVariant: astLines ? "ast" : undefined,
						},
						uiTheme,
					);
					lines.push(...cellLines);
					if (options.expanded) {
						lines.push(uiTheme.fg("dim", EXPANSION_DEFERRED_NOTE));
					}
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

		const rawOutput =
			options.renderContext?.output ?? (result.content?.find(c => c.type === "text")?.text ?? "").trimEnd();

		const output = stripOutputNotice(rawOutput, details?.meta).trimEnd();

		const jsonOutputs = details?.jsonOutputs ?? [];
		const treeExpanded = options.renderContext?.expanded ?? options.expanded;
		const treeDepth = treeExpanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
		const treeLineCap = treeExpanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
		const treeScalarLen = treeExpanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
		const labelOutputs = jsonOutputs.length > 1;
		const jsonLines = jsonOutputs.flatMap((value, index) => {
			const tree = renderJsonTreeLines(value, uiTheme, treeDepth, treeLineCap, treeScalarLen);
			const body = tree.truncated ? [...tree.lines, uiTheme.fg("dim", "…")] : tree.lines;
			return labelOutputs ? [uiTheme.fg("dim", `display[${index + 1}]`), ...body] : body;
		});

		const timeoutSeconds = options.renderContext?.timeout;
		const timeoutLine =
			typeof timeoutSeconds === "number"
				? uiTheme.fg("dim", wrapBrackets(`Timeout: ${timeoutSeconds}s`, uiTheme))
				: undefined;
		let warningLine: string | undefined;
		if (details?.meta?.truncation) {
			warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
		}
		const noticeLine = details?.notice ? uiTheme.fg("dim", wrapBrackets(details.notice, uiTheme)) : undefined;
		const asyncLine =
			details?.async?.state === "running"
				? uiTheme.fg("dim", wrapBrackets(`Backgrounded: ${details.async.jobId}`, uiTheme))
				: undefined;

		const cellResults = details?.cells;
		if (cellResults && cellResults.length > 0) {
			const displayCells = cellResults.map(cell => {
				const language = cell.language ?? details?.language ?? "python";
				return { cell, code: formatEvalCodeForDisplay(cell.code, language), language };
			});
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
					for (let i = 0; i < displayCells.length; i++) {
						const { cell, code, language } = displayCells[i];
						const allEvents = cell.statusEvents ?? [];
						const agentEvents = allEvents.filter(e => e.op === "agent");
						const otherEvents = agentEvents.length > 0 ? allEvents.filter(e => e.op !== "agent") : allEvents;
						// Keep a still-executing cell inside the viewport (see
						// EVAL_STREAMING_SECTION_LINES): cap Status/agent sections and
						// let the code window absorb the remainder of the live budget.
						// Ctrl+O expansion is deferred for live cells for the same
						// reason — it takes effect once the cell settles.
						const cellLive = isPartialResult && (cell.status === "running" || cell.status === "pending");
						const cellExpanded = expanded && !cellLive;
						const liveWindow = previewWindowRows();
						const liveSectionCap = Math.min(
							EVAL_STREAMING_SECTION_LINES,
							Math.max(3, Math.floor(liveWindow / 2)),
						);
						// Diff hunks and section overflow are suppressed for EVERY cell
						// while the call is partial — a completed cell's rows still sit
						// in the live region until the call settles, so a big hunk there
						// would commit to scrollback mid-stream and print again on
						// finish (see EVAL_STREAMING_SECTION_LINES).
						let statusLines = renderStatusEvents(
							otherEvents,
							uiTheme,
							cellExpanded,
							outputBlockContentWidth(width),
							{ suppressDiffs: isPartialResult },
						);
						if (isPartialResult) {
							statusLines = capPreviewLines(statusLines, uiTheme, { max: liveSectionCap });
						}
						const outputContent = formatCellOutputLines(cell, cellExpanded, previewLines, uiTheme, width);
						const outputLines = [...outputContent.lines];
						if (!cellExpanded && outputContent.hiddenCount > 0) {
							outputLines.push(
								uiTheme.fg("dim", `… ${outputContent.hiddenCount} more lines (ctrl+o to expand)`),
							);
						}
						let agentLines =
							agentEvents.length > 0
								? renderAgentProgressEvents(agentEvents, uiTheme, options.spinnerFrame)
								: [];
						if (isPartialResult) {
							agentLines = capPreviewLines(agentLines, uiTheme, { max: liveSectionCap });
						}
						const codeMaxLines = cellLive
							? Math.max(3, liveWindow - statusLines.length - outputLines.length - agentLines.length)
							: liveWindow;
						const astLines = cellExpanded ? undefined : astPreviewLines(code, language, uiTheme, width);
						const cellLines = renderCodeCell(
							{
								code,
								language: languageForHighlighter(language),
								showLanguage: true,
								index: i,
								total: cellResults.length,
								title: cell.title,
								status: cell.status,
								spinnerFrame: options.spinnerFrame,
								duration: cell.durationMs,
								output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
								outputMaxLines: outputLines.length,
								extraSections:
									statusLines.length > 0
										? [{ label: uiTheme.fg("toolTitle", "Status"), lines: statusLines }]
										: undefined,

								codeTail: true,
								codeMaxLines,
								expanded: cellExpanded,
								width,
								preRenderedCodeLines: astLines,
								codeVariant: astLines ? "ast" : undefined,
							},
							uiTheme,
						);
						lines.push(...cellLines);
						if (agentLines.length > 0) {
							lines.push(...agentLines);
						}
						if (expanded && cellLive) {
							lines.push(uiTheme.fg("dim", EXPANSION_DEFERRED_NOTE));
						}
						if (i < cellResults.length - 1) {
							lines.push("");
						}
					}
					if (jsonLines.length > 0) {
						if (lines.length > 0) {
							lines.push("");
						}
						lines.push(...jsonLines);
					}
					if (timeoutLine) {
						lines.push(timeoutLine);
					}
					if (noticeLine) {
						lines.push(noticeLine);
					}
					if (asyncLine) {
						lines.push(asyncLine);
					}
					if (warningLine) {
						lines.push(warningLine);
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
		const combinedOutput = [displayOutput, ...jsonLines].filter(Boolean).join("\n");

		const statusEvents = details?.statusEvents ?? [];
		const hasStatusEvents = statusEvents.length > 0;
		const expandedStatus = options.renderContext?.expanded ?? options.expanded;

		if (!combinedOutput && !hasStatusEvents) {
			const lines = [timeoutLine, noticeLine, asyncLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!combinedOutput && hasStatusEvents) {
			return widthAwareText(width => {
				const lines = [
					uiTheme.fg("dim", "Status"),
					...renderStatusEvents(statusEvents, uiTheme, expandedStatus, width, {
						suppressDiffs: isPartialResult,
					}),
					timeoutLine,
					noticeLine,
					asyncLine,
					warningLine,
				].filter(Boolean) as string[];
				return lines;
			});
		}

		if (options.renderContext?.expanded ?? options.expanded) {
			const styledOutput = combinedOutput
				.split("\n")
				.map(line => uiTheme.fg("toolOutput", line))
				.join("\n");
			return widthAwareText(width => {
				const statusLines = renderStatusEvents(statusEvents, uiTheme, expandedStatus, width, {
					suppressDiffs: isPartialResult,
				});
				const lines = [
					styledOutput,
					...(statusLines.length > 0 ? [uiTheme.fg("dim", "Status"), ...statusLines] : []),
					timeoutLine,
					noticeLine,
					asyncLine,
					warningLine,
				].filter(Boolean) as string[];
				return lines;
			});
		}

		const styledOutput = combinedOutput
			.split("\n")
			.map(line => uiTheme.fg("toolOutput", line))
			.join("\n");
		const textContent = `\n${styledOutput}`;

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
					const result = truncateToVisualLines(textContent, previewLines, width);
					cachedLines = result.visualLines;
					cachedSkipped = result.skippedCount;
					cachedWidth = width;
					cachedPreviewLines = previewLines;
				}
				const outputLines: string[] = [];
				if (cachedSkipped && cachedSkipped > 0) {
					outputLines.push("");
					const skippedLine = uiTheme.fg(
						"dim",
						`… (${cachedSkipped} earlier lines, showing ${cachedLines.length} of ${cachedSkipped + cachedLines.length}) (ctrl+o to expand)`,
					);
					outputLines.push(truncateToWidth(skippedLine, width));
				}
				outputLines.push(...cachedLines);
				if (hasStatusEvents) {
					const statusLines = renderStatusEvents(statusEvents, uiTheme, expandedStatus, width, {
						suppressDiffs: isPartialResult,
					});
					outputLines.push(uiTheme.fg("dim", "Status"));
					outputLines.push(...statusLines);
				}
				if (timeoutLine) {
					outputLines.push(truncateToWidth(timeoutLine, width));
				}
				if (noticeLine) {
					outputLines.push(truncateToWidth(noticeLine, width));
				}
				if (asyncLine) {
					outputLines.push(truncateToWidth(asyncLine, width));
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
