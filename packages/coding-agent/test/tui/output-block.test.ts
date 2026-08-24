import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderMarkdownCell } from "@oh-my-pi/pi-coding-agent/tui/code-cell";
import { renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui/output-block";

describe("renderOutputBlock", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("draws content rows on the default-padded left rail", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 16,
				sections: [{ lines: ["abcdefghijklmnop"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines).toEqual(["▏  abcdefghijklm", "▏  nop"]);
	});

	it("keeps explicitly flush content flush against the rail", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 16,
				contentPaddingLeft: 0,
				sections: [{ lines: ["abcdefghijklmn"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines).toEqual(["▏ abcdefghijklmn"]);
	});

	it("budgets collapsed Markdown rows against the railed block width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderMarkdownCell(
			{
				content: "x".repeat(54),
				contentMaxLines: 1,
				status: "complete",
				title: "Read",
				width: 30,
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines[0]?.trim()).toBe("▪ Read");
		expect(lines[1]).toBe(`▏  ${"x".repeat(27)}`);
		expect(lines.slice(2).some(line => line.startsWith("▏  … 1 more line"))).toBe(true);
	});
});
