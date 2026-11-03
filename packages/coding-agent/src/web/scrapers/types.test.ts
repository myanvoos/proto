import { afterEach, describe, expect, test } from "bun:test";
import { loadPage } from "./types";

describe("loadPage network safety", () => {
	let servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers = [];
	});

	test("follows a redirect into a loopback service", async () => {
		// A redirect into private space is followed like any other. Refusing it broke
		// ordinary local setups (a dev server redirecting to another local port).
		let internalHits = 0;
		const internal = Bun.serve({
			port: 0,
			fetch() {
				internalHits++;
				return new Response("internal body");
			},
		});
		servers.push(internal);

		const redirector = Bun.serve({
			port: 0,
			fetch: () => Response.redirect(`http://127.0.0.1:${internal.port}/next`, 302),
		});
		servers.push(redirector);

		const result = await loadPage(`http://127.0.0.1:${redirector.port}/start`, { timeout: 2 });

		expect(result.ok).toBe(true);
		expect(internalHits).toBe(1);
		expect(result.content).toContain("internal body");
	});

	test("fetches a loopback address the caller named directly", async () => {
		const local = Bun.serve({ port: 0, fetch: () => new Response("local dev body") });
		servers.push(local);

		const result = await loadPage(`http://127.0.0.1:${local.port}/page`, { timeout: 2 });

		expect(result.ok).toBe(true);
		expect(result.content).toContain("local dev body");
	});

	test("cancels a response stream that exceeds the byte cap despite its content-length", async () => {
		const cancelled = { value: false };
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(2048));
			},
			cancel() {
				cancelled.value = true;
			},
		});
		const result = await loadPage("http://127.0.0.1/oversized", {
			fetch: async () => new Response(stream, { status: 200, headers: { "content-length": "1" } }),
			maxBytes: 1024,
			timeout: 2,
		});

		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(cancelled.value).toBe(true);
	});
});

test("bodyless success and failed HTTP responses preserve their transport verdict", async () => {
	const success = await loadPage("https://example.test/empty", {
		fetch: async () => new Response(null, { status: 204 }),
	});
	const failure = await loadPage("https://example.test/missing", {
		fetch: async () => new Response(null, { status: 404 }),
	});
	expect(success).toMatchObject({ ok: true, status: 204, content: "" });
	expect(failure).toMatchObject({ ok: false, status: 404 });
});

test("bare refusal statuses rotate user agents without reading the refused body", async () => {
	const agents: string[] = [];
	let cancelled = false;
	const result = await loadPage("https://example.test/protected", {
		fetch: async (_url, init) => {
			agents.push(new Headers(init?.headers).get("user-agent") ?? "");
			if (agents.length === 1)
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 403 },
				);
			return new Response("article");
		},
	});
	expect(result).toMatchObject({ ok: true, content: "article" });
	expect(agents.length).toBe(2);
	expect(agents[0]).not.toBe(agents[1]);
	expect(cancelled).toBe(true);
});

test("case-insensitive caller user-agent is sent once and refused finally", async () => {
	const agents: string[] = [];
	const result = await loadPage("https://example.test/protected", {
		headers: { "uSeR-aGeNt": "Caller/1.0" },
		fetch: async (_url, init) => {
			agents.push(new Headers(init?.headers).get("user-agent") ?? "");
			return new Response("no", { status: 403 });
		},
	});
	expect(agents).toEqual(["Caller/1.0"]);
	expect(result).toMatchObject({ ok: false, status: 403 });
});

test("transport failures still retry with a caller-provided user agent", async () => {
	let attempts = 0;
	const result = await loadPage("https://example.test/transient", {
		headers: { "user-agent": "Caller/1.0" },
		fetch: async () => {
			if (++attempts < 3) throw new Error("connection reset");
			return new Response("recovered");
		},
	});
	expect(attempts).toBe(3);
	expect(result.content).toBe("recovered");
});
