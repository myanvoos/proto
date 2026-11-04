import { afterEach, expect, test, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	DEFAULT_TAB_WIDTH,
	estimateRenderCacheSize,
	getHangulCompatibilityJamoWidth,
	setHangulCompatibilityJamoWidth,
	truncateToWidth,
	wrapTextWithAnsi,
} from "./utils";

afterEach(() => vi.restoreAllMocks());

test("mutating a wrapTextWithAnsi result must not corrupt later wraps of the same text", () => {
	// Longer than the width, so the text takes the memoized native path rather than
	// the short plain-ASCII fast path.
	const text =
		"wrap cache entries are shared across every component render — appended rows would leak into later frames";
	const width = 32;
	const pristine = wrapTextWithAnsi(text, width).join("\n");

	const first = wrapTextWithAnsi(text, width);
	first.push("POISONED ROW");

	expect(wrapTextWithAnsi(text, width).join("\n")).toBe(pristine);
	expect(wrapTextWithAnsi(text, width)).not.toContain("POISONED ROW");
});

test("each wrapTextWithAnsi call returns an independent array", () => {
	const text = "two callers appending to their own results must not observe each other's rows in any frame";
	const width = 24;
	const a = wrapTextWithAnsi(text, width);
	const b = wrapTextWithAnsi(text, width);
	expect(a).toEqual(b);
	expect(a).not.toBe(b);
	a.push("A-ONLY ROW");
	expect(b).not.toContain("A-ONLY ROW");
});

test("row-heavy wraps evict cold arrays without changing ANSI or Unicode output", () => {
	const source = `${"\n".repeat(6000)}\x1b[32m界🙂 cached rows\x1b[0m`;
	const expected = natives.wrapTextWithAnsi(source, 18, DEFAULT_TAB_WIDTH);
	const nativeWrap = vi.spyOn(natives, "wrapTextWithAnsi");
	expect(wrapTextWithAnsi(source, 18)).toEqual(expected);
	expect(wrapTextWithAnsi(source, 18)).toEqual(expected);
	expect(nativeWrap).toHaveBeenCalledTimes(1);
	// Fewer than 512 entries, and very little text: array slots/string headers,
	// not entry count or source code units, must force the cold entry out.
	for (let index = 0; index < 30; index++) wrapTextWithAnsi(`${source}-${index}`, 18);
	const afterPressure = nativeWrap.mock.calls.length;
	wrapTextWithAnsi(`${source}-29`, 18);
	expect(nativeWrap).toHaveBeenCalledTimes(afterPressure);
	const recomputed = wrapTextWithAnsi(source, 18);
	expect(nativeWrap).toHaveBeenCalledTimes(afterPressure + 1);
	expect(recomputed).toEqual(expected);
	recomputed.push("caller mutation");
	expect(wrapTextWithAnsi(source, 18)).toEqual(expected);
});

test("truncation evicts cold Unicode keys within its byte allowance and recomputes exact ANSI", () => {
	const source = `\x1b[34mtruncate-byte-bound-${"界".repeat(7000)}\x1b[0m`;
	const expected = natives.truncateToWidth(source, 24, natives.Ellipsis.Unicode, false, DEFAULT_TAB_WIDTH);
	const nativeTruncate = vi.spyOn(natives, "truncateToWidth");
	expect(truncateToWidth(source, 24)).toBe(expected);
	expect(truncateToWidth(source, 24)).toBe(expected);
	expect(nativeTruncate).toHaveBeenCalledTimes(1);
	for (let index = 0; index < 160; index++) truncateToWidth(`${source}-${index}`, 24);
	const afterPressure = nativeTruncate.mock.calls.length;
	truncateToWidth(`${source}-159`, 24);
	expect(nativeTruncate).toHaveBeenCalledTimes(afterPressure);
	expect(truncateToWidth(source, 24)).toBe(expected);
	expect(nativeTruncate).toHaveBeenCalledTimes(afterPressure + 1);
});

test("width configuration changes cannot serve stale wrapped or truncated Hangul rows", () => {
	const previousWidth = getHangulCompatibilityJamoWidth();
	const source = "\x1b[32mㄱㄴㄷㄹㅁㅂㅅㅇ\x1b[0m";
	try {
		setHangulCompatibilityJamoWidth(1);
		const narrowWrap = wrapTextWithAnsi(source, 6);
		const narrowTruncate = truncateToWidth(source, 6);
		setHangulCompatibilityJamoWidth(2);
		expect(wrapTextWithAnsi(source, 6)).toEqual(natives.wrapTextWithAnsi(source, 6, DEFAULT_TAB_WIDTH));
		expect(wrapTextWithAnsi(source, 6)).not.toEqual(narrowWrap);
		expect(truncateToWidth(source, 6)).toBe(
			natives.truncateToWidth(source, 6, natives.Ellipsis.Unicode, false, DEFAULT_TAB_WIDTH),
		);
		expect(truncateToWidth(source, 6)).not.toBe(narrowTruncate);
	} finally {
		setHangulCompatibilityJamoWidth(previousWidth);
	}
});

test("render cache accounting charges Unicode backing storage and empty row containers", () => {
	const ascii = ["x".repeat(100)];
	const unicode = ["界".repeat(100)];
	const astral = ["🙂".repeat(100)];
	const cache = new LRUCache<string, readonly string[]>({
		maxSize: estimateRenderCacheSize("a", ascii) * 2,
		sizeCalculation: (lines, key) => estimateRenderCacheSize(key, lines),
	});
	cache.set("a", ascii).set("u", unicode);
	expect(cache.size).toBe(2); // Both are conservatively charged as UTF-16, not UTF-8.
	cache.set("s", astral);
	expect(cache.get("a")).toBeUndefined();
	expect(cache.get("u")).toBeUndefined();
	expect(cache.get("s")).toEqual(astral);
	cache.set(
		"r",
		Array.from({ length: 100 }, () => ""),
	);
	// Even zero text bytes cannot admit an unbounded array of rows.
	expect(cache.get("r")).toBeUndefined();
	expect(cache.get("s")).toEqual(astral);
});
