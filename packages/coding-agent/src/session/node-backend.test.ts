import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { captureNodeTarget, DirectNodeBackend } from "./node-backend";
import { pageNodeHistory } from "./node-history";
import { SessionManager } from "./session-manager";

const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const authStores: AuthStorage[] = [];
const backends: DirectNodeBackend[] = [];
afterEach(async () => {
	for (const backend of backends.splice(0)) backend.close();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.close();
	for (const auth of authStores.splice(0)) auth.close();
});

async function session(parent?: AgentSession, handler: MockHandler = { content: ["done"] }): Promise<AgentSession> {
	const manager = SessionManager.inMemory();
	const id = manager.getSessionId();
	await manager.setNodeTopology({
		id,
		rootId: parent?.sessionManager.getNodeTopology()?.rootId ?? id,
		parentId: parent?.sessionId,
		generation: 0,
		state: "active",
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing deterministic test model");
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	authStores.push(auth);
	const result = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler }).stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	sessions.push(result);
	return result;
}

function backend(root: AgentSession, registry: AgentRegistry): DirectNodeBackend {
	const result = new DirectNodeBackend(root, registry, new AgentLifecycleManager(registry));
	backends.push(result);
	return result;
}

test("a captured depth-three mutation changes only that node and refuses a stale completion", async () => {
	const registry = new AgentRegistry();
	const root = await session();
	let child = root;
	for (let depth = 1; depth <= 3; depth++) {
		const parent = child;
		child = await session(parent);
		registry.register({
			id: `worker-${depth}`,
			nodeId: child.sessionId,
			rootId: root.sessionId,
			parentId: parent.sessionId,
			parentNodeId: parent.sessionId,
			label: `depth ${depth}`,
			kind: "sub",
			session: child,
			status: "idle",
		});
	}
	const owner = backend(root, registry);
	const target = captureNodeTarget(child.sessionManager);
	await owner.execute(target, { type: "rename", name: "deep node" });
	expect(child.sessionName).toBe("deep node");
	expect(root.sessionName).toBeUndefined();
	await expect(owner.execute(target, { type: "rename", name: "stale selector" })).rejects.toMatchObject({
		code: "stale_target",
	});
	await expect(owner.snapshot("Main")).rejects.toMatchObject({ code: "node_not_found" });
	const context = await owner.execute((await owner.snapshot(child.sessionId)).target, { type: "context" });
	expect(context.result).toMatchObject({ type: "context", runtime: "live" });
	expect(context.snapshot.topology.parentId).not.toBe(root.sessionId);
});

test("targeted abort remains usable while the same node has a pending turn and a newer history revision", async () => {
	const started = Promise.withResolvers<void>();
	const root = await session(undefined, () => {
		started.resolve();
		return { delayMs: 30_000, content: ["should be cancelled"] };
	});
	const owner = backend(root, new AgentRegistry());
	const target = captureNodeTarget(root.sessionManager);
	const pending = owner.execute(target, { type: "prompt", message: "." });
	await started.promise;
	root.sessionManager.appendCustomEntry("external-progress", { observed: true });
	expect(captureNodeTarget(root.sessionManager).revision).not.toBe(target.revision);
	await owner.execute(target, { type: "abort" });
	await pending;
	expect((await owner.snapshot(target.nodeId)).isStreaming).toBe(false);
	await owner.execute(captureNodeTarget(root.sessionManager), { type: "rename", name: "capacity returned" });
	expect(root.sessionName).toBe("capacity returned");
});

test("abandoned generations remain inspectable but cannot mutate or silently revive", async () => {
	const registry = new AgentRegistry();
	const root = await session();
	const child = await session(root);
	const topology = child.sessionManager.getNodeTopology()!;
	await child.sessionManager.setNodeTopology({ ...topology, generation: 1, state: "abandoned" });
	registry.register({
		id: "abandoned",
		nodeId: child.sessionId,
		rootId: root.sessionId,
		parentId: root.sessionId,
		parentNodeId: root.sessionId,
		label: "abandoned",
		kind: "sub",
		session: child,
	});
	const owner = backend(root, registry);
	const target = captureNodeTarget(child.sessionManager);
	await expect(owner.execute(target, { type: "rename", name: "resurrected" })).rejects.toMatchObject({
		code: "node_read_only",
	});
	expect((await owner.execute(target, { type: "tree", limit: 1 })).result.type).toBe("tree");
	await expect(owner.execute({ ...target, generation: 0 }, { type: "context" })).rejects.toMatchObject({
		code: "stale_target",
	});
});

test("history cursors retain their semantic head while new messages arrive and reject rewritten generations", async () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	for (let index = 0; index < 6; index++)
		manager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index });
	const target = captureNodeTarget(manager);
	const latest = pageNodeHistory(manager, target, { limit: 2 });
	expect(latest.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
		"message 4",
		"message 5",
	]);
	manager.appendMessage({ role: "user", content: "new progress", timestamp: 6 });
	const older = pageNodeHistory(manager, target, { cursor: latest.nextCursor });
	expect(older.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
		"message 2",
		"message 3",
	]);
	expect(older.totalMessages).toBe(6);
	expect(() => pageNodeHistory(manager, { ...target, generation: 1 }, { cursor: latest.nextCursor })).toThrow("stale");
});

test("history pages do not hydrate unrelated oversized retained payloads", () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	const first = manager.appendMessage({ role: "user", content: "unrelated".repeat(1_000_000), timestamp: 0 });
	for (let index = 0; index < 12; index++)
		manager.appendMessage({ role: "user", content: `tail ${index}`, timestamp: index + 1 });
	const state = manager.captureState();
	const raw = state.rawEntryFiles.find(([id]) => id === first)?.[1];
	if (!raw || !state.rawEntryDirectory) throw new Error("Expected retained historical payload");
	const file = path.join(state.rawEntryDirectory, raw.name);
	const bytes = fs.readFileSync(file);
	const degraded: string[] = [];
	manager.onHistoryDegraded(message => degraded.push(message));
	fs.unlinkSync(file);
	try {
		const page = pageNodeHistory(manager, captureNodeTarget(manager), { limit: 2 });
		expect(page.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
			"tail 10",
			"tail 11",
		]);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
		expect(degraded).toEqual([]);
	} finally {
		fs.writeFileSync(file, bytes);
	}
	expect(() => pageNodeHistory(manager, captureNodeTarget(manager), { limit: 513 })).toThrow("between 1 and 512");
});

test("expanded node history admits payloads beyond the old byte budget while keeping the new page bounded", () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	for (let index = 0; index < 8; index++)
		manager.appendMessage({ role: "user", content: `${index}:${"x".repeat(220_000)}`, timestamp: index });
	const target = captureNodeTarget(manager);
	const latest = pageNodeHistory(manager, target, { limit: 512 });
	expect(
		latest.messages.map(message =>
			message.role === "user" && typeof message.content === "string" ? message.content.slice(0, 2) : "unexpected",
		),
	).toEqual(["5:", "6:", "7:"]);
	expect(Buffer.byteLength(JSON.stringify(latest))).toBeLessThan(1536 * 1024);
	const earlier = pageNodeHistory(manager, target, { cursor: latest.nextCursor });
	expect(
		earlier.messages.map(message =>
			message.role === "user" && typeof message.content === "string" ? message.content.slice(0, 2) : "unexpected",
		),
	).toEqual(["2:", "3:", "4:"]);
});
