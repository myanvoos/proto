import { afterEach, describe, expect, it } from "bun:test";
import { MCPManager, type MCPReconnectPolicy } from "./manager";
import type { MCPHttpServerConfig } from "./types";

// Real HTTP transport + real timers: fake timers cannot drive socket I/O, so the policy is shrunk to
// milliseconds instead and waits poll the observable state.
/** Short ladder, fast schedule: retries at 20/40/80/80… ms after the ladder fails. */
const FAST: MCPReconnectPolicy = { ladderMs: [10, 10], retryBaseMs: 20, retryMaxMs: 80 };
const QUIET_MS = FAST.retryMaxMs * 4;

interface FlakyServer {
	url: string;
	requests: () => number;
	setDown: (down: boolean) => void;
	stop: () => void;
}

function startFlakyServer(): FlakyServer {
	let down = false;
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			requests++;
			if (down) return new Response("unavailable", { status: 503 });
			if (req.method !== "POST") return new Response(null, { status: 405 });
			const message = (await req.json()) as { id?: unknown; method?: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			if (message.method === "initialize") {
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "flaky", version: "1" },
					},
				});
			}
			if (message.method === "tools/list") {
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
				});
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		requests: () => requests,
		setDown: value => {
			down = value;
		},
		stop: () => server.stop(true),
	};
}

async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

describe("MCP lost remote server retry schedule", () => {
	let manager: MCPManager | undefined;
	let flaky: FlakyServer | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		flaky?.stop();
		manager = undefined;
		flaky = undefined;
	});

	async function connected(): Promise<{ manager: MCPManager; flaky: FlakyServer }> {
		flaky = startFlakyServer();
		manager = new MCPManager(process.cwd(), null, FAST);
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url, timeout: 2_000 };
		await manager.connectServers({ flaky: config }, {});
		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		return { manager, flaky };
	}

	it("keeps retrying a lost remote server after the ladder fails until it comes back", async () => {
		const { manager, flaky } = await connected();
		flaky.setDown(true);
		// An awaited reconnect stays bounded by the ladder.
		expect(await manager.reconnectServer("flaky")).toBeNull();
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");

		await Bun.sleep(QUIET_MS);
		flaky.setDown(false);
		await until(() => manager.getConnectionStatus("flaky") === "connected", "the scheduled reconnect");
	});

	it("stops retrying once the server is disconnected", async () => {
		const { manager, flaky } = await connected();
		flaky.setDown(true);
		expect(await manager.reconnectServer("flaky")).toBeNull();
		await manager.disconnectServer("flaky");
		const seen = flaky.requests();
		await Bun.sleep(QUIET_MS);
		expect(flaky.requests()).toBe(seen);
	});

	it("does not schedule a server that never connected", async () => {
		flaky = startFlakyServer();
		flaky.setDown(true);
		manager = new MCPManager(process.cwd(), null, FAST);
		await manager.connectServers({ flaky: { type: "http", url: flaky.url, timeout: 2_000 } }, {});
		expect(manager.getConnectionStatus("flaky")).not.toBe("connected");
		await until(() => manager?.getConnectionStatus("flaky") === "disconnected", "the startup failure");
		const seen = flaky.requests();
		await Bun.sleep(QUIET_MS);
		expect(flaky.requests()).toBe(seen);
	});
});
