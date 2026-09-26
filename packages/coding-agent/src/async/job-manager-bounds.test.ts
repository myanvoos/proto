import { describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "./job-manager";

async function flushPromises(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("async resource admission", () => {
	test("reservation resizing atomically enforces both byte budgets without consuming another count slot", async () => {
		const manager = new AsyncJobManager({ maxTotalJobs: 3, maxOwnerJobs: 2, maxTotalBytes: 100, maxOwnerBytes: 60 });
		try {
			const first = manager.reserve({ ownerId: "a", bytes: 20 });
			const sameOwner = manager.reserve({ ownerId: "a", bytes: 10 });
			const other = manager.reserve({ ownerId: "b", bytes: 40 });
			first.resize(40);
			expect(() => other.resize(51)).toThrow(/byte/);
			sameOwner.release();
			// Rejected global growth leaves the old charge intact, so exactly 20 bytes remain.
			manager.reserve({ ownerId: "c", bytes: 20 }).release();
			other.resize(20);
			expect(() => first.resize(61)).toThrow(/byte/);
			expect(() => first.resize(-1)).toThrow(/bytes/);
			// Rejected owner growth also preserves the old charge, leaving 20 owner bytes.
			manager.reserve({ ownerId: "a", bytes: 20 }).release();
			first.resize(10);
			other.resize(60);
			const last = manager.reserve({ ownerId: "c", bytes: 30 });
			expect(manager.atCapacity).toBe(true);
			last.release();
			first.release();
			other.release();
			expect(manager.atCapacity).toBe(false);
		} finally {
			await manager.dispose();
		}
	});

	test("resizing cannot release registered callback bytes during cancellation or reuse retired tokens", async () => {
		const manager = new AsyncJobManager({ maxOwnerBytes: 60 });
		const finish = Promise.withResolvers<string>();
		try {
			const admission = manager.reserve({ ownerId: "owner", bytes: 40 });
			const id = manager.register("worker", "job", () => finish.promise, { ownerId: "owner", admission });
			expect(() => admission.resize(0)).toThrow(/unavailable/);
			manager.cancel(id);
			expect(() => admission.resize(0)).toThrow(/unavailable/);
			expect(() => manager.reserve({ ownerId: "owner", bytes: 21 })).toThrow(/byte/);
			finish.resolve("done");
			await manager.waitForAll();
			expect(() => admission.resize(0)).toThrow(/unavailable/);
			const released = manager.reserve({ ownerId: "owner", bytes: 60 });
			released.release();
			expect(() => released.resize(0)).toThrow(/unavailable/);
			const unused = manager.reserve();
			await manager.dispose();
			expect(() => unused.resize(0)).toThrow(/unavailable/);
		} finally {
			finish.resolve("done");
			await manager.dispose();
		}
	});
	test("monitor callbacks also hold total admission through noncooperative cancellation", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 1, maxTotalJobs: 1 });
		const finish = Promise.withResolvers<string>();
		try {
			const id = manager.register("monitor", "watch", () => finish.promise, { ownerId: "owner" });
			expect(() => manager.register("monitor", "another", async () => "unexpected", { ownerId: "owner" })).toThrow(
				/limit/,
			);
			manager.cancel(id);
			expect(() => manager.register("worker", "replacement", async () => "unexpected")).toThrow(/limit/);
			finish.resolve("done");
			await manager.waitForAll();
			const replacement = manager.register("worker", "replacement", async () => "accepted");
			await manager.waitForAll();
			expect(manager.getJob(replacement)?.resultText).toBe("accepted");
		} finally {
			finish.resolve("done");
			await manager.dispose();
		}
	});

	test("monitor commands count toward pending input byte admission", async () => {
		const manager = new AsyncJobManager({ maxTotalBytes: 100 });
		const finish = Promise.withResolvers<string>();
		try {
			manager.register("monitor", "watch", () => finish.promise, {
				ownerId: "owner",
				monitor: { command: "x".repeat(60), cwd: "/", mode: "stream", eventCount: 0, maxEvents: 10 },
			});
			expect(() =>
				manager.register("monitor", "watch", async () => "unexpected", {
					ownerId: "owner",
					monitor: { command: "x".repeat(40), cwd: "/", mode: "stream", eventCount: 0, maxEvents: 10 },
				}),
			).toThrow(/byte/);
		} finally {
			finish.resolve("done");
			await manager.dispose();
		}
	});
	test("invalid or reused reservations cannot start work or consume another owner's admission", async () => {
		const manager = new AsyncJobManager({ maxTotalJobs: 1 });
		const run = vi.fn(async () => "done");
		try {
			expect(() => manager.register("worker", "long label", run, { bytes: -1 })).toThrow(/bytes/);
			const reserved = manager.reserve({ ownerId: "owner", bytes: 10 });
			expect(() => manager.register("worker", "job", run, { ownerId: "other", admission: reserved })).toThrow(
				/owner/,
			);
			expect(run).not.toHaveBeenCalled();
			manager.register("worker", "job", run, { ownerId: "owner", admission: reserved });
			expect(() => manager.register("worker", "job", run, { ownerId: "owner", admission: reserved })).toThrow(
				/admission/,
			);
			await manager.waitForAll();
			expect(run).toHaveBeenCalledTimes(1);
			const unused = manager.reserve();
			expect(manager.atCapacity).toBe(true);
			unused.release();
			expect(manager.atCapacity).toBe(false);
		} finally {
			await manager.dispose();
		}
	});
	test.each(["single", "bulk"] as const)(
		"%s cancellation cannot admit replacement work before cleanup settles",
		async kind => {
			const manager = new AsyncJobManager({ maxRunningJobs: 1 });
			const cleanup = Promise.withResolvers<string>();
			const id = manager.register("bash", "ignores cancellation", () => cleanup.promise);
			const available = vi.fn();
			try {
				manager.onCapacityAvailable(available);
				if (kind === "single") manager.cancel(id);
				else manager.cancelAll();
				expect(manager.getJob(id)?.status).toBe("cancelled");
				expect(manager.getRunningJobs()).toEqual([]);
				expect(manager.atCapacity).toBe(true);
				expect(available).not.toHaveBeenCalled();
				expect(() => manager.register("bash", "replacement", async () => "unexpected")).toThrow(/limit/);
				cleanup.reject(new Error("late cleanup failed"));
				await manager.waitForAll();
				expect(manager.atCapacity).toBe(false);
				expect(available).toHaveBeenCalledTimes(1);
				expect(manager.getJob(id)?.status).toBe("cancelled");
				expect(manager.getJob(id)?.errorText).toBe("late cleanup failed");
			} finally {
				cleanup.resolve("done");
				await manager.dispose();
			}
		},
	);

	test("queued work and pre-allocation reservations share total and owner byte admission", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			maxTotalJobs: 3,
			maxTotalBytes: 100,
			maxOwnerJobs: 2,
			maxOwnerBytes: 60,
		});
		const finish = Promise.withResolvers<string>();
		try {
			const held = manager.reserve({ ownerId: "a", bytes: 40 });
			expect(() => manager.reserve({ ownerId: "a", bytes: 21 })).toThrow(/byte/);
			const id = manager.register("worker", "queued", () => finish.promise, {
				ownerId: "a",
				queued: true,
				admission: held,
			});
			held.release();
			manager.cancel(id);
			expect(() => manager.reserve({ ownerId: "a", bytes: 21 })).toThrow(/byte/);
			const other = manager.reserve({ ownerId: "b", bytes: 60 });
			expect(() => manager.reserve({ ownerId: "c", bytes: 1 })).toThrow(/byte/);
			other.release();
			const last = manager.reserve({ ownerId: "a", bytes: 20 });
			expect(() => manager.reserve({ ownerId: "a" })).toThrow(/limit/);
			const third = manager.reserve({ ownerId: "b" });
			expect(() => manager.register("worker", "fourth", async () => "unexpected", { queued: true })).toThrow(
				/limit/,
			);
			finish.resolve("finished");
			await manager.waitForAll();
			manager.reserve({ ownerId: "a", bytes: 40 }).release();
			last.release();
			third.release();
		} finally {
			finish.resolve("done");
			await manager.dispose();
		}
	});
});

describe("bounded async delivery", () => {
	test("acknowledging a failed delivery immediately releases its retained payload", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({
			onJobComplete: () => {
				throw new Error("sink unavailable");
			},
		});
		try {
			const id = manager.register("worker", "result", async () => "payload");
			await manager.waitForAll();
			await flushPromises();
			expect(manager.getDeliveryState().queued).toBe(1);
			expect(manager.acknowledgeDeliveries([id])).toBe(1);
			expect(manager.getDeliveryState().retainedBytes).toBe(0);
			expect(manager.getJob(id)?.resultText).toBe("payload");
		} finally {
			await manager.dispose({ timeoutMs: 0 });
			vi.useRealTimers();
		}
	});

	test("a lone failed sink retries without requiring another job or an explicit drain", async () => {
		vi.useFakeTimers();
		const received: string[] = [];
		let attempts = 0;
		const failedCall = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: (_id, text) => {
				if (++attempts === 1) return failedCall.promise;
				received.push(text);
			},
		});
		try {
			manager.register("worker", "result", async () => "retry me");
			await manager.waitForAll();
			await flushPromises();
			expect(attempts).toBe(1);
			failedCall.reject(new Error("temporary failure"));
			await flushPromises();
			vi.advanceTimersByTime(750);
			await flushPromises();
			expect(received).toEqual(["retry me"]);
			expect(manager.getDeliveryState().retainedBytes).toBe(0);
			expect(manager.getDeliveryState().dropped).toBe(0);
		} finally {
			await manager.dispose({ timeoutMs: 0 });
			vi.useRealTimers();
		}
	});

	test("permanently failing sinks expire independently of successful job status and retention", async () => {
		vi.useFakeTimers();
		const sink = vi.fn(() => {
			throw new Error("sink unavailable");
		});
		const manager = new AsyncJobManager({ onJobComplete: sink, deliveryRetentionMs: 1_000, retentionMs: 5_000 });
		try {
			const id = manager.register("worker", "result", async () => "durable result");
			await manager.waitForAll();
			await flushPromises();
			vi.advanceTimersByTime(750);
			await flushPromises();
			expect(sink).toHaveBeenCalledTimes(2);
			expect(manager.getDeliveryState()).toMatchObject({ queued: 0, retainedBytes: 0, dropped: 1 });
			expect(manager.getJob(id)).toMatchObject({ status: "completed", resultText: "durable result" });
			vi.advanceTimersByTime(60_000);
			await flushPromises();
			expect(sink).toHaveBeenCalledTimes(2);
		} finally {
			await manager.dispose({ timeoutMs: 0 });
			vi.useRealTimers();
		}
	});

	test("timed-out sink calls hold effective capacity until settlement while other owners can still drain", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ maxDeliveryCalls: 2, deliveryTimeoutMs: 20, deliveryRetentionMs: 1_000 });
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const firstSink = vi.fn(() => first.promise);
		const secondSink = vi.fn(() => second.promise);
		const healthySink = vi.fn();
		manager.registerDeliverySink("first", firstSink);
		manager.registerDeliverySink("second", secondSink);
		manager.registerDeliverySink("healthy", healthySink);
		try {
			manager.register("worker", "first", async () => "one", { ownerId: "first" });
			manager.register("worker", "second", async () => "two", { ownerId: "second" });
			const healthy = manager.register("worker", "healthy", async () => "three", { ownerId: "healthy" });
			await manager.waitForAll();
			await flushPromises();
			expect(firstSink).toHaveBeenCalledTimes(1);
			expect(secondSink).toHaveBeenCalledTimes(1);
			expect(healthySink).not.toHaveBeenCalled();
			const bytesWithCalls = manager.getDeliveryState().retainedBytes;
			vi.advanceTimersByTime(20);
			await flushPromises();
			expect(manager.getDeliveryState()).toMatchObject({ queued: 1, unresolvedCalls: 2, dropped: 2 });
			expect(manager.getDeliveryState().retainedBytes).toBe(bytesWithCalls);
			expect(healthySink).not.toHaveBeenCalled();
			first.resolve();
			await flushPromises();
			expect(healthySink).toHaveBeenCalledTimes(1);
			expect(healthySink.mock.calls[0]?.slice(0, 2)).toEqual([healthy, "three"]);
			second.reject(new Error("late sink rejection"));
			await flushPromises();
			expect(manager.getDeliveryState()).toMatchObject({
				queued: 0,
				unresolvedCalls: 0,
				retainedBytes: 0,
				dropped: 2,
			});
			vi.advanceTimersByTime(60_000);
			await flushPromises();
			expect(firstSink).toHaveBeenCalledTimes(1);
			expect(secondSink).toHaveBeenCalledTimes(1);
		} finally {
			first.resolve();
			second.resolve();
			await flushPromises();
			await manager.dispose({ timeoutMs: 0 });
			vi.useRealTimers();
		}
	});

	test("delivery byte pressure drops queued payloads but never forgets unresolved call ownership", async () => {
		vi.useFakeTimers();
		const finish = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			maxDeliveryBytes: 100,
			maxDeliveries: 10,
			deliveryTimeoutMs: 10,
			deliveryRetentionMs: 1_000,
			onJobComplete: () => finish.promise,
		});
		try {
			manager.register("worker", "first", async () => "a".repeat(20));
			await manager.waitForAll();
			await flushPromises();
			vi.advanceTimersByTime(10);
			await flushPromises();
			for (let i = 0; i < 20; i++) {
				manager.register("worker", "queued", async () => "b".repeat(20));
				await manager.waitForAll();
			}
			expect(manager.getDeliveryState().retainedBytes).toBeLessThanOrEqual(100);
			expect(manager.getDeliveryState().unresolvedCalls).toBe(1);
			expect(manager.getDeliveryState().queued).toBe(1);
			expect(manager.getDeliveryState().dropped).toBe(20);
			manager.register("worker", "oversized", async () => "x".repeat(100));
			await manager.waitForAll();
			expect(manager.getDeliveryState().dropped).toBe(21);
			vi.advanceTimersByTime(1_000);
			await flushPromises();
			expect(manager.getDeliveryState()).toMatchObject({ queued: 0, unresolvedCalls: 1, dropped: 22 });
			finish.resolve();
			await flushPromises();
			expect(manager.getDeliveryState().retainedBytes).toBe(0);
		} finally {
			finish.resolve();
			await flushPromises();
			await manager.dispose({ timeoutMs: 0 });
			vi.useRealTimers();
		}
	});

	test("watched monitor events obey the delivery count and lifetime limits", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ maxDeliveries: 2, deliveryRetentionMs: 20, retentionMs: 0 });
		const finish = Promise.withResolvers<string>();
		let emit: (text: string) => void = () => {
			throw new Error("monitor not started");
		};
		const id = manager.register(
			"monitor",
			"watch",
			async ({ emitEvent }) => {
				emit = text => emitEvent("output", text);
				return finish.promise;
			},
			{ ownerId: "owner" },
		);
		try {
			manager.watchJobs([id]);
			emit("oldest");
			emit("middle");
			emit("newest");
			expect(manager.getJob(id)?.events?.map(event => event.text)).toEqual(["middle", "newest"]);
			expect(manager.getDeliveryState().dropped).toBe(1);
			finish.resolve("done");
			await manager.waitForAll();
			expect(manager.getJob(id)?.status).toBe("completed");
			vi.advanceTimersByTime(20);
			await flushPromises();
			expect(manager.takeEvents([id])).toEqual([]);
			expect(manager.getJob(id)).toBeUndefined();
			expect(manager.getDeliveryState()).toMatchObject({ retainedBytes: 0, dropped: 3 });
		} finally {
			finish.resolve("done");
			await manager.dispose({ timeoutMs: 0 });
			vi.useRealTimers();
		}
	});
});

describe("bounded async history", () => {
	test("completed history evicts oldest entries by count without changing successful delivery", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			maxRetainedJobs: 2,
			onJobComplete: (_id, text) => {
				delivered.push(text);
			},
		});
		try {
			const ids: string[] = [];
			for (const text of ["old", "middle", "new"]) {
				ids.push(manager.register("worker", "job", async () => text));
				await manager.waitForAll();
			}
			await manager.drainDeliveries();
			expect(delivered).toEqual(["old", "middle", "new"]);
			expect(manager.getJob(ids[0]!)).toBeUndefined();
			expect(manager.getJob(ids[1]!)?.status).toBe("completed");
			expect(manager.getJob(ids[2]!)?.status).toBe("completed");
		} finally {
			await manager.dispose();
		}
	});

	test("oversized completed payloads are delivered without retaining them or purging affordable history", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			maxRetainedBytes: 100,
			onJobComplete: (_id, text) => {
				delivered.push(text);
			},
		});
		try {
			const old = manager.register("worker", "job", async () => "a".repeat(20));
			await manager.waitForAll();
			const recent = manager.register("worker", "job", async () => "b".repeat(20));
			await manager.waitForAll();
			expect(manager.getJob(old)).toBeUndefined();
			expect(manager.getJob(recent)?.resultText).toBe("b".repeat(20));
			const oversized = manager.register("worker", "job", async () => "x".repeat(100));
			await manager.waitForAll();
			await manager.drainDeliveries();
			expect(delivered).toEqual(["a".repeat(20), "b".repeat(20), "x".repeat(100)]);
			expect(manager.getJob(oversized)).toBeUndefined();
			expect(manager.getJob(recent)?.resultText).toBe("b".repeat(20));
		} finally {
			await manager.dispose();
		}
	});

	test("completed monitor commands are included in the retained-history byte budget", async () => {
		const manager = new AsyncJobManager({ maxRetainedBytes: 100 });
		try {
			const id = manager.register("monitor", "job", async () => "done", {
				ownerId: "owner",
				monitor: { command: "x".repeat(100), cwd: "/", mode: "stream", eventCount: 0, maxEvents: 10 },
			});
			await manager.waitForAll();
			expect(manager.getJob(id)).toBeUndefined();
		} finally {
			await manager.dispose();
		}
	});

	test("retired owners and historical polling cannot leave an ever-escalated next wait", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0 });
		try {
			const first = manager.nextPollWaitMs("owner", 0);
			manager.recordPollWaitEnd("owner", 1);
			expect(manager.nextPollWaitMs("owner", 2)).toBeGreaterThan(first);
			const unregister = manager.registerDeliverySink("owner", () => {});
			unregister();
			expect(manager.nextPollWaitMs("owner", 3)).toBe(first);
			manager.recordPollWaitEnd("owner", 4);
			expect(manager.nextPollWaitMs("owner", 5)).toBeGreaterThan(first);
			manager.register("worker", "job", async () => "done", { ownerId: "owner" });
			await manager.waitForAll();
			expect(manager.nextPollWaitMs("owner", 6)).toBe(first);
			manager.recordPollWaitEnd("owner", 7);
			expect(manager.nextPollWaitMs("owner", 8)).toBeGreaterThan(first);
			for (let index = 0; index < 300; index++) manager.nextPollWaitMs(`historical-${index}`, 9);
			expect(manager.nextPollWaitMs("owner", 10)).toBe(first);
		} finally {
			await manager.dispose();
		}
	});

	test("watching and acknowledging nonexistent history cannot suppress a later job with that identity", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_id, text) => {
				delivered.push(text);
			},
		});
		try {
			expect(manager.watchJobs(["later"])).toBe(0);
			expect(manager.acknowledgeDeliveries(["later"])).toBe(0);
			manager.register("worker", "job", async () => "delivered", { id: "later" });
			await manager.waitForAll();
			await manager.drainDeliveries();
			expect(delivered).toEqual(["delivered"]);
		} finally {
			await manager.dispose();
		}
	});
});
