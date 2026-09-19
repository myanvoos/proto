import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { materializeString, sanitizeText, truncateHeadBytes, truncateTailBytes } from "@oh-my-pi/pi-utils";
import { formatBytes } from "../tools/render-utils";
import {
	isSixelPassthroughEnabled,
	sanitizeWithOptionalSixelPassthrough,
	splitIncompleteSixelTail,
	splitSixelSequences,
} from "../utils/sixel";
import type { ExecutionCollectorMetadata, ExecutionOutputDisposition } from "./execution-metadata";

export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_COLUMN = 512;

const ARTIFACT_DEFAULT_MAX_BYTES = 0;

const ARTIFACT_DEFAULT_HEAD_BYTES = 3 * 1024 * 1024;

const NL = "\n";
const CR = "\r";
const ELLIPSIS = "…";

const MAX_ACTIONABLE_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_ACTIONABLE_DIAGNOSTIC_LINE_BYTES = MAX_ACTIONABLE_DIAGNOSTIC_BYTES - 1;
const MAX_HELD_SIXEL_BYTES = 64 * 1024;

function isActionableDiagnostic(line: string): boolean {
	if (!line.trim()) return false;
	return (
		/(?:^|[\s[(<{])(?:error|warning|fatal|panic|exception|assert(?:ion)?|failed|failure|traceback)(?:\b|:)/iu.test(
			line,
		) || /(?:^|[\s[(<{])[^\s:]+:\d+(?::\d+)?(?:[:\s]|$)/u.test(line)
	);
}
export interface OutputSummary {
	output: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;

	elidedBytes?: number;

	elidedLines?: number;

	columnDroppedBytes?: number;

	columnTruncatedLines?: number;

	columnMax?: number;

	artifactId?: string;

	/** Collector status is independent from the child process status. */
	collector?: ExecutionCollectorMetadata;
	outputDisposition?: ExecutionOutputDisposition;
	summarized?: boolean;
	actionableDiagnostics?: string[];
}

export interface OutputSinkOptions {
	artifactPath?: string;
	artifactId?: string;

	spillThreshold?: number;

	headBytes?: number;

	maxColumns?: number;
	onChunk?: (chunk: string) => void;

	chunkThrottleMs?: number;

	artifactMaxBytes?: number;

	artifactHeadBytes?: number;
}

export interface TruncationResult {
	content: string;
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines?: number;
	outputBytes?: number;

	elidedBytes?: number;

	elidedLines?: number;
	lastLinePartial?: boolean;
	firstLineExceedsLimit?: boolean;
}

export interface TruncationOptions {
	maxLines?: number;

	maxBytes?: number;

	maxHeadBytes?: number;

	maxHeadLines?: number;
}

interface TailTruncationNoticeOptions {
	fullOutputPath?: string;
	originalContent?: string;
	suffix?: string;
}

interface HeadTruncationNoticeOptions {
	startLine?: number;
	totalFileLines?: number;
}

function countNewlines(text: string): number {
	let count = 0;
	let pos = text.indexOf(NL);
	while (pos !== -1) {
		count++;
		pos = text.indexOf(NL, pos + 1);
	}
	return count;
}

export function truncateLine(
	line: string,
	maxChars: number = DEFAULT_MAX_COLUMN,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: materializeString(`${line.slice(0, maxChars)}…`), wasTruncated: true };
}

export function noTruncResult(content: string, totalLines?: number, totalBytes?: number): TruncationResult {
	if (totalLines == null) totalLines = countNewlines(content) + 1;
	if (totalBytes == null) totalBytes = Buffer.byteLength(content, "utf-8");
	return { content, totalLines, totalBytes };
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let cutIndex = 0;
	let cursor = 0;

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.indexOf(NL, cursor);
		const lineEnd = nl === -1 ? content.length : nl;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		const lineCodeUnits = lineEnd - cursor;
		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		const lineText = content.slice(cursor, lineEnd);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		bytesUsed += sepBytes + lineBytes;
		includedLines++;

		cutIndex = nl === -1 ? content.length : nl;
		if (nl === -1) break;
		cursor = nl + 1;
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: materializeString(content.slice(0, cutIndex)),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/**
 * Accumulates text while retaining only the most recent `maxBytes`, so a producer that never stops cannot
 * grow the heap without bound. Callers that only ever need a truncated tail should push here instead of
 * collecting every chunk and truncating at the end.
 */
export class TailAccumulator {
	#chunks: string[] = [];
	#bytes = 0;
	#droppedBytes = 0;

	constructor(readonly maxBytes: number) {}

	push(text: string): void {
		if (text.length === 0) return;
		this.#chunks.push(text);
		this.#bytes += Buffer.byteLength(text, "utf-8");
		while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
			const removed = this.#chunks.shift()!;
			const removedBytes = Buffer.byteLength(removed, "utf-8");
			this.#bytes -= removedBytes;
			this.#droppedBytes += removedBytes;
		}
	}

	/** Bytes discarded from the head because the retained window was full. */
	get droppedBytes(): number {
		return this.#droppedBytes;
	}

	get isEmpty(): boolean {
		return this.#chunks.length === 0;
	}

	text(): string {
		return this.#chunks.join("");
	}

	clear(): void {
		this.#chunks = [];
		this.#bytes = 0;
	}
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let startIndex = content.length;
	let end = content.length;

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.lastIndexOf(NL, end - 1);
		const lineStart = nl === -1 ? 0 : nl + 1;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		const lineCodeUnits = end - lineStart;

		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				const windowStart = Math.max(lineStart, end - maxBytes);
				const window = content.substring(windowStart, end);
				const tail = truncateTailBytes(window, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
				};
			}
			break;
		}

		const lineText = content.slice(lineStart, end);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				const tail = truncateTailBytes(lineText, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
				};
			}
			break;
		}

		bytesUsed += sepBytes + lineBytes;
		includedLines++;
		startIndex = lineStart;

		if (nl === -1) break;
		end = nl;
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: materializeString(content.slice(startIndex)),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

export function formatMiddleElisionMarker(elidedLines: number, elidedBytes: number): string {
	if (elidedLines <= 1) return `[…${elidedBytes}B elided…]`;
	return `[…${elidedLines}ln elided…]`;
}

export function truncateMiddle(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const headBytes = options.maxHeadBytes ?? Math.floor(maxBytes / 2);
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const headLines = options.maxHeadLines ?? Math.max(1, Math.floor(maxLines / 2));
	const tailLines = Math.max(0, maxLines - headLines);

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	if (headBytes <= 0 || headLines <= 0) {
		return truncateTail(content, { maxBytes: tailBytes || maxBytes, maxLines: tailLines || maxLines });
	}
	if (tailBytes <= 0 || tailLines <= 0) {
		return truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	}

	const head = truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	const tail = truncateTail(content, { maxBytes: tailBytes, maxLines: tailLines });

	const headLinesKept = head.outputLines ?? 0;
	const tailLinesKept = tail.outputLines ?? 0;
	const headBytesKept = head.outputBytes ?? Buffer.byteLength(head.content, "utf-8");
	const tailBytesKept = tail.outputBytes ?? Buffer.byteLength(tail.content, "utf-8");

	if (headLinesKept === 0 || head.firstLineExceedsLimit) return tail;

	if (tailLinesKept === 0) return head;

	if (headLinesKept + tailLinesKept >= totalLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	const elidedLines = totalLines - headLinesKept - tailLinesKept;

	const elidedBytes = Math.max(0, totalBytes - headBytesKept - tailBytesKept);
	const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
	const composed = `${head.content}\n${marker}\n${tail.content}`;
	const markerBytes = Buffer.byteLength(marker, "utf-8");

	return {
		content: composed,
		truncated: true,
		truncatedBy: "middle",
		totalLines,
		totalBytes,
		outputLines: headLinesKept + tailLinesKept + 1,
		outputBytes: headBytesKept + tailBytesKept + markerBytes + 2,
		elidedLines,
		elidedBytes,
		lastLinePartial: tail.lastLinePartial,
		firstLineExceedsLimit: false,
	};
}

interface InlineByteCapOptions {
	maxBytes?: number;

	saveArtifact?: (full: string) => string | undefined | Promise<string | undefined>;
}

function trimHeadToLineBoundary(text: string): string {
	const idx = text.lastIndexOf(NL);
	return idx > 0 ? text.substring(0, idx) : text;
}

function trimTailToLineBoundary(text: string): string {
	const idx = text.indexOf(NL);
	if (idx < 0 || idx === text.length - 1) return text;
	return text.substring(idx + 1);
}

export async function enforceInlineByteCap(text: string, options: InlineByteCapOptions): Promise<string> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (maxBytes <= 0) return text;
	const totalBytes = Buffer.byteLength(text, "utf-8");
	if (totalBytes <= maxBytes) return text;

	const head = trimHeadToLineBoundary(truncateHeadBytes(text, Math.floor(maxBytes * 0.6)).text);
	const tail = trimTailToLineBoundary(truncateTailBytes(text, Math.floor(maxBytes * 0.25)).text);
	const elidedBytes = Math.max(0, totalBytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8"));
	const marker = `[…${elidedBytes}B elided…]`;
	let composed = `${head}\n${marker}\n${tail}`;

	const artifactId = await options.saveArtifact?.(text);
	if (artifactId) {
		const sep = composed.endsWith(NL) ? "" : NL;
		composed += `${sep}[raw output: artifact://${artifactId}]`;
	}
	return composed;
}

const MAX_PENDING = 10;

export class TailBuffer {
	#pending: string[] = [];
	#pos = 0;

	constructor(readonly maxBytes: number) {}

	append(text: string): void {
		if (!text) return;

		const max = this.maxBytes;
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}

		const n = Buffer.byteLength(text, "utf-8");

		if (n >= max) {
			const { text: t, bytes } = truncateTailBytes(text, max);
			this.#pending[0] = t;
			this.#pending.length = 1;
			this.#pos = bytes;
			return;
		}

		this.#pos += n;

		if (this.#pending.length === 0) {
			this.#pending[0] = text;
			this.#pending.length = 1;
		} else {
			this.#pending.push(text);
			if (this.#pending.length > MAX_PENDING) this.#compact();
		}

		if (this.#pos > max * 2) this.#trimTo(max);
	}

	text(): string {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#flush();
	}

	bytes(): number {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#pos;
	}

	#compact(): void {
		this.#pending[0] = this.#pending.join("");
		this.#pending.length = 1;
	}

	#flush(): string {
		if (this.#pending.length === 0) return "";
		if (this.#pending.length > 1) this.#compact();
		return this.#pending[0];
	}

	#trimTo(max: number): void {
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}
		if (this.#pos <= max) return;

		const joined = this.#flush();
		const { text, bytes } = truncateTailBytes(joined, max);
		this.#pos = bytes;
		this.#pending[0] = text;
		this.#pending.length = 1;
	}
}

interface BufferedChunk {
	text: string;
	bytes: number;
}

class ByteChunkDeque {
	#chunks: Array<BufferedChunk | undefined> = [];
	#start = 0;
	#size = 0;
	#bytes = 0;

	get bytes(): number {
		return this.#bytes;
	}

	get isEmpty(): boolean {
		return this.#size === 0;
	}

	append(text: string, bytes: number): void {
		if (text.length === 0) return;
		if (this.#size === this.#chunks.length) this.#grow();
		const index = (this.#start + this.#size) % this.#chunks.length;
		this.#chunks[index] = { text, bytes };
		this.#size++;
		this.#bytes += bytes;
	}

	replace(text: string, bytes: number): void {
		this.clear();
		this.append(text, bytes);
	}

	clear(): void {
		for (let offset = 0; offset < this.#size; offset++) {
			this.#chunks[(this.#start + offset) % this.#chunks.length] = undefined;
		}
		this.#start = 0;
		this.#size = 0;
		this.#bytes = 0;
	}

	trimStart(maxBytes: number): void {
		if (maxBytes <= 0) {
			this.clear();
			return;
		}
		if (this.#bytes <= maxBytes) return;

		let bytesToDrop = this.#bytes - maxBytes;
		while (this.#size > 0) {
			const first = this.#first();
			if (first.bytes <= bytesToDrop) {
				bytesToDrop -= first.bytes;
				this.#removeFirst();
				if (bytesToDrop === 0) return;
				continue;
			}

			const retained = truncateTailBytes(first.text, first.bytes - bytesToDrop);
			if (retained.bytes === 0) {
				this.#removeFirst();
				return;
			}
			this.#chunks[this.#start] = retained;
			this.#bytes += retained.bytes - first.bytes;
			return;
		}
	}

	materialize(): string {
		if (this.#size === 0) return "";
		if (this.#size === 1) return this.#first().text;
		const parts = new Array<string>(this.#size);
		for (let offset = 0; offset < this.#size; offset++) {
			parts[offset] = this.#chunks[(this.#start + offset) % this.#chunks.length]!.text;
		}
		return parts.join("");
	}

	startsWith(prefix: string): boolean {
		return this.#size > 0 && this.#first().text.startsWith(prefix);
	}

	endsWith(suffix: string): boolean {
		return this.#size > 0 && this.#last().text.endsWith(suffix);
	}

	#first(): BufferedChunk {
		return this.#chunks[this.#start]!;
	}

	#last(): BufferedChunk {
		return this.#chunks[(this.#start + this.#size - 1) % this.#chunks.length]!;
	}

	#removeFirst(): void {
		const first = this.#first();
		this.#chunks[this.#start] = undefined;
		this.#bytes -= first.bytes;
		this.#size--;
		this.#start = this.#size === 0 ? 0 : (this.#start + 1) % this.#chunks.length;
	}

	#grow(): void {
		const chunks = new Array<BufferedChunk | undefined>(Math.max(16, this.#chunks.length * 2));
		for (let offset = 0; offset < this.#size; offset++) {
			chunks[offset] = this.#chunks[(this.#start + offset) % this.#chunks.length];
		}
		this.#chunks = chunks;
		this.#start = 0;
	}
}

export class OutputSink {
	readonly #buffer = new ByteChunkDeque();
	readonly #head = new ByteChunkDeque();
	#headLines = 0;
	#headRetentionDisabled = false;
	#totalLines = 0;
	#totalBytes = 0;
	#sawData = false;
	#truncated = false;
	#summarized = false;
	#collectorError: string | undefined;
	#diagnosticPending = "";
	#diagnosticPendingBytes = 0;
	#diagnosticSkippingOversized = false;
	#actionableDiagnostics: string[] = [];
	#actionableDiagnosticBytes = 0;
	#lastChunkTime = 0;
	#pendingChunk = "";
	#pendingCarriageReturn = false;
	#pendingChunkTimer: Timer | undefined;

	#currentLineBytes = 0;
	#columnEllipsisAdded = false;
	#columnDroppedBytes = 0;
	#columnTruncatedLines = 0;
	#file?: {
		path: string;
		artifactId?: string;
		sink: Bun.FileSink;
	};

	#pendingFileWrites?: string[];
	#fileReady = false;

	#fileCreation?: Promise<void>;

	#finalized = false;
	// A trailing incomplete sixel envelope held back until the next push
	// completes it (only while sixel passthrough is enabled).
	#heldSixelTail = "";
	// Bytes already included in #totalBytes while the held tail was pending.
	#heldSixelAccountedBytes = 0;

	readonly #artifactPath?: string;
	readonly #artifactId?: string;
	readonly #spillThreshold: number;
	readonly #headLimit: number;
	readonly #onChunk?: (chunk: string) => void;
	readonly #chunkThrottleMs: number;
	readonly #maxColumns: number;

	readonly #artifactMaxBytes: number;
	readonly #artifactHeadBudget: number;
	readonly #artifactTailBudget: number;
	#artifactHeadBytesWritten = 0;
	#artifactHeadClosed = false;
	readonly #artifactTailRing = new ByteChunkDeque();
	#artifactTailIncomingBytes = 0;

	constructor(options?: OutputSinkOptions) {
		const {
			artifactPath,
			artifactId,
			spillThreshold = DEFAULT_MAX_BYTES,
			headBytes = 0,
			maxColumns = 0,
			onChunk,
			chunkThrottleMs = 0,
			artifactMaxBytes = ARTIFACT_DEFAULT_MAX_BYTES,
			artifactHeadBytes = ARTIFACT_DEFAULT_HEAD_BYTES,
		} = options ?? {};
		this.#artifactPath = artifactPath;
		this.#artifactId = artifactId;
		this.#spillThreshold = spillThreshold;
		this.#headLimit = Math.max(0, Math.min(headBytes, Math.floor(spillThreshold / 2)));
		this.#maxColumns = Math.max(0, maxColumns);
		this.#onChunk = onChunk;
		this.#chunkThrottleMs = chunkThrottleMs;
		this.#artifactMaxBytes = Math.max(0, artifactMaxBytes);
		this.#artifactHeadBudget = Math.max(0, Math.min(artifactHeadBytes, this.#artifactMaxBytes));
		this.#artifactTailBudget = Math.max(0, this.#artifactMaxBytes - this.#artifactHeadBudget);
	}

	#markCollectorFailure(error: unknown): void {
		if (this.#collectorError !== undefined) return;
		this.#collectorError = error instanceof Error ? error.message : String(error);
	}

	#collectActionableDiagnostics(chunk: string): void {
		if (!chunk) return;

		let cursor = 0;
		while (cursor < chunk.length) {
			if (this.#diagnosticSkippingOversized) {
				const newline = chunk.indexOf(NL, cursor);
				if (newline === -1) return;
				this.#diagnosticSkippingOversized = false;
				cursor = newline + 1;
				continue;
			}

			const newline = chunk.indexOf(NL, cursor);
			const lineEnd = newline === -1 ? chunk.length : newline;
			const segment = chunk.substring(cursor, lineEnd);
			const segmentBytes = Buffer.byteLength(segment, "utf-8");
			const lineBytes = this.#diagnosticPendingBytes + segmentBytes;
			if (lineBytes > MAX_ACTIONABLE_DIAGNOSTIC_LINE_BYTES) {
				this.#diagnosticPending = "";
				this.#diagnosticPendingBytes = 0;
				if (newline === -1) this.#diagnosticSkippingOversized = true;
			} else {
				if (segment.length > 0) {
					this.#diagnosticPending += segment;
					this.#diagnosticPendingBytes = lineBytes;
				}
				if (newline !== -1) {
					this.#rememberActionableDiagnostic(this.#diagnosticPending);
					this.#diagnosticPending = "";
					this.#diagnosticPendingBytes = 0;
				}
			}

			if (newline === -1) return;
			cursor = newline + 1;
		}
	}

	#rememberActionableDiagnostic(line: string): void {
		if (!isActionableDiagnostic(line) || this.#actionableDiagnostics.includes(line)) return;
		const bytes = Buffer.byteLength(line, "utf-8") + 1;
		if (bytes > MAX_ACTIONABLE_DIAGNOSTIC_BYTES) return;
		while (
			this.#actionableDiagnosticBytes + bytes > MAX_ACTIONABLE_DIAGNOSTIC_BYTES &&
			this.#actionableDiagnostics.length > 0
		) {
			const removed = this.#actionableDiagnostics.shift()!;
			this.#actionableDiagnosticBytes -= Buffer.byteLength(removed, "utf-8") + 1;
		}
		this.#actionableDiagnostics.push(line);
		this.#actionableDiagnosticBytes += bytes;
	}

	#finishActionableDiagnostics(): void {
		if (this.#diagnosticPending) {
			this.#rememberActionableDiagnostic(this.#diagnosticPending);
			this.#diagnosticPending = "";
		}
		this.#diagnosticPendingBytes = 0;
		this.#diagnosticSkippingOversized = false;
	}

	#collector(): ExecutionCollectorMetadata {
		if (this.#collectorError !== undefined) return { state: "failed", error: this.#collectorError };
		return { state: this.#finalized ? "complete" : "running" };
	}

	collectorStatus(): ExecutionCollectorMetadata {
		return this.#collector();
	}

	#summaryDisposition(outputBytes: number): ExecutionOutputDisposition {
		if (this.#totalBytes > 0 && outputBytes === 0 && this.#collectorError !== undefined) return "unavailable";
		if (this.#truncated) return "truncated";
		if (this.#summarized) return "summarized";
		return "complete";
	}
	#normalizeCarriageReturns(text: string): string {
		if (text.length === 0 || (!this.#pendingCarriageReturn && !text.includes(CR))) return text;

		let cursor = 0;
		let normalized = "";
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			normalized = NL;
			if (text.startsWith(NL)) cursor = 1;
		}

		while (cursor < text.length) {
			const carriageReturn = text.indexOf(CR, cursor);
			if (carriageReturn === -1) {
				normalized += text.substring(cursor);
				break;
			}
			normalized += text.substring(cursor, carriageReturn);
			if (carriageReturn === text.length - 1) {
				this.#pendingCarriageReturn = true;
				break;
			}
			normalized += NL;
			cursor = text.startsWith(NL, carriageReturn + 1) ? carriageReturn + 2 : carriageReturn + 1;
		}
		return normalized;
	}

	push(chunk: string): void {
		if (this.#finalized) return;
		if (isSixelPassthroughEnabled()) {
			const previousHeld = this.#heldSixelTail;
			const previousHeldBytes = this.#heldSixelAccountedBytes;
			const combined = previousHeld + chunk;
			const split = splitIncompleteSixelTail(combined);
			const accountedPrefixBytes =
				previousHeld.length > 0 && split.text.startsWith(previousHeld) ? previousHeldBytes : 0;
			if (split.text.length > 0) {
				this.#pushChunk(split.text, true, false, false, accountedPrefixBytes);
			}

			const heldText = split.heldTail;
			const heldStart = combined.length - heldText.length;
			const oldHeldOverlapLength = Math.max(0, Math.min(heldText.length, previousHeld.length - heldStart));
			const oldHeldOverlapBytes =
				oldHeldOverlapLength > 0 ? Buffer.byteLength(heldText.slice(0, oldHeldOverlapLength), "utf-8") : 0;
			const newlyHeldBytes = Math.max(
				0,
				Buffer.byteLength(heldText, "utf-8") - Math.min(previousHeldBytes, oldHeldOverlapBytes),
			);
			const isSixelTail = heldText.startsWith("\x1bP") || previousHeldBytes > 0;
			if (isSixelTail && newlyHeldBytes > 0) this.#totalBytes += newlyHeldBytes;

			const heldBytes = Buffer.byteLength(heldText, "utf-8");
			const holdLimit = this.#maxHeldSixelBytes();
			if (heldBytes > holdLimit) this.#truncated = true;
			if (heldBytes > Math.max(0, this.#spillThreshold - this.#head.bytes - this.#buffer.bytes)) {
				this.#truncated = true;
			}
			if (heldBytes > holdLimit) {
				this.#heldSixelTail = truncateTailBytes(heldText, holdLimit).text;
			} else {
				this.#heldSixelTail = heldText;
			}
			this.#heldSixelAccountedBytes = isSixelTail ? Buffer.byteLength(this.#heldSixelTail, "utf-8") : 0;
			return;
		}
		this.#pushChunk(chunk, true);
	}
	#maxHeldSixelBytes(): number {
		if (this.#spillThreshold <= 0) return MAX_HELD_SIXEL_BYTES;
		return Math.max(1, Math.min(MAX_HELD_SIXEL_BYTES, this.#spillThreshold));
	}

	#flushHeldSixelTail(): void {
		if (this.#heldSixelTail.length === 0) return;
		const held = this.#heldSixelTail;
		const accountedBytes = this.#heldSixelAccountedBytes;
		this.#heldSixelTail = "";
		this.#heldSixelAccountedBytes = 0;
		// A sixel tail is intentionally materialized at EOF. Preserve a DCS
		// prefix verbatim; a lone speculative ESC still goes through normal
		// sanitization instead of leaking an arbitrary control byte.
		const normalizedHeld = held.startsWith("\x1bP") ? held.replace(/\r\n?/gu, "\n") : held;
		this.#pushChunk(normalizedHeld, true, held.startsWith("\x1bP"), held.startsWith("\x1bP"), accountedBytes);
	}

	#pushChunk(
		chunk: string,
		accountTotals: boolean,
		preserveRaw = false,
		atomicSixel = false,
		accountedBytes = 0,
	): void {
		if (!preserveRaw) {
			chunk = sanitizeWithOptionalSixelPassthrough(chunk, text =>
				sanitizeText(this.#normalizeCarriageReturns(text)),
			);
		}
		this.#collectActionableDiagnostics(chunk);

		if (this.#onChunk) {
			const now = Date.now();
			if (now - this.#lastChunkTime >= this.#chunkThrottleMs) {
				this.#emitPendingChunkWith(chunk, now);
			} else {
				this.#pendingChunk += chunk;
				this.#schedulePendingChunkFlush();
			}
		}

		const rawBytes = Buffer.byteLength(chunk, "utf-8");
		if (accountTotals) this.#totalBytes = Math.max(0, this.#totalBytes + rawBytes - accountedBytes);

		if (chunk.length > 0) {
			this.#sawData = true;
			if (accountTotals) this.#totalLines += countNewlines(chunk);
		}

		const capped = this.#maxColumns > 0 && !atomicSixel ? this.#applyColumnCap(chunk) : chunk;
		const cappedBytes = capped === chunk ? rawBytes : Buffer.byteLength(capped, "utf-8");
		const cappedThisChunk = cappedBytes < rawBytes;
		if (cappedThisChunk) this.#truncated = true;

		const forcedHeldSpill = accountedBytes > 0 && this.#truncated;
		if (
			this.#artifactPath &&
			(this.#file != null || cappedThisChunk || this.#willOverflow(cappedBytes) || forcedHeldSpill)
		) {
			this.#writeToFile(chunk);
		}

		if (cappedBytes === 0) return;

		let tailChunk = capped;
		let tailBytes = cappedBytes;
		if (this.#headLimit > 0 && !this.#headRetentionDisabled && this.#head.bytes < this.#headLimit) {
			const room = this.#headLimit - this.#head.bytes;
			if (cappedBytes <= room) {
				this.#head.append(capped, cappedBytes);
				this.#headLines += countNewlines(capped);
				return;
			}

			const headSlice = truncateHeadBytes(capped, room);
			if (headSlice.bytes > 0) {
				this.#head.append(headSlice.text, headSlice.bytes);
				this.#headLines += countNewlines(headSlice.text);
				tailChunk = capped.substring(headSlice.text.length);
				tailBytes = cappedBytes - headSlice.bytes;
			}
		}

		this.#pushTail(tailChunk, tailBytes);
	}
	#applyColumnCap(chunk: string): string {
		if (chunk.length === 0) return chunk;
		const max = this.#maxColumns;
		const parts: string[] = [];
		const applyText = (text: string): void => {
			let cursor = 0;
			while (cursor < text.length) {
				const nlIdx = text.indexOf(NL, cursor);
				const segEnd = nlIdx === -1 ? text.length : nlIdx;
				if (segEnd > cursor) {
					const segment = text.substring(cursor, segEnd);
					if (this.#columnEllipsisAdded) {
						this.#columnDroppedBytes += Buffer.byteLength(segment, "utf-8");
					} else {
						const segBytes = Buffer.byteLength(segment, "utf-8");
						const remaining = max - this.#currentLineBytes;
						if (segBytes <= remaining) {
							parts.push(segment);
							this.#currentLineBytes += segBytes;
						} else {
							const ellipsisBytes = 3;
							const headRoom = Math.max(0, remaining - ellipsisBytes);
							let kept = "";
							let keptBytes = 0;
							if (headRoom > 0) {
								const sliced = truncateHeadBytes(segment, headRoom);
								kept = sliced.text;
								keptBytes = sliced.bytes;
								parts.push(kept);
							}
							parts.push(ELLIPSIS);
							this.#columnDroppedBytes += segBytes - keptBytes;
							this.#columnTruncatedLines++;
							this.#currentLineBytes += keptBytes + ellipsisBytes;
							this.#columnEllipsisAdded = true;
						}
					}
				}
				if (nlIdx === -1) break;
				parts.push(NL);
				this.#currentLineBytes = 0;
				this.#columnEllipsisAdded = false;
				cursor = nlIdx + 1;
			}
		};

		for (const part of splitSixelSequences(chunk)) {
			if (!part.isSixel) {
				applyText(part.text);
				continue;
			}
			// Sixel is a terminal control envelope, not line text. Keep it as
			// one atomic unit so a column cap can never leave an open DCS.
			if (this.#columnEllipsisAdded) {
				this.#columnDroppedBytes += Buffer.byteLength(part.text, "utf-8");
			} else {
				parts.push(part.text);
			}
		}
		return parts.join("");
	}
	#willOverflow(dataBytes: number): boolean {
		return this.#buffer.bytes + dataBytes > this.#spillThreshold - this.#head.bytes;
	}

	#pushTail(chunk: string, dataBytes: number): void {
		if (dataBytes === 0) return;

		const threshold = Math.max(0, this.#spillThreshold - this.#head.bytes);
		const willOverflow = this.#buffer.bytes + dataBytes > threshold;

		if (!willOverflow) {
			this.#buffer.append(chunk, dataBytes);
			return;
		}

		this.#truncated = true;

		if (dataBytes >= threshold) {
			const { text, bytes } = truncateTailBytes(chunk, threshold);
			this.#buffer.replace(text, bytes);
		} else {
			this.#buffer.append(chunk, dataBytes);
			this.#buffer.trimStart(threshold);
		}
	}

	#writeToFile(chunk: string): void {
		if (this.#fileReady && this.#file) {
			this.#emitToSink(chunk);
			return;
		}

		if (!this.#pendingFileWrites) {
			this.#pendingFileWrites = [chunk];
			this.#fileCreation = this.#createFileSink();
		} else {
			this.#pendingFileWrites.push(chunk);
		}
	}

	#writeArtifactChunk(chunk: string): boolean {
		if (!this.#file || chunk.length === 0) return true;
		try {
			this.#file.sink.write(chunk);
			return true;
		} catch (error) {
			this.#markCollectorFailure(error);
			return false;
		}
	}

	#emitToSink(chunk: string): void {
		if (!this.#file || chunk.length === 0) return;
		if (this.#artifactMaxBytes === 0) {
			this.#writeArtifactChunk(chunk);
			return;
		}
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		const room = this.#artifactHeadClosed ? 0 : this.#artifactHeadBudget - this.#artifactHeadBytesWritten;
		if (room >= chunkBytes) {
			this.#writeArtifactChunk(chunk);
			this.#artifactHeadBytesWritten += chunkBytes;
			return;
		}
		let overflow = chunk;
		if (room > 0) {
			const headSlice = truncateHeadBytes(chunk, room);
			if (headSlice.bytes > 0) {
				this.#writeArtifactChunk(headSlice.text);
				this.#artifactHeadBytesWritten += headSlice.bytes;
			}

			this.#artifactHeadClosed = true;
			overflow = chunk.substring(headSlice.text.length);
		}
		if (overflow.length === 0 || this.#artifactTailBudget === 0) {
			if (overflow.length > 0) {
				this.#artifactTailIncomingBytes += Buffer.byteLength(overflow, "utf-8");
			}
			return;
		}
		this.#pushArtifactTail(overflow);
	}

	#pushArtifactTail(chunk: string): void {
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		this.#artifactTailIncomingBytes += chunkBytes;
		const budget = this.#artifactTailBudget;
		if (chunkBytes >= budget) {
			const { text, bytes } = truncateTailBytes(chunk, budget);
			this.#artifactTailRing.replace(text, bytes);
			return;
		}
		this.#artifactTailRing.append(chunk, chunkBytes);
		this.#artifactTailRing.trimStart(budget);
	}

	async #createFileSink(): Promise<void> {
		if (!this.#artifactPath || this.#fileReady) return;
		try {
			const sink = Bun.file(this.#artifactPath).writer();
			this.#file = { path: this.#artifactPath, artifactId: this.#artifactId, sink };
			this.#fileReady = true;

			if (!this.#head.isEmpty) {
				this.#emitToSink(this.#head.materialize());
			}

			if (!this.#buffer.isEmpty) {
				this.#emitToSink(this.#buffer.materialize());
			}

			if (this.#pendingFileWrites) {
				for (const pending of this.#pendingFileWrites) {
					this.#emitToSink(pending);
				}
				this.#pendingFileWrites = undefined;
			}
		} catch (error) {
			this.#markCollectorFailure(error);
			try {
				await this.#file?.sink?.end();
			} catch (endError) {
				this.#markCollectorFailure(endError);
			}
			this.#file = undefined;
			this.#pendingFileWrites = undefined;
			this.#fileReady = false;
		}
	}

	createInput(): WritableStream<Uint8Array | string> {
		const dec = new TextDecoder("utf-8", { ignoreBOM: true });
		const finalize = () => {
			this.push(dec.decode());
		};
		return new WritableStream({
			write: chunk => {
				this.push(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }));
			},
			close: finalize,
			abort: finalize,
		});
	}

	replace(text: string, options?: { summarized?: boolean }): void {
		this.#clearPendingChunkTimer();
		const bytes = Buffer.byteLength(text, "utf-8");
		this.#buffer.replace(text, bytes);
		this.#head.clear();
		this.#headLines = 0;
		this.#headRetentionDisabled = true;
		this.#totalBytes = bytes;
		this.#totalLines = countNewlines(text);
		this.#sawData = text.length > 0;
		this.#truncated = false;
		this.#summarized = options?.summarized === true;
		this.#diagnosticPending = "";
		this.#diagnosticPendingBytes = 0;
		this.#diagnosticSkippingOversized = false;
		this.#actionableDiagnostics = [];
		this.#actionableDiagnosticBytes = 0;
		this.#currentLineBytes = 0;
		this.#columnEllipsisAdded = false;
		this.#columnDroppedBytes = 0;
		this.#columnTruncatedLines = 0;
		this.#pendingChunk = "";
		this.#pendingCarriageReturn = false;
		this.#heldSixelTail = "";
		this.#heldSixelAccountedBytes = 0;
	}

	#clearPendingChunkTimer(): void {
		if (!this.#pendingChunkTimer) return;
		clearTimeout(this.#pendingChunkTimer);
		this.#pendingChunkTimer = undefined;
	}

	#emitPendingChunkWith(chunk: string, now: number): void {
		this.#clearPendingChunkTimer();
		this.#lastChunkTime = now;
		const merged = this.#pendingChunk + chunk;
		this.#pendingChunk = "";
		try {
			this.#onChunk?.(merged);
		} catch (error) {
			// Rendering/progress observers must never change the child process result.
			this.#markCollectorFailure(error);
		}
	}

	#flushPendingChunk(): void {
		if (this.#pendingChunk.length === 0) {
			this.#clearPendingChunkTimer();
			return;
		}
		this.#emitPendingChunkWith("", Date.now());
	}

	#schedulePendingChunkFlush(): void {
		if (this.#chunkThrottleMs <= 0 || this.#pendingChunkTimer) return;
		const elapsed = Date.now() - this.#lastChunkTime;
		const delay = Math.max(0, this.#chunkThrottleMs - elapsed);
		this.#pendingChunkTimer = setTimeout(() => {
			this.#pendingChunkTimer = undefined;
			this.#flushPendingChunk();
		}, delay);
	}

	#flushArtifactTailIfCapped(): void {
		if (!this.#file) return;
		if (this.#artifactMaxBytes === 0) return;
		const tailBytes = this.#artifactTailRing.bytes;
		const droppedBytes = Math.max(0, this.#artifactTailIncomingBytes - tailBytes);
		if (tailBytes === 0 && droppedBytes === 0) return;

		if (droppedBytes > 0) {
			const headWritten = this.#artifactHeadBytesWritten;
			const totalCapped = headWritten + this.#artifactTailIncomingBytes;
			const headSep = headWritten > 0 ? "\n" : "";
			const tailSep = tailBytes > 0 && !this.#artifactTailRing.startsWith("\n") ? "\n" : "";
			const notice =
				`${headSep}[ARTIFACT TRUNCATED: kept first ${formatBytes(headWritten)} + last ${formatBytes(tailBytes)} ` +
				`of ${formatBytes(totalCapped)}; ${formatBytes(droppedBytes)} elided from the middle]${tailSep}`;
			this.#writeArtifactChunk(notice);
		}
		if (tailBytes > 0) {
			this.#writeArtifactChunk(this.#artifactTailRing.materialize());
		}
	}

	async dump(notice?: string): Promise<OutputSummary> {
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			this.#pushChunk(NL, true);
		}
		this.#flushHeldSixelTail();
		const noticeLine = notice ? `[${notice}]\n` : "";

		this.#flushPendingChunk();
		const totalLines = this.#sawData ? this.#totalLines + 1 : 0;

		await this.#finalizeFile();

		const headBuf = this.#head.materialize();
		const tailBuf = this.#buffer.materialize();
		const headBytes = this.#head.bytes;
		const tailBytes = this.#buffer.bytes;
		const headLines = this.#headLines + (headBytes > 0 && !this.#head.endsWith("\n") ? 1 : 0);
		const tailLines = tailBuf.length > 0 ? countNewlines(tailBuf) + 1 : 0;

		this.#finishActionableDiagnostics();
		const effectiveTotalBytes = Math.max(0, this.#totalBytes - this.#columnDroppedBytes);

		let body: string;
		let outputBytes: number;
		let outputLines: number;
		let elidedBytes: number | undefined;
		let elidedLines: number | undefined;

		if (headBytes > 0 && effectiveTotalBytes > headBytes + tailBytes) {
			elidedBytes = Math.max(0, effectiveTotalBytes - headBytes - tailBytes);
			elidedLines = Math.max(0, totalLines - headLines - tailLines);
			const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
			const markerBytes = Buffer.byteLength(marker, "utf-8");
			const headSep = this.#head.endsWith("\n") ? "" : "\n";
			const tailSep = tailBuf.startsWith("\n") ? "" : "\n";
			body = `${headBuf}${headSep}${marker}${tailSep}${tailBuf}`;
			outputBytes =
				headBytes +
				markerBytes +
				tailBytes +
				Buffer.byteLength(headSep, "utf-8") +
				Buffer.byteLength(tailSep, "utf-8");
			outputLines = headLines + 1 + tailLines;
			this.#truncated = true;
		} else if (headBytes > 0) {
			body = `${headBuf}${tailBuf}`;
			outputBytes = headBytes + tailBytes;
			outputLines = body.length > 0 ? countNewlines(body) + 1 : 0;
		} else {
			body = tailBuf;
			outputBytes = tailBytes;
			outputLines = tailLines;
		}

		const actionable = this.#actionableDiagnostics.filter(line => !body.includes(line));
		if (this.#truncated && actionable.length > 0) {
			const diagnosticSection = `[ACTIONABLE DIAGNOSTICS]\n${actionable.join("\n")}`;
			body = body.length > 0 ? `${body}\n${diagnosticSection}` : diagnosticSection;
			outputBytes = Buffer.byteLength(body, "utf-8");
			outputLines = countNewlines(body) + 1;
		}

		return {
			output: `${noticeLine}${body}`,
			truncated: this.#truncated,
			totalLines,
			totalBytes: this.#totalBytes,
			outputLines,
			outputBytes,
			elidedBytes,
			elidedLines,
			columnDroppedBytes: this.#columnDroppedBytes > 0 ? this.#columnDroppedBytes : undefined,
			columnTruncatedLines: this.#columnTruncatedLines > 0 ? this.#columnTruncatedLines : undefined,
			columnMax: this.#columnTruncatedLines > 0 ? this.#maxColumns : undefined,
			artifactId: this.#collectorError === undefined ? this.#file?.artifactId : undefined,
			collector: this.#collector(),
			outputDisposition: this.#summaryDisposition(outputBytes),
			summarized: this.#summarized || undefined,
			actionableDiagnostics: actionable.length > 0 ? actionable : undefined,
		};
	}

	async #finalizeFile(): Promise<void> {
		if (this.#finalized) return;
		this.#finalized = true;
		if (this.#fileCreation) {
			await this.#fileCreation.catch(() => undefined);
		}
		const file = this.#file;
		if (!file) return;

		try {
			this.#flushArtifactTailIfCapped();
		} catch (error) {
			this.#markCollectorFailure(error);
		} finally {
			try {
				await file.sink.end();
			} catch (error) {
				this.#markCollectorFailure(error);
			}
		}
	}

	async dispose(): Promise<void> {
		this.#clearPendingChunkTimer();
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			this.#pushChunk(NL, true);
		}
		this.#flushHeldSixelTail();
		await this.#finalizeFile();
	}
}

export function formatTailTruncationNotice(
	truncation: TruncationResult,
	options: TailTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const { fullOutputPath, originalContent, suffix = "" } = options;
	const startLine = truncation.totalLines - (truncation.outputLines ?? truncation.totalLines) + 1;
	const endLine = truncation.totalLines;
	const fullOutputPart = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

	let notice: string;
	if (truncation.lastLinePartial) {
		let lastLineSizePart = "";
		if (originalContent) {
			const lastNl = originalContent.lastIndexOf(NL);
			const lastLine = lastNl === -1 ? originalContent : originalContent.substring(lastNl + 1);
			lastLineSizePart = ` (line is ${formatBytes(Buffer.byteLength(lastLine, "utf-8"))})`;
		}
		notice = `[Showing last ${formatBytes(truncation.outputBytes ?? truncation.totalBytes)} of line ${endLine}${lastLineSizePart}${fullOutputPart}${suffix}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputPart}${suffix}]`;
	}

	return `\n\n${notice}`;
}

export function formatHeadTruncationNotice(
	truncation: TruncationResult,
	options: HeadTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const startLineDisplay = options.startLine ?? 1;
	const totalFileLines = options.totalFileLines ?? truncation.totalLines;
	const endLineDisplay = startLineDisplay + (truncation.outputLines ?? truncation.totalLines) - 1;
	const nextOffset = endLineDisplay + 1;
	const notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use :${nextOffset} to continue]`;
	return `\n\n${notice}`;
}

export function streamTailUpdates<TDetails, TInput = unknown>(
	tailBuffer: TailBuffer,
	onUpdate: AgentToolUpdateCallback<TDetails, TInput> | undefined,
): (chunk: string) => void {
	return chunk => {
		tailBuffer.append(chunk);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: tailBuffer.text() }],
				details: {} as TDetails,
			});
		}
	};
}
