const trailingEvents = new WeakSet<ServerSentEvent>();

import { abortableSource } from "./abortable";
import { parseStreamingJson } from "./json-parse";

const LF = 0x0a;
const CR = 0x0d;

/** Reject lines beyond maxLineBytes before accumulating more stream data. */
export async function* readLines(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<Uint8Array> {
	const buffer = new ConcatSink();
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			for (const line of buffer.appendAndFlushLines(chunk, maxLineBytes)) {
				yield line;
			}
		}
		if (!buffer.isEmpty) {
			const tail = buffer.flush();
			if (tail) {
				buffer.clear();
				yield tail;
			}
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

export async function* readJsonl<T>(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
	const buffer = new ConcatSink();
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			yield* buffer.pullJSONL<T>(chunk, 0, chunk.length);
		}
		if (!buffer.isEmpty) {
			const tail = buffer.flush();
			if (tail) {
				buffer.clear();
				const { values, error, done } = Bun.JSONL.parseChunk(tail, 0, tail.length);
				if (values.length > 0) {
					yield* values as T[];
				}
				if (error) throw error;
				if (!done) {
					throw new Error("JSONL stream ended unexpectedly");
				}
			}
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

export interface ReadBytesLimitResult {
	bytes: Uint8Array;

	truncated: boolean;
}

export async function readBytesWithLimit(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<ReadBytesLimitResult> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of abortableSource(stream, signal)) {
		if (total + chunk.byteLength > maxBytes) {
			const accepted = maxBytes - total;
			if (accepted > 0) {
				chunks.push(chunk.subarray(0, accepted));
				total += accepted;
			}
			truncated = true;
			break;
		}
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

class ConcatSink {
	#space?: Buffer;
	#length = 0;
	#skipLeadingLf = false;

	#ensureCapacity(size: number): Buffer {
		const space = this.#space;
		if (space && space.length >= size) return space;
		const nextSize = space ? Math.max(size, space.length * 2) : size;
		const next = Buffer.allocUnsafe(nextSize);
		if (space && this.#length > 0) {
			space.copy(next, 0, 0, this.#length);
		}
		this.#space = next;
		return next;
	}

	append(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) return;
		const offset = this.#length;
		const space = this.#ensureCapacity(offset + n);
		space.set(chunk, offset);
		this.#length += n;
	}

	reset(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) {
			this.#length = 0;
			return;
		}
		const space = this.#ensureCapacity(n);
		space.set(chunk, 0);
		this.#length = n;
	}

	get isEmpty(): boolean {
		return this.#length === 0;
	}

	flush(): Uint8Array | undefined {
		if (!this.#length) return undefined;
		return this.#space!.subarray(0, this.#length);
	}

	clear() {
		this.#length = 0;
	}

	*appendAndFlushLines(chunk: Uint8Array, maxLineBytes: number) {
		// Snapshot newline-bearing chunks before the first yield. The stream source
		// may reuse its backing storage while this generator is suspended between
		// lines, so copying each direct suffix at its eventual yield is too late.
		const source = chunk.indexOf(LF) === -1 ? chunk : Buffer.from(chunk);
		let pos = 0;
		while (pos < source.length) {
			const nl = source.indexOf(LF, pos);
			const end = nl === -1 ? source.length : nl;
			if (this.#length + end - pos > maxLineBytes) {
				throw new RangeError(`Stream line exceeds the ${maxLineBytes}-byte limit`);
			}
			if (nl === -1) {
				this.append(source.subarray(pos));
				return;
			}
			const suffix = source.subarray(pos, nl);
			pos = nl + 1;
			if (this.isEmpty) {
				yield suffix;
			} else {
				this.append(suffix);
				const payload = this.flush();
				if (payload) {
					// Copy before yielding: the consumer may outlive this
					// generator step, and later appends would otherwise
					// mutate the retained line in place.
					yield Buffer.from(payload);
					this.clear();
				}
			}
		}
	}

	// Flushes through the last LF, CRLF, or lone CR. A chunk ending on CR defers the LF that may start the next chunk.
	appendAndFlushText(chunk: Uint8Array, decoder: TextDecoder): string | undefined {
		let start = 0;
		if (this.#skipLeadingLf) {
			if (chunk.length === 0) return undefined;
			this.#skipLeadingLf = false;
			if (chunk[0] === LF) start = 1;
		}

		const lastLineEnd = Math.max(chunk.lastIndexOf(LF), chunk.lastIndexOf(CR));
		if (lastLineEnd < start) {
			if (start < chunk.length) this.append(chunk.subarray(start));
			return undefined;
		}

		const completeEnd = lastLineEnd + 1;
		this.#skipLeadingLf = chunk[lastLineEnd] === CR && completeEnd === chunk.length;
		let text: string;
		if (this.isEmpty) {
			const complete = start === 0 && completeEnd === chunk.length ? chunk : chunk.subarray(start, completeEnd);
			text = decoder.decode(complete);
		} else {
			this.append(chunk.subarray(start, completeEnd));
			text = decoder.decode(this.flush());
			this.clear();
		}
		if (completeEnd < chunk.length) {
			this.append(chunk.subarray(completeEnd));
		}
		return text;
	}
	*pullJSONL<T>(chunk: Uint8Array, beg: number, end: number) {
		const newline = chunk.indexOf(LF, beg);
		if (newline === -1 || newline >= end) {
			if (this.isEmpty) this.reset(chunk.subarray(beg, end));
			else this.append(chunk.subarray(beg, end));
			return;
		}

		if (this.isEmpty) {
			const { values, error, read, done } = Bun.JSONL.parseChunk(chunk, beg, end);
			if (values.length > 0) {
				yield* values as T[];
			}
			if (error) throw error;
			if (done) return;
			this.reset(chunk.subarray(read, end));
			return;
		}

		const offset = this.#length;
		const n = end - beg;
		const total = offset + n;
		const space = this.#ensureCapacity(total);
		space.set(chunk.subarray(beg, end), offset);
		this.#length = total;

		const { values, error, read, done } = Bun.JSONL.parseChunk(space, 0, total);
		if (values.length > 0) {
			yield* values as T[];
		}
		if (error) throw error;
		if (done) {
			this.#length = 0;
			return;
		}
		const rem = total - read;
		if (rem < total) {
			space.copyWithin(0, read, total);
		}
		this.#length = rem;
	}
}

export type SseEventObserver = (event: ServerSentEvent) => void;

function notifySseEventObserver(observer: SseEventObserver | undefined, event: ServerSentEvent): void {
	if (!observer) return;
	try {
		observer(event);
	} catch {}
}

function isRecoverableTrailingJson(data: string): boolean {
	const first = data.trimStart()[0];
	if (first !== "{" && first !== "[") return false;

	const recovered = parseStreamingJson<unknown>(data);
	return typeof recovered === "object" && recovered !== null;
}

export interface ReadSseJsonOptions {
	malformed?: "skip" | "throw";
}

type SseFrame<T> = { ok: true; value: T } | { ok: false; raw: string; error: SyntaxError };

async function* readSseFrames<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
): AsyncGenerator<SseFrame<T>> {
	for await (const sse of readSseEvents(stream, signal)) {
		const isTrailing = trailingEvents.has(sse);
		notifySseEventObserver(onEvent, sse);
		const data = sse.data;
		if (data === "" || data === "[DONE]") {
			if (data === "[DONE]") return;
			continue;
		}
		let value: T;
		try {
			value = JSON.parse(data) as T;
		} catch (err) {
			if (!(err instanceof SyntaxError)) throw err;
			if (isTrailing && isRecoverableTrailingJson(data)) return;
			yield { ok: false, raw: data, error: err };
			continue;
		}
		yield { ok: true, value };
	}
}

export async function* readSseJson<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
	options?: ReadSseJsonOptions,
): AsyncGenerator<T> {
	for await (const frame of readSseFrames<T>(stream, signal, onEvent)) {
		if (frame.ok) yield frame.value;
		else if (options?.malformed !== "skip") throw frame.error;
	}
}

/**
 * Like {@link readSseJson}, but a non-JSON `data:` frame is yielded as its raw
 * text (e.g. a proxy's `429 Too Many Requests` after the stream committed to
 * HTTP 200). A JSON-encoded string frame is also yielded as a string, so
 * consumers must treat every string as untrusted text.
 */
export async function* readSseJsonOrText<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
): AsyncGenerator<T | string> {
	for await (const frame of readSseFrames<T>(stream, signal, onEvent)) {
		yield frame.ok ? frame.value : frame.raw;
	}
}

export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
	id?: string;
	retry?: number;
}

interface SseEventState {
	event: string | null;

	data: string | null;
	raw: string[];
	id?: string;
	retry?: number;
}

const SSE_DECODER = new TextDecoder("utf-8");

function flushSseEvent(state: SseEventState): ServerSentEvent | null {
	if (state.event === null && state.data === null && state.id === undefined && state.retry === undefined) {
		state.raw = [];
		return null;
	}
	const event: ServerSentEvent = {
		event: state.event,
		data: state.data ?? "",
		raw: state.raw,
	};
	if (state.id !== undefined) event.id = state.id;
	if (state.retry !== undefined) event.retry = state.retry;
	state.event = null;
	state.data = null;
	state.raw = [];
	state.id = undefined;
	state.retry = undefined;
	return event;
}

function pushSseLine(line: string, state: SseEventState): ServerSentEvent | null {
	if (line.length === 0) return flushSseEvent(state);

	if (line.charCodeAt(0) === 0x3a) {
		state.raw.push(line);
		return null;
	}

	state.raw.push(line);

	const colon = line.indexOf(":");
	const fieldName = colon === -1 ? line : line.slice(0, colon);
	let value = colon === -1 ? "" : line.slice(colon + 1);
	if (value.charCodeAt(0) === 0x20) value = value.slice(1);

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		if (state.data === null) {
			state.data = value;
		} else {
			state.data += "\n";
			state.data += value;
		}
	} else if (fieldName === "id") {
		if (!value.includes("\0")) state.id = value;
	} else if (fieldName === "retry" && value.length > 0) {
		let valid = true;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (code < 0x30 || code > 0x39) {
				valid = false;
				break;
			}
		}
		if (valid) {
			const retry = Number(value);
			if (Number.isSafeInteger(retry)) state.retry = retry;
		}
	}
	return null;
}

export async function* readSseEvents(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const lineBuffer = new ConcatSink();
	const state: SseEventState = { event: null, data: null, raw: [] };
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			const text = lineBuffer.appendAndFlushText(chunk, SSE_DECODER);
			if (text === undefined) continue;
			let start = 0;
			while (start < text.length) {
				let lineEnd = start;
				while (lineEnd < text.length) {
					const code = text.charCodeAt(lineEnd);
					if (code === LF || code === CR) break;
					lineEnd++;
				}
				const event = pushSseLine(text.slice(start, lineEnd), state);
				if (event) yield event;
				if (text.charCodeAt(lineEnd) === CR && text.charCodeAt(lineEnd + 1) === LF) lineEnd++;
				start = lineEnd + 1;
			}
		}

		if (!lineBuffer.isEmpty) {
			const tail = lineBuffer.flush();
			if (tail) {
				lineBuffer.clear();
				const event = pushSseLine(SSE_DECODER.decode(tail), state);
				if (event) {
					trailingEvents.add(event);
					yield event;
				}
			}
		}

		const trailing = flushSseEvent(state);
		if (trailing) {
			trailingEvents.add(trailing);
			yield trailing;
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

function advanceJsonlChunk<T>(
	buffer: string,
	onValues: (values: T[]) => void,
	options: { onMalformedRecord?: () => void },
): string {
	const { values, error, read, done } = Bun.JSONL.parseChunk(buffer);
	if (values.length > 0) onValues(values as T[]);
	if (error) {
		const nextNewline = buffer.indexOf("\n", read);
		const malformedEnd = nextNewline === -1 ? buffer.length : nextNewline;
		if (buffer.substring(read, malformedEnd).trim().length > 0) options.onMalformedRecord?.();
		if (nextNewline === -1) return "";
		return buffer.substring(nextNewline + 1);
	}
	if (read === 0) {
		if (buffer.trim().length > 0) options.onMalformedRecord?.();
		return "";
	}
	if (done) return "";
	return buffer.substring(read);
}

/** Parsed-records sink for {@link forEachJsonlRecord}; keeps per-record handling allocation-free. */
export type JsonlRecordSink<T> = (record: T) => void;

/**
 * Stream JSONL records to `onRecord` as they parse, skipping malformed lines exactly like
 * {@link parseJsonlLenient}. Unlike `parseJsonlLenient` it never materializes the full record
 * array, so scanning a transcript-sized buffer costs O(largest single record) memory instead of
 * O(buffer).
 */
export function forEachJsonlRecord<T>(
	buffer: string,
	onRecord: JsonlRecordSink<T>,
	options: { onMalformedRecord?: () => void } = {},
): void {
	let rest = buffer;
	while (rest.length > 0) {
		rest = advanceJsonlChunk<T>(
			rest,
			values => {
				for (const value of values) onRecord(value);
			},
			options,
		);
	}
}

export function parseJsonlLenient<T>(buffer: string, options: { onMalformedRecord?: () => void } = {}): T[] {
	const entries: T[] = [];
	let rest = buffer;
	while (rest.length > 0) {
		rest = advanceJsonlChunk<T>(
			rest,
			values => {
				for (const value of values) entries.push(value);
			},
			options,
		);
	}
	return entries;
}
