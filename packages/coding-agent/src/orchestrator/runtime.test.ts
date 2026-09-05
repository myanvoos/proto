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

	test("an idle worker without an authoritative registry ref is terminal, never stale idle", () => {
		AgentRegistry.resetGlobalForTests();
		OrchestratorRuntime.resetGlobalForTests();
		const runtime = OrchestratorRuntime.global();
		runtime.registerRecordForTests({ id: "opaque-worker-1", ownerId: "Main", state: "idle" });
		const [screen] = runtime.screens(scopedSession("test-parent-session"));
		expect(screen.state).toBe("dead");
		expect(screen.addressable).toBe(false);
		expect(screen.terminal?.reason).toBe("ownership-lost");
		expect(screen.terminal?.history).toBe("history://opaque-worker-1");
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
			displayName: "review",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "worker-b",
			displayName: "review",
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
			displayName: "race",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "aborted",
		});
		await expect(
			runtime.send(scopedSession("parent-race"), { session: "worker-race", message: "follow up" }),
		).rejects.toThrow(/history:\/\/worker-race/);
	});
});
