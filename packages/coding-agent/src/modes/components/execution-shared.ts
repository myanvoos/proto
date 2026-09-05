import { type Component, Container, Loader, Text, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { ExecutionMetadata } from "../../session/execution-metadata";
import { formatTruncationMetaNotice, type TruncationMeta } from "../../tools/output-meta";
import { DynamicBorder } from "./dynamic-border";
import { truncateToVisualLines } from "./visual-truncate";

export type ExecutionStatus = "running" | "complete" | "cancelled" | "error" | "unknown";

export function formatExecutionMetadata(execution: ExecutionMetadata | undefined): string | undefined {
	if (!execution) return undefined;
	const parts = [`state=${execution.state}`];
	if (execution.exitCode !== undefined) parts.push(`exit=${execution.exitCode}`);
	if (execution.signal !== undefined) parts.push(`signal=${execution.signal}`);
	if (execution.elapsedMs !== undefined) parts.push(`elapsed=${formatDuration(Math.round(execution.elapsedMs))}`);
	if (execution.timeout) parts.push(`timeout=${execution.timeout.cause}/${execution.timeout.scope}`);
	parts.push(`collector=${execution.collector.state}`);
	if (execution.renderer) parts.push(`renderer=${execution.renderer.state}`);
	if (execution.output) parts.push(`output=${execution.output.disposition}`);
	return `Execution: ${parts.join(" | ")}`;
}

export type ExecutionColorKey = "dim" | "bashMode" | "pythonMode";

export function buildExecutionFrame(
	parent: Container,
	ui: TUI,
	colorKey: ExecutionColorKey,
): { contentContainer: Container; loader: Loader } {
	const borderColor = (str: string) => theme.fg(colorKey, str);

	parent.addChild(new DynamicBorder(borderColor));

	const contentContainer = new Container();
	parent.addChild(contentContainer);

	const loader = new Loader(
		ui,
		spinner => theme.fg(colorKey, spinner),
		text => theme.fg("muted", text),
		`Running… (esc to cancel)`,
		getSymbolTheme().spinnerFrames,
	);

	parent.addChild(new DynamicBorder(borderColor));
	return { contentContainer, loader };
}

export function createCollapsedPreview(previewText: string, previewLines: number): Component {
	return {
		render: (width: number) => truncateToVisualLines(previewText, previewLines, width, 1).visualLines,
		invalidate: () => {},
	};
}

export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	truncation: TruncationMeta | undefined;
	hiddenLineCount: number;
	execution?: ExecutionMetadata;

	suppressHiddenCount?: boolean;
}): Text | undefined {
	const parts: string[] = [];

	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		parts.push(theme.fg("dim", `… ${opts.hiddenLineCount} more lines (ctrl+o to expand)`));
	}
	if (opts.status === "cancelled") {
		parts.push(theme.fg("warning", "(cancelled)"));
	} else if (opts.status === "error") {
		parts.push(theme.fg("error", `(exit ${opts.exitCode})`));
	} else if (opts.status === "unknown") {
		parts.push(theme.fg("warning", "(status unknown)"));
	}
	const executionLine = formatExecutionMetadata(opts.execution);
	if (executionLine) parts.push(theme.fg("dim", executionLine));
	if (opts.truncation) {
		parts.push(theme.fg("warning", formatTruncationMetaNotice(opts.truncation)));
	}

	if (parts.length === 0) return undefined;
	return new Text(`\n${parts.join("\n")}`, 1, 0);
}

export function resolveExecutionStatus(
	exitCode: number | undefined,
	cancelled: boolean,
	execution?: ExecutionMetadata,
): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (execution?.state === "unknown") return "unknown";
	if (execution?.state === "running") return "running";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
