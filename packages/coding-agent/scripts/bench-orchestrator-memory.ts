import type { Model } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "../src/async/job-manager";
import { Settings } from "../src/config/settings";
import { ORCHESTRATOR_IDLE_PAYLOAD_WINDOW, OrchestratorRuntime } from "../src/orchestrator/runtime";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";

function option(name: string, fallback: number): number {
	const index = Bun.argv.indexOf(name);
	const value = index >= 0 ? Number(Bun.argv[index + 1]) : fallback;
	return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function collectMemory(): NodeJS.MemoryUsage {
	Bun.gc(true);
	return process.memoryUsage();
}

function makePayload(size: number, seed: number): object {
	return { values: Array.from({ length: Math.max(1, Math.ceil(size / 8)) }, (_, index) => (index + seed) % 10) };
}

function adoptAbortedWorker(
	lifecycle: AgentLifecycleManager,
	registry: AgentRegistry,
	worker: number,
	payloadSize: number,
): WeakRef<object> {
	const id = `lifecycle-${worker}`;
	const ref = registry.register({ id, displayName: id, kind: "sub", session: null, status: "parked" });
	const payload = makePayload(payloadSize, worker);
	const weak = new WeakRef(payload);
	lifecycle.adopt(id, { idleTtlMs: 0, revive: async () => payload as never });
	registry.setStatus(id, "aborted", ref);
	return weak;
}

const lifecycleWorkers = option("--lifecycle-workers", 40);
const lifecyclePayloadSize = option("--lifecycle-payload-size", 64 * 1024);
const ordinaryWorkers = option("--ordinary-workers", 20);
const stressWorkers = option("--stress-workers", 80);
const propertiesPerWorker = option("--properties", 3_000);
const ordinaryPromptSize = option("--ordinary-prompt-size", 4_096);
const agentPromptSize = option("--agent-prompt-size", 32_768);
const propertySuffix = "x".repeat(option("--property-suffix", 16));

AgentRegistry.resetGlobalForTests();
AgentLifecycleManager.resetGlobalForTests();
const lifecycleRegistry = new AgentRegistry();
const lifecycle = new AgentLifecycleManager(lifecycleRegistry);
const lifecycleWeakRefs: WeakRef<object>[] = [];
for (let worker = 0; worker < lifecycleWorkers; worker++) {
	lifecycleWeakRefs.push(adoptAbortedWorker(lifecycle, lifecycleRegistry, worker, lifecyclePayloadSize));
}
const lifecycleBeforeDispose = collectMemory();
const lifecycleRetainedAbortedRevivers = lifecycleWeakRefs.filter(ref => ref.deref() !== undefined).length;
await lifecycle.dispose();

const settings = Settings.isolated({ "orchestrator.maxConcurrency": 1, "orchestrator.agentIdleTtlMs": 60_000 });
const manager = new AsyncJobManager({ retentionMs: 0 });
const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings,
	asyncJobManager: manager,
	getSessionFile: () => null,
	getSessionId: () => "memory-benchmark-parent",
	getAsyncJobOwnerId: () => "memory-benchmark-parent",
	getAgentId: () => "Main",
	getSessionSpawns: () => "*",
};

const runtime = new OrchestratorRuntime();
const before = collectMemory();
const schemaRefs: WeakRef<object>[] = [];
const ordinaryPrompt = "ordinary task prompt ".repeat(Math.ceil(ordinaryPromptSize / 22)).slice(0, ordinaryPromptSize);
for (let worker = 0; worker < ordinaryWorkers; worker++) {
	const agent = {
		name: "worker",
		description: "ordinary benchmark worker",
		systemPrompt: "ordinary worker instructions ".repeat(Math.ceil(agentPromptSize / 29)).slice(0, agentPromptSize),
		source: "bundled" as const,
		tools: [],
	};
	runtime.setWorkerResolutionForTesting(agent, {} as Model);
	const spawned = await runtime.spawn(session, {
		agent: "worker",
		name: `ordinary-${worker}`,
		prompt: ordinaryPrompt,
		outputSchema: { type: "object", properties: { result: { type: "string" } } },
	});
	manager.cancel(spawned.jobId, { ownerId: "memory-benchmark-parent" });
}
for (let worker = 0; worker < stressWorkers; worker++) {
	const properties: Record<string, { type: "string" }> = {};
	for (let property = 0; property < propertiesPerWorker; property++) {
		properties[`worker_${worker}_${property}_${propertySuffix}`] = { type: "string" };
	}
	const agent = {
		name: "worker",
		description: "stress benchmark worker",
		systemPrompt: "stress worker instructions",
		source: "bundled" as const,
		tools: [],
	};
	runtime.setWorkerResolutionForTesting(agent, {} as Model);
	const outputSchema = { type: "object", properties };
	schemaRefs.push(new WeakRef(outputSchema));
	const spawned = await runtime.spawn(session, {
		agent: "worker",
		name: `stress-${worker}`,
		prompt: `stress task ${worker}: ${ordinaryPrompt}`,
		outputSchema,
	});
	manager.cancel(spawned.jobId, { ownerId: "memory-benchmark-parent" });
}
await manager.waitForAll();
const retainedWorkerIds = runtime.listIds(session).length;
const after = collectMemory();
const retainedOutputSchemas = schemaRefs.filter(ref => ref.deref() !== undefined).length;
const expectedWorkerIds = ordinaryWorkers + stressWorkers;
if (retainedWorkerIds !== expectedWorkerIds) {
	throw new Error(`Worker records lost addressability: expected ${expectedWorkerIds}, got ${retainedWorkerIds}`);
}
if (expectedWorkerIds > ORCHESTRATOR_IDLE_PAYLOAD_WINDOW && retainedOutputSchemas > ORCHESTRATOR_IDLE_PAYLOAD_WINDOW) {
	throw new Error(
		`Worker payload window exceeded: ${retainedOutputSchemas} output schemas retained (cap ${ORCHESTRATOR_IDLE_PAYLOAD_WINDOW})`,
	);
}
console.log(
	JSON.stringify({
		lifecycleWorkers,
		lifecyclePayloadSize,
		lifecycleRetainedAbortedRevivers,
		lifecycleHeapUsed: lifecycleBeforeDispose.heapUsed,
		ordinaryWorkers,
		stressWorkers,
		propertiesPerWorker,
		ordinaryPromptSize,
		agentPromptSize,
		before,
		after,
		heapUsedDelta: after.heapUsed - before.heapUsed,
		rssDelta: after.rss - before.rss,
		retainedWorkerIds,
		retainedOutputSchemas,
		retainedJobs: manager.getAllJobs().length,
	}),
);
