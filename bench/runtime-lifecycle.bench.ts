import { strict as assert } from "node:assert";
import { AsyncJobManager } from "../packages/coding-agent/src/async/job-manager";
import { parseSessionContent } from "../packages/coding-agent/src/session/session-loader";
import { RpcFrameQueue } from "../packages/coding-agent/src/session-host/client";

// Run with: bun bench/runtime-lifecycle.bench.ts
// Compare post-warmup/post-GC low/high/low samples; RSS includes native allocator
// high-water marks and is not equivalent to retained JavaScript objects.
async function exercise(cycles: number, entries: number): Promise<void> {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "stress",
		cwd: "/stress",
		timestamp: "2026-09-22T00:00:00Z",
	});
	const transcript = [
		header,
		...Array.from({ length: entries }, (_, i) =>
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: i ? `m${i - 1}` : null,
				message: { role: "user", content: "x".repeat(2_000), timestamp: i },
			}),
		),
	].join("\n");
	assert.equal(parseSessionContent(transcript).entries.length, entries + 1);
	for (let i = 0; i < cycles; i++) {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("owner", (_id, text) => {
			delivered.push(text);
		});
		manager.register("worker", "success", async () => "ok", { ownerId: "owner" });
		manager.register(
			"worker",
			"failure",
			() => {
				throw new Error("failure");
			},
			{ ownerId: "owner" },
		);
		const release = Promise.withResolvers<string>();
		const cancelled = manager.register("worker", "cancelled", () => release.promise);
		manager.cancel(cancelled);
		release.resolve("cancel cleanup");
		await manager.waitForAll();
		await manager.drainDeliveries();
		assert.deepEqual(delivered.sort(), ["failure", "ok"]);
		assert.equal(manager.getAllJobs().length, 0);
		assert.equal(await manager.dispose(), true);
		assert.equal(manager.getDeliveryState().queued, 0);

		const queue = new RpcFrameQueue();
		const waits = Array.from({ length: 20 }, (_, index) =>
			(index % 2 ? queue.next() : queue.findResponse(String(index), 60_000)).then(
				() => {
					throw new Error("unexpected frame");
				},
				error => assert.equal(error.message, "session RPC connection closed"),
			),
		);
		queue.close();
		await Promise.all(waits);
	}
}

async function sample(label: string, cycles: number, entries: number): Promise<void> {
	const start = performance.now();
	await exercise(cycles, entries);
	for (let i = 0; i < 3; i++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
	const { heapUsed, rss, external } = process.memoryUsage();
	console.log(JSON.stringify({ label, cycles, entries, ms: performance.now() - start, heapUsed, rss, external }));
}

await sample("warmup", 100, 500);
for (let round = 1; round <= 3; round++) {
	await sample(`round-${round}-low`, 100, 500);
	await sample(`round-${round}-high`, 2_000, 8_000);
	await sample(`round-${round}-low-again`, 100, 500);
}
