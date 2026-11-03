import { expect, test } from "bun:test";
import { type AnyMessage, RequestError, RpcConnection } from "./transport";

test("permission cancellation aborts opted-in handlers and suppresses their late result", async () => {
	const inbound = new TransformStream<AnyMessage, AnyMessage>();
	const outbound = new TransformStream<AnyMessage, AnyMessage>();
	const started = Promise.withResolvers<void>();
	let observed: AbortSignal | undefined;
	const connection = new RpcConnection(
		{ readable: inbound.readable, writable: outbound.writable },
		async (method, _params, notification, signal) => {
			if (notification) return;
			if (method === "ping") return { pong: true };
			observed = signal;
			started.resolve();
			const aborted = Promise.withResolvers<void>();
			signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return { late: true };
		},
		{ honorsInboundCancellation: true },
	);
	const writer = inbound.writable.getWriter();
	const reader = outbound.readable.getReader();
	await writer.write({ jsonrpc: "2.0", id: 7, method: "permission" });
	await started.promise;
	await writer.write({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 7 } });
	expect(observed?.aborted).toBe(true);
	expect((await reader.read()).value).toMatchObject({ id: 7, error: { code: -32800 } });
	await writer.write({ jsonrpc: "2.0", id: 9, method: "ping" });
	expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 9, result: { pong: true } });
	await writer.close();
	await connection.closed;
});

test("cancellation does not hide results from handlers that did not opt in", async () => {
	const inbound = new TransformStream<AnyMessage, AnyMessage>();
	const outbound = new TransformStream<AnyMessage, AnyMessage>();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const connection = new RpcConnection(
		{ readable: inbound.readable, writable: outbound.writable },
		async (_method, _params, notification) => {
			if (notification) return;
			started.resolve();
			await release.promise;
			return { completed: true };
		},
	);
	const writer = inbound.writable.getWriter();
	const reader = outbound.readable.getReader();
	await writer.write({ jsonrpc: "2.0", id: 8, method: "work" });
	await started.promise;
	await writer.write({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 8 } });
	release.resolve();
	expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 8, result: { completed: true } });
	await writer.close();
	await connection.closed;
});

test("a clean EOF answers accepted requests before the connection closes", async () => {
	const inbound = new TransformStream<AnyMessage, AnyMessage>();
	const outbound = new TransformStream<AnyMessage, AnyMessage>();
	const sessionStarted = Promise.withResolvers<void>();
	const releaseSession = Promise.withResolvers<void>();
	const connection = new RpcConnection({ writable: outbound.writable, readable: inbound.readable }, async method => {
		if (method === "initialize") return { protocolVersion: 1 };
		if (method === "session/new") {
			sessionStarted.resolve();
			await releaseSession.promise;
			return { sessionId: "session-1" };
		}
		throw RequestError.methodNotFound(method);
	});
	const writer = inbound.writable.getWriter();
	const reader = outbound.readable.getReader();
	await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
	await writer.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
	await sessionStarted.promise;
	await writer.close();

	expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
	let closed = false;
	void connection.closed.then(() => {
		closed = true;
	});
	await Bun.sleep(25);
	expect(closed).toBe(false);

	releaseSession.resolve();
	expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } });
	await connection.closed;
	reader.releaseLock();
});

test("a read error closes the connection without waiting for inbound handlers", async () => {
	const inbound = new TransformStream<AnyMessage, AnyMessage>();
	const outbound = new TransformStream<AnyMessage, AnyMessage>();
	const started = Promise.withResolvers<void>();
	const hold = Promise.withResolvers<void>();
	const connection = new RpcConnection({ writable: outbound.writable, readable: inbound.readable }, async () => {
		started.resolve();
		await hold.promise;
		return {};
	});
	const writer = inbound.writable.getWriter();
	await writer.write({ jsonrpc: "2.0", id: 1, method: "slow" });
	await started.promise;
	await writer.abort(new Error("broken pipe"));
	await connection.closed;
	expect(connection.signal.aborted).toBe(true);
	hold.resolve();
});
