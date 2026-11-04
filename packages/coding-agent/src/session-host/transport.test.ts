import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { SocketWriter } from "../utils/socket-writer";
import { connectSessionRpc } from "./client";
import { listenSessionHost, SessionHostMux } from "./transport";

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
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		mux.feed(new TextEncoder().encode(`{"type":"prompt"}\n`));
		expect(text(await nextChunk(mux.input))).toBe(`{"type":"prompt"}\n`);
	});

	test("input stays open after client detach so runRpcMode never sees closure", async () => {
		const mux = new SessionHostMux();
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		mux.detach();
		const pending = nextChunk(mux.input);
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		mux.feed(new TextEncoder().encode("after-reattach\n"));
		expect(text(await pending)).toBe("after-reattach\n");
	});

	test("latest client wins and pending bytes from the detached client are dropped", async () => {
		const mux = new SessionHostMux();
		const firstLines: string[] = [];
		mux.attach(
			new SocketWriter(
				bytes => {
					firstLines.push(text(bytes));
					return bytes.byteLength;
				},
				() => {},
			),
		);
		mux.feed(new TextEncoder().encode("stale-partial-frame"));
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		mux.feed(new TextEncoder().encode("from-second\n"));
		expect(text(await nextChunk(mux.input))).toBe("from-second\n");
	});

	test("a split multibyte command from a disconnected client cannot poison replacement commands", async () => {
		const mux = new SessionHostMux();
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		const stale = new TextEncoder().encode('{"prompt":"🦊"}\n');
		mux.feed(stale.subarray(0, stale.byteLength - 4));
		// Force a consumer to be waiting while the old UTF-8 sequence is incomplete.
		const pending = nextChunk(mux.input);
		await Promise.resolve();
		mux.detach();
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		mux.feed(new TextEncoder().encode('{"prompt":"雪"}\n'));
		expect(new TextDecoder("utf8", { fatal: true }).decode(await pending)).toBe('{"prompt":"雪"}\n');
		mux.close();
	});

	test("replacement between wake and input delivery does not strand the new client's command", async () => {
		const mux = new SessionHostMux();
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		const attachedGeneration = mux.attachmentGeneration;
		const pending = nextChunk(mux.input);
		await Promise.resolve();
		mux.feed(new TextEncoder().encode("retired-before-delivery\n"));
		expect(mux.attachmentGeneration).toBe(attachedGeneration);
		mux.detach();
		await Promise.resolve();
		mux.attach(
			new SocketWriter(
				bytes => bytes.byteLength,
				() => {},
			),
		);
		mux.feed(new TextEncoder().encode("replacement\n"));
		expect(mux.attachmentGeneration).toBeGreaterThan(attachedGeneration);
		expect(text(await pending)).toBe("replacement\n");
		mux.close();
	});

	test("writeLine reaches only the attached client and is a no-op when detached", () => {
		const mux = new SessionHostMux();
		expect(() => mux.writeLine("dropped\n")).not.toThrow();
		const lines: string[] = [];
		mux.attach(
			new SocketWriter(
				bytes => {
					lines.push(text(bytes));
					return bytes.byteLength;
				},
				() => {},
			),
		);
		mux.writeLine("hello\n");
		expect(lines).toEqual(["hello\n"]);
		mux.detach();
		mux.writeLine("dropped\n");
		expect(lines).toEqual(["hello\n"]);
	});
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function socketFixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-mux-socket-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const socketPath = path.join(dir, "host.sock");
	const host = await listenSessionHost(socketPath);
	cleanups.push(() => host.stop());
	return { host, socketPath };
}

async function pausedPeer(socketPath: string): Promise<net.Socket> {
	const socket = net.createConnection(socketPath);
	cleanups.push(() => {
		socket.destroy();
	});
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.once("connect", resolve);
	socket.once("error", reject);
	await promise;
	socket.pause();
	return socket;
}

describe("session host real socket backpressure", () => {
	test("a slow receiver gets every large encoded UTF-8 frame before the following control reply", async () => {
		const { host, socketPath } = await socketFixture();
		const peer = await pausedPeer(socketPath);
		peer.write("attached\n");
		expect(text(await nextChunk(host.mux.input))).toBe("attached\n");
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const frames = [...encoder.encodeFrames({ type: "catalog", description: "雪🦊".repeat(512 * 1024) })];
		frames.push(...encoder.encodeFrames({ type: "response", id: "control", success: true }));
		const expected = Buffer.from(frames.join(""));
		const chunks: Buffer[] = [];
		let bytes = 0;
		const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
		peer.on("data", chunk => {
			const received = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			chunks.push(received);
			bytes += received.byteLength;
			if (bytes >= expected.byteLength) resolve(Buffer.concat(chunks));
		});
		peer.once("error", reject);
		// The peer remains paused for the entire burst; queued suffixes must wait for drain.
		for (const frame of frames) host.mux.writeLine(frame);
		peer.resume();
		expect(await promise).toEqual(expected);
	}, 10_000);

	test("replacing a paused client discards its queued catalog and partial command only", async () => {
		const { host, socketPath } = await socketFixture();
		const old = await pausedPeer(socketPath);
		old.write("attached\n");
		await nextChunk(host.mux.input);
		old.write('{"type":"unfinished","text":"');
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		for (const frame of encoder.encodeFrames({ stale: "雪🦊".repeat(512 * 1024) })) host.mux.writeLine(frame);
		const current = await connectSessionRpc(socketPath);
		cleanups.push(() => current.close());
		const command = { type: "get_state", id: "new-雪🦊", padding: "large-雪🦊".repeat(32 * 1024) };
		current.sendCommand(command);
		const received = await nextChunk(host.mux.input);
		expect(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(received))).toEqual(command);
		host.mux.writeLine(`${JSON.stringify({ type: "response", id: command.id, success: true })}\n`);
		expect(await current.frames.findResponse(command.id, 1000)).toEqual({
			type: "response",
			id: command.id,
			success: true,
		});
	}, 10_000);
});
