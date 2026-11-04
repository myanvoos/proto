import { describe, expect, test } from "bun:test";
import { SocketWriter } from "./socket-writer";

describe("SocketWriter", () => {
	test("short writes preserve UTF-8 bytes and FIFO framing across zero writes and drain", () => {
		const received: Uint8Array[] = [];
		let capacity = 2;
		const errors: Error[] = [];
		const writer = new SocketWriter(
			bytes => {
				const count = Math.min(capacity, bytes.byteLength);
				received.push(bytes.slice(0, count));
				capacity = 0;
				return count;
			},
			error => errors.push(error),
		);
		writer.send("雪🦊\n");
		writer.send("second\n");
		expect(Buffer.concat(received).byteLength).toBe(2);
		writer.drain(); // A spurious drain while the socket still accepts zero bytes.
		expect(Buffer.concat(received).byteLength).toBe(2);
		for (let index = 0; index < 20; index++) {
			capacity = 1;
			writer.drain();
		}
		expect(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(received))).toBe("雪🦊\nsecond\n");
		expect(errors).toEqual([]);
	});

	test("Node false accepts the whole buffer but pauses following frames until drain", () => {
		const received: Uint8Array[] = [];
		const writer = new SocketWriter(
			bytes => {
				received.push(bytes.slice());
				return false;
			},
			() => {},
		);
		writer.send("first\n");
		writer.send("second\n");
		expect(Buffer.concat(received).toString()).toBe("first\n");
		writer.drain();
		expect(Buffer.concat(received).toString()).toBe("first\nsecond\n");
	});

	test("replacing a blocked connection never writes its partial suffix into the next stream", () => {
		const oldBytes: Uint8Array[] = [];
		const old = new SocketWriter(
			bytes => {
				oldBytes.push(bytes.slice(0, 3));
				return Math.min(3, bytes.byteLength);
			},
			() => {},
		);
		old.send("stale-frame\n");
		old.send("also-stale\n");
		old.close();
		const received: Uint8Array[] = [];
		const next = new SocketWriter(
			bytes => {
				received.push(bytes.slice());
				return bytes.byteLength;
			},
			() => {},
		);
		old.drain();
		next.send("new-frame\n");
		expect(Buffer.concat(oldBytes).toString()).toBe("sta");
		expect(Buffer.concat(received).toString()).toBe("new-frame\n");
		expect(() => old.send("late\n")).toThrow("connection closed");
	});

	test("byte-bounded overflow fails visibly and prevents queued control replies from continuing", () => {
		const errors: Error[] = [];
		let writes = 0;
		const writer = new SocketWriter(
			() => {
				writes++;
				return 0;
			},
			error => errors.push(error),
			6,
		);
		writer.send("雪");
		writer.send("abc");
		expect(() => writer.send("x")).toThrow("backpressure limit exceeded");
		writer.drain();
		expect(writes).toBe(1);
		expect(errors.map(error => error.message)).toEqual(["Socket transport backpressure limit exceeded"]);
		expect(() => writer.send("later")).toThrow("backpressure limit exceeded");
	});

	test("drain write failures notify the owner once and permanently retire accepted replies", () => {
		const errors: Error[] = [];
		let fail = false;
		const writer = new SocketWriter(
			() => {
				if (fail) throw new Error("broken pipe");
				return 0;
			},
			error => errors.push(error),
		);
		writer.send("accepted reply\n");
		fail = true;
		writer.drain();
		writer.drain();
		expect(errors.map(error => error.message)).toEqual(["broken pipe"]);
		expect(() => writer.send("next reply\n")).toThrow("broken pipe");
	});
});
