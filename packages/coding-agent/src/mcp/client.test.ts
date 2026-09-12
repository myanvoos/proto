import { afterEach, expect, test } from "bun:test";
import { connectToServer } from "./client";
import { HttpTransport } from "./transports/http";
import type { JsonRpcMessage } from "./types";

const encoder = new TextEncoder();
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	while (servers.length > 0) servers.pop()?.stop(true);
});

function serve(options: Parameters<typeof Bun.serve>[0]): Bun.Server<undefined> {
	const server = Bun.serve(options);
	servers.push(server);
	return server;
}

function hangingResponse(req: Request, aborted: { resolve: () => void }): Promise<Response> {
	const { promise, resolve } = Promise.withResolvers<Response>();
	if (req.signal.aborted) {
		aborted.resolve();
		resolve(new Response(null, { status: 499 }));
	} else {
		req.signal.addEventListener(
			"abort",
			() => {
				aborted.resolve();
				resolve(new Response(null, { status: 499 }));
			},
			{ once: true },
		);
	}
	return promise;
}

function initializeResult(id: unknown): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				serverInfo: { name: "fixture", version: "1" },
			},
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function readMessage(req: Request): Promise<Extract<JsonRpcMessage, { method: string }>> {
	const message = (await req.json()) as JsonRpcMessage;
	if (!("method" in message)) throw new Error("Expected a JSON-RPC request or notification");
	return message;
}

test("connectToServer aborts a hanging initialized notification", async () => {
	const initializedReceived = Promise.withResolvers<void>();
	const initializedAborted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const server = serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return new Response(null, { status: 404 });
			const message = await readMessage(req);
			if (message.method === "initialize" && "id" in message) return initializeResult(message.id);
			if (message.method === "notifications/initialized") {
				initializedReceived.resolve();
				return hangingResponse(req, initializedAborted);
			}
			return new Response(null, { status: 202 });
		},
	});

	const pending = connectToServer(
		"notification-hang",
		{ type: "http", url: server.url.href, timeout: 0 },
		{ signal: controller.signal },
	);
	pending.catch(() => {});
	await initializedReceived.promise;
	controller.abort(new Error("cancel notification handshake"));

	await expect(pending).rejects.toThrow("cancel notification handshake");
	await initializedAborted.promise;
});

test("connectToServer aborts a hanging HTTP SSE listener startup", async () => {
	const listenerReceived = Promise.withResolvers<void>();
	const listenerAborted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const server = serve({
		port: 0,
		async fetch(req) {
			if (req.method === "POST") {
				const message = await readMessage(req);
				if (message.method === "initialize" && "id" in message) return initializeResult(message.id);
				return new Response(null, { status: 202 });
			}
			if (req.method === "GET") {
				listenerReceived.resolve();
				return hangingResponse(req, listenerAborted);
			}
			return new Response(null, { status: 404 });
		},
	});

	const pending = connectToServer(
		"listener-hang",
		{ type: "http", url: server.url.href, timeout: 0 },
		{ signal: controller.signal },
	);
	pending.catch(() => {});
	await listenerReceived.promise;
	controller.abort(new Error("cancel listener startup"));

	await expect(pending).rejects.toThrow("cancel listener startup");
	await listenerAborted.promise;
});

test("connectToServer aborts a legacy SSE endpoint handshake before assignment", async () => {
	const endpointReceived = Promise.withResolvers<void>();
	const endpointAborted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const server = serve({
		port: 0,
		fetch(req) {
			const response = hangingResponse(req, endpointAborted);
			endpointReceived.resolve();
			return response;
		},
	});

	const pending = connectToServer(
		"legacy-hang",
		{ type: "sse", url: server.url.href, timeout: 0 },
		{ signal: controller.signal },
	);
	pending.catch(() => {});
	await endpointReceived.promise;
	controller.abort(new Error("cancel legacy endpoint"));

	// Real-socket handshake under full-suite load can take longer than the
	// default 5s test timeout before the abort rejection surfaces.
	await expect(pending).rejects.toThrow("cancel legacy endpoint");
}, 15_000);

test("closing HTTP transport aborts an SSE response drain after its result arrives", async () => {
	const responseCancelled = Promise.withResolvers<void>();
	const server = serve({
		port: 0,
		async fetch(req) {
			const message = await readMessage(req);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									jsonrpc: "2.0",
									id: "id" in message ? message.id : 0,
									result: { ok: true },
								})}\n\n`,
							),
						);
					},
					cancel() {
						responseCancelled.resolve();
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 0 });
	await transport.connect();

	await expect(transport.request("initialize")).resolves.toEqual({ ok: true });
	await transport.close();
	await responseCancelled.promise;
});
