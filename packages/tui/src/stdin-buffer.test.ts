import { describe, expect, it } from "bun:test";
import { StdinBuffer } from "./stdin-buffer";

function collect(): { received: string[]; buffer: StdinBuffer } {
	const received: string[] = [];
	const buffer = new StdinBuffer({ timeout: 5 });
	buffer.on("data", (sequence: string) => received.push(sequence));
	return { received, buffer };
}

describe("StdinBuffer", () => {
	it("reassembles a multibyte UTF-8 character split across chunks", () => {
		const { received, buffer } = collect();
		buffer.process(Buffer.from([0xc3]));
		buffer.process(Buffer.from([0xa9]));
		buffer.flush();
		expect(received.join("")).toBe("é");
	});

	it("reassembles a four-byte emoji split into single-byte chunks", () => {
		const { received, buffer } = collect();
		for (const byte of Buffer.from("🦀", "utf8")) {
			buffer.process(Buffer.from([byte]));
		}
		buffer.flush();
		expect(received.join("")).toBe("🦀");
	});

	it("normalizes a lone 8-bit C1 CSI reply to its 7-bit form", () => {
		const { received, buffer } = collect();
		buffer.process(Buffer.from([0x9b]));
		buffer.process(Buffer.from("A"));
		expect(received).toContain("\x1b[A");
	});

	it("does not mistake UTF-8 continuation bytes for C1 introducers", () => {
		const { received, buffer } = collect();
		// 0x9f is both a C1 APC introducer and a valid UTF-8 continuation byte;
		// with a pending lead sequence it must complete the character instead.
		for (const byte of Buffer.from("🟿", "utf8")) {
			buffer.process(Buffer.from([byte]));
		}
		buffer.flush();
		expect(received.join("")).toBe("🟿");
	});

	it("recognizes a batched 8-bit C1 sequence inside one chunk", () => {
		const { received, buffer } = collect();
		buffer.process(Buffer.from([0x9b, 0x41]));
		expect(received.join("")).toContain("\x1b[A");
	});

	it("recognizes batched C1 OSC with ST terminator", () => {
		const { received, buffer } = collect();
		buffer.process(Buffer.from([0x9d, 0x30, 0x9c]));
		expect(received.join("")).toBe("\x1b]0\x1b\\");
	});

	it("materializes a held UTF-8 tail on explicit flush instead of completing later", () => {
		const { received, buffer } = collect();
		const flushed: string[] = [];
		buffer.process(Buffer.from([0xc3]));
		flushed.push(...buffer.flush());
		buffer.process(Buffer.from([0x41]));
		flushed.push(...buffer.flush());
		expect(flushed.join("")).toBe("\ufffd");
		expect(received.join("")).toBe("A");
	});

	it("still routes complete 7-bit escape sequences unchanged", () => {
		const { received, buffer } = collect();
		buffer.process(Buffer.from("\x1b[A"));
		expect(received).toContain("\x1b[A");
	});
});
