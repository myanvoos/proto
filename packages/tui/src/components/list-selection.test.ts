import { describe, expect, test } from "bun:test";
import { ListRangeSelection } from "./list-selection";

describe("ListRangeSelection", () => {
	test("extend marks an anchor..cursor range across downward and upward extension", () => {
		const selection = new ListRangeSelection<string>();
		expect(selection.range(3)).toBeNull();

		selection.extend(3, "c");
		expect(selection.range(3)).toBeNull(); // single row is inactive
		selection.extend(5, "e");
		expect(selection.range(5)).toEqual([3, 5]);
		expect(selection.covers(5, 4)).toBe(true);
		expect(selection.covers(5, 2)).toBe(false);

		selection.extend(1, "a"); // anchor survives; extending upward re-anchors at 3
		expect(selection.range(1)).toEqual([1, 3]);
		expect(selection.covers(1, 2)).toBe(true);
		expect(selection.covers(1, 4)).toBe(false);
	});

	test("collapse forgets the anchor so the next extend starts fresh", () => {
		const selection = new ListRangeSelection<string>();
		selection.extend(2, "b");
		selection.extend(4, "d");
		selection.collapse();
		expect(selection.anchored).toBe(false);
		selection.extend(6, "f");
		expect(selection.range(6)).toBeNull();
		selection.extend(7, "g");
		expect(selection.range(7)).toEqual([6, 7]);
	});

	test("remap moves the anchor with its key and clears when the key is gone", () => {
		const selection = new ListRangeSelection<string>();
		selection.extend(1, "b");
		selection.extend(2, "c");
		selection.remap(key => ["a", "b", "c", "d"].indexOf(key));
		expect(selection.range(3)).toEqual([1, 3]); // "b" moved 1 -> 1, cursor remapped by consumer

		selection.remap(key => ["a", "c", "d"].indexOf(key));
		expect(selection.anchored).toBe(false);
		expect(selection.range(0)).toBeNull();
	});

	test("remap is a no-op without an anchor", () => {
		const selection = new ListRangeSelection<number>();
		selection.remap(() => {
			throw new Error("must not consult the index without an anchor");
		});
		expect(selection.anchored).toBe(false);
	});
});
