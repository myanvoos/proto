import { beforeEach, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { HistoryEntry, HistoryStorage } from "../../session/history-storage";
import { initThemeSync, theme } from "../theme/theme";
import { HistorySearchComponent } from "./history-search";

beforeEach(() => initThemeSync());
const entries: HistoryEntry[] = Array.from({ length: 20 }, (_, i) => ({
	id: i + 1,
	prompt: `/record ${String(i).padStart(2, "0")} 漢字🙂 é 🧑🏽‍🚀 long label\nsecond line`,
	created_at: 0,
}));
function setup(results = entries) {
	// Deterministic read-only storage boundary; no process-wide HistoryStorage singleton/profile changes.
	const storage = {
		getRecent: (limit: number) => results.slice(0, limit),
		search: (query: string, limit: number) => results.filter(entry => entry.prompt.includes(query)).slice(0, limit),
	} as HistoryStorage;
	const selected: string[] = [];
	let cancelled = false;
	const history = new HistorySearchComponent(
		storage,
		prompt => selected.push(prompt),
		() => {
			cancelled = true;
		},
	);
	return { history, selected, cancelled: () => cancelled };
}
const plain = (lines: readonly string[]) => lines.map(line => Bun.stripANSI(line));

for (const height of [2, 3, 4, 6, 10, 15]) {
	test(`history shows query and selected matching result within ${height} rows`, () => {
		const { history, selected } = setup();
		history.setMaxHeight(height);
		history.handleInput("07");
		const lines = history.render(20);
		expect(lines.length).toBeLessThanOrEqual(height);
		expect(plain(lines).some(line => line.includes("> 07"))).toBe(true);
		expect(plain(lines).some(line => line.includes(`${theme.nav.cursor} /record 07`))).toBe(true);
		history.handleInput("\r");
		expect(selected).toEqual([entries[7].prompt]);
	});
}
for (const width of [0, 1, 2, 3, 4, 5, 8, 12, 20, 40]) {
	test(`Unicode history rows stay within ${width} columns`, () => {
		const { history } = setup([{ id: 1, created_at: 0, prompt: "🧑🏽‍🚀 é 漢字🙂 🧑🏽‍🚀 long" }]);
		history.setMaxHeight(6);
		expect(history.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
		history.handleInput("missing");
		expect(history.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
	});
}
test("navigation follows the visible window, including End, paging and height shrink", () => {
	const { history, selected } = setup();
	history.setMaxHeight(15);
	history.handleInput("\x1b[F");
	expect(plain(history.render(20)).some(line => line.includes(`${theme.nav.cursor} /record 19`))).toBe(true);
	history.setMaxHeight(2);
	expect(plain(history.render(20)).some(line => line.includes(`${theme.nav.cursor} /record 19`))).toBe(true);
	history.handleInput("\x1b[5~");
	expect(plain(history.render(20)).some(line => line.includes(`${theme.nav.cursor} /record 18`))).toBe(true);
	history.handleInput("\x1b[H");
	history.render(20);
	history.handleInput("\x1b[6~");
	expect(plain(history.render(20)).some(line => line.includes(`${theme.nav.cursor} /record 01`))).toBe(true);
	history.handleInput("\x1b[B");
	history.handleInput("\x1b[A");
	history.handleInput("\r");
	expect(selected).toEqual([entries[1].prompt]);
});
test("empty search is visible and cannot accept a stale result; Escape cancels", () => {
	const { history, selected, cancelled } = setup();
	history.setMaxHeight(3);
	history.handleInput("missing");
	const lines = plain(history.render(40));
	expect(lines.some(line => line.includes("> missing"))).toBe(true);
	expect(lines.some(line => line.includes("No matching history"))).toBe(true);
	history.handleInput("\r");
	expect(selected).toEqual([]);
	history.handleInput("\x1b");
	expect(cancelled()).toBe(true);
});
test("a single available row preserves the actionable result instead of empty chrome", () => {
	const { history, selected } = setup();
	history.setMaxHeight(1);
	expect(plain(history.render(20))).toHaveLength(1);
	expect(plain(history.render(20))[0]).toContain(`${theme.nav.cursor} /record 00`);
	history.handleInput("\r");
	expect(selected).toEqual([entries[0].prompt]);
});

test("narrow history preserves the matching label before timestamp metadata", () => {
	const { history } = setup([
		{ id: 1, prompt: "/record beta 🧑🏽‍🚀 history long label", created_at: Math.floor(Date.now() / 1000) - 125 },
	]);
	history.setMaxHeight(3);
	history.handleInput("beta");
	expect(plain(history.render(20)).some(line => line.includes(`${theme.nav.cursor} /record beta`))).toBe(true);
});

for (const height of [1, 2, 3, 4, 5, 6, 10, 15]) {
	test(`history query and results use a complete frame or no frame at ${height} rows`, () => {
		const { history } = setup();
		history.setMaxHeight(height);
		const lines = plain(history.render(20));
		expect(lines.length).toBeLessThanOrEqual(height);
		if (height < 4)
			expect(
				lines.some(line => line.startsWith(theme.boxRound.topLeft) || line.startsWith(theme.boxRound.vertical)),
			).toBe(false);
		else {
			expect(lines[0].startsWith(theme.boxRound.topLeft)).toBe(true);
			expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
		}
		expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("/record 00"))).toBe(true);
	});
}
