import { expect, test } from "bun:test";
import { SettingsList, type SettingsListTheme } from "./settings-list";

const theme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	hint: text => text,
	cursor: "> ",
};

test("settings total height keeps selected setting visible and clickable through resize", () => {
	const list = new SettingsList(
		Array.from({ length: 30 }, (_, i) => ({
			id: `${i}`,
			label: `Setting ${i}`,
			currentValue: "on",
			description: "A long description that must yield before the selected setting.",
		})),
		12,
		theme,
		() => {},
		() => {},
	);
	list.selectItem("27");
	for (const height of [20, 1, 2, 4, 6, 10, 20]) {
		list.setMaxHeight(height);
		const lines = list.render(40);
		expect(lines.length).toBeLessThanOrEqual(height);
		const selectedRow = lines.findIndex(line => line.includes("> Setting 27"));
		expect(selectedRow).toBeGreaterThanOrEqual(0);
		expect(list.hitTest(selectedRow, 0)).toBe("27");
	}
});

test("a narrowed value column marks a clipped value instead of silently shortening it", () => {
	const list = new SettingsList(
		[
			{ id: "cbm", label: "Color-Blind Mode", currentValue: "false" },
			{ id: "sep", label: "Status Line Separator", currentValue: "powerline-thin" },
			{ id: "dark", label: "Dark Theme", currentValue: "dark-volcanic" },
		],
		10,
		theme,
		() => {},
		() => {},
	);
	list.setMaxHeight(10);
	for (const width of [60, 50, 46, 42, 40, 38, 36, 34]) {
		const rows = list.render(width);
		const row = rows.find(line => line.includes("Color-Blind"));
		expect(row, `width ${width}`).toBeDefined();
		// A boolean is short enough to survive every one of these widths intact.
		expect(row, `width ${width}`).toContain("false");
		const separator = rows.find(line => line.includes("Separator"));
		// Anything the value column does clip says so.
		if (separator !== undefined && !separator.includes("powerline-thin")) {
			expect(separator, `width ${width}`).toContain("…");
		}
	}
});

test("the value column survives a label column that would otherwise eat the row", () => {
	const list = new SettingsList(
		[{ id: "long", label: "Native Terminal Progress Reporting", currentValue: "false" }],
		10,
		theme,
		() => {},
		() => {},
	);
	list.setMaxHeight(10);
	for (const width of [48, 44, 40, 36]) {
		const row = list.render(width).find(line => line.includes("Native"));
		expect(row, `width ${width}`).toContain("false");
	}
});
