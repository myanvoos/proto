import { describe, expect, test } from "bun:test";
import { readBoundedText } from "./fetch";

const CAP = 1024;

describe("readBoundedText", () => {
	test("caps a body that omits or misreports content-length", async () => {
		const oversized = "x".repeat(CAP * 4);

		// Regression: the Jina reader used `response.text()`, which buffers the whole
		// body no matter what `content-length` claims (or omits).
		expect(await readBoundedText(new Response(oversized), CAP)).toBeNull();
		expect(await readBoundedText(new Response(oversized, { headers: { "content-length": "10" } }), CAP)).toBeNull();
	});

	test("returns bodies within the cap unchanged", async () => {
		expect(await readBoundedText(new Response("hello"), CAP)).toBe("hello");
		expect(await readBoundedText(new Response(""), CAP)).toBe("");
		const exact = "y".repeat(CAP);
		expect(await readBoundedText(new Response(exact), CAP)).toBe(exact);
	});

	test("decodes multi-byte text split across stream chunks", async () => {
		const bytes = new TextEncoder().encode("héllo wörld");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Split inside the two-byte `é` so a naive per-chunk decode would corrupt it.
				controller.enqueue(bytes.slice(0, 2));
				controller.enqueue(bytes.slice(2));
				controller.close();
			},
		});

		expect(await readBoundedText(new Response(stream), CAP)).toBe("héllo wörld");
	});
});
