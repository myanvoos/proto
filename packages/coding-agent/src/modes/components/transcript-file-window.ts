import * as fs from "node:fs";

const SCAN_BYTES = 64 * 1024;

/** An omitted record/group keeps its disk interval, but never its oversized payload. */
export interface TranscriptFileRecord {
	start: number;
	end: number;
	text?: string;
}

export interface TranscriptFileWindow {
	start: number;
	end: number;
	records: TranscriptFileRecord[];
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

/** Tool results stay with their assistant. An oversized opaque row is an omitted boundary. */
function classifyRecord(record: TranscriptFileRecord): { boundary: boolean; renderUnits: number } {
	if (record.text === undefined) return { boundary: true, renderUnits: 1 };
	try {
		const value = JSON.parse(record.text) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		const assistant = value.type === "message" && value.message?.role === "assistant";
		return {
			boundary: value.type === "message" && (value.message?.role === "user" || assistant),
			// A tool call can add a card and a following assistant segment even if its JSON is tiny.
			renderUnits: assistant && Array.isArray(value.message?.content) ? 1 + value.message.content.length * 2 : 1,
		};
	} catch {
		return { boundary: false, renderUnits: 1 };
	}
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

/** Scan fixed-size chunks; even one enormous JSONL row never allocates its full span. */
function* readRecords(
	file: string,
	start: number,
	end: number,
	maxBytes: number,
	reverse: boolean,
): Generator<TranscriptFileRecord> {
	let parts: Buffer[] = [];
	let recordEdge = reverse ? end : start;
	let cursor = reverse ? end : start;
	while (reverse ? cursor > start : cursor < end) {
		const chunkStart = reverse ? Math.max(start, cursor - SCAN_BYTES) : cursor;
		const chunkEnd = reverse ? cursor : Math.min(end, cursor + SCAN_BYTES);
		const chunk = readFileRangeSync(file, chunkStart, chunkEnd - chunkStart);
		if (reverse) {
			let right = chunk.length;
			for (let index = chunk.length - 1; index >= 0; index--) {
				if (chunk[index] !== 0x0a || chunkStart + index + 1 === recordEdge) continue;
				const left = index + 1;
				const recordStart = chunkStart + left;
				if (recordEdge - recordStart <= maxBytes) parts.push(chunk.subarray(left, right));
				yield {
					start: recordStart,
					end: recordEdge,
					text:
						recordEdge - recordStart <= maxBytes ? Buffer.concat(parts.reverse()).toString("utf-8") : undefined,
				};
				parts = [];
				recordEdge = recordStart;
				right = left;
			}
			if (recordEdge - chunkStart <= maxBytes) parts.push(chunk.subarray(0, right));
			else parts = [];
			cursor = chunkStart;
		} else {
			let left = 0;
			for (let index = 0; index < chunk.length; index++) {
				if (chunk[index] !== 0x0a) continue;
				const recordEnd = chunkStart + index + 1;
				if (recordEnd - recordEdge <= maxBytes) parts.push(chunk.subarray(left, index + 1));
				yield {
					start: recordEdge,
					end: recordEnd,
					text: recordEnd - recordEdge <= maxBytes ? Buffer.concat(parts).toString("utf-8") : undefined,
				};
				parts = [];
				recordEdge = recordEnd;
				left = index + 1;
			}
			if (chunkEnd - recordEdge <= maxBytes) parts.push(chunk.subarray(left));
			else parts = [];
			cursor = chunkEnd;
		}
	}
	if (reverse && recordEdge > start) {
		yield {
			start,
			end: recordEdge,
			text: recordEdge - start <= maxBytes ? Buffer.concat(parts.reverse()).toString("utf-8") : undefined,
		};
	}
}

interface RecordGroup {
	renderUnits: number;
	start: number;
	end: number;
	records: TranscriptFileRecord[];
}

function* readGroups(
	file: string,
	start: number,
	end: number,
	maxBytes: number,
	maxRecords: number,
	reverse: boolean,
): Generator<RecordGroup> {
	let group: RecordGroup | undefined;
	let omitted = false;
	for (const record of readRecords(file, start, end, maxBytes, reverse)) {
		const { boundary, renderUnits } = classifyRecord(record);
		if (!reverse && boundary && group) {
			yield group;
			group = undefined;
		}
		if (!group) {
			group = { start: record.start, end: record.end, records: [], renderUnits: 0 };
			omitted = false;
		}
		group.start = Math.min(group.start, record.start);
		group.end = Math.max(group.end, record.end);
		group.renderUnits += renderUnits;
		omitted ||=
			record.text === undefined ||
			group.end - group.start > maxBytes ||
			group.records.length >= maxRecords ||
			group.renderUnits > maxRecords * 2;
		if (omitted) group.records = [{ start: group.start, end: group.end }];
		else if (reverse) group.records.unshift(record);
		else group.records.push(record);
		if (reverse && boundary) {
			yield group;
			group = undefined;
		}
	}
	if (group) yield group;
}

function readWindow(
	file: string,
	start: number,
	end: number,
	maxBytes: number,
	maxGroups: number,
	reverse: boolean,
): TranscriptFileWindow {
	const groups: RecordGroup[] = [];
	let bytes = 0;
	let recordCount = 0;
	let renderUnits = 0;
	const maxRecords = maxGroups * 2;
	for (const group of readGroups(file, start, end, maxBytes, maxRecords, reverse)) {
		const size = group.end - group.start;
		if (
			groups.length > 0 &&
			(bytes + size > maxBytes ||
				recordCount + group.records.length > maxRecords ||
				renderUnits + group.renderUnits > maxRecords * 2)
		)
			break;
		if (reverse) groups.unshift(group);
		else groups.push(group);
		bytes += size;
		recordCount += group.records.length;
		renderUnits += group.renderUnits;
		if (groups.length >= maxGroups || bytes >= maxBytes || recordCount >= maxRecords) break;
	}
	return {
		start: groups[0]?.start ?? end,
		end: groups.at(-1)?.end ?? end,
		records: groups.flatMap(group => group.records),
	};
}

export function readTranscriptTail(
	file: string,
	size: number,
	maxBytes: number,
	maxGroups: number,
): TranscriptFileWindow {
	return readWindow(file, 0, completeEnd(file, size), maxBytes, maxGroups, true);
}

export function readTranscriptBefore(
	file: string,
	end: number,
	maxBytes: number,
	maxGroups: number,
): TranscriptFileWindow {
	return readWindow(file, 0, end, maxBytes, maxGroups, true);
}

export function readTranscriptAfter(
	file: string,
	start: number,
	size: number,
	maxBytes: number,
	maxGroups: number,
): TranscriptFileWindow {
	return readWindow(file, start, completeEnd(file, size), maxBytes, maxGroups, false);
}
