import { afterEach, expect, test } from "bun:test";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { MCPManager } from "./manager";

const managers: MCPManager[] = [];

afterEach(async () => {
	while (managers.length > 0) await managers.pop()?.dispose();
	MCPManager.resetForTests();
});

test("dispose releases the manager singleton and connection state", async () => {
	const manager = new MCPManager(process.cwd());
	managers.push(manager);
	manager.setOnToolsChanged(() => {});
	manager.setOnResourcesChanged(() => {});
	manager.setOnPromptsChanged(() => {});
	manager.addNotificationListener(() => {});
	MCPManager.setInstance(manager);

	await manager.dispose();

	expect(MCPManager.instance()).toBeUndefined();
	expect(manager.getConnectedServers()).toEqual([]);
	expect(manager.getAllServerNames()).toEqual([]);
	expect(manager.getNotificationState()).toEqual({ enabled: false, subscriptions: new Map() });
});

function serveHangingMcpServer(): {
	url: string;
	requestReceived: Promise<void>;
	requestAborted: Promise<void>;
	stop: () => void;
} {
	const received = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			received.resolve();
			const { promise, resolve } = Promise.withResolvers<Response>();
			req.signal.addEventListener(
				"abort",
				() => {
					aborted.resolve();
					resolve(new Response(null, { status: 499 }));
				},
				{ once: true },
			);
			return promise;
		},
	});
	return {
		url: server.url.href,
		requestReceived: received.promise,
		requestAborted: aborted.promise,
		stop: () => server.stop(true),
	};
}

for (const [label, disconnect] of [
	["disconnectAll", (manager: MCPManager) => manager.disconnectAll()],
	["disconnectServer", (manager: MCPManager) => manager.disconnectServer("slow")],
] as const) {
	test(`${label} aborts an in-flight handshake instead of waiting for the MCP timeout`, async () => {
		const server = serveHangingMcpServer();
		try {
			const manager = new MCPManager(process.cwd());
			managers.push(manager);

			const startup = manager.connectServers({ slow: { type: "http", url: server.url, timeout: 60_000 } }, {});
			const pending = manager.waitForConnection("slow");
			pending.catch(() => {});
			await startup;
			await withTimeout(server.requestReceived, 2_000, "MCP handshake was not received");
			expect(manager.getConnectionStatus("slow")).toBe("connecting");

			await disconnect(manager);

			await expect(withTimeout(pending, 2_000, "cancelled MCP handshake did not settle")).rejects.toThrow(
				'MCP server "slow" disconnected while connecting',
			);
			await withTimeout(server.requestAborted, 2_000, "MCP handshake was not aborted");
			expect(manager.getConnectionStatus("slow")).toBe("disconnected");
		} finally {
			server.stop();
		}
	});
}

type TestMcpServer = {
	url: string;
	setInitializeMode: (mode: "healthy" | "hang" | "fail") => void;
	setHangDeletes: (enabled: boolean) => void;
	releaseDelete: () => void;
	waitForInitialize: (count: number) => Promise<void>;
	waitForInitializeAbort: (count: number) => Promise<void>;
	waitForDelete: (count: number) => Promise<void>;
	initializeCount: () => number;
	stop: () => void;
};

function serveTestMcpServer(toolNames: string[]): TestMcpServer {
	let initializeMode: "healthy" | "hang" | "fail" = "healthy";
	let hangDeletes = false;
	let initializeCount = 0;
	let deleteCount = 0;
	let currentToolName: string | undefined;
	let pendingDeleteResolve: ((response: Response) => void) | undefined;
	const initializeWaiters = new Map<number, Array<() => void>>();
	const initializeAbortWaiters = new Map<number, Array<() => void>>();
	const deleteWaiters = new Map<number, Array<() => void>>();

	const resolveWaiters = (waiters: Map<number, Array<() => void>>, count: number): void => {
		const pending = waiters.get(count);
		if (!pending) return;
		waiters.delete(count);
		for (const resolve of pending) resolve();
	};
	const waitForCount = (
		waiters: Map<number, Array<() => void>>,
		current: () => number,
		count: number,
	): Promise<void> => {
		if (current() >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const pending = waiters.get(count) ?? [];
		pending.push(resolve);
		waiters.set(count, pending);
		return promise;
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "DELETE") {
				deleteCount++;
				resolveWaiters(deleteWaiters, deleteCount);
				if (hangDeletes) {
					const response = Promise.withResolvers<Response>();
					pendingDeleteResolve = response.resolve;
					return response.promise;
				}
				return new Response(null, { status: 202 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });

			const body = (await request.json()) as { id?: string | number; method?: string };
			if (body.method === "initialize") {
				initializeCount++;
				resolveWaiters(initializeWaiters, initializeCount);
				if (initializeMode === "hang") {
					const response = Promise.withResolvers<Response>();
					request.signal.addEventListener(
						"abort",
						() => {
							resolveWaiters(initializeAbortWaiters, initializeCount);
							response.resolve(new Response(null, { status: 499 }));
						},
						{ once: true },
					);
					return response.promise;
				}
				if (initializeMode === "fail") return new Response("test failure", { status: 503 });
				currentToolName = toolNames[Math.min(initializeCount - 1, toolNames.length - 1)];
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "manager-test", version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": `manager-test-${initializeCount}` } },
				);
			}
			if (body.method === "tools/list") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: [
							{
								name: currentToolName ?? toolNames[0] ?? "manager-test-tool",
								inputSchema: { type: "object" },
							},
						],
					},
				});
			}
			return new Response(null, { status: 202 });
		},
	});

	return {
		url: server.url.href,
		setInitializeMode: mode => {
			initializeMode = mode;
		},
		setHangDeletes: enabled => {
			hangDeletes = enabled;
		},
		releaseDelete: () => {
			pendingDeleteResolve?.(new Response(null, { status: 202 }));
			pendingDeleteResolve = undefined;
		},
		waitForInitialize: count => waitForCount(initializeWaiters, () => initializeCount, count),
		waitForInitializeAbort: count => waitForCount(initializeAbortWaiters, () => initializeCount, count),
		waitForDelete: count => waitForCount(deleteWaiters, () => deleteCount, count),
		initializeCount: () => initializeCount,
		stop: () => server.stop(true),
	};
}

test("disconnectServer aborts an in-flight reconnect handshake and prevents retries", async () => {
	const server = serveTestMcpServer(["initial-tool", "reconnect-tool"]);
	try {
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const config = { type: "http" as const, url: server.url, timeout: 60_000 };

		await manager.connectServers({ slow: config }, {});
		expect(manager.getConnection("slow")).toBeDefined();
		server.setInitializeMode("hang");
		const reconnect = manager.reconnectServer("slow");
		reconnect.catch(() => {});
		await withTimeout(server.waitForInitialize(2), 2_000, "reconnect handshake was not received");

		await manager.disconnectServer("slow");
		await expect(withTimeout(reconnect, 2_000, "cancelled reconnect did not settle")).resolves.toBeNull();
		await withTimeout(server.waitForInitializeAbort(2), 2_000, "reconnect handshake was not aborted");
		expect(server.initializeCount()).toBe(2);
		expect(manager.getConnectionStatus("slow")).toBe("disconnected");
	} finally {
		server.stop();
	}
});

test("disconnectServer cancels reconnect backoff instead of waiting for the next retry", async () => {
	const server = serveTestMcpServer(["initial-tool", "reconnect-tool"]);
	try {
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const config = { type: "http" as const, url: server.url, timeout: 60_000 };

		await manager.connectServers({ slow: config }, {});
		server.setInitializeMode("fail");
		const reconnect = manager.reconnectServer("slow");
		reconnect.catch(() => {});
		await withTimeout(server.waitForInitialize(2), 2_000, "failing reconnect was not received");

		const cancelledAt = performance.now();
		await manager.disconnectServer("slow");
		await expect(withTimeout(reconnect, 2_000, "cancelled reconnect backoff did not settle")).resolves.toBeNull();
		expect(performance.now() - cancelledAt).toBeLessThan(400);
		expect(server.initializeCount()).toBe(2);
	} finally {
		server.stop();
	}
});

test("disconnectServer cancels a reconnect waiting for auth", async () => {
	const server = serveTestMcpServer(["initial-tool", "reconnect-tool"]);
	const authStarted = Promise.withResolvers<void>();
	const authResult = Promise.withResolvers<undefined>();
	try {
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const config = { type: "http" as const, url: server.url, timeout: 60_000 };

		await manager.connectServers({ slow: config }, {});
		manager.setAuthHandler(async () => {
			authStarted.resolve();
			return authResult.promise;
		});
		const reconnect = manager.reconnectServer("slow", { authChallenge: { wwwAuthenticate: [] } });
		reconnect.catch(() => {});
		await withTimeout(authStarted.promise, 2_000, "reconnect auth handler was not called");

		await manager.disconnectServer("slow");
		await expect(withTimeout(reconnect, 2_000, "cancelled auth wait did not settle")).resolves.toBeNull();
		expect(server.initializeCount()).toBe(1);
		authResult.resolve(undefined);
	} finally {
		server.stop();
	}
});
test("same-name connection survives cleanup from an older disconnect", async () => {
	const server = serveTestMcpServer(["old-tool", "new-tool"]);
	try {
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		const config = { type: "http" as const, url: server.url, timeout: 60_000 };

		await manager.connectServers({ slow: config }, {});
		server.setHangDeletes(true);
		const oldDisconnect = manager.disconnectServer("slow");
		oldDisconnect.catch(() => {});
		await withTimeout(server.waitForDelete(1), 2_000, "old connection cleanup was not received");

		await manager.connectServers({ slow: config }, {});
		await withTimeout(server.waitForInitialize(2), 2_000, "replacement connection was not received");
		expect(
			manager
				.getTools()
				.filter(tool => tool.mcpServerName === "slow")
				.map(tool => tool.name),
		).toEqual(["mcp__slow_new_tool"]);

		server.releaseDelete();
		await withTimeout(oldDisconnect, 2_000, "old connection cleanup did not settle");
		expect(
			manager
				.getTools()
				.filter(tool => tool.mcpServerName === "slow")
				.map(tool => tool.name),
		).toEqual(["mcp__slow_new_tool"]);
		server.setHangDeletes(false);
	} finally {
		server.stop();
	}
});
test("disposed manager does not start later discovery, connections, or reconnects", async () => {
	const server = serveTestMcpServer(["unexpected-tool"]);
	try {
		const manager = new MCPManager(process.cwd());
		managers.push(manager);
		await manager.dispose();

		expect(await manager.discoverAndConnect()).toEqual({
			tools: [],
			errors: new Map(),
			connectedServers: [],
			exaApiKeys: [],
		});
		expect(await manager.connectServers({ slow: { type: "http", url: server.url } }, {})).toEqual({
			tools: [],
			errors: new Map(),
			connectedServers: [],
			exaApiKeys: [],
		});
		expect(await manager.reconnectServer("slow")).toBeNull();
		expect(server.initializeCount()).toBe(0);
	} finally {
		server.stop();
	}
});
test("disconnectAll keeps the singleton for a live reconnect", async () => {
	const manager = new MCPManager(process.cwd());
	managers.push(manager);
	MCPManager.setInstance(manager);

	await manager.disconnectAll();

	expect(MCPManager.instance()).toBe(manager);
});
