import { afterEach, describe, expect, test } from "bun:test";
import { loadPage } from "./types";

describe("loadPage network safety", () => {
	let servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers = [];
	});

	test("does not follow a redirect into a loopback service", async () => {
		let internalHits = 0;
		const internal = Bun.serve({
			port: 0,
			fetch() {
				internalHits++;
				return new Response("internal-secret");
			},
		});
		servers.push(internal);

		let redirectorHits = 0;
		const redirector = Bun.serve({
			port: 0,
			fetch() {
				redirectorHits++;
				return Response.redirect(`http://127.0.0.1:${internal.port}/secret`, 302);
			},
		});
		servers.push(redirector);

		const result = await loadPage(`http://127.0.0.1:${redirector.port}/start`, {
			timeout: 2,
			allowPrivateNetwork: true,
		});

		expect(result.ok).toBe(false);
		expect(redirectorHits).toBe(1);
		expect(internalHits).toBe(0);
	});

	test("fetches a loopback address the caller named directly", async () => {
		// Reading a local dev server is ordinary intent, not SSRF. Only a redirect INTO private space is
		// attacker-chosen, so a directly requested private address must still work without any escape hatch.
		const local = Bun.serve({ port: 0, fetch: () => new Response("local dev body") });
		servers.push(local);

		const result = await loadPage(`http://127.0.0.1:${local.port}/page`, { timeout: 2 });

		expect(result.ok).toBe(true);
		expect(result.content).toContain("local dev body");
	});

	test("refuses a redirect that leaves the private origin it started on", async () => {
		let internalHits = 0;
		const internal = Bun.serve({
			port: 0,
			fetch() {
				internalHits++;
				return new Response("internal-secret");
			},
		});
		servers.push(internal);

		const redirector = Bun.serve({
			port: 0,
			fetch: () => Response.redirect(`http://127.0.0.1:${internal.port}/secret`, 302),
		});
		servers.push(redirector);

		// No escape hatch here: the first hop is allowed because the caller named it, the second is not.
		const result = await loadPage(`http://127.0.0.1:${redirector.port}/start`, { timeout: 2 });

		expect(result.ok).toBe(false);
		expect(internalHits).toBe(0);
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
			allowPrivateNetwork: true,
			maxBytes: 1024,
			timeout: 2,
		});

		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(cancelled.value).toBe(true);
	});
});
