/**
 * Byte-safe UTF-8 truncation for strings and byte arrays.
 *
 * Cutting a UTF-8 string or buffer at a raw byte offset can split a multi-byte
 * sequence and produce a trailing U+FFFD replacement character (or invalid
 * output when written back out). These helpers retreat to (head mode) or
 * advance past (tail mode) the nearest sequence boundary so the result is
 * always valid UTF-8 that fits within the byte budget.
 *
 * @example
 * const { text, bytes } = truncateHeadBytes(longOutput, 50 * 1024);

/** Result from byte-level UTF-8 truncation: decoded text and its exact byte length. */
export interface Utf8TruncationResult {
	text: string;
	bytes: number;
}

/** Zero-copy view of a Uint8Array as a Buffer (copies only if already a Buffer). */
function asBuffer(data: Uint8Array): Buffer {
	return Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Retreat past UTF-8 continuation bytes to land on a leading byte. */
function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
	let i = Math.min(buf.length, Math.max(0, cut));
	// If the cut is at end-of-buffer, it's already a valid boundary.
	if (i >= buf.length) return buf.length;
	while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

/** Advance past UTF-8 continuation bytes (10xxxxxx) to a leading byte. */
function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
	let i = Math.max(0, pos);
	while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

function truncateBytesWindowed(
	data: string | Uint8Array,
	maxBytes: number,
	mode: "head" | "tail",
): Utf8TruncationResult {
	if (maxBytes === 0) return { text: "", bytes: 0 };

	// --------------------------
	// String path (windowed)
	// --------------------------
	if (typeof data === "string") {
		// Fast non-truncation check only when it *might* fit.
		if (data.length <= maxBytes) {
			const len = Buffer.byteLength(data, "utf-8");
			if (len <= maxBytes) return { text: data, bytes: len };
			// else: multibyte-heavy string; fall through to truncation using full string as window.
		}

		const window =
			mode === "head"
				? data.substring(0, Math.min(data.length, maxBytes))
				: data.substring(Math.max(0, data.length - maxBytes));

		const buf = Buffer.from(window, "utf-8");

		if (mode === "head") {
			const end = findUtf8BoundaryBackward(buf, maxBytes);
			if (end <= 0) return { text: "", bytes: 0 };
			const slice = buf.subarray(0, end);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		} else {
			const startAt = Math.max(0, buf.length - maxBytes);
			const start = findUtf8BoundaryForward(buf, startAt);
			const slice = buf.subarray(start);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		}
	}

	// --------------------------
	// Uint8Array / Buffer path
	// --------------------------
	const buf = asBuffer(data);
	if (buf.length <= maxBytes) return { text: buf.toString("utf-8"), bytes: buf.length };

	if (mode === "head") {
		const end = findUtf8BoundaryBackward(buf, maxBytes);
		if (end <= 0) return { text: "", bytes: 0 };
		const slice = buf.subarray(0, end);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	} else {
		const startAt = buf.length - maxBytes;
		const start = findUtf8BoundaryForward(buf, startAt);
		const slice = buf.subarray(start);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}
}

/**
 * Truncate a string/buffer to fit within a byte limit, keeping the head.
 * Handles multi-byte UTF-8 boundaries correctly.
 */
export function truncateHeadBytes(data: string | Uint8Array, maxBytes: number): Utf8TruncationResult {
	return truncateBytesWindowed(data, maxBytes, "head");
}

/**
 * Truncate a string/buffer to fit within a byte limit, keeping the tail.
 * Handles multi-byte UTF-8 boundaries correctly.
 */
export function truncateTailBytes(data: string | Uint8Array, maxBytes: number): Utf8TruncationResult {
	return truncateBytesWindowed(data, maxBytes, "tail");
}
