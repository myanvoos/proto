import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "../async/job-manager";
import { Settings } from "../config/settings";
import { registerWakeTurnOwner } from "../orchestrator/wake-turns";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { attachWakeTurnMonitor } from "../task/executor";
import type { MonitorToolDetails } from "../tools/monitor";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { MONITOR_EVENT_MESSAGE_TYPE } from "./monitor-event";
import { SessionManager } from "./session-manager";

const TEST_TIMESTAMP = 1_700_000_000_000;

interface Harness {
	session: AgentSession;
	authStorage: AuthStorage;
	agentDir: string;
}

function stubAnswer(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ack" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: TEST_TIMESTAMP,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function createHarness(options: {
	id: string;
	sub?: boolean;
	registry: AgentRegistry;
	asyncEnabled?: boolean;
}): Promise<Harness> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-wake-"));
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	try {
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir,
			agentId: options.id,
			taskDepth: options.sub ? 1 : 0,
			parentTaskPrefix: options.sub ? options.id : undefined,
			agentRegistry: options.registry,
			settings: Settings.isolated({
				"async.enabled": options.asyncEnabled ?? true,
				"monitor.enabled": true,
				"compaction.enabled": false,
				"checklist.enabled": false,
				"tools.xdev": false,
			}),
			authStorage,
			sessionManager: SessionManager.inMemory(process.cwd()),
			disableExtensionDiscovery: true,
			enableMCP: false,
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			extensions: [],
		});
		session.agent.setModel(
			buildModel({
				id: "monitor-wake-test",
				name: "Monitor Wake Test",
				api: "openai-responses",
				provider: "monitor-wake-test",
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		session.agent.getApiKey = () => "test";
		return { session, authStorage, agentDir };
	} catch (error) {
		authStorage.close();
		await fs.rm(agentDir, { recursive: true, force: true });
		throw error;
	}
}

async function closeHarness(harness: Harness): Promise<void> {
	await harness.session.dispose();
	harness.authStorage.close();
	await fs.rm(harness.agentDir, { recursive: true, force: true });
}

function delivered(harness: Harness): string[] {
	return harness.session.agent.state.messages.flatMap(message =>
		message.role === "custom" && message.customType === MONITOR_EVENT_MESSAGE_TYPE
			? [typeof message.content === "string" ? message.content : ""]
			: [],
	);
}

function answerTurns(harness: Harness): Promise<void> {
	const turnStarted = Promise.withResolvers<void>();
	harness.session.agent.streamFn = () => {
		turnStarted.resolve();
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: stubAnswer() }));
		return stream;
	};
	return turnStarted.promise;
}

async function start(harness: Harness, command: string, label = "deploy") {
	const tool = harness.session.getToolByName("monitor");
	expect(tool).toBeDefined();
	const result = await tool!.execute("start-monitor", { op: "start", command, label, match: "READY", maxEvents: 100 });
	expect(result.isError).toBeUndefined();
	return (result.details as MonitorToolDetails).monitors[0]!;
}

async function sharedHarnesses(
	run: (
		manager: AsyncJobManager,
		registry: AgentRegistry,
		parent: Harness,
		worker: Harness,
		sibling: Harness,
	) => Promise<void>,
) {
	const previous = AsyncJobManager.instance();
	const manager = new AsyncJobManager({});
	const registry = new AgentRegistry();
	AsyncJobManager.setInstance(manager);
	const harnesses: Harness[] = [];
	try {
		for (const id of ["monitor-parent", "monitor-worker", "monitor-sibling"]) {
			harnesses.push(await createHarness({ id, sub: id !== "monitor-parent", registry }));
		}
		await run(manager, registry, harnesses[0]!, harnesses[1]!, harnesses[2]!);
	} finally {
		for (const harness of harnesses) await closeHarness(harness);
		await manager.dispose();
		AsyncJobManager.setInstance(previous);
	}
}

test("a registered subagent monitor wakes only its owner and invokes the wake-turn observer", async () => {
	await sharedHarnesses(async (manager, registry, parent, worker, sibling) => {
		const started = answerTurns(worker);
		let foreignTurns = 0;
		for (const other of [parent, sibling]) {
			answerTurns(other);
			other.session.agent.streamFn = () => {
				foreignTurns++;
				throw new Error("Foreign monitor delivery");
			};
		}
		let wakeCount = 0;
		let finished = 0;
		const completed = Promise.withResolvers<void>();
		const unregisterWake = registerWakeTurnOwner("monitor-worker", task => {
			wakeCount++;
			expect(task).toContain("READY worker");
			return {
				progress: () => {},
				settle: result => {
					finished++;
					expect(result.output).toContain("ack");
					completed.resolve();
				},
				fail: error => completed.reject(error),
			};
		});
		try {
			attachWakeTurnMonitor(worker.session, {
				id: "monitor-worker",
				agent: { name: "worker", description: "test", systemPrompt: "test", source: "bundled" },
			});
			const monitor = await start(worker, "printf 'noise\nREADY worker\n'; sleep 60");
			expect(manager.getJob(monitor.id)?.ownerId).toBe(worker.session.sessionId);
			expect(registry.get("monitor-worker")?.kind).toBe("sub");
			expect(parent.session.hasActiveMonitors()).toBe(false);
			expect(sibling.session.hasActiveMonitors()).toBe(false);
			await started;
			await worker.session.waitForIdle();
			expect(delivered(worker).join("\n")).toContain("READY worker");
			expect(delivered(worker).join("\n")).not.toContain("noise");
			expect(delivered(worker).join("\n")).toContain(monitor.id);
			await completed.promise;
			expect(wakeCount).toBeGreaterThan(0);
			expect(finished).toBe(wakeCount);
			expect(foreignTurns).toBe(0);
			expect(delivered(parent)).toEqual([]);
			expect(delivered(sibling)).toEqual([]);
		} finally {
			unregisterWake();
		}
	});
}, 30_000);

test("fleet lists and cancels monitor jobs without leaking owner events or hanging settlement", async () => {
	await sharedHarnesses(async (manager, _registry, parent, worker, sibling) => {
		for (const harness of [parent, worker, sibling]) answerTurns(harness);
		const own = await start(worker, "sleep 60", "worker monitor");
		const other = await start(sibling, "sleep 60", "sibling monitor");
		expect(worker.session.hasPendingAsyncWork()).toBe(false);
		await worker.session.settleAsyncWork();
		expect(manager.getJob(own.id)?.status).toBe("running");
		const fleet = worker.session.getToolByName("fleet")!;
		const listed = await fleet.execute("list", { op: "jobs" });
		const text = listed.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain(own.id);
		const cancelled = await fleet.execute("cancel", { op: "cancel", ids: [own.id] });
		expect(cancelled.isError).toBeUndefined();
		await worker.session.settleAsyncWork();
		expect(manager.getJob(own.id)?.status).toBe("cancelled");
		expect(manager.getJob(other.id)?.status).toBe("running");
		expect(worker.session.hasActiveMonitors()).toBe(false);
		expect(delivered(parent)).toEqual([]);
		expect(delivered(sibling)).toEqual([]);
	});
}, 30_000);

test("disposing a shared-manager owner reaps only its monitors", async () => {
	await sharedHarnesses(async (manager, _registry, parent, worker, sibling) => {
		const own = await start(worker, "sleep 60");
		const other = await start(sibling, "sleep 60");
		const ownJob = manager.getJob(own.id)!;
		const cancelled = await start(worker, "sleep 60", "already cancelled");
		const cancelledJob = manager.getJob(cancelled.id)!;
		let reaped = false;
		let cancelledReaped = false;
		void ownJob.promise.then(() => {
			reaped = true;
		});
		void cancelledJob.promise.then(() => {
			cancelledReaped = true;
		});
		expect(manager.cancel(cancelled.id, { ownerId: worker.session.sessionId })).toBe(true);
		await worker.session.dispose();
		expect(reaped).toBe(true);
		expect(cancelledReaped).toBe(true);
		expect(ownJob.status).toBe("cancelled");
		expect(manager.getRunningJobs({ ownerId: worker.session.sessionId })).toEqual([]);
		expect(manager.getJob(other.id)?.status).toBe("running");
		expect(sibling.session.hasActiveMonitors()).toBe(true);
		expect(parent.session.hasActiveMonitors()).toBe(false);
	});
}, 30_000);

test("idle worker parking retains active monitor owner until cancellation", async () => {
	await sharedHarnesses(async (_manager, registry, _parent, worker) => {
		const lifecycle = new AgentLifecycleManager(registry);
		try {
			const monitor = await start(worker, "sleep 60");
			registry.setStatus("monitor-worker", "idle");
			lifecycle.adopt("monitor-worker", { idleTtlMs: 0 });
			await lifecycle.park("monitor-worker");
			expect(registry.get("monitor-worker")?.session).toBe(worker.session);
			expect(worker.session.isDisposed).toBe(false);
			await worker.session.getToolByName("fleet")!.execute("cancel", { op: "cancel", ids: [monitor.id] });
			await worker.session.settleAsyncWork();
			await lifecycle.park("monitor-worker");
			expect(registry.get("monitor-worker")?.status).toBe("parked");
			expect(worker.session.isDisposed).toBe(true);
		} finally {
			await lifecycle.dispose();
		}
	});
}, 30_000);

test("async disabled hides the monitor tool even with a shared manager", async () => {
	const previous = AsyncJobManager.instance();
	const manager = new AsyncJobManager({});
	AsyncJobManager.setInstance(manager);
	const harness = await createHarness({
		id: "disabled",
		sub: true,
		registry: new AgentRegistry(),
		asyncEnabled: false,
	});
	try {
		expect(harness.session.asyncJobManager).toBeUndefined();
		expect(harness.session.getToolByName("monitor")).toBeUndefined();
	} finally {
		await closeHarness(harness);
		await manager.dispose();
		AsyncJobManager.setInstance(previous);
	}
}, 30_000);

test("fleet event consumption invalidates an already queued lazy monitor yield", async () => {
	await sharedHarnesses(async (manager, _registry, parent, worker, sibling) => {
		const queued = Promise.withResolvers<Array<() => unknown>>();
		const enqueue = worker.session.yieldQueue.enqueue.bind(worker.session.yieldQueue);
		const spy = spyOn(worker.session.yieldQueue, "enqueue").mockImplementation((kind, entry) => {
			enqueue(kind, entry);
			if (kind === MONITOR_EVENT_MESSAGE_TYPE) queued.resolve(worker.session.yieldQueue.drainLazy());
		});
		try {
			const monitor = await start(worker, "printf 'READY once\n'; sleep 60");
			const lazy = await queued.promise;
			const waiting = await worker.session
				.getToolByName("fleet")!
				.execute("wait", { op: "wait", ids: [monitor.id] });
			expect(waiting.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(
				"READY once",
			);
			expect(lazy.map(build => build())).toEqual([null]);
			expect(manager.takeEvents([monitor.id], { ownerId: worker.session.sessionId })).toEqual([]);
			expect(delivered(worker)).toEqual([]);
			expect(delivered(parent)).toEqual([]);
			expect(delivered(sibling)).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});
}, 30_000);

test("switching sessions cancels old owner monitors and binds events to the new owner", async () => {
	await sharedHarnesses(async (manager, _registry, parent, worker, sibling) => {
		const oldOwner = worker.session.sessionId;
		const old = await start(worker, "sleep 60");
		const oldJob = manager.getJob(old.id)!;
		const other = await start(sibling, "sleep 60");
		expect(await worker.session.newSession()).toBe(true);
		expect(worker.session.sessionId).not.toBe(oldOwner);
		expect(oldJob.status).toBe("cancelled");
		await oldJob.promise;
		const turn = answerTurns(worker);
		const current = await start(worker, "printf 'READY new owner\n'");
		expect(manager.getJob(current.id)?.ownerId).toBe(worker.session.sessionId);
		await turn;
		await worker.session.waitForIdle();
		expect(delivered(worker).join("\n")).toContain("READY new owner");
		expect(manager.getJob(other.id)?.status).toBe("running");
		expect(delivered(parent)).toEqual([]);
		expect(delivered(sibling)).toEqual([]);
	});
}, 30_000);
