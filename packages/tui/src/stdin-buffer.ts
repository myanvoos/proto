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

const STRING_SEQ_PARTIAL = /^\x1b[\]P_^X]/;

/**
 * 8-bit C1 introducers that cannot be UTF-8 continuation bytes, normalized to
 * their 7-bit ESC forms so the protocol scanner recognizes the reply. This
 * serves direct byte callers: production stdin is string-oriented
 * (setEncoding("utf8") upstream), and terminals emit 7-bit control replies.
 */
function c1SevenBitForm(byte: number): string | undefined {
	switch (byte) {
		case 0x90:
			return "\x1bP"; // DCS
		case 0x98:
			return "\x1bX"; // SOS
		case 0x9b:
			return "\x1b["; // CSI
		case 0x9c:
			return "\x1b\\"; // ST
		case 0x9d:
			return "\x1b]"; // OSC
		case 0x9e:
			return "\x1b^"; // PM
		case 0x9f:
			return "\x1b_"; // APC
		default:
			return undefined;
	}
}

const SGR_MOUSE_COMPLETE = /^<\d+;\d+;\d+[Mm]$/;

export type StringSequenceKind = "osc" | "dcs" | "apc" | "sos" | "pm";

/**
 * Clip `text` to at most `maxBytes` UTF-8 bytes without splitting a code
 * point (a naive subarray would decode a replacement character and can even
 * re-encode larger than the cap).
 */
function utf8Clip(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let cut = maxBytes;
	while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
	return bytes.subarray(0, cut).toString("utf8");
}

function stringDiscardKindFor(sequence: string): StringSequenceKind {
	const second = sequence.charCodeAt(1);
	if (second === 0x50) return "dcs";
	if (second === 0x58) return "sos";
	if (second === 0x5e) return "pm";
	if (second === 0x5f) return "apc";
	return "osc";
}

const RAW_PASTE_CLASSIFICATION_TIMEOUT_MS = 10;

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
		case 0x50: // DCS
		case 0x58: // SOS
		case 0x5e: // PM
		case 0x5f: {
			// APC
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
): {
	sequences: string[];
	remainder: string;
	resumeSearchFrom: number;
	discardFrom?: number;
	discardKind?: StringSequenceKind;
} {
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
			const nextHint =
				pos === 0 && (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f)
					? length
					: 0;
			return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: nextHint };
		}
		if (end === -2) {
			const next = buffer.charCodeAt(pos + 1);
			if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				return {
					sequences,
					remainder: "",
					resumeSearchFrom: 0,
					discardFrom: pos,
					discardKind: stringDiscardKindFor(buffer.slice(pos, pos + 2)),
				};
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

	/** Inactivity window after which a discarded string gives up (tests). */
	stringDiscardInactivity?: number;
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
	readonly #stringDiscardInactivityMs: number;
	#pasteMode: boolean = false;
	#pasteOverLimit = false;
	#pastePendingMarker: string = "";
	#pastePendingMatched = 0;
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
	#stringDiscardKind: StringSequenceKind = "osc";
	#stringDiscardBytes = 0;
	#stringDiscardEscHeld = false;
	#stringDiscardWatchdog?: NodeJS.Timeout;
	#utf8Held: Buffer = Buffer.alloc(0);

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeoutMs = options.timeout ?? 75;
		this.#partialHoldMaxMs = options.partialHoldTimeout ?? PARTIAL_HOLD_MAX_MS;
		this.#pasteTimeoutMs = options.pasteTimeout ?? PASTE_INACTIVITY_TIMEOUT_MS;
		this.#pasteByteLimit = options.pasteByteLimit ?? PASTE_MAX_BYTES;
		this.#stringDiscardInactivityMs = options.stringDiscardInactivity ?? STRING_DISCARD_INACTIVITY_MS;
	}

	process(data: string | Buffer): void {
		let str: string;
		if (Buffer.isBuffer(data)) {
			str = this.#decodeStdinBytes(data);
			if (str.length === 0 && data.length > 0) {
				// Every byte began an incomplete UTF-8 sequence; hold until the
				// continuation bytes arrive in a later chunk. Held bytes still
				// count as input activity: keep any active parser mode's timers
				// alive so classification and watchdogs do not expire
				// mid-character.
				if (this.#pasteMode) this.#armPasteWatchdog();
				else if (this.#rawPasteCandidate.length > 0) this.#armRawPasteTimer();
				else if (this.#stringDiscardActive) this.#armStringDiscardWatchdog();
				return;
			}
		} else {
			str = data;
		}
		if (this.#stringDiscardActive) {
			str = this.#consumeStringDiscard(str);
			if (str.length === 0) return;
		}

		if (this.#flushDeferral && this.#isFreshEscapeAfterDeferredFlush(str)) {
			// A fresh escape must not be joined to the deferred partial. Force
			// the held bytes out first, including under Kitty partial holding.
			this.#flushExpired(false, true);
		} else {
			this.#clearFlushTimer();
		}
		if (this.#stringDiscardActive) {
			// The expired flush may have entered discard mode; route this chunk
			// through the discard consumer instead of the normal parser.
			str = this.#consumeStringDiscard(str);
			if (str.length === 0) return;
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
				} else {
					this.#armRawPasteTimer();
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
				if (result.remainder.length > 0) {
					// The prefix ends inside a control string whose terminator
					// may sit past the marker. Re-parse the whole buffer BEFORE
					// emitting anything: a terminator after the marker proves the
					// marker was payload, and holding must never double-emit the
					// prefix (the held buffer re-parses from scratch on retry).
					const full = extractCompleteSequences(this.#buffer, 0);
					if (full.remainder.length === 0) {
						this.#escapeSearchOffset = 0;
						const junkStart = full.discardFrom;
						const junk = junkStart !== undefined ? this.#buffer.slice(junkStart) : "";
						this.#buffer = "";
						for (const sequence of full.sequences) {
							this.#emitDataSequence(sequence);
						}
						if (junkStart !== undefined) {
							this.#pendingKittyPrintableCodepoint = undefined;
							this.#enterStringDiscard(full.discardKind ?? "osc");
							const after = this.#consumeStringDiscard(junk);
							if (after.length > 0) this.process(after);
						}
						return;
					}
					// Genuinely incomplete string: hold the buffer whole; the
					// flush timer or the next chunk re-parses it from the start.
					this.#armFlushTimer();
					return;
				}
				for (const sequence of result.sequences) {
					this.#emitDataSequence(sequence);
				}
				if (result.discardFrom !== undefined) {
					// The prefix contains an oversized/unterminated control string:
					// the paste marker is payload inside it, so discard the whole
					// string instead of classifying a paste.
					this.#escapeSearchOffset = 0;
					this.#pendingKittyPrintableCodepoint = undefined;
					const junk = this.#buffer.slice(result.discardFrom);
					this.#buffer = "";
					this.#enterStringDiscard(result.discardKind ?? "osc");
					const after = this.#consumeStringDiscard(junk);
					if (after.length > 0) this.process(after);
					return;
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
			// Reset after the replay: emitting the preceding sequences may
			// re-establish a pending Kitty printable that must not leak into
			// the discarded string's tail.
			this.#pendingKittyPrintableCodepoint = undefined;
			this.#enterStringDiscard(result.discardKind ?? "osc");
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

	/**
	 * Decode stdin bytes with UTF-8 sequence state carried across chunks: a
	 * multibyte character split across reads must survive intact instead of
	 * degrading into Meta escapes or replacement characters. Tail bytes that
	 * begin a valid but incomplete sequence are held for the next chunk. Lone
	 * 8-bit C1 introducers that are not valid continuation bytes normalize to
	 * their 7-bit ESC forms; continuation bytes of a pending sequence always
	 * take precedence over C1 interpretation.
	 */
	#decodeStdinBytes(data: Buffer): string {
		let bytes = data;
		if (this.#utf8Held.length > 0) {
			bytes = Buffer.concat([this.#utf8Held, data]);
			this.#utf8Held = Buffer.alloc(0);
		}
		const len = bytes.length;
		let text = "";
		let runStart = 0;
		let i = 0;
		let pendingContinuations = 0;
		const flushRun = (end: number): void => {
			if (end > runStart) text += bytes.toString("utf8", runStart, end);
			runStart = end;
		};
		while (i < len) {
			const byte = bytes[i]!;
			if (pendingContinuations > 0) {
				if (byte >= 0x80 && byte <= 0xbf) {
					pendingContinuations--;
					i++;
					continue;
				}
				// Invalid sequence: leave the run to be decoded with replacement
				// characters and resume scanning at this byte.
				pendingContinuations = 0;
				i++;
				continue;
			}
			if (byte < 0x80) {
				i++;
				continue;
			}
			const c1 = c1SevenBitForm(byte);
			if (c1 !== undefined) {
				flushRun(i);
				text += c1;
				i++;
				runStart = i;
				continue;
			}
			const seqLen =
				byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
			if (seqLen === 0) {
				// Invalid lead or orphan continuation: replacement character via
				// the batched run decode.
				i++;
				continue;
			}
			if (i + seqLen > len) break; // incomplete tail: hold for the next chunk
			let valid = true;
			for (let j = 1; j < seqLen; j++) {
				const cont = bytes[i + j]!;
				if (cont < 0x80 || cont > 0xbf) {
					valid = false;
					break;
				}
			}
			if (!valid) {
				i++; // invalid lead stays in the run and decodes as replacement
				continue;
			}
			pendingContinuations = seqLen - 1;
			i++;
		}
		if (i < len) {
			flushRun(i);
			this.#utf8Held = Buffer.from(bytes.subarray(i));
		} else {
			flushRun(len);
		}
		return text;
	}

	/**
	 * An explicit flush ends the wait for continuation bytes in ordinary input.
	 * Paste payloads keep their held lead until the continuation arrives, while
	 * string-discard payloads drop it with the rest of the discarded bytes.
	 */
	#materializeHeldUtf8(): void {
		if (this.#utf8Held.length === 0) return;
		if (this.#pasteMode) return;
		if (this.#stringDiscardActive) {
			this.#utf8Held = Buffer.alloc(0);
			return;
		}
		this.#utf8Held = Buffer.alloc(0);
		this.#buffer += "\ufffd";
	}

	#consumePasteChunk(chunk: string): void {
		const probe = this.#pasteOverlap + chunk;
		if (this.#pasteOverLimit) {
			if (this.#pastePendingMarker.length > 0) {
				// Continue matching the withheld candidate from its accumulated
				// offset. A mismatch restores the withheld bytes as ordinary
				// in-cap payload; completion accepts them as the real
				// terminator. The candidate resolves BEFORE any independent
				// terminator in the same chunk is accepted.
				const base = this.#pastePendingMarker.length + this.#pastePendingMatched;
				let consumed = 0;
				while (
					consumed < chunk.length &&
					base + consumed < BRACKETED_PASTE_END.length &&
					chunk.charCodeAt(consumed) === BRACKETED_PASTE_END.charCodeAt(base + consumed)
				) {
					consumed++;
				}
				if (base + consumed >= BRACKETED_PASTE_END.length) {
					// The candidate completed as the real terminator.
					const delivered = this.#pasteChunks.join("");
					const remaining = chunk.slice(consumed);
					this.#clearPasteWatchdog();
					this.#pasteMode = false;
					this.#pasteOverLimit = false;
					this.#pastePendingMarker = "";
					this.#pastePendingMatched = 0;
					this.#pasteChunks = [];
					this.#pasteOverlap = "";
					this.#pasteBytes = 0;
					this.#pendingKittyPrintableCodepoint = undefined;
					this.emit("paste", delivered);
					if (remaining.length > 0) this.process(remaining);
					return;
				}
				if (consumed < chunk.length) {
					// Mismatch: the withheld suffix was ordinary in-cap payload.
					const restored = `${this.#pasteChunks.join("")}${this.#pastePendingMarker}`;
					this.#pasteChunks = restored.length > 0 ? [restored] : [];
					this.#pasteBytes = Buffer.byteLength(restored, "utf8");
					this.#pastePendingMarker = "";
					this.#pastePendingMatched = 0;
					const rest = chunk.slice(consumed);
					if (rest.length > 0) {
						this.#consumePasteChunk(rest);
					} else {
						this.#armPasteWatchdog();
					}
					return;
				}
				// The entire chunk continues the candidate.
				this.#pastePendingMatched += consumed;
				this.#armPasteWatchdog();
				return;
			}
			const endInProbe = probe.indexOf(BRACKETED_PASTE_END);
			if (endInProbe === -1) {
				// Over-cap paste: keep consuming paste-mode bytes (so the
				// terminator is swallowed by this state machine, not leaked to
				// the app) without accumulating payload. The overlap still
				// tracks the chunk tail or a split terminator is never seen.
				const keep = BRACKETED_PASTE_END.length - 1;
				this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
				this.#armPasteWatchdog();
				return;
			}
			// Terminator found: deliver the frozen bounded prefix. The marker
			// may straddle the overlap, so the post-terminator tail is measured
			// in probe coordinates, and the dropped gap is never concatenated.
			const tailStart = Math.max(0, endInProbe + BRACKETED_PASTE_END.length - this.#pasteOverlap.length);
			const remaining = chunk.slice(tailStart);
			const delivered = this.#pasteChunks.join("");
			this.#clearPasteWatchdog();
			this.#pasteMode = false;
			this.#pasteOverLimit = false;
			this.#pastePendingMarker = "";
			this.#pastePendingMatched = 0;
			this.#pasteChunks = [];
			this.#pasteOverlap = "";
			this.#pasteBytes = 0;
			this.#pendingKittyPrintableCodepoint = undefined;
			this.emit("paste", delivered);
			if (remaining.length > 0) this.process(remaining);
			return;
		}
		if (probe.indexOf(BRACKETED_PASTE_END) === -1) {
			// Enforce the accumulation cap (in UTF-8 bytes) before storing more
			// payload so a hostile paste cannot grow memory unbounded. The
			// crossing chunk is clipped to the room left and the payload freezes;
			// later chunks are scanned only for the terminator.
			const chunkBytes = Buffer.byteLength(chunk, "utf8");
			if (this.#pasteBytes + chunkBytes > this.#pasteByteLimit) {
				// Freeze against the ACCUMULATED payload: an under-cap chunk may
				// already have committed a terminator prefix at its tail, so the
				// combined payload is trimmed of any trailing BRACKETED_PASTE_END
				// prefix before the UTF-8-byte clip. The trimmed suffix is only
				// WITHHELD (it may yet be proven to be data by following bytes).
				const markerGuard = BRACKETED_PASTE_END.length - 1;
				const combined = `${this.#pasteChunks.join("")}${chunk}`;
				let frozen = utf8Clip(combined, this.#pasteByteLimit);
				this.#pastePendingMarker = "";
				for (let trim = Math.min(markerGuard, frozen.length); trim > 0; trim--) {
					if (BRACKETED_PASTE_END.startsWith(frozen.slice(frozen.length - trim))) {
						this.#pastePendingMarker = frozen.slice(frozen.length - trim);
						frozen = frozen.slice(0, frozen.length - trim);
						break;
					}
				}
				this.#pasteChunks = frozen.length > 0 ? [frozen] : [];
				this.#pasteBytes = Buffer.byteLength(frozen, "utf8");
				this.#pasteOverLimit = true;
				const keep = markerGuard;
				this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
				this.#armPasteWatchdog();
				return;
			}
			this.#pasteChunks.push(chunk);
			this.#pasteBytes += chunkBytes;
			const keep = BRACKETED_PASTE_END.length - 1;
			this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
			this.#armPasteWatchdog();
			return;
		}

		const flat = this.#pasteChunks.length > 0 ? `${this.#pasteChunks.join("")}${chunk}` : chunk;
		const endIndex = flat.indexOf(BRACKETED_PASTE_END);
		const pastedContent = flat.slice(0, endIndex);
		const remaining = flat.slice(endIndex + BRACKETED_PASTE_END.length);

		// The complete-marker path must honor the same cap as accumulation;
		// pastedContent already includes the stored chunks, so compare it
		// directly and deliver a byte-bounded prefix when it exceeds the cap.
		const overLimit = Buffer.byteLength(pastedContent, "utf8") > this.#pasteByteLimit;
		const delivered = overLimit ? utf8Clip(pastedContent, this.#pasteByteLimit) : pastedContent;

		this.#clearPasteWatchdog();
		this.#pasteMode = false;
		this.#pasteOverLimit = false;
		this.#pastePendingMarker = "";
		this.#pastePendingMatched = 0;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", delivered);

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
		// The watchdog fires on inactivity: the withheld terminator candidate
		// was never proven to be a terminator, so it is ordinary (in-cap)
		// payload of this abandoned paste. A held UTF-8 lead also began inside
		// the paste payload — drop it so its continuation cannot leak into
		// ordinary input after the paste ends.
		const content = `${this.#pasteChunks.join("")}${this.#pastePendingMarker}`;
		this.#pasteMode = false;
		this.#pasteOverLimit = false;
		this.#pastePendingMarker = "";
		this.#pastePendingMatched = 0;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#utf8Held = Buffer.alloc(0);
		this.emit("paste", content);
	}

	#armRawPasteTimer(): void {
		// Classification debounces on inactivity: every appended chunk pushes
		// the cutoff out so a paste delivered over several reads still
		// classifies as one burst.
		this.#clearRawPasteTimer();
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
			// isRawMultilineBurst requires two logical breaks plus a later
			// non-break char: a lone Enter followed by fast typing must stay
			// key events, never a paste. Trailing breaks alone never burst.
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
		// One printable code point, whether BMP (1 UTF-16 unit) or astral (2).
		const rawCodepoint =
			sequence.length === 1 || (sequence.length === 2 && sequence.codePointAt(0)! > 0xffff)
				? sequence.codePointAt(0)
				: undefined;
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
		const heldString = STRING_SEQ_PARTIAL.test(this.#buffer);
		if (str.length === 1) {
			// A lone ESC can begin a split ST only when the held bytes are an
			// ST-terminated string; otherwise it is a fresh escape.
			return !heldString;
		}
		if (str.startsWith(`${ESC}\\`) && heldString) {
			return false;
		}
		return true;
	}

	#shouldHoldPartial(): boolean {
		return SGR_MOUSE_PARTIAL.test(this.#buffer) || isKittyProtocolActive();
	}

	#flushExpired(fromTimer = false, force = false): void {
		if (this.#buffer.length === 0) {
			this.#partialHoldStartMs = 0;
			return;
		}
		if (!force && this.#shouldHoldPartial()) {
			if (this.#partialHoldStartMs === 0) this.#partialHoldStartMs = Date.now();
			if (Date.now() - this.#partialHoldStartMs < this.#partialHoldMaxMs) {
				this.#armFlushTimer();
				return;
			}
		}
		this.#partialHoldStartMs = 0;
		for (const sequence of this.#drainBuffered(fromTimer, force)) {
			this.#emitDataSequence(sequence);
		}
	}

	flush(): string[] {
		this.#materializeHeldUtf8();
		return this.#drainBuffered(false);
	}

	#drainBuffered(discardTornString: boolean, emitTornString = false): string[] {
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
			if (discardTornString) this.#enterStringDiscard(stringDiscardKindFor(buffered));
			else if (emitTornString) sequences.push(buffered);
		} else if (buffered.includes(ESC) && !buffered.startsWith(ESC)) {
			// Mixed buffer: a complete prefix precedes a torn control string.
			// Re-parse so the prefix emits exactly once and the torn tail is
			// handled by string kind instead of leaking markers wholesale.
			const parsed = extractCompleteSequences(buffered, 0);
			for (const sequence of parsed.sequences) {
				sequences.push(sequence);
			}
			if (parsed.discardFrom !== undefined) {
				this.#enterStringDiscard(parsed.discardKind ?? "osc");
				const after = this.#consumeStringDiscard(buffered.slice(parsed.discardFrom));
				if (after.length > 0) sequences.push(after);
			} else if (parsed.remainder.length > 0 && STRING_SEQ_PARTIAL.test(parsed.remainder)) {
				if (discardTornString) {
					this.#enterStringDiscard(stringDiscardKindFor(parsed.remainder));
					const after = this.#consumeStringDiscard(parsed.remainder);
					if (after.length > 0) sequences.push(after);
				} else {
					sequences.push(parsed.remainder);
				}
			} else if (parsed.remainder.length > 0) {
				sequences.push(parsed.remainder);
			}
		} else {
			sequences.push(buffered);
		}
		return sequences;
	}

	#enterStringDiscard(kind: StringSequenceKind): void {
		this.#stringDiscardActive = true;
		this.#stringDiscardKind = kind;
		this.#stringDiscardBytes = 0;
		this.#stringDiscardEscHeld = false;
		this.#armStringDiscardWatchdog();
	}

	#exitStringDiscard(): void {
		this.#stringDiscardActive = false;
		this.#stringDiscardKind = "osc";
		this.#stringDiscardBytes = 0;
		this.#stringDiscardEscHeld = false;
		// A held UTF-8 lead at this point was decoded from inside the
		// discarded payload: drop it so its continuation cannot surface as
		// ordinary input after the string ends.
		this.#utf8Held = Buffer.alloc(0);
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
				// BEL terminates only OSC strings; DCS/APC require ST (STX/BEL is
				// payload there), matching resolveEscapeEnd's terminator policy.
				if (this.#stringDiscardKind === "osc") {
					this.#exitStringDiscard();
					return str.slice(i + 1);
				}
				continue;
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
		}, this.#stringDiscardInactivityMs);
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
		this.#pasteOverLimit = false;
		this.#pastePendingMarker = "";
		this.#pastePendingMatched = 0;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#partialHoldStartMs = 0;
		this.#escapeSearchOffset = 0;
		this.#utf8Held = Buffer.alloc(0);
	}

	getBuffer(): string {
		return `${this.#rawPasteCandidate}${this.#buffer}`;
	}

	destroy(): void {
		this.clear();
	}
}
