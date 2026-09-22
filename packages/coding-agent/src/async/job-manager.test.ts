import { describe, expect, test, vi } from "bun:test";

import { AsyncJobManager } from "./job-manager";

describe("AsyncJobManager cancellation retention", () => {
	test.each(["single", "bulk"] as const)("keeps %s cancelled work retrievable past retention", async kind => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ retentionMs: 25 });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"bash",
			"pending cleanup",
			async () => {
				await release.promise;
				return "cleanup finished";
			},
			{ ownerId: "owner" },
		);
		try {
			if (kind === "single") manager.cancel(jobId);
			else manager.cancelAll({ ownerId: "owner" });
			vi.advanceTimersByTime(50);
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
			const reap = await manager.cancelAndReapOwnerJobs("owner", Date.now());
			expect(reap.settled).toBe(false);
			expect(reap.pendingJobIds).toEqual([jobId]);
			release.resolve();
			await reap.completion;
			expect(manager.getJob(jobId)?.resultText).toBe("cleanup finished");
			expect(await manager.waitForOwnerJobs("owner")).toBe(true);
			vi.advanceTimersByTime(25);
			expect(manager.getJob(jobId)).toBeUndefined();
		} finally {
			release.resolve();
			await manager.waitForAll();
			await manager.dispose();
			vi.useRealTimers();
		}
	});
});

describe("AsyncJobManager registration and shutdown", () => {
	test("synchronous failures retain owner routing and honor zero retention", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("owner", (_id, text) => {
			delivered.push(text);
		});
		try {
			for (let i = 0; i < 100; i++) {
				manager.register(
					"worker",
					"sync failure",
					() => {
						throw new Error("failed synchronously");
					},
					{ ownerId: "owner" },
				);
				await manager.waitForAll();
			}
			await manager.drainDeliveries();
			expect(delivered).toEqual(Array(100).fill("failed synchronously"));
			expect(manager.getAllJobs()).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});

	test("late delivery failures cannot resurrect a disposed manager", async () => {
		const failure = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				started.resolve();
				await failure.promise;
			},
		});
		manager.register("worker", "late delivery", async () => "finished");
		await started.promise;
		expect(await manager.dispose({ timeoutMs: 0 })).toBe(false);
		failure.reject(new Error("late sink failure"));
		await Promise.resolve();
		await Promise.resolve();
		expect(manager.getDeliveryState().pendingJobIds).toEqual([]);
		expect(manager.getAllJobs()).toEqual([]);
		await manager.dispose({ timeoutMs: 0 });
	});
});
