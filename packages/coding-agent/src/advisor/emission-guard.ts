export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,

	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,

	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,

	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

const DEFAULT_HISTORY_CAPACITY = 4096;

/** Admitted non-blocker notes per advisor update; blockers are exempt. */
const BUDGET_PER_UPDATE = 1;

/** Why the guard suppressed a note; surfaced in the tool acknowledgment. */
export type AdvisorSuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit";

export interface AdvisorAdmission {
	accepted: boolean;
	/** Set only when `accepted` is false. */
	reason?: AdvisorSuppressionReason;
	/** A still-pending note of the same update displaced by this admission; the caller must drop it from its backlog. */
	displacedKey?: string;
}

/**
 * The single admission authority for advisor notes: noise filter, severity-aware session dedupe, and the per-update
 * non-blocker budget. A note is admitted when emitted — live or deferred behind an in-progress primary turn — so a
 * deferred flush routes without re-admission and never loses notes to the budget of a later update.
 *
 * Dedupe admits only a strictly higher severity for the same text (a real escalation). At budget, a strictly
 * higher-severity note displaces the lowest-rank note still pending from the same update; routed notes are charged
 * for good because delivery cannot be retracted.
 */
export class AdvisorEmissionGuard {
	/** Normalized key → highest admitted severity rank. */
	#seen = new Map<string, number>();
	#seenOrder: string[] = [];
	/** Budget slots charged this update; only `pending` slots may be displaced. */
	#slots: { key: string; rank: number; pending: boolean }[] = [];
	readonly #capacity: number;

	constructor(opts: { capacity?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
	}

	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#slots = [];
	}

	/** Starts a fresh per-update budget; earlier updates' pending notes keep their reservations. */
	beginUpdate(): void {
		this.#slots = [];
	}

	/** A still-pending note re-raised at a higher severity escalates in place without a new admission. */
	escalatePending(note: string, rank: number): void {
		const key = normalizeAdvisorNote(note);
		if (!key || rank <= (this.#seen.get(key) ?? 0)) return;
		this.#recordRank(key, rank);
		const slot = this.#slots.find(s => s.key === key);
		if (slot && slot.rank < rank) slot.rank = rank;
	}

	/** A deferred flush delivered the note: its slot in the originating update can no longer be displaced. */
	markRouted(note: string): void {
		const key = normalizeAdvisorNote(note);
		const slot = this.#slots.find(s => s.key === key);
		if (slot) slot.pending = false;
	}

	/** `pending`: withheld behind an in-progress primary turn (displaceable) rather than routed now. */
	admit(note: string, opts: { rank: number; pending: boolean }): AdvisorAdmission {
		const key = normalizeAdvisorNote(note);
		if (!key) return { accepted: false, reason: "empty" };
		if (SUPPRESSED_NORMALIZED_PHRASES[key]) return { accepted: false, reason: "noise" };
		const { rank } = opts;
		if (rank <= (this.#seen.get(key) ?? 0)) return { accepted: false, reason: "duplicate" };
		let displacedKey: string | undefined;
		const ownSlot = this.#slots.find(s => s.key === key);
		if (rank >= 3) {
			// A blocker always interrupts. Escalating a still-pending note routes it live, so its reservation is void.
			if (ownSlot?.pending) this.#slots.splice(this.#slots.indexOf(ownSlot), 1);
		} else if (ownSlot) {
			ownSlot.rank = rank;
		} else if (this.#slots.length < BUDGET_PER_UPDATE) {
			this.#slots.push({ key, rank, pending: opts.pending });
		} else {
			let minIndex = -1;
			for (let i = 0; i < this.#slots.length; i++) {
				const slot = this.#slots[i]!;
				if (slot.pending && (minIndex === -1 || slot.rank < this.#slots[minIndex]!.rank)) minIndex = i;
			}
			if (minIndex === -1 || rank <= this.#slots[minIndex]!.rank) return { accepted: false, reason: "rate-limit" };
			displacedKey = this.#slots[minIndex]!.key;
			this.#slots[minIndex] = { key, rank, pending: opts.pending };
		}
		this.#recordRank(key, rank);
		return displacedKey === undefined ? { accepted: true } : { accepted: true, displacedKey };
	}

	#recordRank(key: string, rank: number): void {
		const isNew = !this.#seen.has(key);
		this.#seen.set(key, rank);
		if (!isNew) return;
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
	}
}
