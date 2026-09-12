import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { type CustomStreamSimpleFn, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { discoverAuthStorage } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { getBundledAgent } from "../../src/task/agents";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function positiveOption(name: string, fallback: number): number {
	const index = Bun.argv.indexOf(name);
	const value = index >= 0 ? Number(Bun.argv[index + 1]) : fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

function assistantMessage(model: Model, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function finish(stream: AssistantMessageEventStream, model: Model, tool: ToolCall): void {
	const partial = assistantMessage(model, [tool]);
	stream.push({ type: "start", partial });
	stream.push({ type: "toolcall_start", contentIndex: 0, partial });
	stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(tool.arguments), partial });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial });
	stream.push({ type: "done", reason: "toolUse", message: partial });
}

function scriptedProvider(
	gate: Promise<void>,
	expectedStarts: number,
	transcriptPayload: string,
): {
	streamFn: CustomStreamSimpleFn;
	allStarted: Promise<void>;
	continuityChecks: () => number;
	requests: () => number;
} {
	const allStarted = Promise.withResolvers<void>();
	let starts = 0;
	const continuityWorkers = new Set<string>();
	const streamFn: CustomStreamSimpleFn = (model, context) => {
		const contextText = JSON.stringify(context.messages);
		if (starts >= expectedStarts) {
			if (!contextText.includes("memory-continuity-marker"))
				throw new Error("revived transcript lost prior content");
			const worker = /fixture worker (\d+)/.exec(contextText)?.[1];
			if (worker) continuityWorkers.add(worker);
		}
		starts++;
		const invocation = starts;
		if (starts === expectedStarts) allStarted.resolve();
		const stream = createAssistantMessageEventStream();
		void gate.then(() => {
			finish(stream, model, {
				type: "toolCall",
				id: `fixture-yield-${invocation}`,
				name: "yield",
				arguments: { result: { data: { marker: "memory-continuity-marker", transcriptPayload } } },
			});
		});
		return stream;
	};
	return {
		streamFn,
		allStarted: allStarted.promise,
		continuityChecks: () => continuityWorkers.size,
		requests: () => starts,
	};
}

function weakSession(id: string): WeakRef<AgentSession> {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`worker ${id} has no live AgentSession`);
	return new WeakRef(session);
}

function countCollected(refs: WeakRef<object>[]): number {
	return refs.filter(ref => ref.deref() === undefined).length;
}

async function collectWeakRefs(refs: WeakRef<object>[]): Promise<number> {
	for (let attempt = 0; attempt < 20; attempt++) {
		Bun.gc(true);
		await Bun.sleep(10);
		const collected = countCollected(refs);
		if (collected === refs.length) return collected;
		// WeakRef targets dereferenced above stay alive through this JavaScript job.
		await Bun.sleep(0);
	}
	return countCollected(refs);
}

async function runLifecycle(
	count: number,
	payloadKiB: number,
): Promise<{ collectibleOriginalSessionsAfterPark: number; collectibleRevivedSessionsAfterRelease: number }> {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	OrchestratorRuntime.resetGlobalForTests();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `proto-lifecycle-${count}-`));
	process.env.HOME = root;
	process.env.PI_BLACKHOLE_PASSIVE = "1";
	setAgentDir(path.join(root, "agent"));
	const parentFile = path.join(root, "parent.jsonl");
	const sessionManager = await SessionManager.open(parentFile, undefined, undefined, {
		initialCwd: root,
		suppressBreadcrumb: true,
	});
	const settings = Settings.isolated({
		"orchestrator.maxConcurrency": count,
		"orchestrator.agentIdleTtlMs": 60_000,
		"compaction.enabled": false,
	});
	const authStorage = await discoverAuthStorage(path.join(root, "auth"));
	const modelsPath = path.join(root, "models.json");
	await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
	const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
		settings,
		fetch: () => Promise.reject(new Error("network disabled in lifecycle fixture")),
	});
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const started = Promise.withResolvers<void>();
	const transcriptPayload = "p".repeat(payloadKiB * 1024);
	const provider = scriptedProvider(started.promise, count, transcriptPayload);
	registerCustomApi("lifecycle-fixture-api", provider.streamFn, "lifecycle-fixture");
	authStorage.setRuntimeApiKey("lifecycle-fixture", "offline-key");
	modelRegistry.registerProvider("lifecycle-fixture", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "offline-key",
		api: "lifecycle-fixture-api",
		models: [
			{
				id: "lifecycle-fixture-model",
				name: "Lifecycle Fixture Model",
				reasoning: false,
				contextWindow: Math.max(128_000, payloadKiB * 1024 * 8),
				maxTokens: Math.max(4_096, payloadKiB * 1024 * 2),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	const session = {
		cwd: root,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager: manager,
		sessionManager,
		extensionPaths: [],
		customToolPaths: [],
		getSessionFile: () => parentFile,
		getSessionId: () => "lifecycle-fixture-parent",
		getAsyncJobOwnerId: () => "lifecycle-fixture-parent",
		getAgentId: () => "Main",
		getSessionSpawns: () => "*",
		getArtifactsDir: () => root,
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
	} as ToolSession;
	const runtime = OrchestratorRuntime.global();
	const agent = { ...getBundledAgent("worker")!, tools: ["yield"] } as AgentDefinition;
	const model = modelRegistry.find("lifecycle-fixture", "lifecycle-fixture-model");
	if (!model) throw new Error("failed to register deterministic lifecycle fixture model");
	runtime.setWorkerResolutionForTesting(agent, model);
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session: session as unknown as AgentSession,
			authStorage,
			modelRegistry,
			settings,
		}),
		60_000,
	);

	try {
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const spawned = await runtime.spawn(session, {
				name: `lifecycle-${index}`,
				prompt: `fixture worker ${index}`,
			});
			ids.push(spawned.id);
		}
		await provider.allStarted;
		const liveScreens = runtime.screens(session, ids);
		if (liveScreens.some(screen => screen.state !== "running"))
			throw new Error("workers did not reach running state");

		started.resolve();
		await manager.waitForAll();
		await runtime.wait(session, { sessions: ids });
		const completedScreens = runtime.screens(session, ids);
		if (completedScreens.some(screen => screen.state !== "idle")) throw new Error("workers did not become idle");
		const sessionRefs = ids.map(weakSession);

		const lifecycle = AgentLifecycleManager.global();
		await Promise.all(ids.map(id => lifecycle.park(id)));
		const parkedRefs = ids.map(id => AgentRegistry.global().get(id));
		if (parkedRefs.some(ref => ref?.status !== "parked" || ref.session !== null)) {
			throw new Error(
				`workers did not park: ${JSON.stringify(parkedRefs.map(ref => ({ status: ref?.status, live: Boolean(ref?.session) })))}`,
			);
		}
		const collectibleOriginalSessionsAfterPark = await collectWeakRefs(sessionRefs);

		for (const id of ids) await runtime.send(session, { session: id, message: "deterministic revival turn" });
		await manager.waitForAll();
		await runtime.wait(session, { sessions: ids });
		const revivedScreens = runtime.screens(session, ids);
		if (revivedScreens.some(screen => screen.state !== "idle")) throw new Error("workers did not revive and settle");
		if (provider.continuityChecks() !== count)
			throw new Error(
				`not every revived worker retained transcript content: ${provider.continuityChecks()}/${count}`,
			);
		if (provider.requests() !== count * 2) {
			throw new Error(`expected one provider request per worker turn, received ${provider.requests()}`);
		}
		const revivedSessionRefs = ids.map(weakSession);

		for (const id of ids) await runtime.kill(session, id);
		const releasedScreens = runtime.screens(session, ids);
		if (releasedScreens.some(screen => screen.state !== "dead" || screen.addressable)) {
			throw new Error("released workers remained addressable");
		}
		for (const id of ids) {
			try {
				await runtime.send(session, { session: id, message: "must be rejected after release" });
				throw new Error(`released worker ${id} accepted a turn`);
			} catch (error) {
				if (error instanceof Error && error.message.includes("accepted a turn")) throw error;
			}
		}
		const collectibleRevivedSessionsAfterRelease = await collectWeakRefs(revivedSessionRefs);
		return { collectibleOriginalSessionsAfterPark, collectibleRevivedSessionsAfterRelease };
	} finally {
		await manager.dispose({ timeoutMs: 1_000 });
		await AgentLifecycleManager.global().dispose();
		modelRegistry.unregisterProvider("lifecycle-fixture");
		unregisterCustomApis("lifecycle-fixture");
		authStorage.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

const workers = positiveOption("--workers", 1);
const payloadKiB = positiveOption("--payload-kib", 16);
console.log(JSON.stringify(await runLifecycle(workers, payloadKiB)));
