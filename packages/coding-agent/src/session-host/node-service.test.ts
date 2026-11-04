import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { decodeNodeResponse, RpcNodeBackend } from "../modes/rpc/node-client";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { captureNodeTarget, DirectNodeBackend, type NodeBackend } from "../session/node-backend";
import { SessionManager } from "../session/session-manager";
import { isNodeRequest } from "./node-protocol";
import { type HostedNodeService, NodeService, startHostedNodeService } from "./node-service";
import { listenSessionHost, type SessionHostServer } from "./transport";

const sessions: AgentSession[] = [];
const authStores: AuthStorage[] = [];
const servers: SessionHostServer[] = [];
const services: HostedNodeService[] = [];
const clients: RpcNodeBackend[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const service of services.splice(0)) service.close();
	for (const server of servers.splice(0)) await server.stop();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const auth of authStores.splice(0)) auth.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function createSession(
	manager = SessionManager.inMemory(),
	handler: MockHandler = { content: ["done"] },
): Promise<AgentSession> {
	const id = manager.getSessionId();
	if (!manager.getNodeTopology()) await manager.setNodeTopology({ id, rootId: id, generation: 0, state: "active" });
	const auth = await AuthStorage.create(":memory:");
	authStores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing deterministic test model");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
			streamFn: createMockModel({ handler }).stream,
		}),
		sessionManager: manager,
		modelRegistry: new ModelRegistry(auth),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
	});
	sessions.push(session);
	return session;
}

async function serve(session: AgentSession, socket: string, backend?: NodeBackend): Promise<SessionHostServer> {
	const server = await listenSessionHost(socket);
	servers.push(server);
	services.push(
		startHostedNodeService(session, {
			backend,
			input: server.mux.input,
			writeFrame: line => server.mux.writeLine(line),
			attachmentGeneration: () => server.mux.attachmentGeneration,
		}),
	);
	return server;
}

async function directory(): Promise<string> {
	const result = await fs.mkdtemp(path.join(os.tmpdir(), "proto-node-service-"));
	directories.push(result);
	return result;
}

test("typed socket actions address a grandchild without changing root state or accepting a stale selector", async () => {
	const root = await createSession();
	const registry = new AgentRegistry();
	let node = root;
	for (let depth = 1; depth <= 3; depth++) {
		const parent = node;
		node = await createSession();
		await node.sessionManager.setNodeTopology({
			id: node.sessionId,
			rootId: root.sessionId,
			parentId: parent.sessionId,
			generation: 0,
			state: "active",
		});
		registry.register({
			id: `deep-${depth}`,
			nodeId: node.sessionId,
			rootId: root.sessionId,
			parentId: parent.sessionId,
			parentNodeId: parent.sessionId,
			label: `depth ${depth}`,
			kind: "sub",
			session: node,
		});
	}
	const dir = await directory();
	const socket = path.join(dir, "deep.sock");
	await serve(root, socket, new DirectNodeBackend(root, registry, new AgentLifecycleManager(registry)));
	const client = await RpcNodeBackend.connect(socket);
	clients.push(client);
	const selected = await client.snapshot(node.sessionId);
	const changed = await client.execute(selected.target, { type: "rename", name: "deep wire target" });
	expect(changed.snapshot.name).toBe("deep wire target");
	expect(changed.snapshot.parent).not.toBe(root.sessionId);
	expect((await client.snapshot(root.sessionId)).name).toBeUndefined();
	await expect(client.execute(selected.target, { type: "rename", name: "stale wire target" })).rejects.toThrow(
		"stale_target",
	);
	await expect(client.snapshot("Main")).rejects.toThrow("node_not_found");
	for (let index = 0; index < 3; index++)
		node.sessionManager.appendMessage({ role: "user", content: `history ${index}`, timestamp: index });
	const history = await client.execute((await client.snapshot(node.sessionId)).target, { type: "history", limit: 1 });
	if (history.result.type !== "history" || !history.result.page.nextCursor)
		throw new Error("Expected a history cursor");
	await node.sessionManager.setNodeTopology({ ...node.sessionManager.getNodeTopology()!, generation: 1 });
	await expect(
		client.execute((await client.snapshot(node.sessionId)).target, {
			type: "history",
			cursor: history.result.page.nextCursor,
		}),
	).rejects.toThrow("stale_cursor");
});

test("reading a parked node uses a read lease and does not revive it or rewrite its durable history", async () => {
	const dir = await directory();
	const root = await createSession();
	const parked = await createSession(SessionManager.create(dir, dir));
	await parked.sessionManager.setNodeTopology({
		id: parked.sessionId,
		rootId: root.sessionId,
		parentId: root.sessionId,
		generation: 0,
		state: "active",
	});
	parked.sessionManager.appendMessage({ role: "user", content: "durable parked history", timestamp: 0 });
	await parked.sessionManager.ensureOnDisk();
	await parked.sessionManager.flush();
	const file = parked.sessionManager.getSessionFile()!;
	const nodeId = parked.sessionId;
	await parked.releaseRuntime();
	const before = await Bun.file(file).text();
	const registry = new AgentRegistry();
	const ref = registry.register({
		id: "parked",
		nodeId,
		rootId: root.sessionId,
		parentId: root.sessionId,
		parentNodeId: root.sessionId,
		label: "parked",
		kind: "sub",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	const socket = path.join(dir, "parked.sock");
	await serve(root, socket, new DirectNodeBackend(root, registry, new AgentLifecycleManager(registry)));
	const client = await RpcNodeBackend.connect(socket);
	clients.push(client);
	const observed = await client.snapshot(nodeId);
	expect(observed.runtime).toBe("parked");
	const history = await client.execute(observed.target, { type: "history", limit: 2 });
	expect(history.result).toMatchObject({
		type: "history",
		page: { messages: [{ role: "user", content: "durable parked history" }] },
	});
	expect(ref.session).toBeNull();
	expect(await Bun.file(file).text()).toBe(before);
});

test("a same-object root switch invalidates the old controller lease instead of mutating its replacement", async () => {
	const session = await createSession();
	const service = new NodeService(session, () => {});
	services.push(service);
	const negotiated = await service.request({ id: "first", type: "negotiate_protocol", protocolVersion: 3 });
	if (!negotiated.success || negotiated.command !== "negotiate_protocol") throw new Error("Expected negotiation");
	const originalId = session.sessionId;
	await session.newSession();
	expect(session.sessionId).not.toBe(originalId);
	const stale = await service.request({
		id: "stale-root",
		type: "node_operation",
		target: captureNodeTarget(session.sessionManager),
		controllerLease: negotiated.data.controllerLease,
		operation: { type: "rename", name: "wrong root" },
	});
	expect(stale).toMatchObject({ success: false, code: "stale_controller" });
	expect(session.sessionName).toBeUndefined();
	const refreshed = await service.request({ id: "refresh", type: "negotiate_protocol", protocolVersion: 3 });
	expect(refreshed).toMatchObject({ success: true, data: { root: { target: { nodeId: session.sessionId } } } });
	if (!refreshed.success || refreshed.command !== "negotiate_protocol") throw new Error("Expected refreshed root");
	const renamed = await service.request({
		id: "new-root",
		type: "node_operation",
		target: refreshed.data.root.target,
		controllerLease: refreshed.data.controllerLease,
		operation: { type: "rename", name: "new root" },
	});
	expect(renamed).toMatchObject({ success: true });
	expect(session.sessionName).toBe("new root");
});

test("a replaced attachment cannot use its former controller lease even before the next negotiation", async () => {
	const session = await createSession();
	let attachment = 1;
	const service = new NodeService(
		session,
		() => {},
		undefined,
		() => attachment,
	);
	services.push(service);
	const negotiated = await service.request({ id: "hello", type: "negotiate_protocol", protocolVersion: 3 });
	if (!negotiated.success || negotiated.command !== "negotiate_protocol") throw new Error("Expected negotiation");
	attachment++;
	const response = await service.request({
		id: "old",
		type: "node_operation",
		target: captureNodeTarget(session.sessionManager),
		controllerLease: negotiated.data.controllerLease,
		operation: { type: "rename", name: "wrong owner" },
	});
	expect(response).toMatchObject({ success: false, code: "stale_controller" });
	expect(session.sessionName).toBeUndefined();
	expect(
		isNodeRequest({ id: "missing", type: "node_operation", operation: { type: "abort" }, controllerLease: "old" }),
	).toBe(false);
	expect(() =>
		decodeNodeResponse({
			id: "wrong",
			type: "response",
			command: "negotiate_protocol",
			success: true,
			data: { protocolVersion: 2 },
		}),
	).toThrow("Incompatible");
});

test("detaching mid-turn does not cancel accepted work and reattachment reads authoritative history", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const session = await createSession(undefined, async () => {
		started.resolve();
		await finish.promise;
		return { content: ["finished while detached"] };
	});
	const dir = await directory();
	const socket = path.join(dir, "host.sock");
	await serve(session, socket);
	const first = await RpcNodeBackend.connect(socket);
	clients.push(first);
	const completed = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_end") completed.resolve();
	});
	const pending = first.execute(first.root.target, { type: "prompt", message: "continue independently" });
	const detached = pending.catch((error: unknown) => error);
	await started.promise;
	first.close();
	expect(await detached).toMatchObject({ message: "Node backend detached" });
	const second = await RpcNodeBackend.connect(socket);
	clients.push(second);
	expect(second.root.isStreaming).toBe(true);
	finish.resolve();
	await completed.promise;
	unsubscribe();
	const history = await second.execute((await second.snapshot(session.sessionId)).target, {
		type: "history",
		limit: 8,
	});
	if (history.result.type !== "history") throw new Error("Expected history");
	expect(
		history.result.page.messages.some(
			message =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "text" && block.text === "finished while detached"),
		),
	).toBe(true);
});

test("reconnecting after host restart obtains durable identity and state rather than replaying old replies", async () => {
	const dir = await directory();
	const socket = path.join(dir, "host.sock");
	const original = await createSession(SessionManager.create(dir, dir));
	const firstServer = await serve(original, socket);
	const client = await RpcNodeBackend.connect(socket);
	clients.push(client);
	const changed = await client.execute(client.root.target, { type: "rename", name: "durable title" });
	expect(changed.snapshot.name).toBe("durable title");
	const file = original.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected durable file");
	services[services.length - 1]!.close();
	await firstServer.stop();
	await original.releaseRuntime();
	const restoredManager = await SessionManager.open(file);
	expect(restoredManager.getSessionName()).toBe("durable title");
	const restored = await createSession(restoredManager);
	await serve(restored, socket);
	const authoritative = await client.reconnect(socket);
	expect(authoritative.name).toBe("durable title");
	expect(authoritative.target.nodeId).toBe(changed.snapshot.target.nodeId);
	expect(authoritative.topology.state).toBe("active");
	await expect(
		client.execute(
			{ ...authoritative.target, generation: authoritative.target.generation + 1 },
			{ type: "rename", name: "wrong generation" },
		),
	).rejects.toThrow("stale_target");
	expect(restored.sessionName).toBe("durable title");
});

test("typed history sockets accept the expanded page and keep count and byte boundaries bounded", async () => {
	const root = await createSession();
	const markers = Array.from({ length: 600 }, (_, index) => `wire-history-${index}`);
	for (const [index, content] of markers.entries())
		root.sessionManager.appendMessage({ role: "user", content, timestamp: index });
	const socket = path.join(await directory(), "expanded-history.sock");
	await serve(root, socket);
	const client = await RpcNodeBackend.connect(socket);
	clients.push(client);
	const target = (await client.snapshot(root.sessionId)).target;
	const latest = await client.execute(target, { type: "history", limit: 512 });
	if (latest.result.type !== "history") throw new Error("Expected history page");
	expect(
		latest.result.page.messages.map(message => (message.role === "user" ? message.content : message.role)),
	).toEqual(markers.slice(88));
	const older = await client.execute(target, { type: "history", cursor: latest.result.page.nextCursor });
	if (older.result.type !== "history") throw new Error("Expected older history page");
	expect(
		older.result.page.messages.map(message => (message.role === "user" ? message.content : message.role)),
	).toEqual(markers.slice(0, 88));
	await expect(client.execute(target, { type: "history", limit: 513 })).rejects.toThrow();
});
