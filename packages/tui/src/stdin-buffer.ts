/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */
import { EventEmitter } from "events";
import { isKittyProtocolActive } from "./keys";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

const PASTE_INACTIVITY_TIMEOUT_MS = 1000;
const PASTE_MAX_BYTES = 64 * 1024 * 1024;

const KITTY_PRINTABLE_DEDUP_WINDOW_MS = 25;

const SGR_MOUSE_PARTIAL = /^\x1b\[<[\d;]*$/;

const PARTIAL_HOLD_MAX_MS = 150;

const MAX_CSI_BYTES = 4096;
const MAX_STRING_SEQ_BYTES = 16 * 1024 * 1024;

const STRING_DISCARD_MAX_BYTES = 2 * MAX_STRING_SEQ_BYTES;
const STRING_DISCARD_INACTIVITY_MS = 1000;

const STRING_SEQ_PARTIAL = /^\x1b[\]P_]/;

const SGR_MOUSE_COMPLETE = /^<\d+;\d+;\d+[Mm]$/;

const RAW_PASTE_CLASSIFICATION_TIMEOUT_MS = 10;

function isRawMultilineBurst(text: string): boolean {
	let breaks = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x0d) {
			breaks++;
			if (text.charCodeAt(i + 1) === 0x0a) i++;
			continue;
		}
		if (code === 0x0a) {
			breaks++;
			continue;
		}
		if (breaks >= 2) return true;
	}
	return false;
}

function resolveEscapeEnd(buffer: string, pos: number, length: number, resumeSearchFrom: number): number {
	if (pos + 1 >= length) return -1;
	const next = buffer.charCodeAt(pos + 1);

	switch (next) {
		case 0x1b:
			return -1;
		case 0x5b: {
			if (pos + 2 >= length) return -1;

			if (buffer.charCodeAt(pos + 2) === 0x4d) {
				if (pos + 6 <= length) return pos + 6;

				return -1;
			}
			const capEnd = Math.min(length, pos + MAX_CSI_BYTES);
			const isSgrMouse = buffer.charCodeAt(pos + 2) === 0x3c;

			let i = pos + 2;
			while (i < capEnd) {
				const code = buffer.charCodeAt(i);
				if (code >= 0x40 && code <= 0x7e) {
					if (isSgrMouse) {
						if (code !== 0x4d && code !== 0x6d) {
							i++;
							continue;
						}
						const payload = buffer.slice(pos + 2, i + 1);
						if (SGR_MOUSE_COMPLETE.test(payload)) return i + 1;

						i++;
						continue;
					}
					return i + 1;
				}
				i++;
			}
			return length - pos >= MAX_CSI_BYTES ? -2 : -1;
		}
		case 0x5d: {
			const searchFrom = Math.max(pos + 2, resumeSearchFrom - 1);
			const scanLimit = Math.min(length, pos + MAX_STRING_SEQ_BYTES);
			for (let i = searchFrom; i < scanLimit; i++) {
				const code = buffer.charCodeAt(i);
				if (code === 0x07) return i + 1;
				if (code === 0x1b) {
					if (i + 1 < scanLimit && buffer.charCodeAt(i + 1) === 0x5c) return i + 2;
				}
			}
			return length - pos >= MAX_STRING_SEQ_BYTES ? -2 : -1;
		}
		case 0x50:
		case 0x5f: {
			const searchFrom = Math.max(pos + 2, resumeSearchFrom - 1);
			const scanLimit = Math.min(length, pos + MAX_STRING_SEQ_BYTES);
			for (let i = searchFrom; i < scanLimit; i++) {
				if (buffer.charCodeAt(i) === 0x1b && i + 1 < scanLimit && buffer.charCodeAt(i + 1) === 0x5c) {
					return i + 2;
				}
			}
			return length - pos >= MAX_STRING_SEQ_BYTES ? -2 : -1;
		}
		case 0x4f:
			return pos + 3 <= length ? pos + 3 : -1;
		default:
			return pos + 2;
	}
}

function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(
	buffer: string,
	resumeSearchFrom: number,
): { sequences: string[]; remainder: string; resumeSearchFrom: number; discardFrom?: number } {
	const sequences: string[] = [];
	const length = buffer.length;
	let pos = 0;

	let hint = resumeSearchFrom;

	while (pos < length) {
		if (buffer.charCodeAt(pos) !== 0x1b) {
			const codePoint = buffer.codePointAt(pos)!;
			const charLength = codePoint > 0xffff ? 2 : 1;
			sequences.push(buffer.slice(pos, pos + charLength));
			pos += charLength;
			hint = 0;
			continue;
		}

		if (pos + 1 < length && buffer.charCodeAt(pos + 1) === 0x1b) {
			if (pos + 2 >= length) {
				return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: 0 };
			}
			const third = buffer.charCodeAt(pos + 2);
			if (third !== 0x5b && third !== 0x4f) {
				sequences.push(ESC);
				pos += 1;
				hint = 0;
				continue;
			}

			const innerEnd = resolveEscapeEnd(buffer, pos + 1, length, 0);
			if (innerEnd === -1) {
				return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: 0 };
			}
			if (innerEnd === -2) {
				const flushEnd = Math.min(length, pos + MAX_CSI_BYTES);
				sequences.push(buffer.slice(pos, flushEnd));
				pos = flushEnd;
				hint = 0;
				continue;
			}

			if (third === 0x5b && buffer.charCodeAt(pos + 3) === 0x3c) {
				sequences.push(ESC);
				sequences.push(buffer.slice(pos + 1, innerEnd));
				pos = innerEnd;
				hint = 0;
				continue;
			}
			sequences.push(buffer.slice(pos, innerEnd));
			pos = innerEnd;
			hint = 0;
			continue;
		}

		const end = resolveEscapeEnd(buffer, pos, length, pos === 0 ? hint : 0);
		if (end === -1) {
			const next = pos + 1 < length ? buffer.charCodeAt(pos + 1) : -1;
			const nextHint = pos === 0 && (next === 0x5d || next === 0x50 || next === 0x5f) ? length : 0;
			return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: nextHint };
		}
		if (end === -2) {
			const next = buffer.charCodeAt(pos + 1);
			if (next === 0x5d || next === 0x50 || next === 0x5f) {
				return { sequences, remainder: "", resumeSearchFrom: 0, discardFrom: pos };
			}
			const flushEnd = Math.min(length, pos + MAX_CSI_BYTES);
			sequences.push(buffer.slice(pos, flushEnd));
			pos = flushEnd;
			hint = 0;
			continue;
		}
		sequences.push(buffer.slice(pos, end));
		pos = end;
		hint = 0;
	}

	return { sequences, remainder: "", resumeSearchFrom: 0 };
}

export type StdinBufferOptions = {
	timeout?: number;

	partialHoldTimeout?: number;

	pasteTimeout?: number;

	pasteByteLimit?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	#buffer: string = "";
	#timeout?: NodeJS.Timeout;
	#flushDeferral?: NodeJS.Timeout;
	#partialHoldStartMs = 0;
	readonly #timeoutMs: number;
	readonly #partialHoldMaxMs: number;
	readonly #pasteTimeoutMs: number;
	readonly #pasteByteLimit: number;
	#pasteMode: boolean = false;
	#pasteChunks: string[] = [];
	#pasteOverlap: string = "";
	#pasteBytes = 0;
	#pasteWatchdog?: NodeJS.Timeout;
	#pendingKittyPrintableCodepoint: number | undefined;
	#pendingKittyPrintableAtMs = 0;
	#escapeSearchOffset = 0;
	#rawPasteCandidate = "";
	#rawPasteBreaks = 0;
	#rawPasteEndsWithCR = false;
	#rawPasteBurst = false;
	#rawPasteTimer?: NodeJS.Timeout;
	#stringDiscardActive = false;
	#stringDiscardBytes = 0;
	#stringDiscardEscHeld = false;
	#stringDiscardWatchdog?: NodeJS.Timeout;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeoutMs = options.timeout ?? 75;
		this.#partialHoldMaxMs = options.partialHoldTimeout ?? PARTIAL_HOLD_MAX_MS;
		this.#pasteTimeoutMs = options.pasteTimeout ?? PASTE_INACTIVITY_TIMEOUT_MS;
		this.#pasteByteLimit = options.pasteByteLimit ?? PASTE_MAX_BYTES;
	}

	process(data: string | Buffer): void {
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}
		if (this.#stringDiscardActive) {
			str = this.#consumeStringDiscard(str);
			if (str.length === 0) return;
		}

		if (this.#flushDeferral && this.#isFreshEscapeAfterDeferredFlush(str)) {
			this.#flushExpired();
		} else {
			this.#clearFlushTimer();
		}

		if (str.length === 0 && this.#buffer.length === 0 && this.#rawPasteCandidate.length === 0) {
			this.#emitDataSequence("");
			return;
		}

		if (this.#pasteMode) {
			this.#consumePasteChunk(str);
			return;
		}

		if (this.#rawPasteCandidate.length > 0) {
			if (str.indexOf(ESC) !== -1) {
				this.#flushRawPasteCandidate();
			} else {
				this.#rawPasteCandidate += str;
				this.#countRawBreaks(str);
				if (this.#rawPasteBurst) {
					this.#emitRawPasteCandidate();
				}
				return;
			}
		}

		if (
			this.#buffer.length === 0 &&
			str.indexOf(ESC) === -1 &&
			(str.indexOf("\r") !== -1 || str.indexOf("\n") !== -1)
		) {
			this.#rawPasteCandidate = str;
			this.#resetRawBreaks();
			this.#countRawBreaks(str);
			if (this.#rawPasteBurst) {
				this.#emitRawPasteCandidate();
			} else {
				this.#armRawPasteTimer();
			}
			return;
		}

		this.#buffer += str;

		const startIndex = this.#buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.#buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste, 0);
				for (const sequence of result.sequences) {
					this.#emitDataSequence(sequence);
				}
			}

			this.#escapeSearchOffset = 0;
			this.#pendingKittyPrintableCodepoint = undefined;
			this.#buffer = this.#buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			const firstChunk = this.#buffer;
			this.#buffer = "";
			this.#pasteMode = true;
			this.#pasteChunks = [];
			this.#pasteOverlap = "";
			this.#pasteBytes = 0;
			this.#consumePasteChunk(firstChunk);
			return;
		}

		const result = extractCompleteSequences(this.#buffer, this.#escapeSearchOffset);
		if (result.discardFrom !== undefined) {
			const junk = this.#buffer.slice(result.discardFrom);
			this.#buffer = "";
			this.#escapeSearchOffset = 0;
			for (const sequence of result.sequences) {
				this.#emitDataSequence(sequence);
			}
			this.#enterStringDiscard();
			const after = this.#consumeStringDiscard(junk);
			if (after.length > 0) this.process(after);
			return;
		}
		this.#buffer = result.remainder;
		this.#escapeSearchOffset = result.resumeSearchFrom;

		for (const sequence of result.sequences) {
			this.#emitDataSequence(sequence);
		}

		if (this.#buffer.length > 0) {
			this.#armFlushTimer();
		} else {
			this.#partialHoldStartMs = 0;
		}
	}

	#consumePasteChunk(chunk: string): void {
		const probe = this.#pasteOverlap + chunk;
		if (probe.indexOf(BRACKETED_PASTE_END) === -1) {
			this.#pasteChunks.push(chunk);
			this.#pasteBytes += chunk.length;
			const keep = BRACKETED_PASTE_END.length - 1;
			this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
			if (this.#pasteBytes > this.#pasteByteLimit) {
				this.#abortPaste();
				return;
			}
			this.#armPasteWatchdog();
			return;
		}

		const flat = this.#pasteChunks.length > 0 ? `${this.#pasteChunks.join("")}${chunk}` : chunk;
		const endIndex = flat.indexOf(BRACKETED_PASTE_END);
		const pastedContent = flat.slice(0, endIndex);
		const remaining = flat.slice(endIndex + BRACKETED_PASTE_END.length);

		this.#clearPasteWatchdog();
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", pastedContent);

		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	#armPasteWatchdog(): void {
		if (this.#pasteWatchdog) clearTimeout(this.#pasteWatchdog);
		this.#pasteWatchdog = setTimeout(() => {
			this.#pasteWatchdog = undefined;
			this.#abortPaste();
		}, this.#pasteTimeoutMs);
	}

	#clearPasteWatchdog(): void {
		if (this.#pasteWatchdog) {
			clearTimeout(this.#pasteWatchdog);
			this.#pasteWatchdog = undefined;
		}
	}

	#abortPaste(): void {
		this.#clearPasteWatchdog();
		const content = this.#pasteChunks.join("");
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.emit("paste", content);
	}

	#armRawPasteTimer(): void {
		if (this.#rawPasteTimer) return;
		this.#rawPasteTimer = setTimeout(() => {
			this.#rawPasteTimer = undefined;
			this.#flushRawPasteCandidate();
		}, RAW_PASTE_CLASSIFICATION_TIMEOUT_MS);
	}

	#clearRawPasteTimer(): void {
		if (this.#rawPasteTimer) {
			clearTimeout(this.#rawPasteTimer);
			this.#rawPasteTimer = undefined;
		}
	}

	#takeRawPasteCandidate(): string {
		this.#clearRawPasteTimer();
		const content = this.#rawPasteCandidate;
		this.#rawPasteCandidate = "";
		this.#resetRawBreaks();
		return content;
	}

	#emitRawPasteCandidate(): void {
		const content = this.#takeRawPasteCandidate();
		this.#pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", content);
	}

	#resetRawBreaks(): void {
		this.#rawPasteBreaks = 0;
		this.#rawPasteEndsWithCR = false;
		this.#rawPasteBurst = false;
	}

	/**
	 * Incrementally maintain the line-break count for the accumulated raw-paste
	 * candidate (\r\n counts as one break, matching isRawMultilineBurst) so an
	 * append costs O(chunk) instead of rescanning the whole candidate.
	 */
	#countRawBreaks(chunk: string): void {
		for (let i = 0; i < chunk.length; i++) {
			const code = chunk.charCodeAt(i);
			if (code === 0x0d) {
				this.#rawPasteBreaks++;
				this.#rawPasteEndsWithCR = true;
				continue;
			}
			if (code === 0x0a) {
				if (!this.#rawPasteEndsWithCR) this.#rawPasteBreaks++;
				this.#rawPasteEndsWithCR = false;
				continue;
			}
			this.#rawPasteEndsWithCR = false;
			// isRawMultilineBurst fires on the first non-break char after the
			// second line break — trailing breaks alone never classify as a burst.
			if (this.#rawPasteBreaks >= 2) this.#rawPasteBurst = true;
		}
	}

	#flushRawPasteCandidate(): void {
		const content = this.#takeRawPasteCandidate();
		if (content.length === 0) return;
		const result = extractCompleteSequences(content, 0);
		for (const sequence of result.sequences) {
			this.#emitDataSequence(sequence);
		}
	}

	#emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (
			rawCodepoint !== undefined &&
			rawCodepoint === this.#pendingKittyPrintableCodepoint &&
			Date.now() - this.#pendingKittyPrintableAtMs <= KITTY_PRINTABLE_DEDUP_WINDOW_MS
		) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.#pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		if (this.#pendingKittyPrintableCodepoint !== undefined) {
			this.#pendingKittyPrintableAtMs = Date.now();
		}
		this.emit("data", sequence);
	}

	#armFlushTimer(): void {
		this.#timeout = setTimeout(() => {
			this.#timeout = undefined;
			this.#flushDeferral = setTimeout(() => {
				this.#flushDeferral = undefined;
				this.#flushExpired(true);
			});
		}, this.#timeoutMs);
	}

	#clearFlushTimer(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		if (this.#flushDeferral) {
			clearTimeout(this.#flushDeferral);
			this.#flushDeferral = undefined;
		}
	}

	#isFreshEscapeAfterDeferredFlush(str: string): boolean {
		if (!str.startsWith(ESC) || this.#buffer.length === 0) return false;
		if (
			str.startsWith(`${ESC}\\`) &&
			(this.#buffer.startsWith(`${ESC}]`) ||
				this.#buffer.startsWith(`${ESC}P`) ||
				this.#buffer.startsWith(`${ESC}_`))
		) {
			return false;
		}
		return true;
	}

	#shouldHoldPartial(): boolean {
		return SGR_MOUSE_PARTIAL.test(this.#buffer) || isKittyProtocolActive();
	}

	#flushExpired(fromTimer = false): void {
		if (this.#buffer.length === 0) {
			this.#partialHoldStartMs = 0;
			return;
		}
		if (this.#shouldHoldPartial()) {
			if (this.#partialHoldStartMs === 0) this.#partialHoldStartMs = Date.now();
			if (Date.now() - this.#partialHoldStartMs < this.#partialHoldMaxMs) {
				this.#armFlushTimer();
				return;
			}
		}
		this.#partialHoldStartMs = 0;
		for (const sequence of this.#drainBuffered(fromTimer)) {
			this.#emitDataSequence(sequence);
		}
	}

	flush(): string[] {
		return this.#drainBuffered(false);
	}

	#drainBuffered(discardTornString: boolean): string[] {
		this.#clearFlushTimer();

		const rawCandidate = this.#takeRawPasteCandidate();
		const sequences = rawCandidate.length > 0 ? extractCompleteSequences(rawCandidate, 0).sequences : [];

		if (this.#buffer.length === 0) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return sequences;
		}

		const buffered = this.#buffer;
		this.#buffer = "";
		this.#escapeSearchOffset = 0;
		this.#pendingKittyPrintableCodepoint = undefined;

		if (buffered === `${ESC}${ESC}`) {
			sequences.push(ESC, ESC);
		} else if (isKittyProtocolActive() && STRING_SEQ_PARTIAL.test(buffered)) {
			if (discardTornString) this.#enterStringDiscard();
		} else {
			sequences.push(buffered);
		}
		return sequences;
	}

	#enterStringDiscard(): void {
		this.#stringDiscardActive = true;
		this.#stringDiscardBytes = 0;
		this.#stringDiscardEscHeld = false;
		this.#armStringDiscardWatchdog();
	}

	#exitStringDiscard(): void {
		this.#stringDiscardActive = false;
		this.#stringDiscardBytes = 0;
		this.#stringDiscardEscHeld = false;
		if (this.#stringDiscardWatchdog) {
			clearTimeout(this.#stringDiscardWatchdog);
			this.#stringDiscardWatchdog = undefined;
		}
	}

	#consumeStringDiscard(str: string): string {
		if (this.#stringDiscardEscHeld) {
			this.#stringDiscardEscHeld = false;
			if (str.charCodeAt(0) === 0x5c) {
				this.#exitStringDiscard();
				return str.slice(1);
			}
		}
		for (let i = 0; i < str.length; i++) {
			const code = str.charCodeAt(i);
			if (code === 0x07) {
				this.#exitStringDiscard();
				return str.slice(i + 1);
			}
			if (code === 0x1b) {
				if (i + 1 === str.length) {
					this.#stringDiscardEscHeld = true;
					break;
				}
				if (str.charCodeAt(i + 1) === 0x5c) {
					this.#exitStringDiscard();
					return str.slice(i + 2);
				}
			}
		}
		this.#stringDiscardBytes += str.length;
		if (this.#stringDiscardBytes > STRING_DISCARD_MAX_BYTES) {
			this.#exitStringDiscard();
			return "";
		}
		this.#armStringDiscardWatchdog();
		return "";
	}

	#armStringDiscardWatchdog(): void {
		if (this.#stringDiscardWatchdog) clearTimeout(this.#stringDiscardWatchdog);
		this.#stringDiscardWatchdog = setTimeout(() => {
			this.#stringDiscardWatchdog = undefined;
			this.#exitStringDiscard();
		}, STRING_DISCARD_INACTIVITY_MS);
	}

	clear(): void {
		this.#clearFlushTimer();
		this.#clearPasteWatchdog();
		this.#clearRawPasteTimer();
		this.#exitStringDiscard();
		this.#buffer = "";
		this.#rawPasteCandidate = "";
		this.#resetRawBreaks();
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#partialHoldStartMs = 0;
		this.#escapeSearchOffset = 0;
	}

	getBuffer(): string {
		return `${this.#rawPasteCandidate}${this.#buffer}`;
	}

	destroy(): void {
		this.clear();
	}
}
