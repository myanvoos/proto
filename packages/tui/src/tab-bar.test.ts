import { expect, test } from "bun:test";
import { type Tab, TabBar, type TabBarTheme } from "./components/tab-bar";

const PLAIN_THEME: TabBarTheme = {
	label: text => text,
	activeTab: text => `<${text}>`,
	inactiveTab: text => text,
	hint: text => text,
};

const LABELS = [
	"Appearance",
	"Model",
	"Interaction",
	"Context",
	"Files",
	"Shell",
	"Tools",
	"Workers",
	"Providers",
	"Plugins",
];

function bar(labels: readonly string[] = LABELS): TabBar {
	const tabs: Tab[] = labels.map(label => ({ id: label, label }));
	const instance = new TabBar("", tabs, PLAIN_THEME);
	instance.showHint = false;
	return instance;
}

test("a wrapped strip never opens a line with the gap between tabs", () => {
	for (const width of [12, 16, 20, 24, 31, 40]) {
		const lines = bar().render(width);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(line, `${width} columns`).not.toMatch(/^\s{2}/);
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

test("a strip clipped to a row budget scrolls to keep the active tab visible", () => {
	const instance = bar();
	instance.setMaxHeight(3);
	for (let step = 0; step < LABELS.length; step++) {
		const lines = instance.render(20);
		expect(lines.length).toBeLessThanOrEqual(3);
		const active = instance.getActiveTab().label;
		expect(lines.join("\n"), `active ${active}`).toContain(`<${` ${active} `}>`);
		instance.nextTab();
	}
});

test("a clipped strip keeps mouse hit zones aligned with the rows it shows", () => {
	const instance = bar();
	instance.setMaxHeight(2);
	instance.setActiveById("Providers");
	const lines = instance.render(20);
	expect(lines.length).toBe(2);
	const activeLine = lines.findIndex(line => line.includes("<"));
	expect(activeLine).toBeGreaterThanOrEqual(0);
	const column = lines[activeLine]!.indexOf("Providers");
	expect(instance.tabAt(activeLine, column)?.id).toBe("Providers");
	// Rows scrolled out of view must not answer clicks at all.
	expect(instance.tabAt(lines.length, column)).toBeUndefined();
});
