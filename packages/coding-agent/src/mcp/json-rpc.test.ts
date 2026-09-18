import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { callMCP, parseSSE } from "./json-rpc";

const URL = "https://mcp.example.test/rpc";

afterEach(() => vi.restoreAllMocks());

function mockGlobalFetch(
	implementation: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>,
): void {
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

test("caller cancellation augments rather than replaces the default request deadline", async () => {
	const caller = new AbortController();
	const deadline = new AbortController();
	const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	const anySpy = spyOn(AbortSignal, "any");
	const capturedSignal = Promise.withResolvers<AbortSignal>();
	mockGlobalFetch(async (_input, init) => {
		if (!init?.signal) throw new Error("Expected request signal");
		capturedSignal.resolve(init.signal);
		const request = JSON.parse(String(init.body)) as { id: string | number };
		return Response.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
	});

	await callMCP(URL, "tools/list", undefined, { signal: caller.signal });
	const requestSignal = await capturedSignal.promise;

	expect(timeoutSpy).toHaveBeenCalledWith(60_000);
	expect(anySpy).toHaveBeenCalledWith([caller.signal, deadline.signal]);
	expect(requestSignal).not.toBe(caller.signal);
	caller.abort("cancelled by caller");
	expect(requestSignal.aborted).toBe(true);
	expect(requestSignal.reason).toBe("cancelled by caller");
});

test("SSE joins every data field in one event before parsing JSON", () => {
	const text = ['data: {"jsonrpc":"2.0",', 'data: "id":"request-id","result":{"joined":true}}'].join("\n");

	expect(parseSSE(text, "request-id")).toEqual({
		jsonrpc: "2.0",
		id: "request-id",
		result: { joined: true },
	});
});

test("SSE accepts data fields without a space after the colon", () => {
	const text = 'data:{"jsonrpc":"2.0","id":"request-id","result":{"accepted":true}}\n\n';

	expect(parseSSE(text, "request-id")).toEqual({
		jsonrpc: "2.0",
		id: "request-id",
		result: { accepted: true },
	});
});

test("MCP SSE streams past notifications, requests, and malformed envelopes to its multiline response", async () => {
	mockGlobalFetch(async (_input, init) => {
		const request = JSON.parse(String(init?.body)) as { id: string | number };
		const events = [
			'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
			"",
			`data: {"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"method":"sampling/createMessage","params":{}}`,
			"",
			`data: {"id":${JSON.stringify(request.id)},"result":{"selected":false}}`,
			"",
			`data: {"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{},"error":{"code":-32603,"message":"ambiguous"}}`,
			"",
			`data: {"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"error":{"code":"bad","message":42}}`,
			"",
			'data: {"jsonrpc":"2.0","id":"not-the-outbound-id","result":{"selected":false}}',
			"",
			'data: {"jsonrpc":"2.0",',
			`data:"id":${JSON.stringify(request.id)},"result":{"selected":true}}`,
			"",
			"",
		];
		let delivered = false;
		const responseBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (delivered) {
					controller.error(new Error("SSE reader continued after the matching response"));
					return;
				}
				delivered = true;
				controller.enqueue(new TextEncoder().encode(events.join("\n")));
			},
		});
		return new Response(responseBody, { headers: { "Content-Type": "text/event-stream" } });
	});

	const response = await callMCP<{ selected: boolean }>(URL, "tools/list");

	expect(response.result).toEqual({ selected: true });
});
