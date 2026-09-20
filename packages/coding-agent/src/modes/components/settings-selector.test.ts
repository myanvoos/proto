import { describe, expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import { initThemeSync, theme } from "../theme/theme";
import { SettingsSelectorComponent } from "./settings-selector";

await Settings.init({ inMemory: true });
initThemeSync();

describe("SettingsSelectorComponent status line preview", () => {
	test("frames each preview line as its own row sized to the inner width", () => {
		const widths: number[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				cwd: "/srv/demo-project",
			},
			{
				onChange: () => {},
				getStatusLinePreview: width => {
					widths.push(width);
					return ["location line", "capability line"];
				},
				onCancel: () => {},
			},
		);
		const width = 80;
		const rows = selector.render(width).map(row => Bun.stripANSI(row));
		const border = theme.boxRound.vertical;
		for (const content of ["Preview:", "location line", "capability line"]) {
			const row = rows.find(candidate => candidate.includes(content));
			expect(row).toBeDefined();
			expect(row).not.toContain("\n");
			expect(row?.startsWith(border)).toBe(true);
			expect(row?.endsWith(border)).toBe(true);
			expect(Bun.stringWidth(row ?? "")).toBe(width);
		}
		expect(widths).toEqual([width - 4]);
	});
});
