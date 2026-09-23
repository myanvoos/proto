import { afterEach, expect, test } from "bun:test";
import { Settings } from "../../../config/settings";
import { getTabBarTheme } from "../../shared";
import { initThemeSync, theme } from "../../theme/theme";
import { ExtensionDashboard } from "./extension-dashboard";

const settings = await Settings.init({ inMemory: true });
initThemeSync();

const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
afterEach(() => {
	if (stdoutRows) Object.defineProperty(process.stdout, "rows", stdoutRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

interface DashboardLayout {
	lines: string[];
	tabRows: string[];
	bodyRows: number;
}

async function layout(width: number, height: number): Promise<DashboardLayout> {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
	const dashboard = await ExtensionDashboard.create(process.cwd(), settings, height);
	const lines = dashboard.render(width).map(line => Bun.stripANSI(line));
	const dividers = lines.flatMap((line, index) => (line.includes(theme.boxRound.teeRight) ? [index] : []));
	const first = dividers[0];
	// The strip sits between the title and the first divider; the body follows it.
	const tabRows = first === undefined ? [] : lines.slice(1, first);
	const bodyStart = first === undefined ? 1 : first + 1;
	const bodyEnd = dividers[1] ?? lines.length - 2;
	return { lines, tabRows, bodyRows: Math.max(0, bodyEnd - bodyStart) };
}

/** Inner rows the dialog has to divide between the strip, the body and its divider. */
function innerRows(height: number): number {
	return height - 3;
}

test.each([
	[40, 10],
	[40, 12],
	[40, 14],
	[40, 16],
	[40, 18],
	[40, 24],
	[60, 18],
	[60, 30],
	[80, 24],
	[100, 40],
])("the provider strip keeps its rows and the body at %ix%i", async (width, height) => {
	const { lines, tabRows, bodyRows } = await layout(width, height);
	expect(lines.length).toBeLessThanOrEqual(height);
	for (const line of lines) expect(Bun.stringWidth(line)).toBe(width);
	// Neither half may be starved: the strip stays on screen and the body keeps
	// the three rows that make the extension list usable.
	expect(tabRows.length).toBeGreaterThanOrEqual(1);
	expect(tabRows.length).toBeLessThanOrEqual(Math.ceil(innerRows(height) / 3));
	expect(bodyRows).toBeGreaterThanOrEqual(3);
});

test("wrapped provider rows all start in the same column", async () => {
	const { tabRows } = await layout(40, 24);
	expect(tabRows.length).toBeGreaterThan(1);
	const indents = tabRows.map(line => line.replace(theme.boxRound.vertical, "").search(/\S/));
	expect(new Set(indents).size).toBe(1);
});

test("the strip scrolls to the provider it activates instead of hiding it", async () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 18 });
	const dashboard = await ExtensionDashboard.create(process.cwd(), settings, 18);
	// Styling is how a strip marks its active tab, so that is how the test finds it.
	const activeStyle = getTabBarTheme().activeTab("\u0000").split("\u0000")[0]!;
	expect(activeStyle.length).toBeGreaterThan(0);
	const activeLabel = (): string => {
		const rendered = dashboard.render(40);
		const plain = rendered.map(line => Bun.stripANSI(line));
		const divider = plain.findIndex(line => line.includes(theme.boxRound.teeRight));
		const strip = rendered.slice(1, divider === -1 ? 1 : divider);
		expect(strip.length).toBeGreaterThanOrEqual(1);
		expect(strip.length).toBeLessThanOrEqual(Math.ceil(innerRows(18) / 3));
		const active = strip.filter(line => line.includes(activeStyle));
		expect(active).toHaveLength(1);
		return Bun.stripANSI(active[0]!).trim();
	};
	const seen = new Set<string>([activeLabel()]);
	// Walk the provider list; every step must keep its own tab on screen.
	for (let step = 0; step < 12; step++) {
		dashboard.handleInput("\x1b[C");
		seen.add(activeLabel());
	}
	// A strip that simply stopped scrolling would keep answering with one row.
	expect(seen.size).toBeGreaterThan(2);
});
