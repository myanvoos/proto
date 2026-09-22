import { expect, test } from "bun:test";
import { type Tab, TabBar } from "./tab-bar";

const plain = {
	label: (t: string) => t,
	activeTab: (t: string) => t,
	inactiveTab: (t: string) => t,
	hint: (t: string) => t,
};

function bar(tabs: Tab[]): TabBar {
	const instance = new TabBar("", tabs, plain);
	instance.showHint = false;
	return instance;
}

const NAMES = [
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
const tabs = (): Tab[] => NAMES.map(name => ({ id: name.toLowerCase(), label: name }));

test("a bounded tab strip keeps the active tab visible while cycling", () => {
	const instance = bar(tabs());
	instance.setMaxHeight(2);
	for (let step = 0; step < NAMES.length; step++) {
		const lines = instance.render(24);
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines.join("\n")).toContain(instance.getActiveTab().label);
		instance.nextTab();
	}
});

test("clicks on a bounded strip select the tab under the cursor", () => {
	const instance = bar(tabs());
	instance.setMaxHeight(2);
	instance.selectTab("providers");
	const lines = instance.render(24);
	for (let line = 0; line < lines.length; line++) {
		for (let col = 0; col < lines[line].length; col++) {
			const hit = instance.tabAt(line, col);
			if (hit) expect(lines[line]).toContain(hit.label);
		}
	}
	const activeLine = lines.findIndex(line => line.includes("Providers"));
	const activeCol = lines[activeLine].indexOf("Providers");
	expect(instance.tabAt(activeLine, activeCol)?.id).toBe("providers");
});

test("an unbounded strip still wraps every tab onto the screen", () => {
	const instance = bar(tabs());
	const lines = instance.render(24).join("\n");
	for (const name of NAMES) expect(lines).toContain(name);
});
