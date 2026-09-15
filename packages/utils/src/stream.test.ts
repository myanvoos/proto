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
