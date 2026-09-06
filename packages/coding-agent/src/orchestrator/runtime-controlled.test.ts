import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage, StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from "../tools";
import { EvalTool } from "../tools/eval";
import { OrchestratorRuntime, prefersPersistedWorkerRevival } from "./runtime";

const OWNER_PREFIX = `orchestrator-controlled-${process.pid}`;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(
	model: Model,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function pushToolCall(stream: AssistantMessageEventStream, model: Model, tool: ToolCall): void {
	const partial = message(model, [tool], "toolUse");
	stream.push({ type: "start", partial });
	stream.push({ type: "toolcall_start", contentIndex: 0, partial });
	stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(tool.arguments), partial });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial });
	stream.push({ type: "done", reason: "toolUse", message: partial });
}

function controlledProvider(): StreamFn {
	const evaluatedFollowups = new Set<string>();
	return (model, context) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const taskText = JSON.stringify(context.messages);
			const hasToolResult = context.messages.some(message => message.role === "toolResult");
			const followup = taskText.includes("followup") || taskText.includes("revival");
			const followupKey = taskText.includes("worker-a-py-revival")
				? "worker-a-py-revival"
				: taskText.includes("worker-a-py-followup")
					? "worker-a-py-followup"
					: undefined;
			const shouldEvaluate =
				!hasToolResult || (followup && followupKey !== undefined && !evaluatedFollowups.has(followupKey));
			if (shouldEvaluate) {
				if (followupKey) evaluatedFollowups.add(followupKey);
				const language = taskText.includes("-js") ? "js" : "py";
				const worker = taskText.includes("worker-a") ? "a" : "b";
				const code =
					language === "py"
						? followup
							? 'print("CONTEXT", "worker_a_marker" in globals())'
							: worker === "a"
								? 'print("PARENT", "parent_marker" in globals()); worker_a_marker = "a"; print("A", "set")'
								: 'print("PARENT", "parent_marker" in globals()); print("A", "worker_a_marker" in globals())'
						: followup
							? 'console.log("CONTEXT", "workerAMarker" in globalThis)'
							: worker === "a"
								? 'console.log("PARENT", "parent_marker" in globalThis); globalThis.workerAMarker = "a"; console.log("A", "set")'
								: 'console.log("PARENT", "parent_marker" in globalThis); console.log("A", "workerAMarker" in globalThis)';
				pushToolCall(stream, model, call("eval-cell", "controlled_eval", { language, code, timeout: 30 }));
				return;
			}
			const last = context.messages.at(-1) as AgentMessage | undefined;
			pushToolCall(stream, model, call("yield-result", "yield", { result: { data: JSON.stringify(last) } }));
		});
		return stream;
	};
}

function controlledEvalTool(settings: Settings): CustomTool {
	return {
		name: "controlled_eval",
		label: "Controlled Eval",
		description: "Run a deterministic Python or JavaScript kernel cell.",
		parameters: type({ language: type("'py' | 'js'"), code: type("string"), "timeout?": type("number") }),
		strict: true,
		execute: async (toolCallId, params, _onUpdate, context, signal) => {
			const session = {
				cwd: context.sessionManager.getCwd(),
				hasUI: false,
				settings,
				modelRegistry: context.modelRegistry,
				sessionManager: context.sessionManager,
				getSessionFile: () => context.sessionManager.getSessionFile() ?? null,
				getSessionId: () => context.sessionManager.getSessionId(),
				getAsyncJobOwnerId: () => context.sessionManager.getSessionId(),
				getEvalSessionId: () => context.sessionManager.getSessionId(),
				getEvalKernelOwnerId: () => context.sessionManager.getSessionId(),
				getSessionSpawns: () => "*",
			} as unknown as ToolSession;
			return new EvalTool(session).execute(toolCallId, params as never, signal);
		},
	};
}

function parentSession(args: {
	cwd: string;
	file: string;
	manager: AsyncJobManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	streamFn: StreamFn;
	customTools: CustomTool[];
	sessionManager: SessionManager;
}): ToolSession {
	return {
		cwd: args.cwd,
		hasUI: false,
		settings: args.settings,
		asyncJobManager: args.manager,
		modelRegistry: args.modelRegistry,
		authStorage: args.authStorage,
		streamFn: args.streamFn,
		customTools: args.customTools,
		sessionManager: args.sessionManager,
		getSessionFile: () => args.file,
		getSessionId: () => "parent-session",
		getAsyncJobOwnerId: () => "parent-session",
		getAgentId: () => "Main",
		getSessionSpawns: () => "*",
		getEvalSessionId: () => "parent-eval",
		getEvalKernelOwnerId: () => `${OWNER_PREFIX}-parent`,
		getArtifactsDir: () => path.dirname(args.file),
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
	} as ToolSession;
}

let cleanupFixture: (() => Promise<void>) | undefined;
afterEach(async () => {
	try {
		await cleanupFixture?.();
	} finally {
		cleanupFixture = undefined;
		await disposeKernelSessionsByOwner(`${OWNER_PREFIX}-parent`);
		await disposeVmContextsByOwner(`${OWNER_PREFIX}-parent`);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
	}
}, 30_000);

async function controlledFixture(options: { streamFn?: StreamFn; maxConcurrency?: number } = {}) {
	// Registry replacement must not leave a lifecycle bound to the prior test's registry.
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	OrchestratorRuntime.resetGlobalForTests();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-orchestrator-controlled-"));
	cleanupFixture = () => fs.rm(root, { recursive: true, force: true });
	const parentFile = path.join(root, "parent.jsonl");
	const sessionManager = await SessionManager.open(parentFile, undefined, undefined, {
		initialCwd: root,
		suppressBreadcrumb: true,
	});
	const settings = Settings.isolated({
		"orchestrator.maxConcurrency": options.maxConcurrency ?? 4,
		"orchestrator.agentIdleTtlMs": 60_000,
	});
	const authStorage = await discoverAuthStorage(path.join(root, "auth"));
	authStorage.setRuntimeApiKey("controlled-provider", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const manager = new AsyncJobManager({ retentionMs: 60_000 });
	const streamFn = options.streamFn ?? controlledProvider();
	const session = parentSession({
		cwd: root,
		file: parentFile,
		manager,
		settings,
		modelRegistry,
		authStorage,
		streamFn,
		customTools: [controlledEvalTool(settings)],
		sessionManager,
	});
	const runtime = OrchestratorRuntime.global();
	const agent = { ...getBundledAgent("worker")!, tools: ["controlled_eval", "yield"] } as AgentDefinition;
	const model = buildModel({
		id: "controlled-model",
		name: "Controlled Model",
		api: "openai-completions",
		provider: "controlled-provider",
		baseUrl: "http://127.0.0.1:9",
		contextWindow: 128_000,
		maxTokens: 4_096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as never);
	expect(model, "bundled deterministic model metadata is available").toBeDefined();
	runtime.setWorkerResolutionForTesting(agent, model!);
	cleanupFixture = async () => {
		for (const id of runtime.listIds(session)) await runtime.kill(session, id);
		await manager.dispose({ timeoutMs: 1_000 });
		await AgentLifecycleManager.global().dispose();
		authStorage.close();
		await fs.rm(root, { recursive: true, force: true });
	};
	return { runtime, session, manager, sessionManager, agent, model: model! };
}

test("default parent protocol fallbacks remain eligible for disk-backed parking", () => {
	const fallbackOnly = {
		getArtifactsDir: () => null,
		getSessionId: () => null,
		customTools: [],
	} as unknown as ToolSession;
	expect(prefersPersistedWorkerRevival(fallbackOnly)).toBe(true);
	expect(prefersPersistedWorkerRevival({ ...fallbackOnly, localProtocolOptions: {} } as unknown as ToolSession)).toBe(
		false,
	);
	expect(prefersPersistedWorkerRevival({ ...fallbackOnly, streamFn: controlledProvider() })).toBe(false);
	expect(
		prefersPersistedWorkerRevival({ ...fallbackOnly, customTools: [{} as CustomTool] } as unknown as ToolSession),
	).toBe(false);
});

test("orchestrator-created workers isolate Python and JS kernels while preserving explicit sharing", async () => {
	const { runtime, session, manager } = await controlledFixture();
	const parentEval = new EvalTool(session);
	const parentPy = await parentEval.execute("parent-py", {
		language: "py",
		code: 'parent_marker = "parent"; print("parent-set")',
		timeout: 30,
	});
	const parentJs = await parentEval.execute("parent-js", {
		language: "js",
		code: 'globalThis.parent_marker = "parent"; console.log("parent-set")',
		timeout: 30,
	});
	expect(parentPy.details?.cells?.[0]?.status).toBe("complete");
	expect(parentJs.details?.cells?.[0]?.status).toBe("complete");

	const ids: string[] = [];
	for (const prompt of ["worker-a-py", "worker-b-py", "worker-a-js", "worker-b-js"]) {
		const spawned = await runtime.spawn(session, { agent: "worker", name: "same-label", prompt });
		ids.push(spawned.id);
	}
	await manager.waitForAll();
	const waits = await runtime.wait(session, { sessions: ids, timeoutMs: 1_000 });
	expect(waits.settled).toHaveLength(4);
	const output = waits.settled.map(entry => entry.resultText).join("\n");
	expect(output).toMatch(/PARENT (?:false|False)/);
	expect(output).toMatch(/A (?:false|False)/);
	expect(output).not.toMatch(/PARENT (?:true|True)/);
	expect(output).not.toMatch(/A (?:true|True)/);

	const firstWorker = ids[0];
	const followup = await runtime.send(session, { session: firstWorker, message: "worker-a-py-followup" });
	expect(followup.id).toBe(firstWorker);
	expect(followup.receipt.status).toBe("accepted");
	await manager.waitForAll();
	const followupWait = await runtime.wait(session, { sessions: [firstWorker], timeoutMs: 1_000 });
	expect(followupWait.settled).toHaveLength(1);
	expect(followupWait.settled[0]?.resultText).toMatch(/CONTEXT (?:True|true)/);

	await AgentLifecycleManager.global().park(firstWorker);
	const parked = AgentRegistry.global().get(firstWorker);
	expect(parked?.status).toBe("parked");
	expect(parked?.session).toBeNull();
	const revival = await runtime.send(session, { session: firstWorker, message: "worker-a-py-revival" });
	expect(revival.id).toBe(firstWorker);
	await manager.waitForAll();
	const revivalWait = await runtime.wait(session, { sessions: [firstWorker], timeoutMs: 1_000 });
	expect(revivalWait.settled).toHaveLength(1);
	expect(revivalWait.settled[0]?.resultText).toMatch(/CONTEXT (?:True|true)/);

	const sharedA = new EvalTool({ ...session, getEvalSessionId: () => "explicit-shared" } as ToolSession);
	const sharedB = new EvalTool({ ...session, getEvalSessionId: () => "explicit-shared" } as ToolSession);
	const first = await sharedA.execute("shared-a", {
		language: "py",
		code: 'shared_marker = "yes"; print("shared-set")',
		timeout: 30,
	});
	const second = await sharedB.execute("shared-b", {
		language: "py",
		code: 'print("SHARED", shared_marker)',
		timeout: 30,
	});
	expect(first.details?.cells?.[0]?.status).toBe("complete");
	expect(String(second.details?.cells?.[0]?.output ?? "")).toContain("SHARED yes");
}, 30_000);

function yieldingProvider(gates = new Map<string, Promise<void>>()): StreamFn {
	return (model, context) => {
		const stream = createAssistantMessageEventStream();
		const userMessage = context.messages.findLast(message => message.role === "user");
		const text = JSON.stringify(userMessage);
		const gate = [...gates].find(([marker]) => text.includes(marker))?.[1];
		void (async () => {
			await gate;
			pushToolCall(stream, model, call("yield-result", "yield", { result: { data: "controlled turn complete" } }));
		})();
		return stream;
	};
}

test("failed turn-settlement persistence cannot strand a worker as running or accept undeliverable followups", async () => {
	const { runtime, session, manager, sessionManager } = await controlledFixture({ streamFn: yieldingProvider() });
	const worker = await runtime.spawn(session, { prompt: "initial turn" });
	await manager.waitForAll();
	await runtime.wait(session, { sessions: [worker.id] });

	const flush = sessionManager.flush.bind(sessionManager);
	let queuedMode: string | undefined;
	const persistence = spyOn(sessionManager, "flush").mockImplementation(async () => {
		const last = sessionManager.getEntries().at(-1);
		if (
			last?.type === "custom" &&
			last.customType === "orchestrator-worker-lifecycle" &&
			(last.data as { action?: string; turn?: number }).action === "turn-settled" &&
			(last.data as { turn?: number }).turn === 2
		) {
			queuedMode = (await runtime.send(session, { session: worker.id, message: "queued before storage failure" }))
				.mode;
			throw new Error("controlled settlement storage failure");
		}
		await flush();
	});
	try {
		await runtime.send(session, { session: worker.id, message: "finish despite broken storage" });
		await manager.waitForAll();
		const result = await runtime.wait(session, { sessions: [worker.id], timeoutMs: 100 });
		expect(result.stillRunning).toEqual([]);
		expect(result.settled).toHaveLength(1);
		expect(result.settled[0]).toMatchObject({ status: "failed", receipt: { turn: 2 } });
		expect(result.settled[0]?.resultText).toContain("controlled settlement storage failure");
		expect(queuedMode).toBe("queued");
		expect(runtime.screens(session, [worker.id])).toMatchObject([
			{ state: "dead", addressable: false, queued: 0, terminal: { reason: "unrecoverable", lastTurn: 2 } },
		]);
		expect(manager.getAllJobs()).toHaveLength(2);
		expect(AgentRegistry.global().get(worker.id)).toMatchObject({ status: "aborted", session: null });
		await expect(
			runtime.send(session, { session: worker.id, message: "must not be silently queued" }),
		).rejects.toThrow(`history://${worker.id}`);
	} finally {
		persistence.mockRestore();
	}
}, 30_000);

test("a cancelled concurrency-queued turn keeps its number and retries receive a new turn identity", async () => {
	const blocked = Promise.withResolvers<void>();
	const gates = new Map<string, Promise<void>>();
	gates.set("hold-capacity", blocked.promise);
	const { runtime, session, manager } = await controlledFixture({
		streamFn: yieldingProvider(gates),
		maxConcurrency: 1,
	});
	const first = await runtime.spawn(session, { prompt: "first worker" });
	const second = await runtime.spawn(session, { prompt: "second worker" });
	await manager.waitForAll();
	await runtime.wait(session, { sessions: [first.id, second.id] });
	try {
		await runtime.send(session, { session: first.id, message: "hold-capacity" });
		const queued = await runtime.send(session, { session: second.id, message: "cancel before provider starts" });
		expect(queued.receipt.turn).toBe(2);
		expect(queued.jobId).toBe(`${second.id}-t2`);
		expect(manager.cancel(queued.jobId!)).toBe(true);
		await manager.getJob(queued.jobId!)!.promise;
		const cancellation = await runtime.wait(session, { sessions: [second.id], timeoutMs: 100 });
		expect(cancellation.settled).toMatchObject([{ status: "cancelled", receipt: { status: "rejected", turn: 2 } }]);
		expect(cancellation.stillRunning).toEqual([]);

		const retried = await runtime.send(session, { session: second.id, message: "retry cancelled work" });
		expect(retried.receipt.turn).toBe(3);
		expect(retried.jobId).toBe(`${second.id}-t3`);
		blocked.resolve();
		await manager.waitForAll();
		const completed = await runtime.wait(session, { sessions: [second.id], timeoutMs: 100 });
		expect(completed.settled).toMatchObject([{ status: "completed", receipt: { turn: 3 } }]);
	} finally {
		blocked.resolve();
	}
}, 30_000);

test("wait receipts identify the watched turn even when a queued followup starts before delivery", async () => {
	const blocked = Promise.withResolvers<void>();
	const gates = new Map<string, Promise<void>>();
	gates.set("hold-watched-turn", blocked.promise);
	const { runtime, session, manager, sessionManager } = await controlledFixture({ streamFn: yieldingProvider(gates) });
	const worker = await runtime.spawn(session, { prompt: "initial worker turn" });
	await manager.waitForAll();
	await runtime.wait(session, { sessions: [worker.id] });
	const flush = sessionManager.flush.bind(sessionManager);
	let queued = false;
	const persistence = spyOn(sessionManager, "flush").mockImplementation(async () => {
		const last = sessionManager.getEntries().at(-1);
		if (
			!queued &&
			last?.type === "custom" &&
			last.customType === "orchestrator-worker-lifecycle" &&
			(last.data as { action?: string; turn?: number }).action === "turn-settled" &&
			(last.data as { turn?: number }).turn === 2
		) {
			queued = true;
			const followup = await runtime.send(session, { session: worker.id, message: "queued during settlement" });
			expect(followup.mode).toBe("queued");
			expect(followup.receipt.turn).toBe(3);
		}
		await flush();
	});
	try {
		const watched = await runtime.send(session, { session: worker.id, message: "hold-watched-turn" });
		const waiting = runtime.wait(session, { sessions: [worker.id], timeoutMs: 1_000 });
		blocked.resolve();
		const result = await waiting;
		expect(result.settled).toMatchObject([{ jobId: watched.jobId, receipt: { turn: 2, jobId: watched.jobId } }]);
		await manager.waitForAll();
		const followupResult = await runtime.wait(session, { sessions: [worker.id], timeoutMs: 100 });
		expect(followupResult.settled).toMatchObject([{ jobId: `${worker.id}-t3`, receipt: { turn: 3 } }]);
	} finally {
		blocked.resolve();
		persistence.mockRestore();
	}
}, 30_000);

test("killing a later active turn retains that job in terminal recovery instead of the previous completion", async () => {
	const blocked = Promise.withResolvers<void>();
	const gates = new Map<string, Promise<void>>();
	gates.set("hold-terminal-turn", blocked.promise);
	const { runtime, session, manager } = await controlledFixture({ streamFn: yieldingProvider(gates) });
	runtime.setTeardownGraceForTesting(20);
	const worker = await runtime.spawn(session, { prompt: "initial worker turn" });
	await manager.waitForAll();
	await runtime.wait(session, { sessions: [worker.id] });
	try {
		const active = await runtime.send(session, { session: worker.id, message: "hold-terminal-turn" });
		const killed = await runtime.kill(session, worker.id);
		expect(killed.receipt).toMatchObject({
			status: "terminal",
			turn: 2,
			jobId: active.jobId,
			terminal: { lastTurn: 2, lastJobId: active.jobId },
		});
		expect(runtime.screens(session, [worker.id])).toMatchObject([
			{ state: "dead", addressable: false, terminal: { lastJobId: active.jobId } },
		]);
	} finally {
		blocked.resolve();
		await manager.waitForAll();
	}
}, 30_000);

test("rehydration honors a child tombstone even when the parent has no terminal lifecycle event", async () => {
	const { runtime, session, manager, agent, model } = await controlledFixture({ streamFn: yieldingProvider() });
	const worker = await runtime.spawn(session, { prompt: "worker whose child transcript will be terminated" });
	await manager.waitForAll();
	const ref = AgentRegistry.global().get(worker.id)!;
	await AgentLifecycleManager.global().release(worker.id, ref, { tombstone: true });

	// Simulate a fresh process with the original parent journal and no in-memory terminal registry ref.
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	const restored = new OrchestratorRuntime();
	restored.setWorkerResolutionForTesting(agent, model);
	expect(await restored.rehydrate(session)).toBe(0);
	expect(restored.listIds(session)).toEqual([]);
	expect(AgentRegistry.global().get(worker.id)).toMatchObject({
		status: "aborted",
		session: null,
		sessionFile: ref.sessionFile,
	});
	await expect(AgentLifecycleManager.global().ensureLive(worker.id)).rejects.toThrow("cannot be revived");
}, 30_000);

test("send during a peer-driven turn accepts the next turn instead of declaring the worker terminal", async () => {
	const blocked = Promise.withResolvers<void>();
	const gates = new Map<string, Promise<void>>();
	gates.set("hold-external-turn", blocked.promise);
	const { runtime, session, manager } = await controlledFixture({ streamFn: yieldingProvider(gates) });
	const worker = await runtime.spawn(session, { prompt: "initial worker turn" });
	await manager.waitForAll();
	await runtime.wait(session, { sessions: [worker.id] });
	const live = AgentRegistry.global().get(worker.id)?.session;
	expect(live).toBeDefined();
	const running = Promise.withResolvers<void>();
	const unsubscribe = live!.subscribeRunState(state => {
		if (state === "running") running.resolve();
	});
	const external = live!.prompt("hold-external-turn", { attribution: "agent" });
	try {
		await running.promise;
		unsubscribe();
		const sent = await runtime.send(session, { session: worker.id, message: "orchestrator follow-up" });
		expect(sent).toMatchObject({ mode: "turn", receipt: { status: "accepted", turn: 2 } });
		expect(runtime.screens(session, [worker.id])).toMatchObject([{ addressable: true, turns: 2 }]);
		blocked.resolve();
		await external;
		await manager.waitForAll();
		const settled = await runtime.wait(session, { sessions: [worker.id], timeoutMs: 1_000 });
		expect(settled.settled).toMatchObject([{ status: "completed", receipt: { status: "delivered", turn: 2 } }]);
		expect(runtime.screens(session, [worker.id])).toMatchObject([{ state: "idle", addressable: true, turns: 2 }]);
	} finally {
		unsubscribe();
		blocked.resolve();
		await external.catch(() => undefined);
		await manager.waitForAll();
	}
}, 30_000);

test("orchestration rejects disabled parent spawning and excessive recursion before creating workers", async () => {
	const { runtime, session } = await controlledFixture();
	await expect(
		runtime.spawn({ ...session, getSessionSpawns: () => "" }, { prompt: "must not start" }),
	).rejects.toThrow("Allowed: none");
	await expect(runtime.spawn({ ...session, taskDepth: 100 }, { prompt: "must not recurse" })).rejects.toThrow(
		"maximum depth",
	);
	expect(runtime.listIds(session)).toEqual([]);
});

test("omitting an agent uses the parent's permitted default instead of rejecting the generic worker", async () => {
	const { runtime, session, manager } = await controlledFixture({ streamFn: yieldingProvider() });
	const restricted = { ...session, taskDepth: 1, getSessionSpawns: () => "scout" };
	const worker = await runtime.spawn(restricted, { prompt: "permitted default worker" });
	await manager.waitForAll();
	const result = await runtime.wait(restricted, { sessions: [worker.id], timeoutMs: 1_000 });
	expect(result.settled).toMatchObject([{ status: "completed", receipt: { status: "delivered" } }]);
});
