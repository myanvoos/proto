/**
 * Anchor-based contiguous range selection for list views (mass operations).
 *
 * The anchor is the cursor row where the first extend key was pressed; the
 * marked range spans anchor..cursor inclusive. A range covering only the
 * cursor row is inactive — it renders and acts like the plain cursor — but
 * the anchor survives, so extending back re-anchors symmetrically. Plain
 * cursor movement collapses the range entirely.
 *
 * The anchor is tracked by key (`K`) so consumers can remap it after the
 * underlying list is reordered or filtered without losing an in-progress
 * selection.
 */
export class ListRangeSelection<K> {
	#anchor: number | null = null;
	#anchorKey: K | null = null;

	/** Start or extend the range so it spans the anchor and `cursor`. */
	extend(cursor: number, key: K): void {
		if (this.#anchor === null) {
			this.#anchor = cursor;
			this.#anchorKey = key;
		}
	}

	/** Collapse the range onto a plain cursor move; forgets the anchor. */
	collapse(): void {
		this.#anchor = null;
		this.#anchorKey = null;
	}

	clear(): void {
		this.collapse();
	}

	/** True while an anchor exists, even if the range currently covers one row. */
	get anchored(): boolean {
		return this.#anchor !== null;
	}

	/** `[lo, hi]` inclusive, or null when the range covers a single row. */
	range(cursor: number): [number, number] | null {
		if (this.#anchor === null || this.#anchor === cursor) return null;
		return this.#anchor < cursor ? [this.#anchor, cursor] : [cursor, this.#anchor];
	}

	/** Whether `index` lies inside the active range for the given cursor. */
	covers(cursor: number, index: number): boolean {
		const span = this.range(cursor);
		return span !== null && index >= span[0] && index <= span[1];
	}

	/**
	 * Re-resolve the anchor after the list mutated. `indexOfKey` returns the
	 * anchor key's new index, or -1 when the anchor row is gone; a missing
	 * anchor clears the selection.
	 */
	remap(indexOfKey: (key: K) => number): void {
		if (this.#anchorKey === null) return;
		const index = indexOfKey(this.#anchorKey);
		if (index < 0) {
			this.collapse();
			return;
		}
		this.#anchor = index;
	}
}
