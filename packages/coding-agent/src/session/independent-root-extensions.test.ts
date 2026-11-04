import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { ExtensionFactory } from "../extensibility/extensions";
import { initializeExtensions } from "../modes/runtime-init";
import { OrchestratorRuntime } from "../orchestrator/runtime";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { getBundledAgent } from "../task/agents";
import type { FleetDetails } from "../tools/fleet/types";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const inlineExtension: ExtensionFactory = api => {
	let invocations = 0;
	api.registerCommand("trusted-inline", {
		scope: "node",
		handler: async (_args, ctx) => {
			api.appendEntry("inline-invocation", { sessionId: ctx.sessionManager.getSessionId(), count: ++invocations });
		},
	});
};

const sdkTool: CustomTool = {
	name: "trusted_sdk",
	label: "Trusted SDK tool",
	description: "Return the invoking session identity",
	parameters: type({}),
	execute: async (_id, _params, _update, ctx) => ({
		content: [{ type: "text", text: ctx.sessionManager.getSessionId() }],
	}),
};

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-root-extensions-"));
	const extensionPath = path.join(dir, "trusted-extension.ts");
	const toolPath = path.join(dir, "trusted-tool.ts");
	const aiModule = new URL("../../../ai/src/index.ts", import.meta.url).pathname;
	const schemaModule = new URL("../../../omptype/src/index.ts", import.meta.url).pathname;
	await Bun.write(
		extensionPath,
		`
import { createAssistantMessageEventStream } from ${JSON.stringify(aiModule)};
import { type } from ${JSON.stringify(schemaModule)};
export default api => {
	let invocations = 0;
	api.registerCommand("trusted-file", { scope: "node", handler: async (_args, ctx) => {
		api.appendEntry("file-invocation", { sessionId: ctx.sessionManager.getSessionId(), count: ++invocations });
	} });
	api.on("session_start", (_event, ctx) => {
		if (!ctx.sessionManager.getHeader()?.node?.parentId) return;
		api.registerTool({ name: "worker_only", label: "Worker only", description: "Return the invoking worker identity",
			parameters: type({}), execute: async (_id, _params, _signal, _update, context) => ({
				content: [{ type: "text", text: context.sessionManager.getSessionId() }],
			}) });
	});
	api.registerProvider("root-extension-fixture", {
		api: "root-extension-fixture-api", apiKey: "offline-key", baseUrl: "http://127.0.0.1:9",
		models: [{ id: "deterministic", name: "Deterministic extension model", reasoning: false,
			input: ["text"], contextWindow: 32000, maxTokens: 2048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const child = context.tools?.some(tool => tool.name === "yield");
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: child ? [{ type: "toolCall", id: crypto.randomUUID(), name: "yield", arguments: { result: { data: "child settled" } } }]
						: [{ type: "text", text: "provider-session=" + options.sessionId }],
					stopReason: child ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "done", reason: child ? "toolUse" : "stop", message });
			});
			return stream;
		},
	});
};
`,
	);
	await Bun.write(
		toolPath,
		`export default api => ({ name: "trusted_path", label: "Trusted path tool",
		description: "Return the invoking session identity", parameters: api.zod.object({}),
		execute: async (_id, _params, _update, ctx) => ({ content: [{ type: "text", text: ctx.sessionManager.getSessionId() }] }) });`,
	);
	const auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"checklist.enabled": false,
		"retry.enabled": false,
		"orchestrator.maxConcurrency": 1,
	});
	const model = buildModel({
		id: "deterministic",
		name: "Deterministic extension model",
		api: "root-extension-fixture-api",
		provider: "root-extension-fixture",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const created = await createAgentSession({
		cwd: dir,
		agentDir: path.join(dir, "agent"),
		authStorage: auth,
		sessionManager: SessionManager.create(dir, path.join(dir, "sessions")),
		settings,
		model,
		disableExtensionDiscovery: true,
		additionalExtensionPaths: [extensionPath],
		extensions: [inlineExtension],
		preloadedCustomToolPaths: [{ path: toolPath }],
		customTools: [sdkTool],
		enableMCP: false,
		enableIrc: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
	});
	const root = created.session;
	const worker = getBundledAgent("worker");
	if (!worker) throw new Error("Missing bundled worker");
	OrchestratorRuntime.global().setWorkerResolutionForTesting({ ...worker, tools: ["fleet", "jobs", "yield"] }, model);
	const extra: AgentSession[] = [];
	return {
		root,
		model,
		auth,
		settings,
		dir,
		extra,
		async close() {
			for (const session of extra.reverse()) await session.dispose();
			await root.dispose();
			auth.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

async function spawn(parent: AgentSession): Promise<AgentSession> {
	const fleet = parent.getToolForEvalBridge("fleet");
	if (!fleet) throw new Error("No fleet capability");
	const result = await fleet.execute("extension-spawn", { op: "spawn", message: "Finish this child turn" });
	const id = (result.details as FleetDetails | undefined)?.spawned?.id;
	if (result.isError || !id) throw new Error(JSON.stringify(result));
	await parent.settleAsyncWork();
	const child = AgentRegistry.global().get(id)?.session;
	if (!child) throw new Error("Child did not retain its real runtime");
	await child.waitForStreamingIdle();
	return child;
}

async function invokeRootEnvironment(session: AgentSession): Promise<void> {
	await initializeExtensions(session, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw new Error(error.error);
		},
	});
	await session.extensionRunner?.emit({ type: "session_start" });
	await session.prompt("/trusted-file");
	await session.prompt("/trusted-inline");
	for (const name of ["trusted_path", "trusted_sdk"]) {
		const tool = session.getToolForEvalBridge(name);
		if (!tool) throw new Error(`Missing trusted root tool ${name}`);
		const result = await tool.execute(`invoke-${name}`, {});
		expect(result.content).toEqual([{ type: "text", text: session.sessionId }]);
	}
	expect(session.sessionManager.getCustomEntries("file-invocation").at(-1)?.data).toEqual({
		sessionId: session.sessionId,
		count: 1,
	});
	expect(session.sessionManager.getCustomEntries("inline-invocation").at(-1)?.data).toEqual({
		sessionId: session.sessionId,
		count: 1,
	});
	await session.prompt("Use the configured trusted provider");
	expect(session.getLastAssistantText()).toContain(`provider-session=${session.sessionId}`);
}

test("direct root forks rebind trusted CLI, inline and tool-path definitions into a fresh root runtime", async () => {
	const f = await fixture();
	try {
		await invokeRootEnvironment(f.root);
		await f.root.sessionManager.flush();
		const original = await Bun.file(f.root.sessionFile!).text();
		const fork = await f.root.fork();
		if (!fork) throw new Error("Fork cancelled");
		f.extra.push(fork);
		await invokeRootEnvironment(fork);
		expect(await Bun.file(f.root.sessionFile!).text()).toBe(original);
		await f.root.prompt("/trusted-file");
		expect(f.root.sessionManager.getCustomEntries("file-invocation").at(-1)?.data).toEqual({
			sessionId: f.root.sessionId,
			count: 2,
		});
	} finally {
		await f.close();
	}
}, 30_000);

test("depth-three fleet forks restore automatic root extension provenance without copying bound worker-only tools", async () => {
	const f = await fixture();
	try {
		let source = f.root;
		for (let depth = 1; depth <= 3; depth++) source = await spawn(source);
		const workerTool = source.getToolForEvalBridge("worker_only");
		if (!workerTool) throw new Error("Worker-local extension registration did not run");
		expect((await workerTool.execute("worker-identity", {})).content).toEqual([
			{ type: "text", text: source.sessionId },
		]);
		await source.sessionManager.flush();
		const original = await Bun.file(source.sessionFile!).text();
		const topology = source.sessionManager.getNodeTopology();
		const fork = await source.fork();
		if (!fork) throw new Error("Fork cancelled");
		f.extra.push(fork);
		await invokeRootEnvironment(fork);
		expect(fork.getToolForEvalBridge("worker_only")).toBeUndefined();
		expect(source.sessionManager.getNodeTopology()).toEqual(topology);
		expect(await Bun.file(source.sessionFile!).text()).toBe(original);
		const child = await spawn(fork);
		expect(child.sessionManager.getNodeTopology()?.rootId).toBe(fork.sessionId);
	} finally {
		await f.close();
	}
}, 30_000);

test("a strict SDK worker fork uses trusted root definitions, not worker-local tools or spawn restrictions", async () => {
	const f = await fixture();
	try {
		await f.root.sessionManager.ensureOnDisk();
		const sourceManager = SessionManager.create(f.dir, path.join(f.dir, "strict-sessions"));
		const id = `strict-${crypto.randomUUID()}`;
		await sourceManager.setNodeTopology({
			id,
			rootId: f.root.sessionId,
			parentId: f.root.sessionId,
			parentSessionFile: f.root.sessionFile,
			rootSessionFile: f.root.sessionFile,
			generation: 0,
			state: "active",
		});
		const workerOnly: CustomTool = { ...sdkTool, name: "worker_only", label: "Worker local" };
		const created = await createAgentSession({
			cwd: f.dir,
			agentDir: path.join(f.dir, "agent"),
			authStorage: f.auth,
			model: f.model,
			settings: f.settings,
			sessionManager: sourceManager,
			parentTaskPrefix: id,
			agentId: id,
			parentAgentId: "Main",
			rootExtensionEnvironment: f.root.rootExtensionEnvironment,
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			toolNames: ["worker_only"],
			customTools: [workerOnly],
			spawns: "",
			preloadedPreparedExtensions: [],
			preloadedCustomToolPaths: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableIrc: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const source = created.session;
		f.extra.push(source);
		expect(source.getToolForEvalBridge("trusted_sdk")).toBeUndefined();
		expect(source.getToolForEvalBridge("worker_only")).toBeDefined();
		await source.sessionManager.ensureOnDisk();
		const original = await Bun.file(source.sessionFile!).text();
		const fork = await source.fork();
		if (!fork) throw new Error("Fork cancelled");
		f.extra.push(fork);
		await invokeRootEnvironment(fork);
		expect(fork.getToolForEvalBridge("worker_only")).toBeUndefined();
		const child = await spawn(fork);
		expect(child.sessionManager.getNodeTopology()?.parentId).toBe(fork.sessionId);
		expect(await Bun.file(source.sessionFile!).text()).toBe(original);
	} finally {
		await f.close();
	}
}, 30_000);

test("a worker without trusted root provenance cannot promote local tools through an independent fork", async () => {
	const f = await fixture();
	try {
		const id = `detached-${crypto.randomUUID()}`;
		const manager = SessionManager.create(f.dir, path.join(f.dir, "detached-source"));
		const created = await createAgentSession({
			cwd: f.dir,
			agentDir: path.join(f.dir, "agent"),
			authStorage: f.auth,
			model: f.model,
			settings: f.settings,
			sessionManager: manager,
			parentTaskPrefix: id,
			agentId: id,
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			toolNames: ["worker_only"],
			customTools: [{ ...sdkTool, name: "worker_only" }],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableIrc: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const source = created.session;
		f.extra.push(source);
		await manager.ensureOnDisk();
		const original = await Bun.file(source.sessionFile!).text();
		const filesBefore = (await fs.readdir(path.dirname(source.sessionFile!))).filter(file => file.endsWith(".jsonl"));
		await expect(source.fork()).rejects.toThrow("trusted root extension provenance");
		expect(await Bun.file(source.sessionFile!).text()).toBe(original);
		expect((await fs.readdir(path.dirname(source.sessionFile!))).filter(file => file.endsWith(".jsonl"))).toEqual(
			filesBefore,
		);
		expect(source.getToolForEvalBridge("worker_only")).toBeDefined();
	} finally {
		await f.close();
	}
}, 30_000);
