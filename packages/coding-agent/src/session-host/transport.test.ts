import { describe, expect, test } from "bun:test";

import { SessionHostMux } from "./transport";

function text(chunk: Uint8Array): string {
	return new TextDecoder().decode(chunk);
}

async function nextChunk(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const result = await reader.read();
	reader.releaseLock();
	if (result.done) throw new Error("mux input closed unexpectedly");
	return result.value;
}

describe("SessionHostMux", () => {
	test("delivers fed chunks to the input stream", async () => {
		const mux = new SessionHostMux();
		mux.attach(() => 0);
		mux.feed(new TextEncoder().encode(`{"type":"prompt"}\n`));
		expect(text(await nextChunk(mux.input))).toBe(`{"type":"prompt"}\n`);
	});

	test("input stays open after client detach so runRpcMode never sees closure", async () => {
		const mux = new SessionHostMux();
		mux.attach(() => 0);
		mux.detach();
		const pending = nextChunk(mux.input);
		mux.attach(() => 0);
		mux.feed(new TextEncoder().encode("after-reattach\n"));
		expect(text(await pending)).toBe("after-reattach\n");
	});

	test("latest client wins and pending bytes from the detached client are dropped", async () => {
		const mux = new SessionHostMux();
		const firstLines: string[] = [];
		mux.attach(line => {
			firstLines.push(line);
			return 0;
		});
		mux.feed(new TextEncoder().encode("stale-partial-frame"));
		mux.attach(line => {
			void line;
			return 0;
		});
		mux.feed(new TextEncoder().encode("from-second\n"));
		expect(text(await nextChunk(mux.input))).toBe("from-second\n");
	});

	test("writeLine reaches only the attached client and is a no-op when detached", () => {
		const mux = new SessionHostMux();
		expect(() => mux.writeLine("dropped\n")).not.toThrow();
		const lines: string[] = [];
		mux.attach(line => {
			lines.push(line);
			return 0;
		});
		mux.writeLine("hello\n");
		expect(lines).toEqual(["hello\n"]);
		mux.detach();
		mux.writeLine("dropped\n");
		expect(lines).toEqual(["hello\n"]);
	});
});
