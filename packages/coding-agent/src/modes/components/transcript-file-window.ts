import * as fs from "node:fs";

const SCAN_BYTES = 64 * 1024;
export interface TranscriptFileWindow {
	start: number;
	end: number;
	text: string;
}
export function readFileRangeSync(file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const n = fs.readSync(fd, buffer, 0, length, offset);
		return n === length ? buffer : buffer.subarray(0, n);
	} finally {
		fs.closeSync(fd);
	}
}
/** Page boundary: user/assistant record; assistant tool calls remain with all following results. */
function isGroupBoundary(line: Buffer): boolean {
	try {
		const value = JSON.parse(line.toString("utf-8")) as { type?: unknown; message?: { role?: unknown } };
		return value.type === "message" && (value.message?.role === "user" || value.message?.role === "assistant");
	} catch {
		return false;
	}
}
function boundaries(buffer: Buffer, absoluteStart: number): number[] {
	const found: number[] = [];
	let lineStart = absoluteStart === 0 ? 0 : buffer.indexOf(0x0a) + 1;
	if (lineStart === 0 && absoluteStart > 0) return found;
	while (lineStart < buffer.byteLength) {
		const newline = buffer.indexOf(0x0a, lineStart);
		if (newline < 0) break;
		if (isGroupBoundary(buffer.subarray(lineStart, newline))) found.push(absoluteStart + lineStart);
		lineStart = newline + 1;
	}
	return found;
}
function completeEnd(file: string, size: number): number {
	for (let cursor = size; cursor > 0; ) {
		const start = Math.max(0, cursor - SCAN_BYTES);
		const chunk = readFileRangeSync(file, start, cursor - start);
		const newline = chunk.lastIndexOf(0x0a);
		if (newline >= 0) return start + newline + 1;
		cursor = start;
	}
	return 0;
}
function alignedStart(file: string, candidate: number, end: number, maxGroups: number): number {
	let start = candidate;
	let buffer = readFileRangeSync(file, start, end - start);
	for (;;) {
		const found = boundaries(buffer, start);
		if (found.length > 0) return found[Math.max(0, found.length - maxGroups)];
		if (start === 0) return 0;
		const previous = Math.max(0, start - SCAN_BYTES);
		buffer = Buffer.concat([readFileRangeSync(file, previous, start - previous), buffer]);
		start = previous;
	}
}
function readWindow(file: string, start: number, end: number): TranscriptFileWindow {
	return { start, end, text: readFileRangeSync(file, start, end - start).toString("utf-8") };
}
export function readTranscriptTail(
	file: string,
	size: number,
	softBytes: number,
	maxGroups: number,
): TranscriptFileWindow {
	const end = completeEnd(file, size);
	if (end === 0) return { start: 0, end: 0, text: "" };
	return readWindow(file, alignedStart(file, Math.max(0, end - softBytes), end, maxGroups), end);
}
export function readTranscriptBefore(
	file: string,
	end: number,
	softBytes: number,
	maxGroups: number,
): TranscriptFileWindow {
	if (end <= 0) return { start: 0, end: 0, text: "" };
	return readWindow(file, alignedStart(file, Math.max(0, end - softBytes), end, maxGroups), end);
}
export function readTranscriptAfter(
	file: string,
	start: number,
	size: number,
	softBytes: number,
	maxGroups: number,
): TranscriptFileWindow {
	const finalEnd = completeEnd(file, size);
	if (start >= finalEnd) return { start: finalEnd, end: finalEnd, text: "" };
	let end = Math.min(finalEnd, start + SCAN_BYTES);
	for (;;) {
		const buffer = readFileRangeSync(file, start, end - start);
		const found = boundaries(buffer, start).filter(offset => offset > start);
		const groupEnd = found[maxGroups - 1];
		const byteEnd = found.find(offset => offset - start >= softBytes);
		const boundary =
			groupEnd === undefined ? byteEnd : byteEnd === undefined ? groupEnd : Math.min(groupEnd, byteEnd);
		if (boundary !== undefined) return readWindow(file, start, boundary);
		if (end === finalEnd) return readWindow(file, start, finalEnd);
		end = Math.min(finalEnd, end + SCAN_BYTES);
	}
}
