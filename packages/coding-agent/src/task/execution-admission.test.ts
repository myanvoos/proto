import { expect, test } from "bun:test";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async/job-manager";
import { ExecutionAdmission, type ExecutionTurn } from "./execution-admission";

function turn(nodeId: string, treeId = "root", signal = new AbortController().signal): ExecutionTurn {
	return { nodeId, treeId, signal, maxConcurrency: 1 };
}

test("overlapping waits do not resume either continuation before all dependencies and permit reacquisition", async () => {
	const scheduler = new ExecutionAdmission();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const lent = Promise.withResolvers<void>();
	const unrelatedStarted = Promise.withResolvers<void>();
	const unrelatedRelease = Promise.withResolvers<void>();
	const events: string[] = [];
	const parent = scheduler.runTurn(turn("parent"), async () => {
		await Promise.all([
			scheduler
				.withWaitPermit("parent", async () => {
					lent.resolve();
					await first.promise;
				})
				.then(() => events.push("first resumed")),
			scheduler.withWaitPermit("parent", () => second.promise).then(() => events.push("second resumed")),
		]);
	});
	await lent.promise;
	const unrelated = scheduler.runTurn(turn("other", "other-root"), async () => {
		unrelatedStarted.resolve();
		await unrelatedRelease.promise;
	});
	await unrelatedStarted.promise;
	first.resolve();
	await Promise.resolve();
	second.resolve();
	await Promise.resolve();
	expect(events).toEqual([]);
	unrelatedRelease.resolve();
	await withTimeout(Promise.all([parent, unrelated]), 1_000, "overlapping wait leaked a permit");
	expect(events.sort()).toEqual(["first resumed", "second resumed"]);
	await scheduler.runTurn(turn("next"), async () => events.push("next completed"));
	expect(events.at(-1)).toBe("next completed");
});

for (const duringReacquisition of [false, true]) {
	test(`cancellation during ${duringReacquisition ? "reacquisition" : "dependency wait"} never resumes cancelled code or blocks unrelated work`, async () => {
		const scheduler = new ExecutionAdmission();
		const cancellation = new AbortController();
		const dependency = Promise.withResolvers<void>();
		const lent = Promise.withResolvers<void>();
		const otherStarted = Promise.withResolvers<void>();
		const otherRelease = Promise.withResolvers<void>();
		let continued = false;
		const parent = scheduler.runTurn(turn("parent", "root", cancellation.signal), async () => {
			await scheduler.withWaitPermit("parent", async () => {
				lent.resolve();
				await dependency.promise;
			});
			continued = true;
		});
		const rejected = parent.catch(error => error);
		await lent.promise;
		const other = scheduler.runTurn(turn("other", "other-root"), async () => {
			otherStarted.resolve();
			await otherRelease.promise;
		});
		await otherStarted.promise;
		if (duringReacquisition) {
			dependency.resolve();
			await Promise.resolve();
			await Promise.resolve();
		}
		cancellation.abort(new Error("cancelled parent"));
		expect(await withTimeout(rejected, 1_000, "cancelled parent never settled")).toMatchObject({
			message: "cancelled parent",
		});
		expect(continued).toBe(false);
		otherRelease.resolve();
		dependency.resolve();
		await other;
		let completed = false;
		await scheduler.runTurn(turn("after"), async () => {
			completed = true;
		});
		expect(completed).toBe(true);
	});
}

test("queued turns serialize per node and tree round-robin prevents a busy tree starving other roots", async () => {
	const scheduler = new ExecutionAdmission();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const active = scheduler.runTurn(turn("a1", "A"), async () => {
		started.resolve();
		await release.promise;
	});
	await started.promise;
	const events: string[] = [];
	const queued = [
		["a2", "A"],
		["a3", "A"],
		["b1", "B"],
		["b2", "B"],
		["c1", "C"],
	].map(([node, tree]) =>
		scheduler.runTurn(turn(node, tree), async () => {
			events.push(node);
		}),
	);
	release.resolve();
	await Promise.all([active, ...queued]);
	expect(events).toEqual(["a2", "b1", "c1", "a3", "b2"]);
	let running = 0;
	let maximum = 0;
	await Promise.all(
		Array.from({ length: 3 }, () =>
			scheduler.runTurn({ ...turn("same-node"), maxConcurrency: 3 }, async () => {
				running++;
				maximum = Math.max(maximum, running);
				await Promise.resolve();
				running--;
			}),
		),
	);
	expect(maximum).toBe(1);
});

test("mutation freezes descendant spawning but permits idle descendants and independent sibling work", async () => {
	const scheduler = new ExecutionAdmission();
	const child = scheduler.reserveSpawn({
		nodeId: "child",
		parentId: "root",
		treeId: "root",
		maxChildren: 1,
		maxNodes: 2,
	});
	await expect(scheduler.withMutation(["root"], async () => {})).rejects.toThrow("accepted work");
	child.commit();
	await scheduler.withMutation(["root"], async () => {
		expect(() =>
			scheduler.reserveSpawn({
				nodeId: "grandchild",
				parentId: "child",
				treeId: "root",
				maxChildren: 1,
				maxNodes: 2,
			}),
		).toThrow("transitioning");
		let independent = false;
		await scheduler.runTurn(turn("sibling", "other-root"), async () => {
			independent = true;
		});
		expect(independent).toBe(true);
	});
	expect(() =>
		scheduler.reserveSpawn({ nodeId: "second", parentId: "root", treeId: "root", maxChildren: 1, maxNodes: 2 }),
	).toThrow("child admission limit");
	const grandchild = scheduler.reserveSpawn({
		nodeId: "grandchild",
		parentId: "child",
		treeId: "root",
		maxChildren: 1,
		maxNodes: 2,
	});
	grandchild.commit();
	expect(() =>
		scheduler.reserveSpawn({ nodeId: "third", parentId: "grandchild", treeId: "root", maxChildren: 1, maxNodes: 2 }),
	).toThrow("tree node admission limit");
	grandchild.release();
	child.release();
	const replacement = scheduler.reserveSpawn({
		nodeId: "replacement",
		parentId: "root",
		treeId: "root",
		maxChildren: 1,
		maxNodes: 2,
	});
	replacement.release();
});

test("a published answer retains broker capacity, node exclusivity and admitted-node counts until gated cleanup finishes", async () => {
	const scheduler = new ExecutionAdmission();
	const cleanup = Promise.withResolvers<void>();
	let held = 0;
	let peak = 0;
	scheduler.setBroker({
		acquire: async () => {
			held++;
			peak = Math.max(peak, held);
			return {
				release: async () => {
					held--;
				},
			};
		},
	});
	const reserved = scheduler.reserveSpawn({
		nodeId: "parent",
		parentId: "root",
		treeId: "root",
		maxChildren: 1,
		maxNodes: 1,
	});
	reserved.commit();
	let settlement: Promise<void> | undefined;
	const answer = await scheduler.runTurn(
		{
			...turn("parent"),
			onSettlement: completion => {
				settlement = completion;
			},
		},
		async () => {
			scheduler.retainUntilSettled(cleanup.promise);
			return "published answer";
		},
	);
	reserved.release(settlement);
	const confirming = scheduler.settleNode("parent");
	const events: string[] = [];
	const other = scheduler.runTurn(turn("other", "other-root"), async () => {
		events.push("other");
	});
	const same = scheduler.runTurn(turn("parent"), async () => {
		events.push("same");
	});
	try {
		expect(answer).toBe("published answer");
		expect(held).toBe(1);
		expect(events).toEqual([]);
		expect(() =>
			scheduler.reserveSpawn({ nodeId: "next", parentId: "root", treeId: "root", maxChildren: 1, maxNodes: 1 }),
		).toThrow("child admission limit");
		await expect(scheduler.withMutation(["parent"], async () => {})).rejects.toThrow("accepted work");
	} finally {
		cleanup.resolve();
		await Promise.all([other, same, settlement, confirming]);
	}
	expect(events.sort()).toEqual(["other", "same"]);
	expect(held).toBe(0);
	expect(peak).toBe(1);
});

test("failed cleanup preserves its published result and accepted reservation until cleanup retry succeeds", async () => {
	const scheduler = new ExecutionAdmission();
	const manager = new AsyncJobManager({ maxTotalJobs: 1, maxTotalBytes: 8 });
	const reservation = scheduler.reserveSpawn({
		nodeId: "failed",
		parentId: "root",
		treeId: "root",
		maxChildren: 1,
		maxNodes: 1,
	});
	reservation.commit();
	const cleanup = Promise.withResolvers<void>();
	const retry = Promise.withResolvers<void>();
	let settlement: Promise<void> | undefined;
	const id = manager.register(
		"worker",
		"",
		() =>
			scheduler.runTurn(
				{
					...turn("failed"),
					onSettlement: completion => {
						settlement = completion;
					},
				},
				async () => {
					scheduler.retainUntilSettled(cleanup.promise);
					return "answer";
				},
			),
		{ id: "failed", ownerId: "root", bytes: 8, settlement: () => settlement },
	);
	const job = manager.getJob(id)!;
	const resources = manager.waitForJobSettlement(id);
	let independent: Promise<void> | undefined;
	let independentRan = false;
	try {
		await job.promise;
		expect(job).toMatchObject({ status: "completed", resultText: "answer" });
		manager.acknowledgeDeliveries([id]);
		const failed = scheduler.waitForCleanup("failed").catch(error => error);
		cleanup.reject(new Error("dispose failed"));
		expect(await failed).toMatchObject({ message: "dispose failed" });
		expect(() => manager.reserve({ bytes: 0 })).toThrow("admission limit");
		expect(() =>
			scheduler.reserveSpawn({ nodeId: "new", parentId: "root", treeId: "root", maxChildren: 1, maxNodes: 1 }),
		).toThrow("child admission limit");
		await expect(scheduler.withMutation(["failed"], async () => {})).rejects.toThrow("accepted work");
		independent = scheduler.runTurn(turn("independent", "other-root"), async () => {
			independentRan = true;
		});
		const recovered = retry.promise.then(() => scheduler.settleNode("failed"));
		expect(independentRan).toBe(false);
		expect(() => manager.reserve({ bytes: 0 })).toThrow("admission limit");
		retry.resolve();
		await recovered;
		await resources;
		await independent;
		expect(independentRan).toBe(true);
		const next = manager.reserve({ bytes: 8 });
		next.release();
		expect(job).toMatchObject({ status: "completed", resultText: "answer" });
	} finally {
		cleanup.resolve();
		retry.resolve();
		await scheduler.settleNode("failed");
		await resources;
		await independent;
		await manager.dispose({ timeoutMs: 0 });
	}
});

for (const failure of ["release", "reacquire"] as const) {
	test(`an uncertain broker ${failure} aborts nested provider ownership instead of resuming without a permit`, async () => {
		const scheduler = new ExecutionAdmission();
		const cancellation = new AbortController();
		let releases = 0;
		let acquisitions = 0;
		scheduler.setBroker({
			acquire: async () => {
				if (++acquisitions === 2 && failure === "reacquire") throw new Error("lost broker reply");
				return {
					release: async () => {
						if (++releases === 1 && failure === "release") throw new Error("lost broker reply");
					},
				};
			},
		});
		let continued = false;
		const parent = scheduler.runTurn(turn("parent", "root", cancellation.signal), () =>
			scheduler.runTurn(
				{
					...turn("parent", "root", cancellation.signal),
					onFailure: error => cancellation.abort(error),
				},
				async () => {
					// A tool may map the transport failure to an error result; cancellation must still stop the provider.
					try {
						await scheduler.withWaitPermit("parent", async () => {});
					} catch {}
					cancellation.signal.throwIfAborted();
					continued = true;
				},
			),
		);
		await expect(parent).rejects.toThrow("lost broker reply");
		expect(continued).toBe(false);
		let unrelated = false;
		await scheduler.runTurn(turn("other", "other-root"), async () => {
			unrelated = true;
		});
		expect(unrelated).toBe(true);
	});
}

test("result-delivery prompt reacquires capacity while its outer dependency barrier lends", async () => {
	const scheduler = new ExecutionAdmission();
	const events: string[] = [];
	await scheduler.runTurn(turn("parent"), async () => {
		await scheduler.withWaitPermit("parent", async () => {
			await scheduler.runTurn(turn("child"), async () => {
				events.push("child completed");
			});
			await scheduler.runTurn(turn("parent"), async () => {
				events.push("delivery prompt completed");
			});
		});
		events.push("parent continued");
	});
	expect(events).toEqual(["child completed", "delivery prompt completed", "parent continued"]);
});
