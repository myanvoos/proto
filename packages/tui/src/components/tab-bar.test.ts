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

test("a clipped strip says how many tabs it is hiding", () => {
	const instance = bar(tabs());
	instance.setMaxHeight(1);
	const lines = instance.render(28);
	expect(lines.length).toBe(1);
	const shown = NAMES.filter(name => lines[0].includes(name)).length;
	expect(shown).toBeLessThan(NAMES.length);
	expect(lines[0]).toMatch(/\+\d+ more/);
	const hidden = Number(/\+(\d+) more/.exec(lines[0])?.[1]);
	expect(hidden).toBeGreaterThan(0);
	expect(hidden).toBeLessThan(NAMES.length);
	// Every tab is either drawn on the visible row or counted as hidden.
	expect(shown + hidden).toBeLessThanOrEqual(NAMES.length);

	// A wider strip fits more tabs, so it can never claim to hide more of them.
	const wider = instance.render(60);
	const widerHidden = Number(/\+(\d+) more/.exec(wider[0] ?? "")?.[1] ?? 0);
	expect(widerHidden).toBeLessThanOrEqual(hidden);
});

test("a strip that fits every tab carries no overflow marker", () => {
	const instance = bar(tabs());
	instance.setMaxHeight(10);
	const lines = instance.render(200);
	expect(lines.join("\n")).not.toMatch(/\+\d+ more/);
	for (const name of NAMES) expect(lines.join("\n")).toContain(name);
});

test("the overflow marker never leaves a half-drawn tab clickable", () => {
	const instance = bar(tabs());
	instance.setMaxHeight(1);
	for (const width of [20, 24, 28, 34, 40]) {
		const lines = instance.render(width);
		for (let col = 0; col < lines[0].length; col++) {
			const hit = instance.tabAt(0, col);
			if (hit) expect(lines[0], `width ${width}`).toContain(hit.label);
		}
	}
});
