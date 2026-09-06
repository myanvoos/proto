import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { initThemeSync, theme } from "../modes/theme/theme";
import { renderOutputBlock } from "./output-block";

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
