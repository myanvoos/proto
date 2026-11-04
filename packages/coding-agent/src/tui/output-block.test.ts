import { afterEach, expect, test, vi } from "bun:test";
import { getHangulCompatibilityJamoWidth, setHangulCompatibilityJamoWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { loadThemeSync } from "../modes/theme/loader";
import { initThemeSync, theme } from "../modes/theme/theme";
import { CachedOutputBlock, renderOutputBlock } from "./output-block";

afterEach(() => vi.restoreAllMocks());

initThemeSync();

test("output block headers, labels and content fit narrow terminals without emitting tabs", () => {
	for (const width of [0, 2, 20]) {
		const lines = renderOutputBlock(
			{
				width,
				header: `Header\t${"界".repeat(30)}`,
				headerMeta: "metadata\tvalue",
				sections: [{ label: `Label\t${"x".repeat(40)}`, lines: ["\t日本語 output"] }],
			},
			theme,
		);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line).not.toContain("\t");
		}
		if (width === 20) {
			expect(lines.join("\n")).toContain("Header");
			expect(lines.join("\n")).toContain("Label");
			expect(lines.join("\n")).toContain("日本語");
		}
	}
});

test("output cache evicts cold row-heavy blocks and recomputes identical ANSI and Unicode rows", () => {
	const localTheme = loadThemeSync("dark");
	const options = {
		width: 32,
		header: "cold cache output",
		sections: [{ lines: Array.from({ length: 6000 }, () => "\x1b[32m界🙂 cached output\x1b[0m") }],
	};
	const expected = renderOutputBlock(options, localTheme);
	const renderColor = vi.spyOn(localTheme, "fg");
	expect(new CachedOutputBlock().render(options, localTheme)).toEqual(expected);
	const initialCalls = renderColor.mock.calls.length;
	expect(initialCalls).toBeGreaterThan(0);
	expect(new CachedOutputBlock().render(options, localTheme)).toEqual(expected);
	expect(renderColor).toHaveBeenCalledTimes(initialCalls);
	// The byte bound, not the 4096-entry bound, must evict these row arrays.
	for (let index = 0; index < 30; index++) {
		new CachedOutputBlock().render({ ...options, header: `pressure ${index}` }, localTheme);
	}
	const afterPressure = renderColor.mock.calls.length;
	new CachedOutputBlock().render({ ...options, header: "pressure 29" }, localTheme);
	expect(renderColor).toHaveBeenCalledTimes(afterPressure);
	expect(new CachedOutputBlock().render(options, localTheme)).toEqual(expected);
	expect(renderColor.mock.calls.length).toBeGreaterThan(afterPressure);
});

test("a cached block follows theme replacements and width configuration changes", () => {
	const dark = loadThemeSync("dark");
	const light = loadThemeSync("light");
	const block = new CachedOutputBlock();
	const options = { width: 14, sections: [{ lines: ["ㄱㄴㄷㄹㅁㅂㅅㅇ cached output"] }] };
	const previousWidth = getHangulCompatibilityJamoWidth();
	try {
		setHangulCompatibilityJamoWidth(1);
		const first = block.render(options, dark);
		expect(block.render(options, light)).toEqual(renderOutputBlock(options, light));
		expect(block.render(options, light)).not.toEqual(first);
		setHangulCompatibilityJamoWidth(2);
		expect(block.render(options, dark)).toEqual(renderOutputBlock(options, dark));
		expect(block.render(options, dark)).not.toEqual(first);
	} finally {
		setHangulCompatibilityJamoWidth(previousWidth);
	}
});
