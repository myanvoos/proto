import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import { OrchestratorRuntime } from "../orchestrator/runtime";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { getBundledAgent } from "../task/agents";
import { ExecutionAdmission } from "../task/execution-admission";
import type { FleetDetails } from "../tools/fleet/types";
import type { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { readNodeTopology } from "./node-topology";
import { artifactsDirectoryFor, SessionManager } from "./session-manager";

const provider: StreamFn = model => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({
			type: "done",
			reason: "toolUse",
			message: {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [
					{
						type: "toolCall",
						id: crypto.randomUUID(),
						name: "yield",
						arguments: { result: { data: "immutable answer" } },
					},
				],
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		}),
	);
	return stream;
};

async function fixture(extensions: ExtensionFactory[] = []) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-temporal-"));
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing deterministic model fixture");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"orchestrator.maxConcurrency": 1,
		"orchestrator.agentIdleTtlMs": 60_000,
	});
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: path.join(dir, "agent"),
		authStorage: auth,
		sessionManager: SessionManager.create(dir, path.join(dir, "sessions")),
		model,
		settings,
		streamFn: provider,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableIrc: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		extensions,
	});
	const runtime = OrchestratorRuntime.global();
	const worker = getBundledAgent("worker");
	if (!worker) throw new Error("Missing bundled worker fixture");
	runtime.setWorkerResolutionForTesting({ ...worker, tools: ["fleet", "jobs", "yield"] }, model);
	const forks: AgentSession[] = [];
	return {
		session,
		runtime,
		forks,
		dir,
		async close() {
			for (const fork of forks) await fork.dispose();
			await session.dispose();
			auth.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

async function spawn(session: AgentSession, message: string): Promise<AgentSession> {
	const tool = session.getToolByName("fleet");
	if (!tool) throw new Error("Session cannot spawn children");
	const result = await tool.execute("temporal-test-spawn", { op: "spawn", message });
	const details = result.details as FleetDetails;
	if (result.isError || !details.spawned) throw new Error(JSON.stringify(result));
	// Starting work is admitted synchronously but may not have entered the AgentSession yet.
	const receipt = details.receipt;
	if (receipt) {
		const jobs = session.getToolByName("jobs");
		if (!jobs) throw new Error("Session has no owned-job wait tool");
		const waited = await jobs.execute("temporal-test-wait", {
			op: "wait",
			targets: [receipt.job],
			timeoutMs: 10_000,
		});
		if (waited.isError || !AgentRegistry.global().get(details.spawned.id)?.session)
			throw new Error(JSON.stringify(waited));
	}
	const child = AgentRegistry.global().get(details.spawned.id)?.session;
	if (!child) throw new Error("Child runtime was not registered");
	await withTimeout(child.waitForIdle(), 10_000, "Child failed to settle");
	await withTimeout(session.settleAsyncWork(), 10_000, "Owner result delivery failed to settle");
	await session.waitForStreamingIdle();
	return child;
}

test("forking a depth-three node creates an independent spawning root without changing source ownership or results", async () => {
	const f = await fixture();
	try {
		let node = f.session;
		for (let depth = 1; depth <= 3; depth++) node = await spawn(node, `depth-${depth}`);
		const source = node.sessionManager;
		const file = source.getSessionFile()!;
		const head = source.getLeafId();
		const topology = source.getNodeTopology();
		const parentFile = topology!.parentSessionFile!;
		const parentReceipt = await Bun.file(parentFile).text();
		const sourceTree = AgentRegistry.global()
			.descendants(f.session.sessionId)
			.map(ref => ref.nodeId);
		const sourceBytes = await Bun.file(file).text();
		const fork = await node.fork();
		if (!fork) throw new Error("Fork was cancelled");
		f.forks.push(fork);
		expect(fork.sessionManager.getNodeTopology()).toMatchObject({
			id: fork.sessionId,
			rootId: fork.sessionId,
			state: "active",
		});
		expect(fork.sessionManager.getNodeTopology()?.parentId).toBeUndefined();
		expect(fork.getEvalKernelOwnerId()).not.toBe(node.getEvalKernelOwnerId());
		expect(source.getLeafId()).toBe(head);
		expect(source.getNodeTopology()).toEqual(topology);
		expect(await Bun.file(file).text()).toBe(sourceBytes);
		expect(await Bun.file(parentFile).text()).toBe(parentReceipt);
		expect(
			AgentRegistry.global()
				.descendants(f.session.sessionId)
				.map(ref => ref.nodeId),
		).toEqual(sourceTree);
		const child = await spawn(fork, "fresh-root-child");
		expect(child.sessionManager.getNodeTopology()?.rootId).toBe(fork.sessionId);
		expect(AgentRegistry.global().descendants(fork.sessionId)).toHaveLength(1);
		expect(source.getNodeTopology()).toEqual(topology);
	} finally {
		await f.close();
	}
}, 30_000);

test("navigation updates a parked child's canonical journal so revival cannot restore the abandoned generation", async () => {
	const f = await fixture();
	try {
		const boundary = f.session.sessionManager.appendMessage({ role: "user", content: "before child", timestamp: 1 });
		const child = await spawn(f.session, "park-before-navigation");
		const childId = child.getAgentId();
		if (!childId) throw new Error("Spawned child has no agent identity");
		const childJournal = child.sessionManager;
		await AgentLifecycleManager.global().releaseRuntime(childId);
		expect(AgentRegistry.global().get(childId)?.status).toBe("parked");
		await f.session.navigateTree(boundary);
		expect(childJournal.getNodeTopology()).toMatchObject({ state: "abandoned", generation: 1 });
		expect(childJournal.isReleased).toBe(false);
		await expect(AgentLifecycleManager.global().ensureLive(childId)).rejects.toThrow("no longer active");
		expect(await readNodeTopology(child.sessionFile!)).toMatchObject({ state: "abandoned", generation: 1 });
	} finally {
		await f.close();
	}
}, 30_000);

test("navigation preserves early children, durably abandons late children, and refuses racing admitted work", async () => {
	const f = await fixture();
	try {
		const parent = await spawn(f.session, "temporal-parent");
		const early = await spawn(parent, "early-child");
		const boundary = parent.sessionManager.getLeafId()!;
		const late = await spawn(parent, "late-child");
		const grandchild = await spawn(late, "late-grandchild");
		const topology = parent.sessionManager.getNodeTopology()!;
		const reservation = ExecutionAdmission.global().reserveSpawn({
			nodeId: crypto.randomUUID(),
			parentId: topology.id,
			treeId: topology.rootId,
			maxChildren: 0,
			maxNodes: 0,
		});
		await expect(parent.navigateTree(boundary)).rejects.toThrow("accepted work");
		reservation.release();
		const parentFile = parent.sessionFile!;
		const receipt = await Bun.file(f.session.sessionFile!).text();
		await parent.navigateTree(boundary);
		expect(early.sessionManager.getNodeTopology()?.state).toBe("active");
		expect(await readNodeTopology(late.sessionFile!)).toMatchObject({ state: "abandoned", generation: 1 });
		expect(await readNodeTopology(grandchild.sessionFile!)).toMatchObject({ state: "abandoned", generation: 1 });
		const browseOnlyHistory = late.sessionManager.getEntries();
		await expect(late.prompt("must not revive")).rejects.toThrow();
		expect(late.sessionManager.getEntries()).toEqual(browseOnlyHistory);
		expect(await Bun.file(f.session.sessionFile!).text()).toBe(receipt);
		const reopened = await SessionManager.open(parentFile, undefined, undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getNodeTopology()?.generation).toBe(topology.generation + 1);
			expect(reopened.getBranch().some(entry => entry.id === boundary)).toBe(true);
		} finally {
			await reopened.close();
		}
		await parent.waitForStreamingIdle();
		await parent.prompt("continue from navigated head");
		await parent.waitForIdle();
		expect(
			parent.messages.some(
				message =>
					message.role === "user" && JSON.stringify(message.content).includes("continue from navigated head"),
			),
		).toBe(true);
		expect(early.sessionManager.getNodeTopology()?.state).toBe("active");
		await parent.navigateTree(late.sessionManager.getNodeTopology()!.spawnAnchorId!);
		expect(await readNodeTopology(late.sessionFile!)).toMatchObject({ state: "abandoned", generation: 1 });
		await expect(late.prompt("revisiting does not reactivate old generation")).rejects.toThrow();
		const readOnly = await SessionManager.openReadOnly(late.sessionFile!);
		try {
			expect(readOnly.getNodeTopology()?.state).toBe("abandoned");
		} finally {
			await readOnly.close();
		}
	} finally {
		await f.close();
	}
}, 30_000);

test("a committed cut survives a failed source write and requires reopening instead of executing stale context", async () => {
	const f = await fixture();
	try {
		const manager = f.session.sessionManager;
		const boundary = manager.appendCustomEntry("retained-boundary", { value: "retained" });
		const abandoned = manager.appendMessage({ role: "user", content: "abandoned continuation", timestamp: 1 });
		await manager.ensureOnDisk();
		const previousGeneration = manager.getNodeTopology()!.generation;
		const failCut = spyOn(manager, "branch").mockImplementation(() => {
			throw new Error("cut publication failed");
		});
		try {
			await expect(f.session.navigateTree(boundary)).rejects.toThrow("cut publication failed");
		} finally {
			failCut.mockRestore();
		}
		expect(f.session.isDisposed).toBe(true);
		await expect(f.session.prompt("must not run old context")).rejects.toThrow();
		const recovered = await SessionManager.open(manager.getSessionFile()!, undefined, undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		try {
			expect(recovered.getNodeTopology()?.generation).toBe(previousGeneration + 1);
			expect(recovered.getBranch().some(entry => entry.id === boundary)).toBe(true);
			expect(recovered.getBranch().some(entry => entry.id === abandoned)).toBe(false);
		} finally {
			await recovered.close();
		}
	} finally {
		await f.close();
	}
}, 30_000);

test("an independently active ancestor does not block idle grandchild navigation", async () => {
	const f = await fixture();
	const release = Promise.withResolvers<void>();
	let ancestorTurn: Promise<void> | undefined;
	try {
		let node = f.session;
		for (let depth = 1; depth <= 3; depth++) node = await spawn(node, `isolated-depth-${depth}`);
		const boundary = node.sessionManager.appendCustomEntry("local-boundary");
		const late = node.sessionManager.appendMessage({ role: "user", content: "local abandoned tail", timestamp: 1 });
		const entered = Promise.withResolvers<void>();
		const topology = f.session.sessionManager.getNodeTopology()!;
		ancestorTurn = ExecutionAdmission.global().runTurn(
			{ nodeId: topology.id, treeId: topology.rootId, maxConcurrency: 1, signal: new AbortController().signal },
			async () => {
				entered.resolve();
				await release.promise;
			},
		);
		await entered.promise;
		await node.navigateTree(boundary);
		expect(node.sessionManager.getBranch().some(entry => entry.id === late)).toBe(false);
		expect(f.session.sessionManager.getNodeTopology()).toEqual(topology);
	} finally {
		release.resolve();
		await ancestorTurn;
		await f.close();
	}
}, 30_000);

test("fork artifacts retain readable output payloads without copying source descendant histories", async () => {
	const f = await fixture();
	try {
		const child = await spawn(f.session, "source-child-history");
		const artifact = await f.session.sessionManager.allocateArtifactPath("temporal-test");
		if (!artifact.path) throw new Error("No artifact storage was allocated");
		await Bun.write(artifact.path, "historical output payload");
		const fork = await f.session.fork();
		if (!fork) throw new Error("Fork was cancelled");
		f.forks.push(fork);
		const sourceArtifacts = artifactsDirectoryFor(f.session.sessionFile)!;
		const forkArtifacts = artifactsDirectoryFor(fork.sessionFile)!;
		expect(await Bun.file(path.join(forkArtifacts, path.relative(sourceArtifacts, artifact.path))).text()).toBe(
			"historical output payload",
		);
		const copiedChildHistory = path.join(forkArtifacts, path.relative(sourceArtifacts, child.sessionFile!));
		expect(await Bun.file(copiedChildHistory).exists()).toBe(false);
		expect(AgentRegistry.global().descendants(fork.sessionId)).toHaveLength(0);
		expect(AgentRegistry.global().getNode(child.sessionManager.getNodeTopology()!.id)?.session).toBe(child);
	} finally {
		await f.close();
	}
}, 30_000);

test("a spawn racing an already-frozen navigation cannot leave an orphan record", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const f = await fixture([
		pi =>
			pi.on("session_before_tree", async () => {
				entered.resolve();
				await release.promise;
			}),
	]);
	let navigating: Promise<unknown> | undefined;
	try {
		const boundary = f.session.sessionManager.appendCustomEntry("race-boundary");
		f.session.sessionManager.appendMessage({ role: "user", content: "abandoned race tail", timestamp: 1 });
		navigating = f.session.navigateTree(boundary);
		await withTimeout(entered.promise, 5_000, "Navigation did not acquire its subtree freeze");
		await expect(spawn(f.session, "must not become an orphan")).rejects.toThrow("transition");
		release.resolve();
		await navigating;
		expect(AgentRegistry.global().descendants(f.session.sessionId)).toHaveLength(0);
	} finally {
		release.resolve();
		await navigating;
		await f.close();
	}
}, 30_000);
