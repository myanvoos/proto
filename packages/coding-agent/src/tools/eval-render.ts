import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { formatNumber, pluralize, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import type { ExecutionMetadata } from "../session/execution-metadata";
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
	formatExpandHint,
	formatStatusIcon,
	formatTitle,
	getDiffStats,
	PREVIEW_LIMITS,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
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
// So while the result is partial the whole block must fit the live window.
// Everything else (code preview, output, agent lines) gets a reserved floor
// and the leftover rows go to the Status section, which reveals diff hunks
// for write events as soon as they are delivered — a write's ⟦+N/-M⟧ stats
// and its hunk appear together, instead of the hunk waiting for the entire
// call to settle. Hunks that don't fit show their tail plus a marker, and
// every hunk renders in full on settle, so the committed transcript keeps
// complete diffs exactly once.
const EVAL_STREAMING_SECTION_LINES = 12;

// Rows reserved for a cell's code preview while streaming (3 tail lines plus
// the "… N earlier lines" hint) when a hunk wants the space.
const EVAL_LIVE_CODE_FLOOR_ROWS = 4;

// Fudge for rows the budget math doesn't model exactly (wrapping overflow,
// blank separators between cells, expansion-deferred notes, extra sections).
const EVAL_LIVE_SLACK_ROWS = 4;

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
			code,
			title: typeof cell.title === "string" ? cell.title : undefined,
		});
	}
	return out;
}

type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "aborted";

function formatExecutionMetadataLine(execution: ExecutionMetadata | undefined, theme: Theme): string | undefined {
	if (!execution) return undefined;
	const parts = [`state=${execution.state}`];
	if (execution.exitCode !== undefined) parts.push(`exit=${execution.exitCode}`);
	if (execution.signal !== undefined) parts.push(`signal=${execution.signal}`);
	if (execution.elapsedMs !== undefined) parts.push(`elapsed=${formatDuration(Math.round(execution.elapsedMs))}`);
	if (execution.timeout) parts.push(`timeout=${execution.timeout.cause}/${execution.timeout.scope}`);
	parts.push(`collector=${execution.collector.state}`);
	if (execution.renderer) parts.push(`renderer=${execution.renderer.state}`);
	if (execution.collector.error) parts.push(`collector error: ${statusValue(execution.collector.error)}`);
	if (execution.output) parts.push(`output=${execution.output.disposition}`);
	const color =
		execution.state === "running"
			? "accent"
			: execution.state === "exited" && execution.exitCode === 0
				? "success"
				: "warning";
	return theme.fg(color, wrapBrackets(`Execution: ${parts.join(" | ")}`, theme));
}
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

interface EventHunkRows {
	rows: string[];
	// Row index where each logical diff line's wrapped row group starts; a
	// tail truncation cuts between groups, never mid-line.
	groupStarts: number[];
}

// Wrapped hunk rows are memoized per event object: streaming updates re-spread
// the status event array on every output chunk while the event objects stay
// identical, and re-rendering a capped 32k-char diff per chunk would dominate
// stream latency. Entries die with their event.
const eventHunkRowCache = new WeakMap<
	EvalStatusEvent,
	{ width: number; theme: Theme; diff: string; diffTruncated: boolean; hunk: EventHunkRows }
>();

function renderEventHunkRows(event: EvalStatusEvent, theme: Theme, width: number, skipSourceLines = 0): EventHunkRows {
	const diff = typeof event.diff === "string" ? sanitizeText(event.diff) : "";
	const diffTruncated = event.diffTruncated === true;
	if (skipSourceLines === 0) {
		const cached = eventHunkRowCache.get(event);
		if (
			cached &&
			cached.width === width &&
			cached.theme === theme &&
			cached.diff === diff &&
			cached.diffTruncated === diffTruncated
		) {
			return cached.hunk;
		}
	}

	const sourceLines = diff ? diff.split("\n") : [];
	const renderedDiff = sourceLines.slice(skipSourceLines).join("\n");
	const rows: string[] = [];
	const groupStarts: number[] = [];
	if (renderedDiff) {
		const filePath = typeof event.path === "string" ? event.path : undefined;
		for (const diffLine of renderDiffColored(renderedDiff, { filePath, theme }).split("\n")) {
			groupStarts.push(rows.length);
			rows.push(...wrapCodeFrameLine(diffLine, width));
		}
	}
	if (diffTruncated) {
		groupStarts.push(rows.length);
		rows.push(theme.fg("dim", "… diff truncated"));
	}
	const hunk = { rows, groupStarts };
	if (skipSourceLines === 0) {
		eventHunkRowCache.set(event, { width, theme, diff, diffTruncated, hunk });
	}
	return hunk;
}

interface StatusRenderOptions {
	suppressDiffs?: boolean;
	sectionRowBudget?: number;
	headCap?: number;
}

function renderStatusEvents(
	events: EvalStatusEvent[],
	theme: Theme,
	expanded: boolean,
	width: number,
	options: StatusRenderOptions = {},
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

	// Budgeted mode is the streaming path: `sectionRowBudget` bounds the whole
	// section (head lines + hunk bodies) so the live block stays inside the
	// viewport and nothing commits to scrollback mid-stream. Unbudgeted calls
	// are settled renders — full heads, full hunks.
	const budgeted = options.sectionRowBudget !== undefined;
	const allowHunks = budgeted || !options.suppressDiffs;

	interface EventBlock {
		event: EvalStatusEvent;
		cont: string;
		headRows: string[];
		withDiff: boolean;
		hunkRows?: string[];
		hiddenHunkLines?: number;
	}

	const blocks: EventBlock[] = [];
	for (let i = 0; i < visible.length; i++) {
		const event = visible[i]!;
		const isLast = i === visible.length - 1;
		const branch = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? " ".repeat(STATUS_TREE_INDENT) : `${theme.fg("dim", theme.tree.vertical)}  `;
		const withDiff = hasEventDiff(event);
		const [head, ...rest] =
			expanded && !withDiff ? formatStatusEventExpanded(event, theme) : [formatStatusEvent(event, theme)];
		const headRows = [...wrapTextWithAnsi(`${branch} ${head}`, width)];
		for (const line of rest) headRows.push(...wrapTextWithAnsi(`${cont}${line}`, width));
		for (const line of statusEventDetailLines(event)) {
			headRows.push(...wrapTextWithAnsi(`${cont}${theme.fg("dim", line)}`, width));
		}
		blocks.push({ event, cont, headRows, withDiff });
	}

	if (budgeted) {
		// Cap head rows at event granularity — drop whole earliest events over
		// the cap, mirroring capPreviewLines' "… N earlier" marker. Hunk bodies
		// then get whatever rows remain, latest event first: when several
		// writes race for space, the newest hunk is the one being watched.
		const headCap = Math.max(1, options.headCap ?? Number.POSITIVE_INFINITY);
		const totalHeadRows = blocks.reduce((sum, block) => sum + block.headRows.length, 0);
		if (totalHeadRows > headCap) {
			let hiddenRows = 0;
			let dropFrom = 0;
			while (dropFrom < blocks.length && totalHeadRows - hiddenRows > headCap) {
				hiddenRows += blocks[dropFrom]!.headRows.length;
				dropFrom++;
			}
			const marker = `… ${hiddenRows} earlier ${pluralize("line", hiddenRows)} ${formatExpandHint(theme, false, true)}`;
			blocks.splice(0, dropFrom, {
				event: blocks[0]!.event,
				cont: "",
				headRows: [theme.fg("dim", marker.trimEnd())],
				withDiff: false,
			});
		}
	}

	let budget = options.sectionRowBudget ?? Number.POSITIVE_INFINITY;
	if (budgeted) {
		const headRowsTotal = blocks.reduce((sum, block) => sum + block.headRows.length, 0);
		budget = Math.max(0, budget - headRowsTotal);
	}

	for (let i = blocks.length - 1; i >= 0 && budget > 0; i--) {
		const block = blocks[i]!;
		if (!block.withDiff || !allowHunks) continue;
		const hunk = renderEventHunkRows(block.event, theme, bodyWidth);
		if (hunk.rows.length === 0) continue;
		if (!budgeted || hunk.rows.length <= budget) {
			block.hunkRows = hunk.rows;
			budget -= hunk.rows.length;
			continue;
		}
		// The hunk exceeds the remaining budget: tail-truncate at a logical-line
		// boundary so no diff line renders as a severed fragment, and count the
		// hidden lines in a marker. The full hunk renders once the call settles.
		const cutRow = hunk.rows.length - budget;
		const cutAt = hunk.groupStarts.find(start => start >= cutRow);
		if (cutAt === undefined) break;
		const hiddenHunkLines = hunk.groupStarts.indexOf(cutAt);
		const retained = hiddenHunkLines > 0 ? renderEventHunkRows(block.event, theme, bodyWidth, hiddenHunkLines) : hunk;
		block.hunkRows = retained.rows;
		block.hiddenHunkLines = hiddenHunkLines;
		budget -= retained.rows.length;
	}

	const lines: string[] = [];
	if (hiddenCount > 0) {
		lines.push(
			...wrapTextWithAnsi(
				`${theme.fg("dim", theme.tree.branch)} ${theme.fg("dim", `… ${hiddenCount} earlier`)}`,
				width,
			),
		);
	}
	for (const block of blocks) {
		for (const row of block.headRows) lines.push(row);
		if (!block.hunkRows) continue;
		if (block.hiddenHunkLines && block.hiddenHunkLines > 0) {
			lines.push(
				`${block.cont}${theme.fg("dim", `… ${block.hiddenHunkLines} earlier diff ${pluralize("line", block.hiddenHunkLines)}`)}`,
			);
		}
		for (const row of block.hunkRows) lines.push(`${block.cont}${row}`);
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

function astPreviewLines(code: string, language: string, theme: Theme, width: number): string[] | undefined {
	if (language === "python") return renderPythonAstLines(code, theme, width) ?? undefined;
	if (language === "js") return renderJavaScriptAstLines(code, theme, width) ?? undefined;
	return undefined;
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
	},
): string[] {
	const { expanded, isPartial, spinnerFrame, previewLines, width } = opts;
	const language = cell.language ?? "python";
	const cellLive = isPartial || cell.status === "running" || cell.status === "pending";
	const safeCode = sanitizeText(cell.code);
	const code = cellLive ? safeCode : formatEvalCodeForDisplay(safeCode, language);
	const allEvents = cell.statusEvents ?? [];
	const agentEvents = allEvents.filter(e => e.op === "agent");
	const otherEvents = agentEvents.length > 0 ? allEvents.filter(e => e.op !== "agent") : allEvents;
	const cellExpanded = expanded && !cellLive;
	const liveWindow = previewWindowRows();
	const liveSectionCap = Math.min(EVAL_STREAMING_SECTION_LINES, Math.max(3, Math.floor(liveWindow / 2)));

	const outputContent = formatCellOutputLines(cell, cellExpanded, previewLines, theme, width);
	const outputLines = [...outputContent.lines];
	if (!cellExpanded && outputContent.hiddenCount > 0) {
		outputLines.push(theme.fg("dim", `… ${outputContent.hiddenCount} more lines (ctrl+o to expand)`));
	}

	let agentLines = agentEvents.length > 0 ? renderAgentProgressEvents(agentEvents, theme, spinnerFrame) : [];
	if (isPartial) agentLines = capPreviewLines(agentLines, theme, { max: liveSectionCap });

	const treeDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
	const treeLineCap = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
	const treeScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
	const labelOutputs = jsonOutputs.length > 1;
	const jsonLines = jsonOutputs.flatMap((value, index) => {
		const tree = renderJsonTreeLines(value, theme, treeDepth, treeLineCap, treeScalarLen);
		const body = tree.truncated ? [...tree.lines, theme.fg("dim", "…")] : tree.lines;
		return labelOutputs ? [theme.fg("dim", `display[${index + 1}]`), ...body] : body;
	});

	// While the call streams, the whole block must stay inside the live window
	// (see EVAL_STREAMING_SECTION_LINES): reserve rows for everything else and
	// hand the remainder to the Status section, which reveals hunk bodies for
	// delivered write events instead of withholding them until settle. A small
	// window reserves nothing and the section degrades to the summary line.
	let statusLines: string[];
	if (isPartial) {
		const reserve =
			1 /* cell header */ +
			1 /* Status label */ +
			(outputLines.length > 0 ? 1 : 0) /* Output label */ +
			EVAL_LIVE_CODE_FLOOR_ROWS +
			outputLines.length +
			agentLines.length +
			jsonLines.length +
			EVAL_LIVE_SLACK_ROWS;
		statusLines = renderStatusEvents(otherEvents, theme, cellExpanded, outputBlockContentWidth(width), {
			sectionRowBudget: Math.max(0, liveWindow - reserve),
			headCap: liveSectionCap,
		});
	} else {
		statusLines = renderStatusEvents(otherEvents, theme, cellExpanded, outputBlockContentWidth(width));
	}

	// While streaming the code window absorbs whatever the section didn't use
	// (floor 3 + hint); settled cells keep the full window.
	const codeMaxLines = isPartial
		? Math.max(3, liveWindow - statusLines.length - outputLines.length - agentLines.length)
		: liveWindow;
	const astLines = cellLive || cellExpanded ? undefined : astPreviewLines(code, language, theme, width);

	const cellLines = renderCodeCell(
		{
			code,
			language: languageForHighlighter(language),
			showLanguage: true,
			index: opts.index ?? 0,
			total: opts.total ?? 1,
			title: cell.title,
			status: cell.status,
			spinnerFrame,
			duration: cell.durationMs,
			output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
			outputMaxLines: outputLines.length,
			extraSections:
				statusLines.length > 0 ? [{ label: theme.fg("toolTitle", "Status"), lines: statusLines }] : undefined,
			codeTail: true,
			codeMaxLines,
			expanded: cellExpanded,
			width,
			preRenderedCodeLines: astLines,
			codeVariant: astLines ? "ast" : undefined,
		},
		theme,
	);

	const executionLine = formatExecutionMetadataLine(
		cell.execution ? { ...cell.execution, renderer: { state: "complete" } } : undefined,
		theme,
	);
	const lines = executionLine ? [executionLine, ...cellLines, ...agentLines] : [...cellLines, ...agentLines];
	// Ctrl+O expansion is deferred for live cells — an expanded block could
	// outgrow the viewport again. The toggle sticks and applies on settle.
	if (expanded && cellLive) {
		lines.push(theme.fg("dim", EXPANSION_DEFERRED_NOTE));
	}
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

				// The call phase is always live (mergeCallAndResult replaces it once a
				// result arrives), so expansion is deferred here too: the streaming
				// block must stay within the viewport (see EVAL_STREAMING_SECTION_LINES).
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
							title: cell.title,
							status: options.spinnerFrame !== undefined ? "running" : "pending",
							spinnerFrame: options.spinnerFrame,
							width,

							codeTail: true,
							codeMaxLines: previewWindowRows(),
							expanded: false,
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
		const executionLine = formatExecutionMetadataLine(
			details?.execution ? { ...details.execution, renderer: { state: "complete" } } : undefined,
			uiTheme,
		);
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
		const noticeLine = details?.notice
			? uiTheme.fg("dim", wrapBrackets(statusValue(details.notice), uiTheme))
			: undefined;
		const asyncLine =
			details?.async?.state === "running"
				? uiTheme.fg("dim", wrapBrackets(`Backgrounded: ${details.async.jobId}`, uiTheme))
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
					for (let i = 0; i < displayCells.length; i++) {
						const { cell } = displayCells[i];
						// Shared with the bash kernel bridge so the two surfaces can
						// never drift. The streaming budget keeps each cell inside the
						// live window and reveals delivered hunk bodies immediately
						// (see EVAL_STREAMING_SECTION_LINES).
						lines.push(
							...renderKernelCellLines(cell, [], uiTheme, {
								expanded,
								isPartial: isPartialResult,
								spinnerFrame: options.spinnerFrame,
								previewLines,
								width,
								index: i,
								total: cellResults.length,
							}),
						);
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
		// Top-level (non-cell) status events get the same streaming treatment as
		// cell events: budget the section so the live block stays in the window.
		const statusSectionOptions = (): StatusRenderOptions => {
			if (!isPartialResult) return {};
			const liveWindow = previewWindowRows();
			const liveSectionCap = Math.min(EVAL_STREAMING_SECTION_LINES, Math.max(3, Math.floor(liveWindow / 2)));
			return { sectionRowBudget: Math.max(0, liveWindow - 1 - EVAL_LIVE_SLACK_ROWS), headCap: liveSectionCap };
		};

		if (!combinedOutput && !hasStatusEvents) {
			const lines = [executionLine, timeoutLine, noticeLine, asyncLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!combinedOutput && hasStatusEvents) {
			return widthAwareText(width => {
				const lines = [
					executionLine,
					uiTheme.fg("dim", "Status"),
					...renderStatusEvents(statusEvents, uiTheme, expandedStatus, width, statusSectionOptions()),
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
					...statusSectionOptions(),
					sectionRowBudget: isPartialResult
						? Math.max(0, previewWindowRows() - styledOutput.split("\n").length - 1 - EVAL_LIVE_SLACK_ROWS)
						: undefined,
				});
				const lines = [
					executionLine,
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
				const outputLines: string[] = executionLine ? [executionLine] : [];
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
						...statusSectionOptions(),
						sectionRowBudget: isPartialResult
							? Math.max(0, previewWindowRows() - outputLines.length - 1 - EVAL_LIVE_SLACK_ROWS)
							: undefined,
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
