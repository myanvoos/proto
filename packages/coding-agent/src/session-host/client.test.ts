import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RPC_FRAME_BYTES } from "../modes/rpc/rpc-frame";
import { AttachClient } from "./attach-cli";
import { connectSessionRpc, RpcFrameQueue } from "./client";
import { negotiateSessionHost } from "./ensure";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(onConnection: (socket: Socket) => void): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "proto-rpc-client-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const sockets = new Set<Socket>();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		onConnection(socket);
	});
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise<void>(resolve => server.close(() => resolve()));
	});
	const path = join(dir, "rpc.sock");
	await new Promise<void>(resolve => server.listen(path, resolve));
	return path;
}

async function bounded<T>(promise: Promise<T>): Promise<T | "test deadline"> {
	const timer = Promise.withResolvers<"test deadline">();
	const id = setTimeout(() => timer.resolve("test deadline"), 250);
	try {
		return await Promise.race([promise, timer.promise]);
	} finally {
		clearTimeout(id);
	}
}

describe("session RPC client lifecycle", () => {
	test("response deadlines expire on an idle connection", async () => {
		const queue = new RpcFrameQueue();
		const result = queue.findResponse("absent", 5).then(
			() => "unexpected response",
			error => error.message,
		);
		expect(await bounded(result)).toBe("timed out waiting for rpc response absent");
	});

	test("socket fragments preserve UTF-8 and complete JSON lines", async () => {
		const path = await serve(socket => {
			const payload = Buffer.from(`${JSON.stringify({ id: "one", text: "hello 🦊" })}\n`);
			const split = payload.indexOf(Buffer.from("🦊")) + 1;
			socket.write(payload.subarray(0, split));
			setTimeout(() => socket.write(payload.subarray(split)), 10);
		});
		const connection = await connectSessionRpc(path);
		cleanups.push(() => connection.close());
		expect(await bounded(connection.frames.findResponse("one", 100))).toEqual({ id: "one", text: "hello 🦊" });
	});

	test("disconnect releases pending readers and response waiters", async () => {
		const path = await serve(socket => {
			setTimeout(() => socket.end(), 10);
		});
		const connection = await connectSessionRpc(path);
		cleanups.push(() => connection.close());
		const reader = connection.frames.next().then(
			() => "frame",
			error => error.message,
		);
		const response = connection.frames.findResponse("absent", 60_000).then(
			() => "frame",
			error => error.message,
		);
		expect(await bounded(reader)).toBe("session RPC connection closed");
		expect(await bounded(response)).toBe("session RPC connection closed");
	});

	test("oversized unterminated frames close the connection instead of accumulating", async () => {
		const path = await serve(socket => {
			socket.write("x".repeat(MAX_RPC_FRAME_BYTES));
		});
		const connection = await connectSessionRpc(path);
		cleanups.push(() => connection.close());
		const result = connection.frames.next().then(
			() => "frame",
			error => error.message,
		);
		expect(await bounded(result)).toBe("session RPC frame exceeded the transport limit");
		await connection.closed;
	});

	test("repeated concurrent queue readers settle on close", async () => {
		for (let cycle = 0; cycle < 100; cycle++) {
			const queue = new RpcFrameQueue();
			const waits = Array.from({ length: 20 }, (_, index) =>
				(index % 2 ? queue.next() : queue.findResponse(String(index), 60_000)).then(
					() => "frame",
					error => error.message,
				),
			);
			queue.close();
			expect(await Promise.all(waits)).toEqual(Array(20).fill("session RPC connection closed"));
		}
	});

	test("attach closes settle pending and future requests immediately", async () => {
		const path = await serve(() => {});
		const connection = await connectSessionRpc(path);
		const client = new AttachClient(connection);
		cleanups.push(() => client.close());
		const pending = Array.from({ length: 50 }, () => client.request({ type: "get_state" }));
		client.close();
		const results = await bounded(Promise.all(pending));
		expect(results).toEqual(Array(50).fill({ success: false, error: "session RPC connection closed" }));
		expect(await bounded(client.request({ type: "get_state" }))).toEqual({
			success: false,
			error: "session RPC connection closed",
		});
	});

	test("silent probes time out and close their sockets", async () => {
		const ended = Promise.withResolvers<void>();
		const path = await serve(socket => {
			socket.resume();
			socket.once("end", ended.resolve);
		});
		expect((await negotiateSessionHost(path, 5)).socket).toBe("connecting");
		expect(await bounded(ended.promise)).toBeUndefined();
	});

	test("each successful probe closes its socket", async () => {
		let connections = 0;
		let closed = 0;
		const path = await serve(socket => {
			connections++;
			socket.once("end", () => {
				closed++;
			});
			socket.once("data", () =>
				socket.write(`${JSON.stringify({ type: "response", id: "probe", success: true })}\n`),
			);
		});
		for (let i = 0; i < 20; i++) expect((await negotiateSessionHost(path, 100)).socket).toBe("live");
		for (let i = 0; i < 50 && closed !== connections; i++) await Bun.sleep(2);
		expect(connections).toBe(20);
		expect(closed).toBe(connections);
	});
});
