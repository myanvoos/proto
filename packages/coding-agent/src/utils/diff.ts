import * as Diff from "diff";

import { type BlockContextSource, exceedsBlockContextScanCeiling, findBlockContextLines } from "./block-context";

export interface DiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

function formatNumberedDiffLine(prefix: "+" | "-" | " ", lineNum: number, content: string): string {
	return `${prefix}${lineNum}|${content}`;
}

interface ParsedNumberedDiffRow {
	prefix: "+" | "-" | " ";
	lineNumber: number;
	content: string;
}

function parseNumberedDiffRow(row: string): ParsedNumberedDiffRow | undefined {
	const match = /^([+\- ])(\d+)\|(.*)$/s.exec(row);
	if (!match) return undefined;
	const prefix = match[1] as "+" | "-" | " ";
	const lineNumber = Number.parseInt(match[2], 10);
	if (!Number.isFinite(lineNumber)) return undefined;
	return { prefix, lineNumber, content: match[3] ?? "" };
}

function isDiffChangeRow(row: string | undefined): boolean {
	return row !== undefined && (row.startsWith("+") || row.startsWith("-"));
}

const DIFF_GAP_ROW = "";

function parseSourceRowLineNumber(row: string): number | undefined {
	const parsed = parseNumberedDiffRow(row);
	return parsed === undefined || parsed.prefix === "+" ? undefined : parsed.lineNumber;
}

function normalizeDiffGapRows(rows: string[]): void {
	const kept: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row !== DIFF_GAP_ROW) {
			kept.push(row);
			continue;
		}
		if (kept.length === 0 || kept[kept.length - 1] === DIFF_GAP_ROW) continue;
		let before: number | undefined;
		for (let j = kept.length - 1; j >= 0 && before === undefined; j--) {
			before = parseSourceRowLineNumber(kept[j]);
		}
		let after: number | undefined;
		for (let j = i + 1; j < rows.length && after === undefined; j++) {
			if (rows[j] === DIFF_GAP_ROW) continue;
			after = parseSourceRowLineNumber(rows[j]);
		}
		if (before === undefined || after === undefined || after <= before + 1) continue;
		kept.push(row);
	}
	if (kept.length !== rows.length) rows.splice(0, rows.length, ...kept);
}

function adjustedContextInsertIndex(rows: readonly string[], index: number): number {
	let start = index;
	while (start > 0 && isDiffChangeRow(rows[start - 1])) start--;
	let end = index;
	while (end < rows.length && isDiffChangeRow(rows[end])) end++;
	return index > start && index < end ? end : index;
}

function insertBracketContextRows(
	rows: string[],
	contextLines: ReadonlyMap<number, string>,
	seenRows: Set<string>,
): void {
	const context = [...contextLines].sort(([left], [right]) => left - right);
	for (const [lineNumber, text] of context) {
		const row = formatNumberedDiffLine(" ", lineNumber, text);
		if (seenRows.has(row)) continue;

		let insertIndex = rows.length;
		let previousSourceLine: number | undefined;
		let nextSourceLine: number | undefined;
		for (let i = 0; i < rows.length; i++) {
			const parsed = parseNumberedDiffRow(rows[i]);
			if (!parsed || parsed.prefix === "+") continue;
			if (parsed.lineNumber < lineNumber) {
				previousSourceLine = parsed.lineNumber;
				continue;
			}
			nextSourceLine = parsed.lineNumber;
			insertIndex = i;
			break;
		}

		const chunk: string[] = [];
		if (previousSourceLine !== undefined && lineNumber > previousSourceLine + 1) chunk.push(DIFF_GAP_ROW);
		chunk.push(row);
		if (nextSourceLine !== undefined && nextSourceLine > lineNumber + 1) chunk.push(DIFF_GAP_ROW);

		const adjustedIndex = adjustedContextInsertIndex(rows, insertIndex);
		rows.splice(adjustedIndex, 0, ...chunk);
		seenRows.add(row);
	}
}

function addMatchingBracketContextRows(
	rows: string[],
	oldText: string,
	newText: string,
	source: BlockContextSource,
): void {
	if (exceedsBlockContextScanCeiling(oldText) || exceedsBlockContextScanCeiling(newText)) return;
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const oldVisible: number[] = [];
	const newVisible: number[] = [];
	const seenRows = new Set(rows);

	const changes: { newPos: number; delta: 1 | -1 }[] = [];
	let offset = 0;

	for (const row of rows) {
		const parsed = parseNumberedDiffRow(row);
		if (!parsed) continue;
		switch (parsed.prefix) {
			case "-":
				oldVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber + offset, delta: -1 });
				offset--;
				break;
			case "+":
				newVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber, delta: 1 });
				offset++;
				break;
			default:
				oldVisible.push(parsed.lineNumber);
				newVisible.push(parsed.lineNumber + offset);
				break;
		}
	}

	const toOldLineNumber = (newLineNumber: number): number => {
		let shift = 0;
		for (const change of changes) {
			if (change.newPos <= newLineNumber) shift += change.delta;
		}
		return newLineNumber - shift;
	};

	const contextRows = findBlockContextLines(oldLines, oldVisible, { ...source, text: oldText });
	for (const [lineNumber, text] of findBlockContextLines(newLines, newVisible, { ...source, text: newText })) {
		const oldLineNumber = toOldLineNumber(lineNumber);
		if (!contextRows.has(oldLineNumber)) contextRows.set(oldLineNumber, text);
	}
	insertBracketContextRows(rows, contextRows, seenRows);
	normalizeDiffGapRows(rows);
}

const MAX_EVENT_DIFF_CHARS = 32000;

/**
 * Generate the numbered hunk diff for an eval status event and cap it to a
 * character budget. Shared by the host cell walker (eval/cell-file-diff.ts)
 * and the JS kernel's fs tracker (eval/js/shared/fs-tracker.ts); the Python
 * prelude keeps its own copy across the process boundary.
 */
export function capEventDiff(before: string, after: string): { diff: string; diffTruncated?: true } | undefined {
	const rows = generateDiffString(before, after, 2)
		.diff.split("\n")
		.filter(row => row.length > 0);
	if (rows.length === 0) return undefined;
	const kept: string[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.length + 1 > MAX_EVENT_DIFF_CHARS) break;
		kept.push(row);
		used += row.length + 1;
	}
	return kept.length < rows.length ? { diff: kept.join("\n"), diffTruncated: true } : { diff: kept.join("\n") };
}

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 2,
	source: BlockContextSource = {},
): DiffResult {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					output.push(formatNumberedDiffLine("+", newLineNum, line));
					newLineNum++;
				} else {
					output.push(formatNumberedDiffLine("-", oldLineNum, line));
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				const contextLimit = Math.max(0, contextLines);
				let leadingSkip = 0;
				let middleSkip = 0;
				let trailingSkip = 0;
				let linesToShow: string[];

				if (lastWasChange && nextPartIsChange) {
					if (raw.length > contextLimit * 2) {
						const leadingContext = raw.slice(0, contextLimit);
						const trailingContext = raw.slice(raw.length - contextLimit);
						middleSkip = raw.length - leadingContext.length - trailingContext.length;
						linesToShow = [...leadingContext, ...trailingContext];
					} else {
						linesToShow = raw;
					}
				} else if (nextPartIsChange) {
					leadingSkip = Math.max(0, raw.length - contextLimit);
					linesToShow = raw.slice(leadingSkip);
				} else {
					trailingSkip = Math.max(0, raw.length - contextLimit);
					linesToShow = raw.slice(0, contextLimit);
				}

				if (leadingSkip > 0) {
					oldLineNum += leadingSkip;
					newLineNum += leadingSkip;
				}

				const firstChunkLength = middleSkip > 0 ? contextLimit : linesToShow.length;
				for (const line of linesToShow.slice(0, firstChunkLength)) {
					output.push(formatNumberedDiffLine(" ", oldLineNum, line));
					oldLineNum++;
					newLineNum++;
				}

				if (middleSkip > 0) {
					oldLineNum += middleSkip;
					newLineNum += middleSkip;
					for (const line of linesToShow.slice(firstChunkLength)) {
						output.push(formatNumberedDiffLine(" ", oldLineNum, line));
						oldLineNum++;
						newLineNum++;
					}
				}

				if (trailingSkip > 0) {
					oldLineNum += trailingSkip;
					newLineNum += trailingSkip;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	addMatchingBracketContextRows(output, oldContent, newContent, source);

	return { diff: output.join("\n"), firstChangedLine };
}
