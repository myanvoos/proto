import { expect, test } from "bun:test";
import { fsObservationLedger, releaseFsObservationLedger, retainFsObservationLedger } from "./fs-observations";

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
