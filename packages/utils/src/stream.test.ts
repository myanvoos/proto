import { expect, test } from "bun:test";
import { forEachJsonlRecord, parseJsonlLenient, readLines, readSseEvents, type ServerSentEvent } from "./stream";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

test("readLines yields stable line buffers that later chunks cannot mutate", async () => {
	const text = (value: string) => new TextEncoder().encode(value);
	const lines: string[] = [];
	for await (const line of readLines(streamOf([text("a"), text("\nb"), text("\nc\n")]))) {
		// Retain the raw bytes across the loop, like a JSONL consumer would.
		lines.push(new TextDecoder().decode(line));
	}
	// The retained second line must still read "b", not be corrupted to "cb"
	// by the trailing append reusing the sink buffer.
	expect(lines).toEqual(["a", "b", "c"]);
});

test("readLines applies byte limits per line across chunks, including an unterminated tail", async () => {
	const encoder = new TextEncoder();
	const decoded: string[] = [];
	for await (const line of readLines(streamOf([encoder.encode("界"), encoder.encode("x\ny\n1234")]), undefined, 4)) {
		decoded.push(new TextDecoder().decode(line));
	}
	expect(decoded).toEqual(["界x", "y", "1234"]);
});

for (const chunks of [["abc", "de"], ["abcde\n"]]) {
	test(`readLines rejects oversized ${chunks.length > 1 ? "fragmented tails" : "complete lines"} and cancels the source`, async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			},
			cancel() {
				cancelled = true;
			},
		});
		const lines = readLines(stream, undefined, 4);
		await expect(lines.next()).rejects.toThrow(/line exceeds.*4-byte limit/);
		expect(cancelled).toBe(true);
		expect(stream.locked).toBe(false);
	});
}

test("readLines snapshots pooled direct lines before the iterator resumes", async () => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const pool = encoder.encode("ab\ncd\n");
	const lines = readLines(streamOf([pool]))[Symbol.asyncIterator]();

	const first = await lines.next();
	pool.set(encoder.encode("ZZZ"), 3);
	const second = await lines.next();

	expect(decoder.decode(first.value)).toBe("ab");
	expect(decoder.decode(second.value)).toBe("cd");
});

test("readSseEvents dispatches CR-only events without waiting for the stream to end", async () => {
	const encoder = new TextEncoder();
	let closeSource = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("event: first\rdata: 1\r\revent: second\rdata: 2\r\r"));
			closeSource = () => controller.close();
		},
	});
	const iterator = readSseEvents(stream)[Symbol.asyncIterator]();
	const first = await iterator.next();
	const second = await iterator.next();
	closeSource();
	expect([first.value?.event, first.value?.data, second.value?.event, second.value?.data]).toEqual([
		"first",
		"1",
		"second",
		"2",
	]);
	expect((await iterator.next()).done).toBe(true);
});

test("readSseEvents joins a CRLF and a UTF-8 sequence split across chunks", async () => {
	const encoder = new TextEncoder();
	const events: ServerSentEvent[] = [];
	for await (const event of readSseEvents(
		streamOf([
			encoder.encode("event: utf\r"),
			encoder.encode("\ndata: caf"),
			Uint8Array.of(0xc3),
			Uint8Array.of(0xa9, 0x0d),
			encoder.encode("\n\r"),
			encoder.encode("\nevent: next\r\ndata: ok\r\n\r\n"),
		]),
	)) {
		events.push(event);
	}
	expect(events).toEqual([
		{ event: "utf", data: "café", raw: ["event: utf", "data: café"] },
		{ event: "next", data: "ok", raw: ["event: next", "data: ok"] },
	]);
});

test("forEachJsonlRecord streams records in order and skips malformed lines", () => {
	const buffer = [
		JSON.stringify({ n: 1 }),
		"{not json",
		JSON.stringify({ n: 2 }),
		"",
		JSON.stringify({ n: 3 }),
		"{truncated-no-newline",
	].join("\n");

	const seen: number[] = [];
	let malformed = 0;
	forEachJsonlRecord<{ n: number }>(buffer, record => seen.push(record.n), {
		onMalformedRecord: () => malformed++,
	});

	expect(seen).toEqual([1, 2, 3]);
	expect(malformed).toBe(2);
});

test("forEachJsonlRecord matches parseJsonlLenient output on the same buffer", () => {
	const records = Array.from({ length: 500 }, (_, i) => ({ i, text: `record-${i}`.repeat(4) }));
	const buffer = records.map(record => JSON.stringify(record)).join("\n") + "\n";

	const collected: Array<{ i: number; text: string }> = [];
	forEachJsonlRecord<{ i: number; text: string }>(buffer, record => collected.push(record));

	expect(collected).toEqual(parseJsonlLenient<{ i: number; text: string }>(buffer));
});
