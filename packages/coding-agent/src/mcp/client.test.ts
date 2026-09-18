import { afterEach, expect, test, vi } from "bun:test";
import { connectToServer, listPrompts, listResources, listResourceTemplates, listTools } from "./client";
import { HttpTransport } from "./transports/http";
import type { JsonRpcMessage, MCPRequestOptions, MCPServerConnection, MCPTransport } from "./types";

const encoder = new TextEncoder();
const servers: Bun.Server<undefined>[] = [];

interface NamedListItem {
	name: string;
}

type FakeRequestHandler = (
	method: string,
	params: Record<string, unknown> | undefined,
	options: MCPRequestOptions | undefined,
) => unknown | Promise<unknown>;

class FakeTransport implements MCPTransport {
	readonly connected = true;
	#handler: FakeRequestHandler;

	constructor(handler: FakeRequestHandler) {
		this.#handler = handler;
	}

	async connect(): Promise<void> {}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		return (await this.#handler(method, params, options)) as T;
	}

	async notify(): Promise<void> {}

	async close(): Promise<void> {}
}

interface PaginationCase {
	label: string;
	method: string;
	resultKey: "tools" | "resources" | "resourceTemplates" | "prompts";
	item: (name: string) => NamedListItem;
	list: (connection: MCPServerConnection) => Promise<NamedListItem[]>;
	cached: (connection: MCPServerConnection) => NamedListItem[] | undefined;
}

const paginationCases: PaginationCase[] = [
	{
		label: "tools/list",
		method: "tools/list",
		resultKey: "tools",
		item: name => ({ name, inputSchema: { type: "object" } }),
		list: connection => listTools(connection),
		cached: connection => connection.tools,
	},
	{
		label: "resources/list",
		method: "resources/list",
		resultKey: "resources",
		item: name => ({ name, uri: `file:///${name}` }),
		list: connection => listResources(connection),
		cached: connection => connection.resources,
	},
	{
		label: "resources/templates/list",
		method: "resources/templates/list",
		resultKey: "resourceTemplates",
		item: name => ({ name, uriTemplate: `file:///{${name}}` }),
		list: connection => listResourceTemplates(connection),
		cached: connection => connection.resourceTemplates,
	},
	{
		label: "prompts/list",
		method: "prompts/list",
		resultKey: "prompts",
		item: name => ({ name }),
		list: connection => listPrompts(connection),
		cached: connection => connection.prompts,
	},
];

function fakeConnection(transport: MCPTransport, timeout = 0): MCPServerConnection {
	return {
		name: "fixture",
		config: { command: "fixture", timeout },
		transport,
		serverInfo: { name: "fixture", version: "1" },
		capabilities: { tools: {}, resources: {}, prompts: {} },
	};
}

function listResult(testCase: PaginationCase, items: NamedListItem[], nextCursor?: string): Record<string, unknown> {
	return { [testCase.resultKey]: items, nextCursor };
}

async function expectPaginationError(operation: () => Promise<unknown>, expectedMessage: string): Promise<void> {
	try {
		await operation();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		expect(error.message).toBe(expectedMessage);
		return;
	}
	throw new Error(`Expected pagination to fail with: ${expectedMessage}`);
}

afterEach(() => {
	vi.useRealTimers();
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

for (const testCase of paginationCases) {
	test(`${testCase.label} returns all pages in order`, async () => {
		const pages = [
			{ items: [testCase.item("first"), testCase.item("second")], nextCursor: "page-2" },
			{ items: [testCase.item("third")], nextCursor: "page-3" },
			{ items: [testCase.item("fourth")], nextCursor: undefined },
		];
		let calls = 0;
		const transport = new FakeTransport((method, params) => {
			expect(method).toBe(testCase.method);
			expect(params).toEqual(calls === 0 ? {} : { cursor: pages[calls - 1]?.nextCursor });
			const page = pages[calls];
			if (!page) throw new Error("Pagination requested an unexpected page");
			calls++;
			return listResult(testCase, page.items, page.nextCursor);
		});
		const connection = fakeConnection(transport);

		const result = await testCase.list(connection);

		expect(result.map(item => item.name)).toEqual(["first", "second", "third", "fourth"]);
		expect(calls).toBe(3);
	});

	test(`${testCase.label} rejects a repeated cursor without caching duplicate items`, async () => {
		let calls = 0;
		const transport = new FakeTransport(method => {
			expect(method).toBe(testCase.method);
			calls++;
			if (calls > 2) throw new Error("Transport guard: repeated cursor was requested again");
			return listResult(testCase, [testCase.item("duplicate")], "same-cursor");
		});
		const connection = fakeConnection(transport);

		await expectPaginationError(
			() => testCase.list(connection),
			`MCP ${testCase.method} pagination repeated cursor: same-cursor`,
		);
		expect(calls).toBe(2);
		expect(testCase.cached(connection)).toBeUndefined();
	});

	test(`${testCase.label} rejects pagination beyond 100 pages`, async () => {
		let calls = 0;
		const transport = new FakeTransport(method => {
			expect(method).toBe(testCase.method);
			calls++;
			if (calls > 100) throw new Error("Transport guard: page limit was not enforced");
			return listResult(testCase, [], `page-${calls + 1}`);
		});
		const connection = fakeConnection(transport);

		await expectPaginationError(
			() => testCase.list(connection),
			`MCP ${testCase.method} pagination exceeded 100 pages`,
		);
		expect(calls).toBe(100);
		expect(testCase.cached(connection)).toBeUndefined();
	});

	test(`${testCase.label} rejects more than 10000 accumulated items`, async () => {
		let calls = 0;
		const item = testCase.item("item");
		const transport = new FakeTransport(method => {
			expect(method).toBe(testCase.method);
			calls++;
			if (calls === 1) return listResult(testCase, Array<NamedListItem>(6_000).fill(item), "page-2");
			if (calls === 2) return listResult(testCase, Array<NamedListItem>(4_001).fill(item));
			throw new Error("Transport guard: item limit was not enforced");
		});
		const connection = fakeConnection(transport);

		await expectPaginationError(
			() => testCase.list(connection),
			`MCP ${testCase.method} returned more than 10000 items`,
		);
		expect(calls).toBe(2);
		expect(testCase.cached(connection)).toBeUndefined();
	});

	test(`${testCase.label} applies one deadline to the whole pagination operation`, async () => {
		vi.useFakeTimers();
		let calls = 0;
		let operationSignal: AbortSignal | undefined;
		const transport = new FakeTransport((method, _params, options) => {
			expect(method).toBe(testCase.method);
			calls++;
			if (!options?.signal) throw new Error("Pagination request did not receive a deadline signal");
			if (calls === 1) {
				operationSignal = options.signal;
				vi.advanceTimersByTime(6);
				expect(operationSignal.aborted).toBe(false);
				return listResult(testCase, [testCase.item("first")], "page-2");
			}
			if (!operationSignal) throw new Error("Pagination operation signal changed before the second page");
			expect(options.signal).toBe(operationSignal);
			vi.advanceTimersByTime(5);
			return listResult(testCase, [testCase.item("second")]);
		});
		const connection = fakeConnection(transport, 10);

		await expectPaginationError(
			() => testCase.list(connection),
			`MCP ${testCase.method} pagination timed out after 10ms`,
		);
		expect(calls).toBe(2);
		expect(operationSignal?.aborted).toBe(true);
		expect(testCase.cached(connection)).toBeUndefined();
	});
}
