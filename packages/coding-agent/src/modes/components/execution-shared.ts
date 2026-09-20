import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { type Component, Container, type TUI } from "@oh-my-pi/pi-tui/tui";
import { pluralize } from "@oh-my-pi/pi-utils";
import { getSymbolTheme, type Theme, theme } from "../../modes/theme/theme";
import { type ExecutionMetadata, isHardFailureExit } from "../../session/execution-metadata";
import { formatTruncationMetaNotice, type TruncationMeta } from "../../tools/output-meta";
import { formatExpandHint } from "../../tools/render-utils";
import { DynamicBorder } from "./dynamic-border";
import { truncateToVisualLines } from "./visual-truncate";

export type ExecutionStatus = "running" | "complete" | "cancelled" | "error" | "unknown";

/** `… N earlier lines ▸ Ctrl+O expand` — the one marker for output hidden from a tail preview. */
export function formatHiddenLinesNotice(hiddenLineCount: number, uiTheme: Theme = theme): string {
	const notice = uiTheme.fg("dim", `… ${hiddenLineCount} earlier ${pluralize("line", hiddenLineCount)}`);
	return `${notice} ${formatExpandHint(uiTheme)}`;
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

	suppressHiddenCount?: boolean;
}): Text | undefined {
	const parts: string[] = [];

	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		parts.push(formatHiddenLinesNotice(opts.hiddenLineCount));
	}
	if (opts.status === "cancelled") {
		parts.push(theme.fg("warning", "(cancelled)"));
	} else if (opts.status === "error") {
		parts.push(theme.fg("error", `(exit ${opts.exitCode})`));
	} else if (opts.status === "unknown") {
		parts.push(theme.fg("warning", "(status unknown)"));
	} else if (opts.status === "complete" && opts.exitCode !== undefined && opts.exitCode !== 0) {
		// Soft non-zero exit (grep/rg no-match, test false, diff differences):
		// visible for reference, but not failure-styled.
		parts.push(theme.fg("dim", `(exit ${opts.exitCode})`));
	}
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
	if (
		isHardFailureExit(exitCode, execution?.softExit) ||
		execution?.signal !== undefined ||
		execution?.timeout !== undefined
	) {
		return "error";
	}
	return "complete";
}
