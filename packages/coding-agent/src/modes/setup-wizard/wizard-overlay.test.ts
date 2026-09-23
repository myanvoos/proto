import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { initThemeSync, theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { providersSetupScene } from "./scenes/providers";
import { themeSetupScene } from "./scenes/theme";
import { SetupWizardComponent } from "./wizard-overlay";

let auth: AuthStorage;
let wizard: SetupWizardComponent;
let ctx: InteractiveModeContext;
let focus: Component | null;
const terminal = { rows: 24 };

beforeEach(async () => {
	initThemeSync();
	auth = await AuthStorage.create(":memory:");
	terminal.rows = 24;
	ctx = {
		settings: Settings.isolated(),
		session: { modelRegistry: { authStorage: auth, async refreshProvider() {} } },
		ui: {
			terminal,
			requestRender() {},
			setFocus(component: Component | null) {
				focus = component;
			},
		},
	} as unknown as InteractiveModeContext;
	wizard = new SetupWizardComponent(ctx, [providersSetupScene]);
	void wizard.run();
});

afterEach(() => {
	wizard.handleInput("\x03");
	wizard.dispose();
	auth.close();
	vi.restoreAllMocks();
});

const plain = (lines: readonly string[]) => lines.map(line => Bun.stripANSI(line));

test("resizing setup preserves the selected provider instead of showing only branding", () => {
	const providers = getOAuthProviders();
	const first = providers[0].name.split(" ")[0];
	const second = providers[1].name.split(" ")[0];
	for (const [width, height] of [
		[60, 24],
		[20, 6],
		[20, 3],
		[60, 1],
		[20, 10],
		[20, 24],
		[60, 24],
	]) {
		terminal.rows = height;
		const lines = wizard.render(width);
		expect(lines.length).toBe(height);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		expect(plain(lines).find(line => line.includes(theme.nav.cursor))).toContain(first);
		wizard.handleInput("\x1b[B");
		expect(plain(wizard.render(width)).find(line => line.includes(theme.nav.cursor))).toContain(second);
		wizard.handleInput("\x1b[A");
	}
});

test("both provider tabs render as bare lists, never a nested box", () => {
	for (const width of [20, 60, 100]) {
		terminal.rows = 24;
		for (const tab of ["sign-in", "web-search"]) {
			const lines = plain(wizard.render(width));
			expect(lines.some(line => line.includes(theme.boxRound.topLeft))).toBe(false);
			expect(lines.some(line => line.includes(theme.boxRound.bottomLeft))).toBe(false);
			expect(tab).toBeDefined();
			wizard.handleInput("\t");
		}
	}
});

test("the search hint never mimics a selectable row", () => {
	terminal.rows = 24;
	const lines = plain(wizard.render(60));
	const hint = lines.find(line => line.includes("type to search"));
	expect(hint?.trimStart().startsWith(theme.symbol("icon.search"))).toBe(true);
});

test("truncated descriptions end in an ellipsis instead of a severed word", () => {
	wizard.handleInput("\t");
	terminal.rows = 24;
	const lines = plain(wizard.render(60));
	const row = lines.find(line => line.includes(theme.nav.cursor) && line.includes("Auto"));
	expect(row).toContain("…");
	expect(row).not.toContain("configured web-search provider");
});

test("compact provider tabs retain mouse navigation after resizing", () => {
	wizard.render(60);
	terminal.rows = 6;
	const lines = plain(wizard.render(20));
	const tabRow = lines.findIndex(line => line.includes("Sign in"));
	expect(tabRow).toBeGreaterThanOrEqual(0);
	wizard.handleInput(`\x1b[<0;2;${tabRow + 1}M`);
	const switched = plain(wizard.render(20));
	expect(switched.join("\n")).toContain("Web search");
	expect(switched.find(line => line.includes(theme.nav.cursor))).toContain("Auto");
});

test("web search selection stays visible when setup has only one body row", () => {
	wizard.handleInput("\t");
	for (const height of [6, 1, 3, 10]) {
		terminal.rows = height;
		const lines = plain(wizard.render(20));
		expect(lines.find(line => line.includes(theme.nav.cursor))).toContain("Auto");
	}
});

test("theme setup yields its description to the active choice on short screens", () => {
	wizard.dispose();
	wizard = new SetupWizardComponent(ctx, [themeSetupScene]);
	void wizard.run();
	for (const height of [24, 6, 1, 3]) {
		terminal.rows = height;
		const lines = plain(wizard.render(20));
		expect(lines.find(line => line.includes(theme.nav.cursor))).toMatch(/Proto|Light|Match terminal|ANSI-safe/);
	}
});

test("OAuth code input remains visible ahead of login instructions on resize", () => {
	vi.spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
		await callbacks.onPrompt({ message: "Paste the returned code", placeholder: "Authorization code" });
	});
	wizard.handleInput("\r");
	focus?.handleInput?.("CODE042");
	for (const height of [24, 6, 1, 3]) {
		terminal.rows = height;
		expect(plain(wizard.render(20)).join("\n")).toContain("CODE042");
	}
});
