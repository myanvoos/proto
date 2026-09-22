import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../async/job-manager";
import { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { OrchestratorRuntime } from "./runtime";

function scopedSession(sessionId: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => sessionId,
		getSessionFile: () => null,
		getAgentId: () => "Main",
		getSessionSpawns: () => null,
		settings: undefined as never,
	} as ToolSession;
}

describe("orchestrator lifecycle identity", () => {
	test("completion delivery is isolated by canonical parent session id", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const delivered: string[] = [];
		const unregisterA = manager.registerDeliverySink("parent-a", async (_jobId, text) => {
			delivered.push(`a:${text}`);
		});
		const unregisterB = manager.registerDeliverySink("parent-b", async (_jobId, text) => {
			delivered.push(`b:${text}`);
		});
		try {
			manager.register("worker", "worker A", async () => "result-a", { id: "worker-a-t1", ownerId: "parent-a" });
			manager.register("worker", "worker B", async () => "result-b", { id: "worker-b-t1", ownerId: "parent-b" });
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1_000 });
			expect(delivered.sort()).toEqual(["a:result-a", "b:result-b"]);
		} finally {
			unregisterA();
			unregisterB();
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	test("killIfManaged cancels the worker's in-flight turn, and ignores ids it does not own", async () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		runtime.setTeardownGraceForTesting(200);
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const parent = {
			getAgentId: () => "Main",
			getSessionId: () => "test-parent-session",
			getSessionFile: () => null,
			asyncJobManager: manager,
			settings: undefined as never,
		};
		let cancelled = false;
		let requests = 0;
		try {
			// A turn that keeps calling its provider until something cancels it — the shape of the
			// in-flight worker the agents view stop key used to leave running.
			manager.register(
				"worker",
				"stuck worker turn",
				async ({ signal }) => {
					while (!signal.aborted) {
						requests++;
						await new Promise(resolve => setTimeout(resolve, 5));
					}
					cancelled = true;
					return "aborted";
				},
				{ id: "worker-turn-1", ownerId: "test-parent-session" },
			);
			runtime.registerRecordForTests({ id: "worker-1", ownerId: "Main", state: "running", jobId: "worker-turn-1" });

			expect(await runtime.killIfManaged(parent, "not-a-worker")).toBeUndefined();
			const before = requests;
			const outcome = await runtime.killIfManaged(parent, "worker-1");

			expect(outcome?.id).toBe("worker-1");
			expect(outcome?.cancelledTurn).toBe(true);
			expect(before).toBeGreaterThan(0);

			// The turn observes the cancellation and stops issuing work; before the fix the UI had
			// no way to reach this signal and the worker kept calling its provider.
			for (let attempt = 0; attempt < 200 && !cancelled; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			expect(cancelled).toBe(true);
			const after = requests;
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(requests).toBe(after);
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	test("an idle worker without an authoritative registry ref is terminal, never stale idle", () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		runtime.registerRecordForTests({ id: "opaque-worker-1", ownerId: "Main", state: "idle" });
		const [screen] = runtime.screens(scopedSession("test-parent-session"));
		expect(screen.lifecycle).toBe("terminal");
		expect(screen.addressable).toBe(false);
		expect(screen.terminal?.reason).toBe("ownership-lost");
		expect(screen.terminal?.history).toBe("history://opaque-worker-1");
	});
	test("bounds terminal worker records while retaining the newest recovery entry", () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		const session = scopedSession("bounded-terminal-history");
		for (let index = 0; index < 130; index++) {
			runtime.registerRecordForTests({
				id: `terminal-worker-${index}`,
				ownerId: "Main",
				parentSessionId: "bounded-terminal-history",
				state: "idle",
			});
		}
		runtime.screens(session);
		const retained = runtime.listIds(session);
		expect(retained.length).toBeLessThanOrEqual(128);
		expect(retained).toContain("terminal-worker-129");
		expect(runtime.screens(session)).toHaveLength(retained.length);
	});
	test("duplicate display labels remain distinct across parent sessions", () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		runtime.registerRecordForTests({
			id: "worker-a",
			label: "review",
			ownerId: "Main",
			parentSessionId: "parent-a",
			state: "idle",
		});
		runtime.registerRecordForTests({
			id: "worker-b",
			label: "review",
			ownerId: "Main",
			parentSessionId: "parent-b",
			state: "idle",
		});
		AgentRegistry.global().register({
			id: "worker-a",
			label: "review",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "worker-b",
			label: "review",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const [screenA] = runtime.screens(scopedSession("parent-a"));
		const [screenB] = runtime.screens(scopedSession("parent-b"));
		expect(screenA).toMatchObject({ id: "worker-a", label: "review", addressable: true });
		expect(screenB).toMatchObject({ id: "worker-b", label: "review", addressable: true });
	});
	test("send rejects an aborted registry generation with terminal recovery context", async () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		runtime.registerRecordForTests({
			id: "worker-race",
			label: "race",
			ownerId: "Main",
			parentSessionId: "parent-race",
			state: "idle",
		});
		AgentRegistry.global().register({
			id: "worker-race",
			label: "race",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "aborted",
		});
		await expect(
			runtime.send(scopedSession("parent-race"), { session: "worker-race", message: "follow up" }),
		).rejects.toThrow(/history:\/\/worker-race/);
	});

	test("terminal records retain recovery identity after releasing live payloads", async () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		const manager = new AsyncJobManager({ retentionMs: 0 });
		const session = { ...scopedSession("terminal-payload"), asyncJobManager: manager };
		const agent = {
			name: "worker",
			description: "terminal payload test",
			systemPrompt: "terminal worker instructions ".repeat(10_000),
			source: "bundled" as const,
			tools: [],
		};
		const outputSchema = {
			type: "object",
			properties: { result: { type: "string" } },
		};
		runtime.registerRecordForTests({
			id: "worker-terminal-payload",
			label: "terminal payload",
			ownerId: "Main",
			parentSessionId: "terminal-payload",
			state: "idle",
			agent,
			outputSchema,
		});
		AgentRegistry.global().register({
			id: "worker-terminal-payload",
			label: "terminal payload",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});

		try {
			const killed = await runtime.kill(session, "worker-terminal-payload");
			expect(killed.receipt.status).toBe("terminal");
			expect(runtime.listIds(session)).toEqual(["worker-terminal-payload"]);
			expect(runtime.screens(session)).toMatchObject([
				{
					id: "worker-terminal-payload",
					label: "terminal payload",
					lifecycle: "terminal",
					turnState: undefined,
					addressable: false,
					terminal: { reason: "explicit-kill", history: "history://worker-terminal-payload" },
				},
			]);
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});
	test("a worker reported addressable can actually receive a message at 33 workers", async () => {
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const runtime = new OrchestratorRuntime();
		const manager = new AsyncJobManager({ retentionMs: 0 });
		const session = {
			...scopedSession("parent-33"),
			asyncJobManager: manager,
			settings: { get: (key: string) => (key === "orchestrator.maxConcurrency" ? 32 : undefined) },
		} as ToolSession;
		for (let index = 0; index < 33; index++) {
			const id = `worker-${index}`;
			registry.register({
				id,
				label: id,
				kind: "sub",
				parentId: "Main",
				session: {} as never,
				status: "idle",
			});
			runtime.registerRecordForTests({ id, ownerId: "Main", parentSessionId: "parent-33", state: "idle" });
		}
		try {
			expect(runtime.screens(session)[0]).toMatchObject({ id: "worker-0", addressable: true });
			const sent = await runtime.send(session, { session: "worker-0", message: "continue oldest worker" });
			expect(sent).toMatchObject({ id: "worker-0", mode: "turn", receipt: { status: "accepted", turn: 1 } });
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	test("busy-worker follow-ups get distinct turns and overflow is rejected with retry guidance", async () => {
		AgentRegistry.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const runtime = new OrchestratorRuntime();
		registry.register({
			id: "busy-worker",
			label: "busy",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: false } as never,
			status: "running",
		});
		runtime.registerRecordForTests({
			id: "busy-worker",
			ownerId: "Main",
			parentSessionId: "queue-parent",
			state: "running",
			jobId: "busy-worker-t1",
		});
		const session = scopedSession("queue-parent");
		const receipts = [];
		for (let index = 0; index < 32; index++) {
			receipts.push(await runtime.send(session, { session: "busy-worker", message: `follow-up-${index}` }));
		}
		expect(receipts[0]?.receipt).toMatchObject({ status: "queued", turn: 2 });
		expect(receipts.at(-1)?.receipt).toMatchObject({ status: "queued", turn: 33 });
		await expect(
			runtime.send(session, { session: "busy-worker", message: "overflow must be retried" }),
		).rejects.toThrow("Wait for a turn to settle, then retry this message");
		expect(runtime.screens(session)[0]).toMatchObject({
			queued: 32,
		});
	});
});
