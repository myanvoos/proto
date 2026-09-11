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
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { OrchestratorRuntime } from "../src/orchestrator/runtime";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import { discoverAuthStorage } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { getBundledAgent } from "../src/task/agents";
import { createPersistedSubagentReviverFactory } from "../src/task/persisted-revive";
import type { AgentDefinition } from "../src/task/types";
import type { ToolSession } from "../src/tools";

interface MemorySample {
	heapUsed: number;
	external: number;
	rss: number;
	pss: number | null;
	activeHandles: number;
	activeRequests: number;
	fdCount: number | null;
}

interface WorkerMemoryRun {
	workers: number;
	payloadKiB: number;
	collectibleOriginalSessionsAfterPark: number;
	collectibleRevivedSessionsAfterRelease: number;
	continuityChecks: number;
	samples: Record<string, MemorySample>;
	states: Record<string, string>;
}

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

function workerCounts(): number[] {
	const index = Bun.argv.indexOf("--workers");
	const raw = index >= 0 ? Bun.argv[index + 1] : "1,4,8";
	const counts = raw?.split(",").map(Number) ?? [];
	if (counts.length === 0 || counts.some(value => !Number.isSafeInteger(value) || value <= 0)) {
		throw new Error("--workers must contain positive comma-separated integers");
	}
	return counts;
}

async function sampleMemory(): Promise<MemorySample> {
	Bun.gc(true);
	await Bun.sleep(20);
	Bun.gc(true);
	const memory = process.memoryUsage();
	const processWithHandleCounters = process as NodeJS.Process & {
		_getActiveHandles?: () => unknown[];
		_getActiveRequests?: () => unknown[];
	};
	const activeHandles = processWithHandleCounters._getActiveHandles?.().length ?? 0;
	const activeRequests = processWithHandleCounters._getActiveRequests?.().length ?? 0;
	let fdCount: number | null = null;
	let pss: number | null = null;
	if (process.platform === "linux") {
		try {
			fdCount = (await fs.readdir("/proc/self/fd")).length;
		} catch {
			// Some Linux sandboxes restrict procfs; null explicitly means unavailable.
		}
		try {
			const rollup = await Bun.file("/proc/self/smaps_rollup").text();
			const match = /^Pss:\s+(\d+) kB$/m.exec(rollup);
			if (match) pss = Number(match[1]) * 1024;
		} catch {
			// Some Linux sandboxes restrict procfs; null explicitly means unavailable.
		}
	}
	return {
		heapUsed: memory.heapUsed,
		external: memory.external,
		rss: memory.rss,
		pss,
		activeHandles,
		activeRequests,
		fdCount,
	};
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
			const worker = /benchmark worker (\d+)/.exec(contextText)?.[1];
			if (worker) continuityWorkers.add(worker);
		}
		starts++;
		const invocation = starts;
		if (starts === expectedStarts) allStarted.resolve();
		const stream = createAssistantMessageEventStream();
		void gate.then(() => {
			finish(stream, model, {
				type: "toolCall",
				id: `benchmark-yield-${invocation}`,
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

async function benchmark(count: number, payloadKiB: number): Promise<WorkerMemoryRun> {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	OrchestratorRuntime.resetGlobalForTests();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `proto-memory-${count}-`));
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
		fetch: () => Promise.reject(new Error("network disabled in memory benchmark")),
	});
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const started = Promise.withResolvers<void>();
	const transcriptPayload = "p".repeat(payloadKiB * 1024);
	const provider = scriptedProvider(started.promise, count, transcriptPayload);
	const streamFn = provider.streamFn;
	registerCustomApi("memory-benchmark-api", streamFn, "memory-lifecycle-benchmark");
	authStorage.setRuntimeApiKey("memory-benchmark", "offline-key");
	modelRegistry.registerProvider("memory-benchmark", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "offline-key",
		api: "memory-benchmark-api",
		models: [
			{
				id: "memory-benchmark-model",
				name: "Memory Benchmark Model",
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
		getSessionId: () => "memory-benchmark-parent",
		getAsyncJobOwnerId: () => "memory-benchmark-parent",
		getAgentId: () => "Main",
		getSessionSpawns: () => "*",
		getArtifactsDir: () => root,
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
	} as ToolSession;
	const runtime = OrchestratorRuntime.global();
	const agent = { ...getBundledAgent("worker")!, tools: ["yield"] } as AgentDefinition;
	const model = modelRegistry.find("memory-benchmark", "memory-benchmark-model");
	if (!model) throw new Error("failed to register deterministic benchmark model");
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
		const samples: Record<string, MemorySample> = { before: await sampleMemory() };
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const spawned = await runtime.spawn(session, { name: `memory-${index}`, prompt: `benchmark worker ${index}` });
			ids.push(spawned.id);
		}
		await provider.allStarted;
		const liveScreens = runtime.screens(session, ids);
		if (liveScreens.some(screen => screen.state !== "running"))
			throw new Error("workers did not reach running state");
		samples.live = await sampleMemory();

		started.resolve();
		await manager.waitForAll();
		await runtime.wait(session, { sessions: ids });
		const completedScreens = runtime.screens(session, ids);
		if (completedScreens.some(screen => screen.state !== "idle")) throw new Error("workers did not become idle");
		samples.completed = await sampleMemory();
		const sessionRefs = ids.map(weakSession);

		const lifecycle = AgentLifecycleManager.global();
		await Promise.all(ids.map(id => lifecycle.park(id)));
		const parkedRefs = ids.map(id => AgentRegistry.global().get(id));
		if (parkedRefs.some(ref => ref?.status !== "parked" || ref.session !== null)) {
			throw new Error(
				`workers did not park: ${JSON.stringify(parkedRefs.map(ref => ({ status: ref?.status, live: Boolean(ref?.session) })))}`,
			);
		}
		samples.parked = await sampleMemory();
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
		samples.revived = await sampleMemory();
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
		samples.released = await sampleMemory();
		const collectibleRevivedSessionsAfterRelease = await collectWeakRefs(revivedSessionRefs);
		return {
			workers: count,
			payloadKiB,
			collectibleOriginalSessionsAfterPark,
			collectibleRevivedSessionsAfterRelease,
			continuityChecks: provider.continuityChecks(),
			samples,
			states: { live: "running", completed: "idle", parked: "parked", revived: "idle", released: "dead" },
		};
	} finally {
		await manager.dispose({ timeoutMs: 1_000 });
		await AgentLifecycleManager.global().dispose();
		modelRegistry.unregisterProvider("memory-benchmark");
		unregisterCustomApis("memory-lifecycle-benchmark");
		authStorage.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

const payloadKiB = positiveOption("--payload-kib", 256);
if (Bun.argv.includes("--child")) {
	const counts = workerCounts();
	if (counts.length !== 1) throw new Error("child process requires exactly one worker count");
	console.log(JSON.stringify(await benchmark(counts[0]!, payloadKiB)));
} else {
	const runs: WorkerMemoryRun[] = [];
	for (const count of workerCounts()) {
		const child = Bun.spawn(
			[
				process.execPath,
				"--expose-gc",
				import.meta.path,
				"--child",
				"--workers",
				String(count),
				"--payload-kib",
				String(payloadKiB),
			],
			{ stdout: "pipe", stderr: "inherit", timeout: 60_000 },
		);
		const text = await new Response(child.stdout).text();
		const exitCode = await child.exited;
		if (exitCode !== 0) throw new Error(`benchmark child for ${count} workers exited ${exitCode}`);
		runs.push(JSON.parse(text) as WorkerMemoryRun);
	}
	console.log(
		JSON.stringify(
			{
				metadata: {
					platform: process.platform,
					bun: Bun.version,
					pss: process.platform === "linux" ? "/proc/self/smaps_rollup when readable" : "unavailable",
					provider: "in-process deterministic stream; no network or TUI",
					auxiliaryInference: "compaction and observational memory disabled for lifecycle isolation",
					processIsolation: "one fresh subprocess per worker count",
				},
				runs,
			},
			null,
			2,
		),
	);
	if (
		runs.some(
			run =>
				run.collectibleOriginalSessionsAfterPark !== run.workers ||
				run.collectibleRevivedSessionsAfterRelease !== run.workers,
		)
	) {
		throw new Error("Disposed worker sessions remain reachable; inspect the reported collection counts");
	}
}
