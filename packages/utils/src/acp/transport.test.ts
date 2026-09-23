import { expect, test } from "bun:test";
import { type AnyMessage, RequestError, RpcConnection } from "./transport";

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
