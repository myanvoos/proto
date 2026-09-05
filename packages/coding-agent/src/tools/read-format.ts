import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { truncateHeadBytes } from "@oh-my-pi/pi-utils";
import { isMarkdownPath } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import { DEFAULT_MAX_BYTES, noTruncResult, type TruncationResult, truncateHead } from "../session/streaming-output";
import { buildLineEntriesWithBlockContext, type LineEntry, lineEntriesToPlainText } from "../utils/block-context";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { type LineRange, shouldExpandRangeContext } from "./path-utils";
import type { ReadToolDetails } from "./read";
import { formatBytes } from "./render-utils";
import { toolResult } from "./tool-result";

export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

export function formatTextWithMode(text: string, startNum: number, shouldAddLineNumbers: boolean): string {
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

export const BRACKET_CONTEXT_ELLIPSIS = "…";

function formatLineEntryWithMode(entry: LineEntry, shouldAddLineNumbers: boolean): string {
	if (entry.kind === "ellipsis") return BRACKET_CONTEXT_ELLIPSIS;
	return formatSingleLine(entry.lineNumber, entry.text, shouldAddLineNumbers);
}

export function formatLineEntriesWithMode(entries: readonly LineEntry[], shouldAddLineNumbers: boolean): string {
	return entries.map(entry => formatLineEntryWithMode(entry, shouldAddLineNumbers)).join("\n");
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

export function formatSingleLine(line: number, text: string, shouldAddLineNumbers: boolean): string {
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

export function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

export function countTextLines(text: string): number {
	if (text.length === 0) return 0;

	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

export interface ElidedRange {
	start: number;
	end: number;
}

const FOOTER_RANGE_SAMPLES = 2;

export function formatSummaryElisionFooter(
	readPath: string,
	elidedRanges: ReadonlyArray<ElidedRange>,
	elidedLines: number,
): string {
	if (elidedRanges.length === 0) return "";
	const sampleCount = Math.min(elidedRanges.length, FOOTER_RANGE_SAMPLES);
	const selector = elidedRanges
		.slice(0, sampleCount)
		.map(r => `${r.start}-${r.end}`)
		.join(",");
	const example = `${readPath}:${selector}`;
	const tail = elidedRanges.length > sampleCount ? `, e.g. ${example}` : ` with ${example}`;
	return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}
export const READ_CHUNK_SIZE = 8 * 1024;

export const RANGE_LEADING_CONTEXT_LINES = 1;
export const RANGE_TRAILING_CONTEXT_LINES = 3;

function expandRangeWithContext(
	requestedStart: number,
	requestedEnd: number,
	totalLines: number,
	expandStart: boolean,
	expandEnd: boolean,
): { startLine: number; endLine: number } {
	return {
		startLine: expandStart ? Math.max(0, requestedStart - RANGE_LEADING_CONTEXT_LINES) : requestedStart,
		endLine: expandEnd ? Math.min(totalLines, requestedEnd + RANGE_TRAILING_CONTEXT_LINES) : requestedEnd,
	};
}

export function buildInMemoryTextResult(
	session: ToolSession,
	text: string,
	offset: number | undefined,
	limit: number | undefined,
	options: {
		details?: ReadToolDetails;
		sourcePath?: string;
		rangeContextPath?: string;
		sourceUrl?: string;
		sourceInternal?: string;
		entityLabel: string;
		ignoreResultLimits?: boolean;
		raw?: boolean;
	},
): AgentToolResult<ReadToolDetails> {
	const displayMode = resolveFileDisplayMode(session, { raw: options.raw });
	const details = options.details ?? {};
	const allLines = options.raw === true ? text.split("\n") : splitAddressableFileLines(text);
	const totalLines = allLines.length;
	details.totalLines = totalLines;

	const requestedStart = offset ? Math.max(0, offset - 1) : 0;
	const ignoreResultLimits = options.ignoreResultLimits ?? false;
	const requestedEnd = limit !== undefined ? Math.min(requestedStart + limit, allLines.length) : allLines.length;

	const rawDisplay = options.raw === true;
	const contextPath = options.rangeContextPath ?? options.sourcePath;
	const expandContext = shouldExpandRangeContext(contextPath);
	const expanded = expandRangeWithContext(
		requestedStart,
		requestedEnd,
		allLines.length,
		expandContext && !rawDisplay && offset !== undefined && offset > 1,
		expandContext && !rawDisplay && limit !== undefined,
	);
	const startLine = expanded.startLine;
	const endLineExpanded = expanded.endLine;
	const startLineDisplay = startLine + 1;

	const resultBuilder = toolResult(details);
	if (options.sourcePath) {
		resultBuilder.sourcePath(options.sourcePath);
	}
	if (options.sourceUrl) {
		resultBuilder.sourceUrl(options.sourceUrl);
	}
	if (options.sourceInternal) {
		resultBuilder.sourceInternal(options.sourceInternal);
	}

	if (requestedStart >= allLines.length) {
		const suggestion =
			allLines.length === 0
				? `The ${options.entityLabel} is empty.`
				: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
		return resultBuilder
			.text(
				`Line ${requestedStart + 1} is beyond end of ${options.entityLabel} (${allLines.length} lines total). ${suggestion}`,
			)
			.done();
	}

	const endLine = endLineExpanded;
	const selectedContent = allLines.slice(startLine, endLine).join("\n");
	const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
	const truncation = ignoreResultLimits ? noTruncResult(selectedContent) : truncateHead(selectedContent);

	const shouldAddLineNumbers = displayMode.lineNumbers;
	const formatText = (content: string, startNum: number): string => {
		const lineCount = countTextLines(content);
		details.displayContent = {
			text: content,
			startLine: startNum,
			lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
		};
		return formatTextWithMode(content, startNum, shouldAddLineNumbers);
	};
	const formatLineEntries = (entries: readonly LineEntry[], startNum: number): string => {
		const firstLine = entries.find(entry => entry.kind === "line");
		details.displayContent = {
			text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
			startLine: firstLine?.kind === "line" ? firstLine.lineNumber : startNum,
			lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
		};
		return formatLineEntriesWithMode(entries, shouldAddLineNumbers);
	};
	const buildLineEntries = (endLineDisplay: number): LineEntry[] =>
		buildLineEntriesWithBlockContext(allLines, [{ startLine: startLineDisplay, endLine: endLineDisplay }], {
			path: contextPath,
			text,
			includeContext: expandContext,
		});

	let outputText: string;
	let truncationInfo:
		| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
		| undefined;

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[startLine] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);

		outputText = formatText(snippet.text, startLineDisplay);

		if (snippet.text.length === 0) {
			outputText = `[Line ${startLineDisplay} is ${formatBytes(
				firstLineBytes,
			)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		details.truncation = truncation;
		truncationInfo = {
			result: truncation,
			options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
		};
	} else if (truncation.truncated) {
		const outputLines = truncation.outputLines ?? countTextLines(truncation.content);
		const endLineDisplay = startLineDisplay + Math.max(0, outputLines - 1);
		if (options.raw === true) {
			outputText = formatText(truncation.content, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLineDisplay), startLineDisplay);
		}
		details.truncation = truncation;
		truncationInfo = {
			result: truncation,
			options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
		};
	} else if (
		userLimitedLines !== undefined &&
		startLine + userLimitedLines < allLines.length &&
		(expandContext || rawDisplay)
	) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;

		if (options.raw === true) {
			outputText = formatText(selectedContent, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
		}
		outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use :${nextOffset} to continue]`;
	} else {
		if (options.raw === true) {
			outputText = formatText(truncation.content, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
		}
	}

	resultBuilder.text(outputText);
	if (truncationInfo) {
		resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
	}
	return resultBuilder.done();
}

export function buildInMemoryMultiRangeResult(
	session: ToolSession,
	text: string,
	ranges: readonly LineRange[],
	options: {
		details?: ReadToolDetails;
		sourcePath?: string;
		rangeContextPath?: string;
		sourceUrl?: string;
		sourceInternal?: string;
		entityLabel: string;
		raw?: boolean;
	},
): AgentToolResult<ReadToolDetails> {
	const displayMode = resolveFileDisplayMode(session, { raw: options.raw });
	const details = options.details ?? {};
	const allLines = options.raw === true ? text.split("\n") : splitAddressableFileLines(text);
	const totalLines = allLines.length;
	details.totalLines = totalLines;
	const shouldAddLineNumbers = displayMode.lineNumbers;

	const resultBuilder = toolResult(details);
	if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
	if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
	if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

	const outOfBounds: LineRange[] = [];
	const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
	const rawParts: string[] = [];
	for (const range of ranges) {
		if (range.startLine > totalLines) {
			outOfBounds.push(range);
			continue;
		}
		const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
		visibleSpans.push({ startLine: range.startLine, endLine: effectiveEnd });
		if (options.raw === true) {
			rawParts.push(allLines.slice(range.startLine - 1, effectiveEnd).join("\n"));
		}
	}

	let outputText = "";
	if (options.raw === true) {
		outputText = rawParts.length > 0 ? rawParts.join("\n\n…\n\n") : "";
	} else if (visibleSpans.length > 0) {
		const contextPath = options.rangeContextPath ?? options.sourcePath;
		const entries = buildLineEntriesWithBlockContext(allLines, visibleSpans, {
			path: contextPath,
			text,
			includeContext: shouldExpandRangeContext(contextPath),
		});
		const firstLine = entries.find(entry => entry.kind === "line");
		if (firstLine?.kind === "line") {
			details.displayContent = {
				text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
				startLine: firstLine.lineNumber,
				lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
			};
		}
		outputText = formatLineEntriesWithMode(entries, shouldAddLineNumbers);
	}
	const notices: string[] = [];
	for (const range of outOfBounds) {
		const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
		notices.push(`[Range ${bound} is beyond end of ${options.entityLabel} (${totalLines} lines total); skipped]`);
	}
	const finalText =
		notices.length > 0 ? (outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n")) : outputText;
	resultBuilder.text(finalText);
	return resultBuilder.done();
}

export function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}

export function markMarkdownContentType(
	session: ToolSession,
	details: ReadToolDetails,
	filePath: string,
): ReadToolDetails {
	if (!details.contentType && session.settings.get("read.renderMarkdown") && isMarkdownPath(filePath)) {
		details.contentType = "text/markdown";
	}
	return details;
}
