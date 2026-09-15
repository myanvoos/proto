import { describe, expect, test } from "bun:test";
import { ImageBudget } from "./components/image";

describe("ImageBudget admission/transport lifecycle", () => {
	test("a full pass admits up to the cap and suppresses the rest", () => {
		const budget = new ImageBudget(1);
		budget.beginPass("full");
		// Mid-pass admission is provisional (render order is not yet known);
		// the settled decision applies from endPass onward.
		expect(budget.observe(1)).toBe(false);
		expect(budget.observe(2)).toBe(false);
		budget.endPass();

		// Decisions persist for replay in partial/stable passes: cap 1 keeps
		// the last-rendered id and suppresses the earliest (oldest) one.
		budget.beginPass("stable");
		expect(budget.observe(1)).toBe(true);
		expect(budget.observe(2)).toBe(false);
	});

	test("partial passes replay decisions and never finalize global policy", () => {
		const budget = new ImageBudget(1);
		budget.beginPass("full");
		budget.observe(1);
		budget.observe(2);
		budget.endPass();

		budget.beginPass("partial");
		expect(budget.observe(2)).toBe(false);
		budget.endPass();

		// A partial pass observing only a suppressed id does not flip policy.
		budget.beginPass("partial");
		expect(budget.observe(1)).toBe(true);
		budget.endPass();

		budget.beginPass("full");
		expect(budget.observe(1)).toBe(true);
		expect(budget.observe(2)).toBe(false);
		budget.endPass();
	});

	test("a new stable id at capacity renders fallback and requests a full pass", () => {
		const budget = new ImageBudget(1);
		budget.beginPass("full");
		budget.observe(1);
		budget.endPass();

		budget.beginPass("stable");
		expect(budget.observe(9)).toBe(true);
		budget.endPass();
		expect(budget.needsFullPass).toBe(true);
	});

	test("a new stable id below capacity is admitted without a full pass", () => {
		const budget = new ImageBudget(2);
		budget.beginPass("full");
		budget.observe(1);
		budget.endPass();

		budget.beginPass("stable");
		expect(budget.observe(2)).toBe(false);
		budget.endPass();
		expect(budget.needsFullPass).toBe(false);
	});

	test("enqueueing is not transmitting: queued payloads become resident only after the write", () => {
		const budget = new ImageBudget(2);
		budget.beginPass("full");
		budget.observe(1);
		budget.endPass();

		expect(budget.shouldTransmit(1)).toBe(true);
		budget.enqueueTransmit(1, "SEQ-1");
		expect(budget.shouldTransmit(1)).toBe(false);
		expect(budget.hasPendingTransmits()).toBe(true);

		const batch = budget.takeTransmitBatch();
		expect(batch.ids).toEqual([1]);
		expect(batch.sequences).toEqual(["SEQ-1"]);
		// Drained but not yet written: still not resident.
		expect(budget.hasPendingTransmits()).toBe(false);
		expect(budget.shouldTransmit(1)).toBe(false);

		budget.markTransmitWritten([1]);
		expect(budget.shouldTransmit(1)).toBe(false);
	});

	test("suppressing a queued id cancels its payload instead of purging it", () => {
		const budget = new ImageBudget(1);
		budget.beginPass("full");
		budget.observe(1);
		budget.endPass();
		budget.enqueueTransmit(1, "SEQ-1");
		expect(budget.hasPendingTransmits()).toBe(true);
		budget.takeTransmitBatch();

		// A later full pass renders a newer image last: the older id falls out
		// of the admitted set while its payload is still queued.
		budget.beginPass("full");
		budget.observe(1);
		budget.observe(2);
		budget.endPass();

		// Queued payloads are canceled, never deleted (invariant 7).
		expect(budget.takePurgeIds()).toEqual([]);
		expect(budget.hasPendingTransmits()).toBe(false);
	});

	test("suppressing a resident id queues exactly one delete and forces retransmission", () => {
		const budget = new ImageBudget(1);
		budget.beginPass("full");
		budget.observe(1);
		budget.endPass();
		budget.enqueueTransmit(1, "SEQ-1");
		budget.markTransmitWritten(budget.takeTransmitBatch().ids);

		budget.beginPass("full");
		budget.observe(1);
		budget.observe(2);
		budget.endPass();

		expect(budget.takePurgeIds()).toEqual([1]);
		expect(budget.takePurgeIds()).toEqual([]);
		// A later admission of the same id must retransmit (invariant 9).
		budget.beginPass("full");
		budget.observe(1);
		budget.endPass();
		expect(budget.shouldTransmit(1)).toBe(true);
	});

	test("protocol reset returns resident ids and clears queued payloads", () => {
		const budget = new ImageBudget(2);
		budget.beginPass("full");
		budget.observe(1);
		budget.observe(2);
		budget.endPass();
		budget.enqueueTransmit(1, "SEQ-1");
		budget.enqueueTransmit(2, "SEQ-2");
		budget.markTransmitWritten(budget.takeTransmitBatch().ids);
		budget.enqueueTransmit(3, "SEQ-3");

		const residents = budget.takeAllForProtocolReset();
		expect(residents).toEqual([1, 2]);
		expect(budget.hasPendingTransmits()).toBe(false);
		expect(budget.takePurgeIds()).toEqual([]);
		expect(budget.shouldTransmit(1)).toBe(true);
		expect(budget.needsFullPass).toBe(false);
	});
});

test("ids absent from a full pass go offscreen: cap slot freed, resident payload kept", () => {
	const budget = new ImageBudget(2);
	budget.beginPass("full");
	budget.observe(1);
	budget.endPass();
	budget.enqueueTransmit(1, "SEQ-A");
	const batch = budget.takeTransmitBatch();
	budget.markTransmitWritten(batch.ids);

	// Next full pass renders only a new id: the old one leaves the frame.
	budget.beginPass("full");
	expect(budget.observe(2)).toBe(false);
	budget.endPass();

	// The freed slot admitted the new id; the old id is not purged
	// (scrollback keeps displaying its resident payload).
	expect(budget.takePurgeIds()).toEqual([]);
	expect(budget.shouldTransmit(2)).toBe(true);

	// Re-observing the offscreen id below the cap re-admits without a
	// retransmit (its payload is still resident).
	budget.beginPass("partial");
	expect(budget.observe(1)).toBe(false);
	budget.endPass();
	expect(budget.shouldTransmit(1)).toBe(false);
});

test("a re-observed offscreen id at capacity is suppressed for real and purged", () => {
	const budget = new ImageBudget(1);
	budget.beginPass("full");
	budget.observe(1);
	budget.endPass();
	budget.enqueueTransmit(1, "SEQ-A");
	const batch = budget.takeTransmitBatch();
	budget.markTransmitWritten(batch.ids);

	budget.beginPass("full");
	budget.observe(2);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([]);

	// The offscreen id re-renders in a partial pass while the cap is full:
	// it is suppressed for real, so its resident payload must be purged
	// (it is being re-rendered as a fallback placeholder).
	budget.beginPass("partial");
	expect(budget.observe(1)).toBe(true);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([1]);
	expect(budget.shouldTransmit(1)).toBe(false);
});

test("protocol reset also returns purge-pending ids whose delete was not written yet", () => {
	const budget = new ImageBudget(1);
	budget.beginPass("full");
	budget.observe(1);
	budget.endPass();
	budget.enqueueTransmit(1, "SEQ-A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// A policy-tightening full pass evicts the resident id: its delete is
	// queued but not yet written when the reset lands.
	budget.beginPass("full");
	budget.observe(2);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([]);

	const resetIds = budget.takeAllForProtocolReset();
	expect([...resetIds]).toEqual([1]);
	// The reset consumed the purge queue: a later drain returns nothing.
	expect(budget.takePurgeIds()).toEqual([]);
});

test("releaseImageKey cancels queued payloads and drops the key identity", () => {
	const budget = new ImageBudget(2);
	const id = budget.acquireId("py1:0");
	budget.beginPass("full");
	budget.observe(id);
	budget.endPass();
	budget.enqueueTransmit(id, "SEQ-A");
	budget.releaseImageKey("py1:0");

	// The queued payload is canceled, the key is forgotten: re-acquiring the
	// same key allocates a fresh id that must transmit.
	expect(budget.hasPendingTransmits()).toBe(false);
	const fresh = budget.acquireId("py1:0");
	expect(fresh).not.toBe(id);
	expect(budget.shouldTransmit(fresh)).toBe(true);
});

test("releaseImageKey purge-pends a resident payload so the next write deletes it", () => {
	const budget = new ImageBudget(2);
	const id = budget.acquireId("py1:0");
	budget.beginPass("full");
	budget.observe(id);
	budget.endPass();
	budget.enqueueTransmit(id, "SEQ-A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	budget.releaseImageKey("py1:0");
	// The resident payload is deleted on the next terminal write; the freed
	// admission slot accepts a new id in the same pass.
	expect(budget.takePurgeIds()).toEqual([id]);
	budget.beginPass("full");
	expect(budget.observe(2)).toBe(false);
	budget.endPass();
	expect(budget.shouldTransmit(2)).toBe(true);
});

test("shared keys refcount: disposing one owner keeps the shared payload", () => {
	const budget = new ImageBudget(2);
	const a = budget.acquireId("native:0");
	const b = budget.acquireId("native:0");
	expect(a).toBe(b);

	budget.beginPass("full");
	budget.observe(a);
	budget.endPass();
	budget.enqueueTransmit(a, "SEQ-A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// First owner disposes: the shared id must stay resident and usable.
	budget.releaseImageKey("native:0", a);
	expect(budget.takePurgeIds()).toEqual([]);
	expect(budget.shouldTransmit(a)).toBe(false);

	// Last owner disposes: now the payload is purge-pending.
	budget.releaseImageKey("native:0", b);
	expect(budget.takePurgeIds()).toEqual([a]);
});

test("a released id becomes recyclable after its purge drains", () => {
	const budget = new ImageBudget(2);
	const id = budget.acquireId("py1:0");
	budget.beginPass("full");
	budget.observe(id);
	budget.endPass();
	budget.enqueueTransmit(id, "SEQ-A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	budget.releaseImageKey("py1:0", id);
	expect(budget.takePurgeIds()).toEqual([id]);
	// The identity is fully forgotten (transport entry dropped with the purge
	// drained): the old id would transmit again if it were re-rendered, i.e.
	// it no longer occupies any budget state.
	expect(budget.shouldTransmit(id)).toBe(true);
});

test("a stale owner cannot release a re-acquired key identity", () => {
	const budget = new ImageBudget(1);
	const old = budget.acquireId("py1:0");
	budget.beginPass("full");
	budget.observe(old);
	budget.endPass();
	budget.enqueueTransmit(old, "SEQ-A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// Suppression forgets the key identity; a newer card re-acquires it.
	budget.beginPass("full");
	budget.observe(old);
	budget.observe(42);
	budget.endPass(); // over cap: old suppressed, key forgotten
	expect(budget.takePurgeIds()).toEqual([old]);
	const fresh = budget.acquireId("py1:0");
	expect(fresh).not.toBe(old);

	// The stale owner disposes with its own (forgotten) id: the fresh id
	// must keep its key and stay resident.
	budget.releaseImageKey("py1:0", old);
	expect(budget.takePurgeIds()).toEqual([]);
	expect(budget.shouldTransmit(fresh)).toBe(true);
});

test("a stale owner does not corrupt a re-acquired shared identity's refcount", () => {
	const budget = new ImageBudget(1);
	const stale = budget.acquireId("native:0");
	budget.beginPass("full");
	budget.observe(stale);
	budget.endPass();
	budget.enqueueTransmit(stale, "SEQ");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// Policy tightening suppresses the stale identity and forgets its key.
	budget.beginPass("full");
	budget.observe(stale);
	budget.observe(42);
	budget.endPass();
	budget.takePurgeIds();

	// The settled re-render drains the provisional suppression index with an
	// empty full pass before the replacement components render.
	budget.beginPass("full");
	budget.endPass();

	// Two NEW components share the re-acquired key.
	const n1 = budget.acquireId("native:0");
	const n2 = budget.acquireId("native:0");
	expect(n1).toBe(n2);
	budget.beginPass("full");
	budget.observe(n1);
	budget.endPass();
	budget.enqueueTransmit(n1, "SEQ2");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// The stale owner disposes: a pure no-op — the new identity's refcount
	// and resident payload are untouched.
	budget.releaseImageKey("native:0", stale);
	expect(budget.takePurgeIds()).toEqual([]);
	expect(budget.shouldTransmit(n1)).toBe(false);

	// Disposing one of the two new owners must NOT purge the shared id.
	budget.releaseImageKey("native:0", n1);
	expect(budget.takePurgeIds()).toEqual([]);

	// Only the last new owner's disposal releases it.
	budget.releaseImageKey("native:0", n2);
	expect(budget.takePurgeIds()).toEqual([n1]);
});

test("duplicate shared-key observations settle once instead of oscillating", () => {
	const budget = new ImageBudget(1);
	const shared = budget.acquireId("same");
	const other = budget.acquireId("other");
	let changedRounds = 0;
	for (let round = 0; round < 6; round++) {
		budget.beginPass("full");
		const suppressedShared = budget.observe(shared);
		const suppressedSharedAgain = budget.observe(shared);
		expect(suppressedShared).toBe(suppressedSharedAgain);
		budget.observe(other);
		if (budget.endPass()) changedRounds++;
	}
	// Without occurrence deduplication the duplicate id made endPass report a
	// change every round (infinite requestRender loop).
	expect(changedRounds).toBe(1);
});

test("adopt re-binds a key dropped by suppression so a later dispose releases the payload", () => {
	const budget = new ImageBudget(1);
	const a = budget.acquireId("k");
	budget.beginPass("full");
	budget.observe(a);
	budget.endPass();
	budget.enqueueTransmit(a, "A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// A second image pushes `a` below the cap: suppression forgets the key
	// and purges the resident payload.
	const b = budget.acquireId("other");
	budget.beginPass("full");
	budget.observe(a);
	budget.observe(b);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([a]);

	// `a` re-enters the frame under the cap and retransmits.
	budget.beginPass("full");
	budget.observe(a);
	budget.observe(b);
	budget.endPass();
	budget.enqueueTransmit(a, "A2");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// Disposal must release the retransmitted resident payload: without
	// adoption the suppressed-era key mapping was gone and this no-oped.
	budget.adopt("k", a);
	budget.releaseImageKey("k", a);
	expect(budget.takePurgeIds()).toEqual([a]);
});

test("adopt preserves shared ownership after suppression and re-admission", () => {
	const budget = new ImageBudget(1);
	const shared = budget.acquireId("shared");
	budget.acquireId("shared");
	budget.beginPass("full");
	budget.observe(shared);
	budget.endPass();
	budget.enqueueTransmit(shared, "A");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	const other = budget.acquireId("other");
	budget.beginPass("full");
	budget.observe(shared);
	budget.observe(other);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([shared]);

	budget.beginPass("full");
	budget.observe(shared);
	budget.endPass();
	budget.enqueueTransmit(shared, "A2");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);
	budget.adopt("shared", shared);
	budget.releaseImageKey("shared", shared);
	expect(budget.takePurgeIds()).toEqual([]);
	budget.releaseImageKey("shared", shared);
	expect(budget.takePurgeIds()).toEqual([shared]);
});

test("forgotten owner release does not retire a fresh reacquisition", () => {
	const budget = new ImageBudget(1);
	const old = budget.acquireId("shared");
	budget.beginPass("full");
	budget.observe(old);
	budget.endPass();
	budget.enqueueTransmit(old, "OLD");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	const other = budget.acquireId("other");
	budget.beginPass("full");
	budget.observe(old);
	budget.observe(other);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([old]);
	const fresh = budget.acquireId("shared");
	expect(fresh).not.toBe(old);

	budget.beginPass("full");
	budget.observe(old);
	budget.endPass();
	budget.enqueueTransmit(old, "OLD-2");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);
	budget.releaseImageKey("shared", old);
	expect(budget.takePurgeIds()).toEqual([old]);
	expect(budget.acquireId("shared")).toBe(fresh);
});

test("placement salts resolve to distinct wire placement ids", () => {
	const budget = new ImageBudget();
	budget.registerPlacementGeometry(7, 10, 10, 111);
	budget.registerPlacementGeometry(7, 10, 10, 222);
	const first = budget.resolvePlacementEmit(7, 0, -1, 111);
	const second = budget.resolvePlacementEmit(7, 0, -1, 222);
	expect(first?.placementId).toBeDefined();
	expect(second?.placementId).toBeDefined();
	expect(first?.placementId).not.toBe(second?.placementId);

	const ids = new Set<number>();
	for (let salt = 0; salt < 300; salt++) {
		budget.registerPlacementGeometry(8, 10, 10, salt);
		ids.add(budget.resolvePlacementEmit(8, 0, -1, salt)?.placementId ?? 0);
	}
	expect(ids.size).toBe(300);
});

test("persistent overlay observations survive the base endPass boundary", () => {
	const budget = new ImageBudget(2);
	const base = budget.acquireId("base");
	const overlay = budget.acquireId("overlay");
	budget.setOverlayPresence(true);
	budget.beginPass("full");
	budget.observe(base);
	budget.endPass();
	budget.enqueueTransmit(base, "BASE");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);
	budget.beginOverlayPass();
	budget.observe(overlay);
	budget.endOverlayPass();
	budget.enqueueTransmit(overlay, "OVERLAY");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	for (let round = 0; round < 3; round++) {
		budget.setOverlayPresence(true);
		budget.beginPass("full");
		budget.observe(base);
		budget.endPass();
		expect(budget.takePurgeIds()).toEqual([]);
		budget.beginOverlayPass();
		budget.observe(overlay);
		budget.endOverlayPass();
	}
});

test("fullscreen overlay observations purge when the overlay exits", () => {
	const budget = new ImageBudget(1);
	const overlay = budget.acquireId("fullscreen");
	budget.setOverlayPresence(true);
	budget.beginPass("full");
	budget.beginOverlayPass();
	budget.observe(overlay);
	budget.endOverlayPass();
	budget.endPass();
	budget.enqueueTransmit(overlay, "FULLSCREEN");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	budget.setOverlayPresence(false);
	budget.beginPass("full");
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([overlay]);
});

test("fullscreen full passes enforce a cap change across overlay composition", () => {
	const budget = new ImageBudget(2);
	const first = budget.acquireId("first");
	const second = budget.acquireId("second");
	budget.setOverlayPresence(true);
	budget.beginPass("full");
	budget.beginOverlayPass(true);
	expect(budget.observe(first)).toBe(false);
	expect(budget.observe(second)).toBe(false);
	budget.endOverlayPass();
	budget.endPass();
	budget.enqueueTransmit(first, "FIRST");
	budget.enqueueTransmit(second, "SECOND");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	budget.setCap(1);
	budget.beginPass("full");
	budget.beginOverlayPass(true);
	expect(budget.observe(first)).toBe(false);
	expect(budget.observe(second)).toBe(false);
	budget.endOverlayPass();
	expect(budget.endPass()).toBe(true);
	expect(budget.takePurgeIds()).toEqual([first]);

	// The corrective full pass keeps exactly one overlay admitted and does not
	// leave the budget requesting another policy pass.
	budget.beginPass("full");
	budget.beginOverlayPass(true);
	expect(budget.observe(first)).toBe(true);
	expect(budget.observe(second)).toBe(false);
	budget.endOverlayPass();
	expect(budget.endPass()).toBe(false);
	expect(budget.needsFullPass).toBe(false);
});

test("fullscreen full passes re-admit suppressed ids when the cap increases", () => {
	const budget = new ImageBudget(1);
	const first = budget.acquireId("first");
	const second = budget.acquireId("second");
	budget.setOverlayPresence(true);
	budget.beginPass("full");
	budget.beginOverlayPass(true);
	budget.observe(first);
	budget.observe(second);
	budget.endOverlayPass();
	expect(budget.endPass()).toBe(true);

	budget.setCap(2);
	budget.beginPass("full");
	budget.beginOverlayPass(true);
	expect(budget.observe(first)).toBe(true);
	expect(budget.observe(second)).toBe(false);
	budget.endOverlayPass();
	expect(budget.endPass()).toBe(true);
	budget.beginPass("full");
	budget.beginOverlayPass(true);
	expect(budget.observe(first)).toBe(false);
	expect(budget.observe(second)).toBe(false);
	budget.endOverlayPass();
	expect(budget.endPass()).toBe(false);
	expect(budget.needsFullPass).toBe(false);
});

test("overlay carry survives consecutive base endPass cycles", () => {
	const budget = new ImageBudget(2);
	const base = budget.acquireId("base");
	const overlay = budget.acquireId("overlay");
	const newBase = budget.acquireId("new-base");
	budget.setOverlayPresence(true);
	budget.beginPass("full");
	budget.observe(base);
	budget.endPass();
	budget.beginOverlayPass();
	budget.observe(overlay);
	budget.endOverlayPass();
	budget.enqueueTransmit(overlay, "OVERLAY");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);
	budget.setCap(1);

	budget.beginPass("full");
	budget.observe(base);
	budget.observe(newBase);
	expect(budget.endPass()).toBe(true);
	// endPass requested a corrective compose; the second base pass must not
	// interpret the still-carried overlay as a stale deferred payload.
	budget.beginPass("full");
	budget.observe(base);
	budget.observe(newBase);
	expect(budget.endPass()).toBe(false);
	expect(budget.takePurgeIds()).toEqual([]);
	budget.beginOverlayPass();
	budget.observe(overlay);
	budget.endOverlayPass();
});

test("switching overlays preserves the replacement across a changed base pass", () => {
	const budget = new ImageBudget(2);
	const base = budget.acquireId("base");
	const firstOverlay = budget.acquireId("overlay-1");
	const secondOverlay = budget.acquireId("overlay-2");
	const newBase = budget.acquireId("new-base");
	const anotherBase = budget.acquireId("another-base");
	budget.setOverlayPresence(true);
	budget.beginPass("full");
	budget.observe(base);
	budget.endPass();
	budget.beginOverlayPass();
	budget.observe(firstOverlay);
	budget.endOverlayPass();
	budget.enqueueTransmit(firstOverlay, "ONE");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// Hide O1 and show O2 before the next compose.
	budget.beginPass("full");
	budget.observe(base);
	budget.endPass();
	budget.beginOverlayPass();
	budget.observe(secondOverlay);
	budget.endOverlayPass();
	budget.enqueueTransmit(secondOverlay, "TWO");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);
	expect(budget.takePurgeIds()).toEqual([]);

	// A changed base causes two full endPass cycles before O2 is composed.
	budget.beginPass("full");
	budget.observe(base);
	budget.observe(newBase);
	budget.observe(anotherBase);
	expect(budget.endPass()).toBe(true);
	expect(budget.takePurgeIds()).toEqual([firstOverlay]);
	budget.beginPass("full");
	budget.observe(base);
	budget.observe(newBase);
	budget.observe(anotherBase);
	expect(budget.endPass()).toBe(false);
	expect(budget.takePurgeIds()).toEqual([]);
	budget.beginOverlayPass();
	budget.observe(secondOverlay);
	budget.endOverlayPass();
});

test("an unkeyed image releases its id on dispose", () => {
	const budget = new ImageBudget(2);
	const id = budget.acquireId();
	budget.beginPass("full");
	budget.observe(id);
	budget.endPass();
	budget.enqueueTransmit(id, "SEQ");
	budget.releaseImageById(id);
	// The queued payload is canceled and the id becomes reusable.
	expect(budget.takeTransmitBatch().sequences).toEqual([]);
	const next = budget.acquireId();
	expect(budget.shouldTransmit(next)).toBe(true);
});

test("overlay-observed images are purged when they leave the frame", () => {
	const budget = new ImageBudget(2);
	const base = budget.acquireId("base");
	budget.beginPass("full");
	budget.observe(base);
	budget.endPass();
	budget.enqueueTransmit(base, "BASE");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	const overlay = budget.acquireId("overlay");
	budget.beginOverlayPass();
	budget.observe(overlay);
	budget.endOverlayPass();
	budget.enqueueTransmit(overlay, "OVERLAY");
	budget.markTransmitWritten(budget.takeTransmitBatch().ids);

	// The next full pass without the overlay purges it (overlay rows never
	// reach scrollback) instead of retaining it as offscreen.
	budget.beginPass("full");
	budget.observe(base);
	budget.endPass();
	expect(budget.takePurgeIds()).toEqual([overlay]);
});

test("takeTransmitBatch filter cancels payloads for unpainted ids", () => {
	const budget = new ImageBudget(4);
	const painted = budget.acquireId("painted");
	const cropped = budget.acquireId("cropped");
	budget.beginPass("full");
	budget.observe(painted);
	budget.observe(cropped);
	budget.endPass();
	budget.enqueueTransmit(painted, "P");
	budget.enqueueTransmit(cropped, "C");
	const batch = budget.takeTransmitBatch(id => id === painted);
	expect(batch.sequences).toEqual(["P"]);
	expect(budget.takeTransmitBatch().sequences).toEqual([]);
});
