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
