import { expect, test } from "bun:test";
import { type MCPFetchImpl, mcpFetch } from "./header-policy";

test("default redirect handling strips configured secrets on a cross-origin redirect", async () => {
	const requests: Array<{ url: string; headers: Headers }> = [];
	const originalUrl = "https://mcp.example.test/rpc";
	const redirectedUrl = "https://attacker.example.test/collect";

	const fetchImpl: MCPFetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = new Headers(init?.headers);
		requests.push({ url, headers });

		if (url === originalUrl) {
			if (init?.redirect === "manual") {
				return new Response(null, { status: 307, headers: { Location: redirectedUrl } });
			}
			// Emulate fetch's automatic redirect: nonstandard headers are reused.
			requests.push({ url: redirectedUrl, headers: new Headers(init?.headers) });
		}
		return new Response("ok");
	};

	await mcpFetch(
		originalUrl,
		{ method: "GET" },
		{
			generated: {
				Accept: "application/json",
				Authorization: "Bearer generated-secret",
				"Mcp-Session-Id": "session-secret",
			},
			configured: { "X-API-Key": "top-secret" },
		},
		false,
		fetchImpl,
	);

	expect(requests.map(request => request.url)).toEqual([originalUrl, redirectedUrl]);
	expect(requests[0]?.headers.get("X-API-Key")).toBe("top-secret");
	expect(requests[1]?.headers.get("X-API-Key")).toBeNull();
	expect(requests[1]?.headers.get("Authorization")).toBeNull();
	expect(requests[1]?.headers.get("Mcp-Session-Id")).toBeNull();
	expect(requests[1]?.headers.get("Accept")).toBe("application/json");
});

test("same-origin HTTPS redirects retain configured headers", async () => {
	const requests: Array<{ url: string; headers: Headers }> = [];
	const originalUrl = "https://mcp.example.test/rpc";
	const redirectedUrl = "https://mcp.example.test/v2/rpc";
	const fetchImpl: MCPFetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requests.push({ url, headers: new Headers(init?.headers) });
		return url === originalUrl
			? new Response(null, { status: 307, headers: { Location: redirectedUrl } })
			: new Response("ok");
	};

	const response = await mcpFetch(
		originalUrl,
		{ method: "GET" },
		{ generated: { Accept: "application/json" }, configured: { "X-API-Key": "top-secret" } },
		false,
		fetchImpl,
	);

	expect(response.status).toBe(200);
	expect(requests.map(request => request.url)).toEqual([originalUrl, redirectedUrl]);
	expect(requests[1]?.headers.get("X-API-Key")).toBe("top-secret");
});

test("redirect errors do not expose configured secrets or URL query values", async () => {
	const url = "https://mcp.example.test/rpc?token=query-secret";
	const fetchImpl: MCPFetchImpl = async () => new Response(null, { status: 307, headers: { Location: url } });
	const request = mcpFetch(
		url,
		{ method: "GET" },
		{ generated: {}, configured: { "X-API-Key": "header-secret" } },
		false,
		fetchImpl,
	);

	const error = await request.catch(cause => cause);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).not.toContain("query-secret");
	expect((error as Error).message).not.toContain("header-secret");
});
