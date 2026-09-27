import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../async/job-manager";
import type { ToolSession } from "../tools";
import { OrchestratorRuntime } from "./runtime";
import { claimWakeTurn, resetWakeTurnOwnersForTests } from "./wake-turns";

function session(sessionId: string, manager?: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => sessionId,
		getSessionFile: () => null,
		getAgentId: () => "Main",
		getAsyncJobOwnerId: () => sessionId,
		getSessionSpawns: () => null,
		settings: { get: () => 0 } as never,
		...(manager ? { asyncJobManager: manager } : {}),
	} as ToolSession;
}

describe("orchestrator scope session cache", () => {
	test("list-only scopes release their owners on suspension even without worker records", async () => {
		const runtime = new OrchestratorRuntime();
		for (let index = 0; index < 64; index++) {
			const owner = session(`empty-scope-${index}`);
			runtime.screens(owner);
			await runtime.suspendScope(runtime.ownerScope(owner));
		}
		expect(runtime.scopeCacheSizeForTesting()).toBe(0);
	});

	test("retiring the last worker releases each obsolete scope session cache entry", async () => {
		const runtime = new OrchestratorRuntime();
		for (let index = 0; index < 64; index++) {
			const parent = session(`retired-scope-${index}`);
			runtime.screens(parent);
			runtime.registerRecordForTests({
				id: `worker-${index}`,
				ownerId: "Main",
				parentSessionId: `retired-scope-${index}`,
			});
			await runtime.suspendScope(runtime.ownerScope(parent));
		}
		expect(runtime.scopeCacheSizeForTesting()).toBe(0);
		resetWakeTurnOwnersForTests();
	});

	test("terminal history does not retain its disposed parent in the scope cache", async () => {
		const runtime = new OrchestratorRuntime();
		const parent = session("terminal-scope");
		runtime.registerRecordForTests({
			id: "terminal-worker",
			ownerId: "Main",
			parentSessionId: parent.getSessionId!() ?? undefined,
		});
		runtime.screens(parent);

		await runtime.kill(parent, "terminal-worker");

		expect(runtime.scopeCacheSizeForTesting()).toBe(0);
		expect(runtime.screens(parent, ["terminal-worker"])[0]?.lifecycle).toBe("terminal");
	});

	test("terminating a worker evicts its completed turn metadata", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const runtime = new OrchestratorRuntime();
		const parent = session("worker-job-scope", manager);
		const jobId = manager.register("worker", "worker turn", async () => "worker result", {
			ownerId: "worker-job-scope",
			agentId: "worker-job",
		});
		runtime.registerRecordForTests({
			id: "worker-job",
			ownerId: "Main",
			parentSessionId: parent.getSessionId!() ?? undefined,
			jobId,
		});

		try {
			await runtime.kill(parent, "worker-job");
			expect(manager.getJob(jobId)).toBeUndefined();
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	test("pending wake settles without retaining its disposed parent in the scope cache", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		const runtime = new OrchestratorRuntime();
		const parent = session("pending-wake-scope", manager);
		runtime.screens(parent);
		runtime.registerRecordForTests({
			id: "pending-wake-worker",
			ownerId: "Main",
			parentSessionId: parent.getSessionId!() ?? undefined,
		});

		try {
			const claim = claimWakeTurn("pending-wake-worker", "wake after parent switch");
			expect(claim).toBeDefined();
			await runtime.suspendScope(runtime.ownerScope(parent), manager);
			expect(runtime.scopeCacheSizeForTesting()).toBe(0);

			claim?.settle({
				index: 0,
				id: "pending-wake-worker",
				agent: "worker",
				agentSource: "bundled",
				task: "wake after parent switch",
				exitCode: 0,
				output: "wake complete",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			});
			await manager.waitForAll();
			expect(runtime.scopeCacheSizeForTesting()).toBe(0);
		} finally {
			resetWakeTurnOwnersForTests();
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});
});
