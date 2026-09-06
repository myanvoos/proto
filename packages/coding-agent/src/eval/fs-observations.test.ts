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
