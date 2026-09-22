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
