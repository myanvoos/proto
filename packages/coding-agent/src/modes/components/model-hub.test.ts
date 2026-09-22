import { beforeEach, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { initThemeSync, theme } from "../theme/theme";
import { ModelHubComponent } from "./model-hub";
import { ModelPickerComponent } from "./model-picker";

beforeEach(() => initThemeSync());
const models = Array.from({ length: 20 }, (_, index) =>
	buildModel({
		id: `model-${String(index).padStart(2, "0")}`,
		name: `Model ${index}`,
		provider: "offline-provider",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		contextWindow: 128_000,
		maxTokens: 4096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as never),
);
const scoped = models.map(model => ({ model }));
const registry = {} as ModelRegistry; // Scoped models never access the registry or network.
const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line));
const mouse = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`;
function setup(rows = 24) {
	const terminal = { rows };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const assignments: string[] = [];
	const hub = new ModelHubComponent(tui, Settings.isolated(), registry, scoped, {
		onAssign: model => assignments.push(model.id),
		onUnassign() {},
		onCancel() {},
	});
	return { hub, terminal, tui, assignments };
}
for (const width of [20, 32, 40, 60, 80]) {
	test(`model hub exposes the focused model at ${width} columns`, () => {
		const { hub } = setup();
		try {
			hub.render(width);
			hub.handleInput("\x1b[C");
			let lines = hub.render(width);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
			expect(plain(lines).some(line => line.includes(theme.nav.cursor) && line.includes("model-19"))).toBe(true);
			hub.handleInput("\x1b[B");
			lines = hub.render(width);
			expect(plain(lines).some(line => line.includes(theme.nav.cursor) && line.includes("model-18"))).toBe(true);
			hub.handleInput("\r");
			expect(plain(hub.render(width)).some(line => line.includes("["))).toBe(true);
		} finally {
			hub.dispose();
		}
	});
}
for (const rows of [1, 2, 3, 4, 6, 8, 12, 24]) {
	test(`model hub keeps selection through resize to ${rows} rows`, () => {
		const { hub, terminal } = setup();
		try {
			hub.render(32);
			hub.handleInput("\x1b[C");
			for (let i = 0; i < 15; i++) hub.handleInput("\x1b[B");
			terminal.rows = rows;
			const lines = hub.render(32);
			expect(lines.length).toBeLessThanOrEqual(rows);
			expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(rows >= 3);
			expect(plain(lines).some(line => line.includes(`${theme.nav.cursor} model-04`))).toBe(true);
		} finally {
			hub.dispose();
		}
	});
}
test("compact Enter opens scope before activating; mouse targets rendered models and chips", () => {
	const { hub, assignments } = setup();
	try {
		hub.render(32);
		hub.handleInput("\r");
		let lines = plain(hub.render(32));
		expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("model-19"))).toBe(true);
		expect(lines.some(line => line.includes("["))).toBe(false);
		const second = lines.findIndex(line => line.includes("model-18"));
		hub.handleInput(mouse(5, second));
		lines = plain(hub.render(32));
		expect(lines[second]).toContain(`${theme.nav.cursor} model-18`);
		hub.handleInput(mouse(5, second));
		lines = plain(hub.render(32));
		const footer = lines.findIndex(line => line.includes("["));
		expect(footer).toBeGreaterThan(0);
		hub.handleInput(mouse(5, footer));
		hub.render(32);
		expect(assignments).toEqual(["model-18"]);
	} finally {
		hub.dispose();
	}
});
test("compact mouse scope navigation and back header use displayed coordinates", () => {
	const { hub } = setup();
	try {
		let lines = plain(hub.render(32));
		const provider = lines.findIndex(line => line.includes("offline-provider"));
		hub.handleInput(mouse(5, provider));
		lines = plain(hub.render(32));
		expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("model-19"))).toBe(true);
		hub.handleInput(mouse(4, 0));
		expect(plain(hub.render(32)).some(line => line.includes("Enter open"))).toBe(true);
	} finally {
		hub.dispose();
	}
});
for (const rows of [1, 2, 3, 4, 6, 12]) {
	test(`session model picker keeps current model visible at ${rows} rows`, () => {
		const { hub, tui } = setup(rows);
		hub.dispose();
		const picks: string[] = [];
		const picker = new ModelPickerComponent(
			tui,
			Settings.isolated(),
			registry,
			scoped,
			{ onPick: model => picks.push(model.id), onCancel() {} },
			{ currentSelector: "offline-provider/model-15" },
		);
		const lines = picker.render(32);
		expect(lines.length).toBeLessThanOrEqual(rows);
		expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(rows >= 3);
		expect(plain(lines).some(line => line.includes(`${theme.nav.cursor} model-15`))).toBe(true);
		const selected = plain(lines).findIndex(line => line.includes(`${theme.nav.cursor} model-15`));
		picker.handleInput(mouse(5, selected));
		expect(picks).toEqual(["model-15"]);
	});
}

for (const rows of [4, 6]) {
	test(`compact roles retain the focused actionable role at ${rows} rows`, () => {
		const { hub } = setup(rows);
		try {
			hub.render(32);
			hub.handleInput("\x1b[A");
			hub.handleInput("\x1b[C");
			let lines = plain(hub.render(32));
			expect(lines.length).toBeLessThanOrEqual(rows);
			expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(rows >= 3);
			expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("DEFAULT"))).toBe(true);
			hub.handleInput("\r");
			hub.render(32);
			hub.handleInput("\x1b[C");
			lines = plain(hub.render(32));
			expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("model-"))).toBe(true);
		} finally {
			hub.dispose();
		}
	});
}

test("twenty-column model identification and selected role chip stay readable", () => {
	const model = buildModel({ ...models[0], id: "discovery-alpha", name: "Discovery Alpha" } as never);
	const terminal = { rows: 24 };
	const hub = new ModelHubComponent(
		{ terminal, requestRender() {} } as unknown as TUI,
		Settings.isolated(),
		registry,
		[{ model }],
		{ onAssign() {}, onUnassign() {}, onCancel() {} },
	);
	try {
		hub.render(20);
		hub.handleInput("\x1b[C");
		let lines = plain(hub.render(20));
		expect(lines.some(line => line.includes("discovery-alpha"))).toBe(true);
		expect(lines.some(line => line.includes("Enter · ← back"))).toBe(true);
		hub.handleInput("\r");
		lines = plain(hub.render(20));
		expect(lines.some(line => line.includes("[default]"))).toBe(true);
		hub.handleInput("\x1b[C");
		lines = plain(hub.render(20));
		expect(lines.some(line => line.includes("[smol]"))).toBe(true);
		expect(lines.every(line => visibleWidth(line) <= 20)).toBe(true);
	} finally {
		hub.dispose();
	}
});
