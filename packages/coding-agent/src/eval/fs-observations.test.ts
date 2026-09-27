import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	fsObservationLedger,
	recordMutationEvents,
	releaseFsObservationLedger,
	retainFsObservationLedger,
} from "./fs-observations";

function observation(path: string) {
	return { path, kind: "read" as const, mtimeNs: null, size: null };
}

test("releasing the final owner discards stale observations and isolates late writes", () => {
	const sessionId = `fs-observations-final-${crypto.randomUUID()}`;
	const ownerId = "owner";
	retainFsObservationLedger(sessionId, ownerId);
	const releasedLedger = fsObservationLedger(sessionId);
	releasedLedger.record(observation("/stale-before-release"));

	releaseFsObservationLedger(sessionId, ownerId);
	releasedLedger.record(observation("/late-after-release"));

	expect(fsObservationLedger(sessionId).drain()).toEqual([]);
});

test("an unowned ledger retires after its pending observations are drained", () => {
	const sessionId = `fs-observations-unowned-${crypto.randomUUID()}`;
	const ledger = fsObservationLedger(sessionId);
	ledger.record(observation("/unowned"));

	expect(ledger.drain()).toEqual([observation("/unowned")]);
	expect(fsObservationLedger(sessionId).drain()).toEqual([]);
});

test("draining during an async observation preserves the late record", async () => {
	using directory = TempDir.createSync("@fs-observation-race-");
	const target = directory.join("pending.txt");
	await Bun.write(target, "before");
	const sessionId = `fs-observations-race-${crypto.randomUUID()}`;
	const ledger = fsObservationLedger(sessionId);
	const gate = Promise.withResolvers<void>();
	let entered = false;
	const originalStat = fs.stat;
	const statSpy = vi.spyOn(fs, "stat");
	statSpy.mockImplementation((async (...args: never[]) => {
		if (String(args[0]) === target) {
			entered = true;
			await gate.promise;
		}
		return await (originalStat as (...items: never[]) => Promise<unknown>)(...args);
	}) as typeof fs.stat);
	try {
		const pending = ledger.recordWrite(target);
		while (!entered) await Promise.resolve();
		expect(ledger.drain()).toEqual([]);
		gate.resolve();
		await pending;
		expect(fsObservationLedger(sessionId).drain()).toContainEqual(
			expect.objectContaining({ path: target, kind: "write" }),
		);
	} finally {
		statSpy.mockRestore();
	}
});

test("mutation events survive an unowned drain between sequential records", async () => {
	using directory = TempDir.createSync("@fs-observation-event-gap-");
	const firstPath = directory.join("first.txt");
	const secondPath = directory.join("second.txt");
	await Bun.write(firstPath, "first");
	await Bun.write(secondPath, "second");
	const sessionId = `fs-observations-event-gap-${crypto.randomUUID()}`;
	const ledger = fsObservationLedger(sessionId);
	const originalRecordWrite = ledger.recordWrite.bind(ledger);
	const drained: string[][] = [];
	let calls = 0;
	const recordWriteSpy = vi.spyOn(ledger, "recordWrite").mockImplementation(async pathValue => {
		const result = await originalRecordWrite(pathValue);
		if (++calls === 1) drained.push(ledger.drain().map(observation => observation.path));
		return result;
	});
	try {
		await recordMutationEvents(ledger, directory.path(), [
			{ op: "write", path: "first.txt" },
			{ op: "write", path: "second.txt" },
		]);
		const remaining = fsObservationLedger(sessionId)
			.drain()
			.map(observation => observation.path);
		expect([...drained.flat(), ...remaining]).toEqual(expect.arrayContaining([firstPath, secondPath]));
	} finally {
		recordWriteSpy.mockRestore();
	}
});

test("releasing one shared owner preserves observations for the surviving owner", () => {
	const sessionId = `fs-observations-shared-${crypto.randomUUID()}`;
	retainFsObservationLedger(sessionId, "owner-a");
	retainFsObservationLedger(sessionId, "owner-b");
	fsObservationLedger(sessionId).record(observation("/shared"));

	releaseFsObservationLedger(sessionId, "owner-a");
	expect(fsObservationLedger(sessionId).drain()).toEqual([observation("/shared")]);

	releaseFsObservationLedger(sessionId, "owner-b");
});

test("overflow never discards a pending host mutation", () => {
	const ledger = fsObservationLedger(`fs-observations-overflow-${crypto.randomUUID()}`);
	const critical = { ...observation("/critical-host-rewrite"), kind: "write" as const };
	ledger.record(critical);
	for (let index = 0; index < 8192; index++) {
		ledger.record(observation(`/later-read-${index}`));
	}

	expect(ledger.drain()).toContainEqual(critical);
});

test("an all-mutation burst uses a soft cap rather than losing any path", () => {
	const ledger = fsObservationLedger(`fs-observations-write-burst-${crypto.randomUUID()}`);
	for (let index = 0; index < 8193; index++) {
		ledger.record({ ...observation(`/host-rewrite-${index}`), kind: "write" });
	}

	expect(ledger.drain()).toHaveLength(8193);
});

test("a later read does not make a pending mutation evictable", () => {
	const ledger = fsObservationLedger(`fs-observations-reobserved-write-${crypto.randomUUID()}`);
	ledger.record({ ...observation("/rewritten-then-read"), kind: "write" });
	ledger.record(observation("/rewritten-then-read"));
	for (let index = 0; index < 8192; index++) {
		ledger.record(observation(`/unrelated-read-${index}`));
	}

	expect(ledger.drain().map(entry => entry.path)).toContain("/rewritten-then-read");
});
