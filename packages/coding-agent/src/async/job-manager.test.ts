import { describe, expect, test, vi } from "bun:test";

import { type AsyncJobEvent, AsyncJobManager } from "./job-manager";

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

	test("evicts completed jobs for one worker without evicting a sibling", async () => {
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		try {
			manager.register("worker", "worker turn", async () => "worker result", {
				ownerId: "parent",
				agentId: "worker-a",
			});
			manager.register("worker", "sibling turn", async () => "sibling result", {
				ownerId: "parent",
				agentId: "worker-b",
			});
			await manager.waitForAll();

			expect(manager.evictCompletedJobs({ ownerId: "parent", agentId: "worker-a" })).toBe(1);
			expect(manager.getAllJobs({ ownerId: "parent", agentId: "worker-a" })).toEqual([]);
			expect(manager.getAllJobs({ ownerId: "parent", agentId: "worker-b" })).toHaveLength(1);
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

describe("monitor job events", () => {
	test("routes repeated events only to their owner and never falls back to another sink", async () => {
		const fallback: string[] = [];
		const parent: string[] = [];
		const sibling: string[] = [];
		const own: AsyncJobEvent[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_id, text) => {
				fallback.push(text);
			},
		});
		manager.registerDeliverySink("parent", (_id, text) => {
			parent.push(text);
		});
		manager.registerDeliverySink("sibling", (_id, text) => {
			sibling.push(text);
		});
		manager.registerDeliverySink("worker", (_id, _text, _job, event) => {
			if (event) {
				own.push(event);
				manager.acknowledgeEvents([event]);
			}
		});
		try {
			manager.register(
				"monitor",
				"owned watch",
				async ({ emitEvent }) => {
					emitEvent("output", "first");
					emitEvent("output", "second");
					emitEvent("exit", "exited");
					return "terminal summary";
				},
				{ ownerId: "worker" },
			);
			manager.register(
				"monitor",
				"orphan watch",
				async ({ emitEvent }) => {
					emitEvent("output", "not for parent");
					return "orphan";
				},
				{ ownerId: "missing" },
			);
			await manager.waitForAll();
			await manager.drainDeliveries();
			expect(own.map(event => [event.sequence, event.text])).toEqual([
				[1, "first"],
				[2, "second"],
				[3, "exited"],
			]);
			expect(parent).toEqual([]);
			expect(sibling).toEqual([]);
			expect(fallback).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});

	test("wait consumption acknowledges only received events and later events still wake", async () => {
		const manager = new AsyncJobManager({});
		const delivered: AsyncJobEvent[] = [];
		manager.registerDeliverySink("worker", (_id, _text, _job, event) => {
			if (event) delivered.push(event);
		});
		const finish = Promise.withResolvers<string>();
		let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {
			throw new Error("not started");
		};
		const id = manager.register(
			"monitor",
			"watch",
			async ({ emitEvent }) => {
				emit = emitEvent;
				return finish.promise;
			},
			{ ownerId: "worker" },
		);
		const abort = new AbortController();
		try {
			manager.watchJobs([id]);
			const next = manager.waitForEvents([id], abort.signal);
			emit("output", "one");
			await next;
			expect(manager.takeEvents([id], { ownerId: "sibling" })).toEqual([]);
			const received = manager.takeEvents([id], { ownerId: "worker" });
			expect(received.map(event => event.text)).toEqual(["one"]);
			expect(manager.isEventAcknowledged(received[0]!)).toBe(true);
			manager.unwatchJobs([id]);
			emit("output", "two");
			await manager.drainDeliveries();
			expect(delivered.map(event => event.text)).toEqual(["two"]);
			manager.acknowledgeDeliveries([id]);
			emit("output", "three");
			await manager.drainDeliveries();
			expect(delivered.map(event => event.text)).toEqual(["two", "three"]);
			manager.acknowledgeEvents([delivered[1]!]);
			expect(manager.takeEvents([id]).map(event => event.text)).toEqual(["two"]);
		} finally {
			abort.abort();
			finish.resolve("done");
			await manager.dispose();
		}
	});

	test("monitors do not consume finite capacity or block settlement but cancellation cleanup is awaited", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		const cleanup = Promise.withResolvers<string>();
		const worker = Promise.withResolvers<string>();
		try {
			const monitor = manager.register("monitor", "open ended", async () => cleanup.promise, { ownerId: "worker" });
			expect(manager.atCapacity).toBe(false);
			manager.register("bash", "finite", async () => worker.promise, { ownerId: "worker" });
			expect(manager.atCapacity).toBe(true);
			worker.resolve("done");
			expect(await manager.waitForOwnerJobs("worker", { excludeMonitors: true, timeoutMs: 100 })).toBe(true);
			const reap = await manager.cancelAndReapOwnerJobs("worker", Date.now() + 100, { excludeMonitors: true });
			expect(reap.settled).toBe(true);
			expect(manager.getJob(monitor)?.status).toBe("running");
			expect(manager.cancel(monitor, { ownerId: "sibling" })).toBe(false);
			manager.cancel(monitor, { ownerId: "worker" });
			expect(await manager.waitForOwnerJobs("worker", { excludeMonitors: true, timeoutMs: 0 })).toBe(false);
			cleanup.resolve("reaped");
			expect(await manager.waitForOwnerJobs("worker", { excludeMonitors: true })).toBe(true);
		} finally {
			cleanup.resolve("done");
			worker.resolve("done");
			await manager.dispose();
		}
	});

	test("cancelled waits release deferred events instead of discarding them", async () => {
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("owner", (_id, text, _job, event) => {
			delivered.push(text);
			if (event) manager.acknowledgeEvents([event]);
		});
		const finish = Promise.withResolvers<string>();
		let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {};
		const id = manager.register(
			"monitor",
			"watch",
			async ({ emitEvent }) => {
				emit = emitEvent;
				return finish.promise;
			},
			{ ownerId: "owner" },
		);
		try {
			manager.watchJobs([id]);
			const abort = new AbortController();
			const wait = manager.waitForEvents([id], abort.signal);
			abort.abort();
			await wait;
			emit("output", "still relevant");
			manager.unwatchJobs([id]);
			await manager.drainDeliveries();
			expect(delivered).toEqual(["still relevant"]);
		} finally {
			finish.resolve("done");
			await manager.dispose();
		}
	});
});

test("retrying one monitor event does not lose it when a later event is acknowledged first", async () => {
	const manager = new AsyncJobManager({});
	const received: string[] = [];
	let failFirst = true;
	manager.registerDeliverySink("owner", (_id, text, _job, event) => {
		if (text === "first" && failFirst) {
			failFirst = false;
			throw new Error("transient delivery failure");
		}
		received.push(text);
		if (event) manager.acknowledgeEvents([event]);
	});
	try {
		manager.register(
			"monitor",
			"watch",
			async ({ emitEvent }) => {
				emitEvent("output", "first");
				emitEvent("output", "second");
				return "done";
			},
			{ ownerId: "owner" },
		);
		await manager.waitForAll();
		expect(await manager.drainDeliveries({ timeoutMs: 2000 })).toBe(true);
		expect(received).toEqual(["second", "first"]);
	} finally {
		await manager.dispose();
	}
});

test("cancelling a watched monitor discards pending events and cannot emit after cancellation", async () => {
	const manager = new AsyncJobManager({});
	const delivered: string[] = [];
	manager.registerDeliverySink("owner", (_id, text) => {
		delivered.push(text);
	});
	const finish = Promise.withResolvers<string>();
	let emit: (kind: AsyncJobEvent["kind"], text: string) => void = () => {};
	const id = manager.register(
		"monitor",
		"watch",
		async ({ emitEvent }) => {
			emit = emitEvent;
			return finish.promise;
		},
		{ ownerId: "owner" },
	);
	try {
		manager.watchJobs([id]);
		emit("output", "pending");
		manager.cancel(id, { ownerId: "owner" });
		emit("output", "too late");
		manager.unwatchJobs([id]);
		await manager.drainDeliveries();
		expect(delivered).toEqual([]);
		expect(manager.takeEvents([id])).toEqual([]);
	} finally {
		finish.resolve("done");
		await manager.dispose();
	}
});

test("zero retention retains terminal monitor events until the owner consumes them", async () => {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const received: AsyncJobEvent[] = [];
	manager.registerDeliverySink("owner", (_id, _text, _job, event) => {
		if (event) received.push(event);
	});
	try {
		const id = manager.register(
			"monitor",
			"watch",
			async ({ emitEvent }) => {
				emitEvent("exit", "exited");
				return "done";
			},
			{ ownerId: "owner" },
		);
		await manager.waitForAll();
		await manager.drainDeliveries();
		expect(manager.getJob(id)?.status).toBe("completed");
		expect(received.map(event => event.text)).toEqual(["exited"]);
		manager.acknowledgeEvents(received);
		expect(manager.getJob(id)).toBeUndefined();
	} finally {
		await manager.dispose();
	}
});

test("overlapping wait leases keep a job suppressed until the last one ends, then deliver it once", async () => {
	const manager = new AsyncJobManager({});
	const delivered: string[] = [];
	manager.registerDeliverySink("owner", jobId => {
		delivered.push(jobId);
	});
	const finish = Promise.withResolvers<string>();
	try {
		const id = manager.register("bash", "job", async () => finish.promise, { ownerId: "owner" });
		manager.watchJobs([id]);
		manager.watchJobs([id]);
		finish.resolve("done");
		await manager.getJob(id)!.promise;
		// The first wait ends without consuming: the second still holds the job.
		manager.unwatchJobs([id]);
		await manager.drainDeliveries();
		expect(delivered).toEqual([]);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		// The last lease ends unconsumed, so the settled result falls back to automatic delivery.
		manager.unwatchJobs([id]);
		await manager.drainDeliveries();
		expect(delivered).toEqual([id]);
	} finally {
		await manager.dispose();
	}
});

test("a job subscription observes progress and settlement without affecting delivery", async () => {
	const manager = new AsyncJobManager({});
	const delivered: string[] = [];
	manager.registerDeliverySink("owner", (_id, text) => {
		delivered.push(text);
	});
	const finish = Promise.withResolvers<string>();
	let report: (text: string) => Promise<void> = async () => {};
	try {
		const id = manager.register(
			"bash",
			"job",
			async ({ reportProgress }) => {
				report = reportProgress;
				return finish.promise;
			},
			{ ownerId: "owner" },
		);
		const seen: string[] = [];
		const unsubscribe = manager.subscribe(id, observation => {
			seen.push(observation.kind === "progress" ? observation.text : observation.kind);
		});
		await report("half");
		unsubscribe();
		await report("ignored after unsubscribe");
		finish.resolve("result");
		await manager.getJob(id)!.promise;
		await manager.drainDeliveries();
		expect(seen).toEqual(["half"]);
		expect(delivered).toEqual(["result"]);
	} finally {
		await manager.dispose();
	}
});
