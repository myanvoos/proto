import { type Component, Markdown } from "@oh-my-pi/pi-tui";
import { settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../tools/json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "../tools/output-meta";
import { formatExpandHint, truncateToWidth } from "../tools/render-utils";
import { renderStatusLine, WidthAwareText } from "../tui";
import type { MCPToolDetails } from "./tool-bridge";

export function renderMCPCall(args: Record<string, unknown>, theme: Theme, label: string): Component {
	return new WidthAwareText(
		contentWidth => {
			const lines: string[] = [];
			lines.push(renderStatusLine({ icon: "pending", title: label }, theme));

			if (args && typeof args === "object" && Object.keys(args).length > 0) {
				const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(theme.tree.last) - 2);
				const preview = formatArgsInline(args, inlineBudget);
				if (preview) {
					lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
				}
			}

			return lines.join("\n");
		},
		0,
		0,
	);
}

function renderMarkdownMCPResult(
	result: { details?: MCPToolDetails; isError?: boolean },
	trimmedOutput: string,
	truncationWarning: string | null,
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const markdown = new Markdown(trimmedOutput, 0, 0, getMarkdownTheme(), {
		color: text => theme.fg("toolOutput", text),
	});
	return {
		render(contentWidth: number): readonly string[] {
			const lines: string[] = [];
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			lines.push(
				renderStatusLine(
					isError ? { icon: "error", title } : { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title },
					theme,
				),
			);

			if (options.expanded && args && Object.keys(args).length > 0) {
				lines.push(theme.fg("dim", "Args"));
				const tree = renderJsonTreeLines(
					args,
					theme,
					JSON_TREE_MAX_DEPTH_EXPANDED,
					JSON_TREE_MAX_LINES_EXPANDED,
					JSON_TREE_SCALAR_LEN_EXPANDED,
				);
				lines.push(...tree.lines);
				if (tree.truncated) lines.push(theme.fg("dim", "…"));
				lines.push("");
			}

			const rendered = markdown.render(Math.max(1, contentWidth));
			const maxOutputLines = options.expanded ? 12 : 4;
			lines.push(...rendered.slice(0, maxOutputLines));
			if (rendered.length > maxOutputLines) {
				lines.push(
					`${theme.fg("dim", `… ${rendered.length - maxOutputLines} more lines`)} ${formatExpandHint(theme, options.expanded, true)}`,
				);
			} else if (!options.expanded) {
				lines.push(formatExpandHint(theme, options.expanded, true));
			}
			if (truncationWarning) lines.push(truncationWarning);
			return lines;
		},
		invalidate(): void {},
	};
}

export function renderMCPResult(
	result: { content: Array<{ type: string; text?: string }>; details?: MCPToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const { expanded } = options;
	const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
	const trimmedOutput = stripOutputNotice(textContent, result.details?.meta).trimEnd();
	const truncationWarning = result.details?.meta?.truncation
		? formatStyledTruncationWarning(result.details.meta, theme)
		: null;
	let parsedOutput: unknown;
	let isJsonOutput = false;
	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			parsedOutput = JSON.parse(trimmedOutput);
			isJsonOutput = true;
		} catch {}
	}
	if (trimmedOutput && settings.get("mcp.renderMarkdownResults") && !isJsonOutput) {
		return renderMarkdownMCPResult(result, trimmedOutput, truncationWarning, options, theme, args);
	}
	return new WidthAwareText(
		contentWidth => {
			const lines: string[] = [];
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			const success = !isError;
			lines.push(
				renderStatusLine(
					success ? { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title } : { icon: "error", title },
					theme,
				),
			);

			if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
				lines.push(`${theme.fg("dim", "Args")}`);
				const maxDepth = JSON_TREE_MAX_DEPTH_EXPANDED;
				const maxLines = JSON_TREE_MAX_LINES_EXPANDED;
				const tree = renderJsonTreeLines(args, theme, maxDepth, maxLines, JSON_TREE_SCALAR_LEN_EXPANDED);
				for (const line of tree.lines) {
					lines.push(line);
				}
				if (tree.truncated) {
					lines.push(theme.fg("dim", "…"));
				}
				lines.push("");
			}

			if (!trimmedOutput) {
				lines.push(theme.fg("dim", "(no output)"));
				return lines.join("\n");
			}

			if (isJsonOutput) {
				const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
				const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
				const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
				const tree = renderJsonTreeLines(parsedOutput, theme, maxDepth, maxLines, maxScalarLen);

				if (tree.lines.length > 0) {
					lines.push(...tree.lines);
					if (!expanded) {
						lines.push(formatExpandHint(theme, expanded, true));
					} else if (tree.truncated) {
						lines.push(theme.fg("dim", "…"));
					}
					if (truncationWarning) lines.push(truncationWarning);
					return lines.join("\n");
				}
			}

			const outputLines = trimmedOutput.split("\n");
			const maxOutputLines = expanded ? 12 : 4;
			const displayLines = outputLines.slice(0, maxOutputLines);

			for (const line of displayLines) {
				lines.push(theme.fg("toolOutput", truncateToWidth(line, contentWidth)));
			}

			if (outputLines.length > maxOutputLines) {
				const remaining = outputLines.length - maxOutputLines;
				lines.push(`${theme.fg("dim", `… ${remaining} more lines`)} ${formatExpandHint(theme, expanded, true)}`);
			} else if (!expanded) {
				lines.push(formatExpandHint(theme, expanded, true));
			}

			if (truncationWarning) lines.push(truncationWarning);
			return lines.join("\n");
		},
		0,
		0,
	);
}
