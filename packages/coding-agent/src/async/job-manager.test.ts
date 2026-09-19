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
