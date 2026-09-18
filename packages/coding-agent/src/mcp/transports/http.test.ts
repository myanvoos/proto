import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { callTool, connectToServer, disconnectServer, listTools } from "../client";
import { HttpTransport } from "./http";

const URL = "https://mcp.example.test/rpc";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
	});
}

function mockGlobalFetch(
	implementation: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>,
): void {
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

test("plain JSON rejects a response for a different request ID", async () => {
	mockGlobalFetch(async (_input, init) => {
		const request = JSON.parse(String(init?.body)) as { id: string | number };
		const wrongId = typeof request.id === "number" ? request.id + 1 : `${request.id}-wrong`;
		return jsonResponse({ jsonrpc: "2.0", id: wrongId, result: { acceptedWrongResponse: true } });
	});
	const transport = new HttpTransport({ type: "http", url: URL });
	await transport.connect();

	await expect(transport.request("tools/list")).rejects.toThrow("response ID");
});

test.each([
	["missing jsonrpc", { id: 1, result: {} }],
	["wrong jsonrpc version", { jsonrpc: "1.0", id: 1, result: {} }],
	["neither result nor error", { jsonrpc: "2.0", id: 1 }],
	["both result and error", { jsonrpc: "2.0", id: 1, result: {}, error: { code: -32_000, message: "ambiguous" } }],
	["malformed error", { jsonrpc: "2.0", id: 1, error: { code: "bad", message: 42 } }],
])("plain JSON rejects an invalid response envelope: %s", async (_label, responseBody) => {
	spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(responseBody));
	const transport = new HttpTransport({ type: "http", url: URL, requestIdFormat: "number" });
	await transport.connect();

	await expect(transport.request("tools/list")).rejects.toThrow("Invalid JSON-RPC response");
});

function oversizedStream(payload: string, cancelled: { value: boolean }): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(payload);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
		},
		cancel() {
			cancelled.value = true;
		},
	});
}

test("plain JSON rejects and cancels a response body above its byte cap", async () => {
	const cancelled = { value: false };
	mockGlobalFetch(async (_input, init) => {
		const request = JSON.parse(String(init?.body)) as { id: string | number };
		const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "x".repeat(9 * 1024 * 1024) });
		return new Response(oversizedStream(payload, cancelled), {
			headers: { "Content-Type": "application/json" },
		});
	});
	const transport = new HttpTransport({ type: "http", url: URL });
	await transport.connect();

	await expect(transport.request("resources/read")).rejects.toThrow("JSON response exceeded");
	expect(cancelled.value).toBe(true);
});

test("HTTP diagnostics reject and cancel a response body above their smaller byte cap", async () => {
	const cancelled = { value: false };
	spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(oversizedStream("x".repeat(32 * 1024), cancelled), { status: 500 }),
	);
	const transport = new HttpTransport({ type: "http", url: URL });
	await transport.connect();

	await expect(transport.request("tools/list")).rejects.toThrow("diagnostic exceeded");
	expect(cancelled.value).toBe(true);
});

test("an oversized 401 diagnostic preserves status and authentication recovery", async () => {
	let requests = 0;
	let authRefreshes = 0;
	mockGlobalFetch(async (_input, init) => {
		requests++;
		const request = JSON.parse(String(init?.body)) as { id: string | number };
		if (requests === 1) {
			return new Response("x".repeat(32 * 1024), {
				status: 401,
				headers: {
					"WWW-Authenticate": 'Bearer realm="fixture"',
					"Mcp-Auth-Server": "https://auth.example.test",
				},
			});
		}
		return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { recovered: true } });
	});
	const transport = new HttpTransport({ type: "http", url: URL });
	transport.onAuthError = async () => {
		authRefreshes++;
		return { Authorization: "Bearer refreshed" };
	};
	await transport.connect();

	await expect(transport.request("tools/list")).resolves.toEqual({ recovered: true });
	expect(authRefreshes).toBe(1);
});

test("SSE rejects a single event above its byte cap", async () => {
	mockGlobalFetch(async (_input, init) => {
		const request = JSON.parse(String(init?.body)) as { id: string | number };
		const event = `data:${JSON.stringify({
			jsonrpc: "2.0",
			id: request.id,
			result: "x".repeat(5 * 1024 * 1024),
		})}\n\n`;
		return new Response(event, { headers: { "Content-Type": "text/event-stream" } });
	});
	const transport = new HttpTransport({ type: "http", url: URL });
	await transport.connect();

	await expect(transport.request("resources/read")).rejects.toThrow("SSE event exceeded");
});

test.each([
	["missing jsonrpc", { id: 1, result: {} }],
	["both result and error", { jsonrpc: "2.0", id: 1, result: {}, error: { code: -32_000, message: "ambiguous" } }],
])("SSE rejects an invalid response envelope: %s", async (_label, responseBody) => {
	mockGlobalFetch(async (_input, init) => {
		const request = JSON.parse(String(init?.body)) as { id: number };
		return new Response(`data: ${JSON.stringify({ ...responseBody, id: request.id })}\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const transport = new HttpTransport({ type: "http", url: URL, requestIdFormat: "number" });
	await transport.connect();

	await expect(transport.request("tools/list")).rejects.toThrow("Invalid JSON-RPC response");
});

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

function resumableNotification(retry: number): Response {
	return new Response(
		`id: attacker-controlled\nretry: ${retry}\ndata: ${JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: {},
		})}\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

test("SSE retry: 0 is clamped instead of reconnecting immediately", async () => {
	vi.useFakeTimers();
	const timeoutSpy = spyOn(globalThis, "setTimeout");
	spyOn(globalThis, "fetch").mockResolvedValue(resumableNotification(0));
	const transport = new HttpTransport({ type: "http", url: URL, timeout: 0 });
	await transport.connect();
	await transport.startSSEListener();
	await flushMicrotasks();
	await flushMicrotasks();

	const retryDelay = timeoutSpy.mock.calls.find(call => typeof call[1] === "number")?.[1];
	expect(retryDelay).toBeGreaterThanOrEqual(250);
	await transport.close();
});

test("a stalled SSE resume attempt closes the transport within its connect timeout", async () => {
	vi.useFakeTimers();
	spyOn(Math, "random").mockReturnValue(0.5);
	let fetches = 0;
	const state: { resumeSignal?: AbortSignal } = {};
	mockGlobalFetch(async (_input, init) => {
		fetches++;
		if (fetches === 1) return resumableNotification(0);
		if (!init?.signal) throw new Error("Expected resume signal");
		state.resumeSignal = init.signal;
		const pending = Promise.withResolvers<Response>();
		const reject = () => pending.reject(init.signal?.reason);
		if (init.signal.aborted) reject();
		else init.signal.addEventListener("abort", reject, { once: true });
		return pending.promise;
	});
	const transport = new HttpTransport({ type: "http", url: URL, timeout: 20 });
	await transport.connect();
	await transport.startSSEListener();
	for (let step = 0; step < 4 && fetches < 2; step++) {
		await flushMicrotasks();
		vi.advanceTimersByTime(250);
	}
	await flushMicrotasks();
	const resumeSignal = state.resumeSignal;
	if (!resumeSignal) throw new Error("SSE resume fetch did not start");

	vi.advanceTimersByTime(6);
	await flushMicrotasks();
	expect(resumeSignal.aborted).toBe(true);
	expect(transport.connected).toBe(false);
	await transport.close();
});

test("SSE resume retries have exponential backoff and a bounded budget", async () => {
	vi.useFakeTimers();
	spyOn(Math, "random").mockReturnValue(0.5);
	let fetches = 0;
	mockGlobalFetch(async () => {
		fetches++;
		return resumableNotification(100);
	});
	let closes = 0;
	const transport = new HttpTransport({ type: "http", url: URL });
	transport.onClose = () => closes++;
	await transport.connect();
	await transport.startSSEListener();

	for (let step = 0; step < 50; step++) {
		await flushMicrotasks();
		vi.advanceTimersByTime(100);
	}
	await flushMicrotasks();

	expect(fetches).toBe(4);
	expect(transport.connected).toBe(false);
	expect(closes).toBe(1);
	await transport.close();
	expect(closes).toBe(1);
});

test("an ended SSE listener closes once and aborts an in-flight request", async () => {
	const requestStarted = Promise.withResolvers<AbortSignal>();
	mockGlobalFetch(async (_input, init) => {
		if (init?.method === "GET") {
			return new Response("", { headers: { "Content-Type": "text/event-stream" } });
		}
		const signal = init?.signal;
		if (!signal) throw new Error("Expected request signal");
		requestStarted.resolve(signal);
		const pending = Promise.withResolvers<Response>();
		const reject = () => pending.reject(signal.reason);
		if (signal.aborted) reject();
		else signal.addEventListener("abort", reject, { once: true });
		return pending.promise;
	});
	let closes = 0;
	const listenerClosed = Promise.withResolvers<void>();
	const transport = new HttpTransport({ type: "http", url: URL, timeout: 0 });
	transport.onClose = () => {
		closes++;
		listenerClosed.resolve();
	};
	await transport.connect();
	const request = transport.request("tools/list");
	request.catch(() => {});
	const requestSignal = await requestStarted.promise;
	await transport.startSSEListener();
	await listenerClosed.promise;

	expect(transport.connected).toBe(false);
	expect(requestSignal.aborted).toBe(true);
	await expect(request).rejects.toThrow();
	await transport.close();
	expect(closes).toBe(1);
});

test("an ended SSE listener deletes its server session", async () => {
	const methods: string[] = [];
	const listenerClosed = Promise.withResolvers<void>();
	mockGlobalFetch(async (_input, init) => {
		methods.push(init?.method ?? "unknown");
		if (init?.method === "GET") {
			return new Response("", { headers: { "Content-Type": "text/event-stream" } });
		}
		if (init?.method === "DELETE") return new Response(null, { status: 204 });
		const request = JSON.parse(String(init?.body)) as { id: string | number };
		return jsonResponse(
			{ jsonrpc: "2.0", id: request.id, result: {} },
			{ headers: { "Mcp-Session-Id": "session-abc" } },
		);
	});
	const transport = new HttpTransport({ type: "http", url: URL });
	transport.onClose = () => listenerClosed.resolve();
	await transport.connect();
	await transport.request("initialize");
	await transport.startSSEListener();
	await listenerClosed.promise;
	await flushMicrotasks();

	expect(methods).toEqual(["POST", "GET", "DELETE"]);
	await transport.close();
});

test("HTTP connects, lists tools, and calls a tool with valid JSON-RPC envelopes", async () => {
	const methods: string[] = [];
	mockGlobalFetch(async (_input, init) => {
		if (init?.method === "GET") return new Response(null, { status: 405 });
		const message = JSON.parse(String(init?.body)) as {
			id?: string | number;
			method: string;
			params?: Record<string, unknown>;
		};
		methods.push(message.method);
		if (message.id === undefined) return new Response(null, { status: 202 });
		if (message.method === "initialize") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "1" },
				},
			});
		}
		if (message.method === "tools/list") {
			return jsonResponse({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					tools: [{ name: "echo", inputSchema: { type: "object" } }],
				},
			});
		}
		if (message.method === "tools/call") {
			const result = JSON.stringify({ content: [{ type: "text", text: String(message.params?.arguments) }] });
			return new Response(
				`data: {"jsonrpc":"2.0","id":${JSON.stringify(message.id)},\ndata:"result":${result}}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		throw new Error(`Unexpected method: ${message.method}`);
	});

	const connection = await connectToServer("fixture", { type: "http", url: URL });
	const tools = await listTools(connection);
	const result = await callTool(connection, "echo", { text: "hello" });
	await disconnectServer(connection);

	expect(tools.map(tool => tool.name)).toEqual(["echo"]);
	expect(result.content).toEqual([{ type: "text", text: "[object Object]" }]);
	expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});
