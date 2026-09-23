import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import { getBuiltinThemes } from "../theme/loader";
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

const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
afterEach(() => {
	if (stdoutRows) Object.defineProperty(process.stdout, "rows", stdoutRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

function shortSettings() {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["proto", "light", "dark"],
			providers: [],
			cwd: "/tmp/offline",
		},
		{ onChange: () => {}, getStatusLinePreview: () => ["preview path", "preview model"], onCancel: () => {} },
	);
}

test.each([20, 32, 40, 60])("settings retain title and focused row across short resizes at %i columns", width => {
	const selector = shortSettings();
	for (const height of [24, 1, 2, 3, 4, 6, 10, 24]) {
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
		const lines = selector.render(width).map(line => Bun.stripANSI(line));
		expect(lines.length).toBeLessThanOrEqual(height);
		if (height >= 3) {
			expect(lines[0]).toContain("Settings");
			expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
		} else expect(lines.some(line => line.startsWith(theme.boxRound.vertical))).toBe(false);
		expect(lines.some(line => line.includes("Dark Theme") && line.includes(theme.nav.cursor))).toBe(true);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
	}
});

test("settings submenu preserves its selected option and returns to its setting at six rows", () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 6 });
	const selector = shortSettings();
	selector.render(32);
	selector.handleInput("\r");
	let lines = selector.render(32).map(line => Bun.stripANSI(line));
	expect(lines.length).toBeLessThanOrEqual(6);
	expect(lines.join("\n")).toContain("Dark Theme");
	expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("proto"))).toBe(true);
	selector.handleInput("\x1b[B");
	lines = selector.render(32).map(line => Bun.stripANSI(line));
	// The dark slot lists its own themes first, so "dark" follows "proto" and the
	// mismatched "light" sorts behind both.
	expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("dark"))).toBe(true);
	selector.handleInput("\x1b");
	expect(selector.render(32).some(line => Bun.stripANSI(line).includes("Dark Theme"))).toBe(true);
});

const TAB_NAMES = [
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

/** Rows between the dialog title and the first divider: the tab strip. */
function tabStrip(selector: SettingsSelectorComponent, width: number): string[] {
	const lines = selector.render(width).map(line => Bun.stripANSI(line));
	const start = lines.findIndex(line => line.includes("Settings")) + 1;
	const end = lines.findIndex((line, index) => index >= start && line.startsWith(theme.boxRound.teeRight));
	return lines.slice(start, end === -1 ? start : end).map(line => line.replaceAll(theme.boxRound.vertical, " "));
}

/** Every clickable chunk of the strip, split on the two-space gap TabBar emits. */
function tabChunks(strip: string[]): string[] {
	return strip.flatMap(line => line.split(/\s{2,}/)).filter(chunk => chunk.trim().length > 0);
}

test.each([100, 80, 60, 50, 40])("every settings tab names itself at %i columns", width => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
	const selector = shortSettings();
	const browse = tabStrip(selector, width);
	for (const name of TAB_NAMES) expect(browse.join("\n")).toContain(name);

	for (const key of "theme") selector.handleInput(key);
	const search = tabStrip(selector, width);
	for (const name of TAB_NAMES) expect(search.join("\n")).toContain(name);
	// Counts stay on the tabs that still fit them; none degrades to a bare number.
	for (const chunk of tabChunks(search)) expect(chunk).toMatch(/[A-Za-z]/);
});

test("a narrow settings strip scrolls to the tab it activates instead of blanking", () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
	const selector = shortSettings();
	for (const chunk of tabChunks(tabStrip(selector, 20))) expect(chunk).toMatch(/[A-Za-z]/);
	expect(tabStrip(selector, 20).join("\n")).toContain("Appearance");
	// Tab cycles section focus inside the current tab; the strip moves with the
	// arrow keys, and a clipped strip has to scroll to whatever it activates.
	for (let step = 0; step < 8; step++) selector.handleInput("\x1b[C");
	const strip = tabStrip(selector, 20);
	expect(strip.join("\n")).toContain("Providers");
	for (const chunk of tabChunks(strip)) expect(chunk).toMatch(/[A-Za-z]/);
});

test("settings tabs stay readable under every bundled theme", () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
	const themes = Object.keys(getBuiltinThemes());
	expect(themes.length).toBeGreaterThan(10);
	try {
		for (const name of themes) {
			initThemeSync(false, name, name);
			const strip = tabStrip(shortSettings(), 80);
			for (const label of ["Appearance", "Providers", "Plugins"]) expect(strip.join("\n")).toContain(label);
			for (const chunk of tabChunks(strip)) expect(chunk).toMatch(/[A-Za-z]/);
		}
	} finally {
		initThemeSync();
	}
});

test("the settings tab strip never starves the list of rows", () => {
	const selector = shortSettings();
	for (const height of [10, 12, 16, 24]) {
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
		const lines = selector.render(20).map(line => Bun.stripANSI(line));
		expect(lines.length).toBeLessThanOrEqual(height);
		expect(lines.some(line => line.includes("Dark Theme") && line.includes(theme.nav.cursor))).toBe(true);
	}
});

test("a theme slot groups the themes that fit it first and marks the ones that do not", () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
	const names = Object.keys(getBuiltinThemes());
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: names,
			providers: [],
			cwd: "/srv/demo-project",
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	// Open the Dark Theme picker, then filter to the light themes it still offers.
	selector.handleInput("\r");
	for (const key of "light-") selector.handleInput(key);
	const lines = selector.render(100).map(line => Bun.stripANSI(line));
	const rows = lines.filter(line => /\blight-/.test(line) && !line.includes("⌕"));
	expect(rows.length).toBeGreaterThan(0);
	// Every light theme offered for the dark slot says what it is.
	for (const row of rows) expect(row).toContain("light theme");
});

test("a theme slot leaves the themes that match it unmarked", () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
	const names = Object.keys(getBuiltinThemes());
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: names,
			providers: [],
			cwd: "/srv/demo-project",
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	selector.handleInput("\r");
	for (const key of "dark-n") selector.handleInput(key);
	const lines = selector.render(100).map(line => Bun.stripANSI(line));
	const rows = lines.filter(line => /\bdark-n/.test(line) && !line.includes("⌕"));
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) expect(row).not.toContain("light theme");
});

test("the nested picker leaves the hint to the dialog footer", () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
	const selector = shortSettings();
	selector.handleInput("\r");
	const body = selector
		.render(100)
		.map(line => Bun.stripANSI(line))
		.join("\n");
	expect(body).not.toContain("Enter to select");
	expect(body).toContain("Esc back · Enter change");
});
