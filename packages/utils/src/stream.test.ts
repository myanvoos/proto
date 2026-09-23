import { expect, test } from "bun:test";
import { readLines } from "./stream";

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
