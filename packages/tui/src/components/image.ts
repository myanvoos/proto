import { getKittyGraphics } from "../kitty-graphics";
import {
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;

	budget?: ImageBudget;

	imageKey?: string;
}

const EMPTY_IDS: readonly number[] = [];
const EMPTY_STALE_EPOCHS: ReadonlyArray<{ imageId: number; lastEpoch: number; placementIds: readonly number[] }> = [];
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";

const RESERVED_IMAGE_ROW = "\x1b[0m";

export const DEFAULT_MAX_INLINE_IMAGES = 8;

interface PlacementEmitState {
	widthPx: number;
	heightPx: number;

	/** Logical placement epoch (kept for compatibility with reset bookkeeping). */
	epoch: number;
	/** Wire placement id for the current coordinate incarnation. */
	placementId: number;
	/** Placement ids actually emitted since the last protocol reset. */
	emittedPlacementIds: number[];

	lastAttachTopFrameRow: number | undefined;

	cellsArchived: boolean;
}
let nextImageBudgetSeed = Math.floor(Math.random() * 0xffffff);
function nextImageIdSeed(): number {
	nextImageBudgetSeed = (nextImageBudgetSeed + 1) & 0xffffff;
	return nextImageBudgetSeed || 1;
}

// Placement ids are independent from the 24-bit Kitty image id space. They
// must not repeat after 256 component instances: two placements sharing one
// payload id but using different geometry salts otherwise collide on p=.
let nextPlacementSaltSeed = Math.floor(Math.random() * 0xffffff);
function nextPlacementSalt(): number {
	nextPlacementSaltSeed = nextPlacementSaltSeed >= 0xfffffe ? 1 : nextPlacementSaltSeed + 1;
	return nextPlacementSaltSeed;
}

export class ImageBudget {
	#cap: number;
	#requestRender: () => void;
	#nextId = nextImageIdSeed();
	#keyToId = new Map<string, number>();
	#idToKey = new Map<number, string>();

	#passIds: number[] = [];
	#idRefCounts = new Map<number, number>();

	// Admission state (what may render) is per id and independent of transport
	// state (where the Kitty payload physically is). Only a full-frame pass may
	// recompute global admission; partial and stable passes replay decisions
	// and may reserve genuinely free slots without ever evicting.
	// "offscreen" marks a previously admitted id that the latest full pass did
	// not render: its resident payload stays on the terminal (scrollback keeps
	// displaying it) but it no longer occupies an admission slot. Re-observing
	// an offscreen id re-admits it below the cap without a retransmit.
	#decisionById = new Map<number, "admitted" | "suppressed" | "offscreen">();
	#transportById = new Map<number, "absent" | "queued" | "resident">();
	#queuedSequences = new Map<number, string>();
	#residentIds = new Set<number>();
	#suppressedCount = 0;
	#lastTotal = 0;
	#passKind: "full" | "partial" | "stable" = "full";
	#fullPassRequested = false;
	#purgeIds: number[] = [];

	#generation = 0;

	#placementState = new Map<string, PlacementEmitState>();

	#watchedPlacements = new Set<PlacementEmitState>();

	constructor(cap: number = DEFAULT_MAX_INLINE_IMAGES, requestRender: () => void = () => {}) {
		this.#cap = normalizeCap(cap);
		this.#requestRender = requestRender;
	}

	get cap(): number {
		return this.#cap;
	}

	get enabled(): boolean {
		return this.#cap > 0;
	}

	setRequestRender(requestRender: () => void): void {
		this.#requestRender = requestRender;
	}

	setCap(cap: number): void {
		const next = normalizeCap(cap);
		if (next === this.#cap) return;
		this.#cap = next;
		// A cap change reorders the desired admitted set; only a full pass may
		// settle it (invariant 14). Until then partial/stable passes replay
		// the stale decision set, so force the next render to be full.
		this.#fullPassRequested = true;
		this.#generation++;
		this.#requestRender();
	}

	acquireId(key?: string): number {
		if (key) {
			const existing = this.#keyToId.get(key);
			if (existing !== undefined) {
				// Several live components may share one key (e.g. native
				// assistant images keyed by content index): the id is only
				// released when the last owner disposes.
				const refs = (this.#idRefCounts.get(existing) ?? 0) + 1;
				this.#idRefCounts.set(existing, refs);
				this.#keyRefCounts.set(key, refs);
				return existing;
			}
			const id = this.#takeFreeId();
			this.#keyToId.set(key, id);
			this.#idToKey.set(id, key);
			this.#idRefCounts.set(id, 1);
			this.#keyRefCounts.set(key, 1);
			return id;
		}
		return this.#takeFreeId();
	}

	/**
	 * Image ids are 24-bit Kitty graphics ids. On wrap, skip ids that are
	 * still in use anywhere (keyed, transported, queued, or purge-pending) so
	 * a recycled id can never collide with undeleted payload data.
	 */
	#takeFreeId(): number {
		for (let hops = 0; hops <= 0xffffff; hops++) {
			const candidate = this.#nextId;
			this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
			if (
				!this.#idToKey.has(candidate) &&
				!this.#decisionById.has(candidate) &&
				!this.#transportById.has(candidate) &&
				!this.#queuedSequences.has(candidate) &&
				!this.#purgeIds.includes(candidate)
			) {
				return candidate;
			}
		}
		throw new Error("Kitty image id space exhausted");
	}

	#passObserved = new Set<number>();
	#keyRefCounts = new Map<string, number>();
	#overlayPass = false;
	#overlayObserved = new Set<number>();
	#overlayPresent = false;
	#overlayDeferredPurge = new Set<number>();
	#overlayPassAccountsFull = false;

	/** Tell the budget whether the current frame still has an overlay. */
	setOverlayPresence(present: boolean): void {
		this.#overlayPresent = present;
	}

	/** Route observe() calls through overlay semantics while compositing. */
	beginOverlayPass(accountFullPass = false): void {
		this.#overlayPass = true;
		this.#overlayPassAccountsFull = accountFullPass;
		// Stable fullscreen passes do not run endPass, so carry the previous
		// composition into the deferred set before starting a fresh observation.
		for (const id of this.#overlayObserved) this.#overlayDeferredPurge.add(id);
		this.#overlayObserved.clear();
	}

	endOverlayPass(): void {
		// A still-visible overlay observed this frame is no longer a deferred
		// purge candidate. The next full pass may carry it across endPass before
		// composing the overlay again.
		for (const id of this.#overlayObserved) this.#overlayDeferredPurge.delete(id);
		this.#overlayPass = false;
		this.#overlayPassAccountsFull = false;
	}

	beginPass(kind: "full" | "partial" | "stable" = "full"): void {
		this.#overlayPassAccountsFull = false;
		this.#passIds.length = 0;
		this.#passObserved.clear();
		this.#passKind = kind;
	}

	observe(imageId: number): boolean {
		if (this.#passKind === "full" && (!this.#overlayPass || this.#overlayPassAccountsFull)) {
			if (this.#passObserved.has(imageId)) {
				// Shared-key duplicates (two live components, one payload id)
				// occupy a single admission slot and settle once: re-running
				// the same id through endPass oscillated forever.
				return this.#decisionById.get(imageId) === "suppressed";
			}
			const index = this.#passIds.length;
			this.#passIds.push(imageId);
			this.#passObserved.add(imageId);
			const suppressed = this.#cap > 0 && index < this.#suppressedCount;
			if (suppressed) {
				this.#decisionById.set(imageId, "suppressed");
				this.#forgetKeyForId(imageId);
				return true;
			}
			this.#decisionById.set(imageId, "admitted");
			if (this.#overlayPass) this.#overlayObserved.add(imageId);
			return false;
		}

		// Partial/stable pass: replay the global decision. A genuinely new id
		// may reserve genuinely free capacity; at capacity it renders fallback
		// and requests a later full policy pass — it never evicts and never
		// bypasses the cap.
		const decision = this.#decisionById.get(imageId);
		if (decision === "suppressed") {
			this.#forgetKeyForId(imageId);
			return true;
		}
		if (decision === "offscreen") {
			// The id re-entered the frame. Its payload may still be resident:
			// re-admit below the cap without a retransmit; at capacity it is
			// suppressed for real (payload purged, since it is being rendered
			// as a fallback) and a full pass re-settles the policy.
			if (this.#cap === 0 || this.#decisionCount("admitted") < this.#cap) {
				this.#decisionById.set(imageId, "admitted");
				if (this.#overlayPass) this.#overlayObserved.add(imageId);
				return false;
			}
			this.#decisionById.set(imageId, "suppressed");
			if (this.#transportById.get(imageId) === "resident") {
				this.#purgeIds.push(imageId);
				this.#residentIds.delete(imageId);
				this.#transportById.delete(imageId);
				this.#deletePlacementState(imageId);
			}
			this.#forgetKeyForId(imageId);
			this.#fullPassRequested = true;
			this.#requestRender();
			return true;
		}
		if (decision === "admitted") {
			if (this.#overlayPass) this.#overlayObserved.add(imageId);
			return false;
		}
		if (this.#cap === 0 || this.#decisionCount("admitted") < this.#cap) {
			this.#decisionById.set(imageId, "admitted");
			if (this.#overlayPass) this.#overlayObserved.add(imageId);
			return false;
		}
		this.#decisionById.set(imageId, "suppressed");
		this.#forgetKeyForId(imageId);
		this.#fullPassRequested = true;
		this.#requestRender();
		return true;
	}

	endPass(): boolean {
		if (this.#passKind !== "full") return false;
		const total = this.#passIds.length;
		this.#lastTotal = total;
		const desired = this.#cap > 0 ? Math.max(0, total - this.#cap) : 0;
		let changed = false;

		// Invariant 10: removals settle before anything else. A newly
		// suppressed id has its queued payload canceled (invariant 7: queued
		// ids are never deleted, only canceled) or, when resident, receives a
		// delete command; placement state goes with it so any later admission
		// retransmits (invariant 9).
		for (let i = 0; i < desired; i++) {
			const id = this.#passIds[i];
			// Full-pass observe persists provisional admitted decisions; the
			// final policy overrides them either way.
			if (this.#decisionById.get(id) !== "suppressed") changed = true;
			this.#decisionById.set(id, "suppressed");
			const transport = this.#transportById.get(id) ?? "absent";
			if (transport === "queued") {
				this.#queuedSequences.delete(id);
				this.#transportById.set(id, "absent");
			} else if (transport === "resident") {
				this.#purgeIds.push(id);
				this.#residentIds.delete(id);
				// The purge queue keeps the id unrecyclable until its delete
				// is written; drop the transport entry so the id becomes
				// reusable after the drain.
				this.#transportById.delete(id);
			}
			this.#deletePlacementState(id);
			this.#forgetKeyForId(id);
		}
		for (let i = desired; i < total; i++) {
			const id = this.#passIds[i];
			if (this.#decisionById.get(id) !== "admitted") {
				this.#decisionById.set(id, "admitted");
				changed = true;
			}
		}
		// Ids previously admitted but absent from this full frame are no
		// longer on screen: free their admission slot (offscreen) while their
		// resident payload keeps scrollback rendering intact. Overlay rows never
		// enter scrollback, but composition runs after this endPass. Carry the
		// prior overlay observation across one boundary so a persistent overlay
		// is not purged and retransmitted on every base-frame update.
		for (const [id, decision] of this.#decisionById) {
			if (decision !== "admitted" || this.#passObserved.has(id)) continue;
			if (this.#overlayObserved.has(id)) {
				if (this.#overlayPresent) {
					this.#overlayDeferredPurge.add(id);
					continue;
				}
				// The overlay was hidden before this pass: purge its resident
				// payload now instead of retaining it as scrollback content.
			} else if (this.#overlayDeferredPurge.has(id)) {
				// The overlay changed or disappeared since the carried observation.
				// It was not observed by the current overlay composition, so its
				// payload is now safe to delete.
				this.#overlayDeferredPurge.delete(id);
			} else {
				this.#decisionById.set(id, "offscreen");
				// A queued payload that was never written has nothing on screen:
				// cancel it so quiescence is not blocked by stale work.
				if (this.#transportById.get(id) === "queued") {
					this.#queuedSequences.delete(id);
					this.#transportById.delete(id);
				}
				continue;
			}

			const transport = this.#transportById.get(id);
			if (transport === "queued") {
				this.#queuedSequences.delete(id);
				this.#transportById.delete(id);
			} else if (transport === "resident") {
				this.#purgeIds.push(id);
				this.#residentIds.delete(id);
				this.#transportById.delete(id);
			}
			this.#decisionById.delete(id);
			this.#deletePlacementState(id);
			this.#forgetKeyForId(id);
			changed = true;
		}
		this.#suppressedCount = desired;
		// Keep the carried observation until beginOverlayPass starts the next
		// composition. A changed base frame may run several full endPass cycles
		// before the overlay is composed; clearing here would make the second
		// cycle purge a still-visible overlay.
		if (changed) {
			// The frame composed during this pass used provisional decisions:
			// re-render with the settled policy so the cap holds on screen.
			this.#generation++;
			this.#requestRender();
		}
		this.#fullPassRequested = false;
		return changed;
	}

	#decisionCount(decision: "admitted" | "suppressed"): number {
		let count = 0;
		for (const value of this.#decisionById.values()) {
			if (value === decision) count++;
		}
		return count;
	}

	/** A partial/stable pass hit the cap; the next render must be a full pass. */
	get needsFullPass(): boolean {
		return this.#fullPassRequested;
	}

	takePurgeIds(): readonly number[] {
		if (this.#purgeIds.length === 0) return EMPTY_IDS;
		const ids = this.#purgeIds;
		this.#purgeIds = [];
		return ids;
	}

	get generation(): number {
		return this.#generation;
	}

	/**
	 * Protocol reset / stop (invariant 13): cancel every queued payload,
	 * return every resident id for delete commands, and clear all admission,
	 * transport, and placement state so surviving Image components retransmit
	 * from scratch on the next supported render. Retained id-to-key ownership
	 * lets those components dispose safely after the reset.
	 */
	takeAllForProtocolReset(): readonly number[] {
		// Payloads physically on the terminal are the resident ones plus any
		// purge-pending ids whose delete command has not been written yet;
		// both must be deleted or the reset leaks terminal-side data.
		const resident = [...this.#residentIds, ...this.#purgeIds];
		this.#decisionById.clear();
		this.#transportById.clear();
		this.#queuedSequences.clear();
		this.#residentIds.clear();
		this.#purgeIds = [];
		this.#suppressedCount = 0;
		this.#lastTotal = 0;
		this.#fullPassRequested = false;
		// Drop active key mappings, but retain id -> key ownership for surviving
		// keyed Image components. Their next dispose must still release the old
		// identity after a protocol reset, and adopt() must restore its refcount.
		this.#keyToId.clear();
		this.#keyRefCounts.clear();
		this.#generation++;
		this.#placementState.clear();
		this.#watchedPlacements.clear();
		this.#passIds.length = 0;
		this.#passObserved.clear();
		this.#overlayObserved.clear();
		this.#overlayDeferredPurge.clear();
		this.#overlayPassAccountsFull = false;
		return resident;
	}

	/**
	 * Re-bind a surviving component's key after the mapping was dropped
	 * (suppression forgets it; protocol reset clears active key state). Without
	 * this, a later dispose(key, id) would find no mapping and leak the id's
	 * queued/resident terminal payload forever.
	 */
	adopt(imageKey: string, imageId: number): void {
		const mapped = this.#keyToId.get(imageKey);
		if (mapped === imageId) return;
		if (mapped !== undefined) {
			// Another live owner holds this key with a different id. Keep that
			// active identity, while releaseImageKey(ownerId) can still retire
			// this forgotten id through its retained id-to-key mapping.
			return;
		}
		const knownKey = this.#idToKey.get(imageId);
		if (knownKey !== undefined && knownKey !== imageKey) return;
		this.#keyToId.set(imageKey, imageId);
		this.#idToKey.set(imageId, imageKey);
		const refs = this.#idRefCounts.get(imageId) ?? 1;
		this.#idRefCounts.set(imageId, refs);
		this.#keyRefCounts.set(imageKey, refs);
	}

	/** Release an unkeyed image id when its component is disposed. */
	releaseImageById(imageId: number): void {
		const transport = this.#transportById.get(imageId);
		if (transport === "queued") {
			this.#queuedSequences.delete(imageId);
			this.#transportById.delete(imageId);
		} else if (transport === "resident") {
			this.#purgeIds.push(imageId);
			this.#residentIds.delete(imageId);
			this.#transportById.delete(imageId);
		}
		this.#decisionById.delete(imageId);
		this.#deletePlacementState(imageId);
	}

	/**
	 * Release an image key because its owning component was disposed (e.g. a
	 * transcript rebuild replaced the card). Queued payloads are canceled;
	 * resident payloads become purge-pending so the next terminal write
	 * deletes them; keys and decisions are dropped so abandoned rebuilt cards
	 * do not accumulate ids or terminal-side storage.
	 */
	releaseImageKey(imageKey: string, ownerImageId?: number): void {
		const mapped = this.#keyToId.get(imageKey);
		const id = ownerImageId ?? mapped;
		if (id === undefined) return;
		// Retained id-to-key mappings cover identities forgotten by suppression.
		// Validate both the key and the owner id before touching any refcount, so
		// a stale component can never release a newer reacquisition of the key.
		if (this.#idToKey.get(id) !== imageKey) return;
		if (ownerImageId === undefined && mapped !== id) return;
		const currentRefs = this.#idRefCounts.get(id);
		if (currentRefs === undefined) return;
		const remaining = currentRefs - 1;
		if (remaining > 0) {
			this.#idRefCounts.set(id, remaining);
			if (this.#keyToId.get(imageKey) === id) this.#keyRefCounts.set(imageKey, remaining);
			return;
		}

		this.#idRefCounts.delete(id);
		if (this.#keyToId.get(imageKey) === id) {
			this.#keyToId.delete(imageKey);
			this.#keyRefCounts.delete(imageKey);
		}
		this.#idToKey.delete(id);
		const transport = this.#transportById.get(id) ?? "absent";
		if (transport === "queued") {
			this.#queuedSequences.delete(id);
			this.#transportById.delete(id);
		} else if (transport === "resident") {
			this.#purgeIds.push(id);
			this.#residentIds.delete(id);
			// Drop the transport entry: the id stays unrecyclable through the
			// purge queue (its delete is not written yet) and becomes truly
			// free once takePurgeIds drains it.
			this.#transportById.delete(id);
		} else {
			this.#transportById.delete(id);
		}
		this.#decisionById.delete(id);
		this.#deletePlacementState(id);
		this.#generation++;
	}

	shouldTransmit(imageId: number): boolean {
		// A suppressed id must never transmit, regardless of transport state:
		// admission gates the payload, transport only tracks physical state.
		if (this.#decisionById.get(imageId) === "suppressed") return false;
		return (this.#transportById.get(imageId) ?? "absent") === "absent";
	}

	registerPlacementGeometry(imageId: number, widthPx: number, heightPx: number, placementKey?: number): void {
		const key = placementKey === undefined ? String(imageId) : `${imageId}:${placementKey}`;
		const state = this.#placementState.get(key);
		if (state) {
			state.widthPx = widthPx;
			state.heightPx = heightPx;
			return;
		}
		this.#placementState.set(key, {
			widthPx,
			heightPx,
			epoch: 1,
			placementId: nextPlacementSalt(),
			emittedPlacementIds: [],
			lastAttachTopFrameRow: undefined,
			cellsArchived: false,
		});
	}

	observeCommitWatermark(committedTo: number): void {
		if (committedTo < 0 || this.#watchedPlacements.size === 0) return;
		for (const state of this.#watchedPlacements) {
			if (state.lastAttachTopFrameRow !== undefined && committedTo > state.lastAttachTopFrameRow) {
				state.cellsArchived = true;
				this.#watchedPlacements.delete(state);
			}
		}
	}

	beginPlacementCoordinateEpoch(): void {
		for (const state of this.#placementState.values()) state.lastAttachTopFrameRow = undefined;
		this.#watchedPlacements.clear();
	}

	resolvePlacementEmit(
		imageId: number,
		attachTopFrameRow: number,
		committedTo: number,
		placementKey?: number,
	): { placementId: number; widthPx: number; heightPx: number } | null {
		const key = placementKey === undefined ? String(imageId) : `${imageId}:${placementKey}`;
		const state = this.#placementState.get(key);
		if (!state) return null;

		if (committedTo >= 0 && state.lastAttachTopFrameRow !== undefined && committedTo > state.lastAttachTopFrameRow) {
			state.cellsArchived = true;
			this.#watchedPlacements.delete(state);
		}
		if (state.cellsArchived) {
			state.epoch += 1;
			state.placementId = nextPlacementSalt();
			state.cellsArchived = false;
			state.lastAttachTopFrameRow = undefined;
		}
		if (attachTopFrameRow >= 0) {
			state.lastAttachTopFrameRow = attachTopFrameRow;
			this.#watchedPlacements.add(state);
		}
		if (!state.emittedPlacementIds.includes(state.placementId)) {
			state.emittedPlacementIds.push(state.placementId);
		}
		return { placementId: state.placementId, widthPx: state.widthPx, heightPx: state.heightPx };
	}

	resetPlacementEpochs(): ReadonlyArray<{ imageId: number; lastEpoch: number; placementIds: readonly number[] }> {
		let stale: Array<{ imageId: number; lastEpoch: number; placementIds: readonly number[] }> | undefined;
		for (const [placementKey, state] of this.#placementState) {
			stale ??= [];
			stale.push({
				imageId: Number(placementKey.split(":", 1)[0]),
				lastEpoch: state.epoch,
				placementIds: [...state.emittedPlacementIds],
			});
			state.epoch = 1;
			state.placementId = nextPlacementSalt();
			state.emittedPlacementIds = [];
			state.lastAttachTopFrameRow = undefined;
			state.cellsArchived = false;
		}
		this.#watchedPlacements.clear();
		return stale ?? EMPTY_STALE_EPOCHS;
	}

	#deletePlacementState(imageId: number): void {
		for (const [key, state] of this.#placementState) {
			if (key === String(imageId) || key.startsWith(`${imageId}:`)) {
				this.#watchedPlacements.delete(state);
				this.#placementState.delete(key);
			}
		}
	}

	enqueueTransmit(imageId: number, sequence: string): void {
		// Invariant 6: enqueueing is not transmitting. A queued payload
		// reserves its capacity slot but stays distinguishable from a resident
		// one until markTransmitWritten observes the actual terminal write.
		if ((this.#transportById.get(imageId) ?? "absent") !== "absent") return;
		this.#transportById.set(imageId, "queued");
		this.#queuedSequences.set(imageId, sequence);
	}

	hasPendingTransmits(): boolean {
		return this.#queuedSequences.size > 0;
	}

	get quiescent(): boolean {
		return this.#lastTotal === 0 && this.#queuedSequences.size === 0 && this.#purgeIds.length === 0;
	}

	/** Drain queued payloads in enqueue order for one synchronized write. */
	takeTransmitBatch(filter?: (imageId: number) => boolean): { ids: number[]; sequences: string[] } {
		if (this.#queuedSequences.size === 0) return { ids: [], sequences: [] };
		const ids: number[] = [];
		const sequences: string[] = [];
		for (const [id, sequence] of this.#queuedSequences) {
			if (filter && !filter(id)) continue;
			ids.push(id);
			sequences.push(sequence);
		}
		// Filtered-out payloads were never written: cancel them so they
		// cannot block quiescence or leak as unpainted residents.
		if (filter) {
			for (const [id, sequence] of [...this.#queuedSequences]) {
				if (!filter(id)) {
					this.#queuedSequences.delete(id);
					this.#transportById.delete(id);
					void sequence;
				}
			}
		}
		for (const id of ids) this.#queuedSequences.delete(id);
		return { ids, sequences };
	}

	/** The transmit batch reached terminal.write; payloads are now resident. */
	markTransmitWritten(ids: readonly number[]): void {
		for (const id of ids) {
			if ((this.#transportById.get(id) ?? "absent") === "queued") {
				this.#transportById.set(id, "resident");
				this.#residentIds.add(id);
			}
		}
	}

	#forgetKeyForId(id: number): void {
		const key = this.#idToKey.get(id);
		if (key === undefined) return;
		// Keep id -> key and id refcount ownership for surviving components. The
		// key may be reacquired under a fresh id before this forgotten identity is
		// disposed; releaseImageKey(ownerId) must still retire the old payload.
		if (this.#keyToId.get(key) === id) {
			this.#keyToId.delete(key);
			this.#keyRefCounts.delete(key);
		}
	}
}

function normalizeCap(cap: number): number {
	if (!Number.isFinite(cap)) return 0;
	return Math.max(0, Math.trunc(cap));
}

export class Image implements Component {
	#base64Data: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;
	#budget?: ImageBudget;
	#imageId?: number;

	#cachedLines?: string[];
	#cachedWidth?: number;
	#cachedSuppressed = false;
	#cachedBudgetGeneration = -1;
	#cachedImageProtocol: typeof TERMINAL.imageProtocol = null;
	#cachedCellWidthPx = 0;
	#cachedCellHeightPx = 0;
	#cachedKittyUnicodePlaceholders = false;

	#renderedGraphicRows = 0;
	// Unique per component: two placements of one shared payload id must not
	// reuse the same Kitty placement id (p=), or one retargets the other.
	#placementSalt = nextPlacementSalt();

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.#budget = options.budget;
		this.#imageId = options.budget ? options.budget.acquireId(options.imageKey) : undefined;
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
	}

	dispose(): void {
		// A disposed Image (transcript rebuild, card removal) must release its
		// budget identity: without this, every rebuild leaks the key, the id,
		// and the resident terminal payload of the abandoned card.
		if (this.#budget !== undefined && this.#imageId !== undefined) {
			if (this.#options.imageKey !== undefined) {
				// Suppression and protocol reset drop the key mapping while
				// this component is still alive: re-bind before releasing so
				// the release is a validated owner operation, not a no-op.
				this.#budget.adopt(this.#options.imageKey, this.#imageId);
				this.#budget.releaseImageKey(this.#options.imageKey, this.#imageId);
			} else {
				this.#budget.releaseImageById(this.#imageId);
			}
		}
		this.#budget = undefined;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		const imageProtocol = TERMINAL.imageProtocol;
		const hasProtocol = imageProtocol != null;
		const cellDimensions = getCellDimensions();
		const kittyUnicodePlaceholders = getKittyGraphics().unicodePlaceholders;

		const suppressed = hasProtocol && this.#budget !== undefined ? this.#budget.observe(this.#imageId ?? 0) : false;

		if (
			this.#cachedLines &&
			this.#cachedWidth === width &&
			this.#cachedSuppressed === suppressed &&
			this.#cachedImageProtocol === imageProtocol &&
			this.#cachedCellWidthPx === cellDimensions.widthPx &&
			this.#cachedCellHeightPx === cellDimensions.heightPx &&
			this.#cachedKittyUnicodePlaceholders === kittyUnicodePlaceholders &&
			this.#cachedBudgetGeneration === (this.#budget?.generation ?? -1)
		) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];

		if (hasProtocol && !suppressed) {
			const needsTransmit = this.#imageId != null && (this.#budget?.shouldTransmit(this.#imageId) ?? false);
			const result = renderImage(this.#base64Data, this.#dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: this.#options.maxHeightCells,
				imageId: this.#imageId,
				placementId: this.#placementSalt,
				includeTransmit: needsTransmit,
			});

			if (result?.transmit && this.#imageId != null && this.#budget !== undefined) {
				this.#budget.enqueueTransmit(this.#imageId, result.transmit);
			}

			if (result?.lines) {
				lines = result.lines;
			} else if (result) {
				if (this.#imageId != null && this.#budget !== undefined) {
					this.#budget.registerPlacementGeometry(
						this.#imageId,
						this.#dimensions.widthPx,
						this.#dimensions.heightPx,
						this.#placementSalt,
					);
				}
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push(RESERVED_IMAGE_ROW);
				}
				const cursorRows = result.rows - 1;
				const moveUp = cursorRows > 0 ? `\x1b[${cursorRows}A` : "";
				const placement = moveUp + (result.sequence ?? "");
				lines.push(cursorRows > 0 ? SAVE_CURSOR + placement + RESTORE_CURSOR : placement);
			} else {
				lines = this.#fallbackLines();
			}
			this.#renderedGraphicRows = Math.max(this.#renderedGraphicRows, lines.length);
		} else {
			lines = this.#fallbackLines();
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;
		this.#cachedSuppressed = suppressed;
		this.#cachedBudgetGeneration = this.#budget?.generation ?? -1;
		this.#cachedImageProtocol = imageProtocol;
		this.#cachedCellWidthPx = cellDimensions.widthPx;
		this.#cachedCellHeightPx = cellDimensions.heightPx;
		this.#cachedKittyUnicodePlaceholders = kittyUnicodePlaceholders;

		return lines;
	}

	#fallbackLines(): string[] {
		const fallback = this.#theme.fallbackColor(
			imageFallback(this.#mimeType, this.#dimensions, this.#options.filename),
		);
		if (this.#renderedGraphicRows <= 1) return [fallback];
		const lines: string[] = [];
		for (let i = 0; i < this.#renderedGraphicRows - 1; i++) {
			lines.push(RESERVED_IMAGE_ROW);
		}
		lines.push(fallback);
		return lines;
	}
}
