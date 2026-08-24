import { describe, expect, it } from "bun:test";
import { getBuiltinThemes, loadThemeSync } from "../src/modes/theme/loader";
import type { Theme } from "../src/modes/theme/theme-class";

const QUIET_TOKENS = ["sessionAccent", "modeAccent", "shareAccent", "infoAccent", "matchHighlight", "link"] as const;

describe("theme loader quiet token backfill", () => {
	it("resolves quiet tokens on builtins whose JSON omits them", () => {
		const omitting = Object.entries(getBuiltinThemes()).filter(([, json]) => {
			const colors = json.colors as Record<string, unknown>;
			return QUIET_TOKENS.some(token => colors[token] === undefined);
		});
		expect(omitting.length).toBeGreaterThan(0);

		let checked = 0;
		for (const [name] of omitting) {
			let theme: Theme | undefined;
			try {
				theme = loadThemeSync(name);
			} catch {
				continue;
			}
			checked++;
			for (const token of QUIET_TOKENS) {
				expect(theme.fg(token, "x")).toContain("x");
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("backs titanium modeAccent down to accent", () => {
		const theme = loadThemeSync("titanium");
		expect(theme.getColorHex("modeAccent").toLowerCase()).toBe(theme.getColorHex("accent").toLowerCase());
		expect(theme.getColorHex("sessionAccent").toLowerCase()).toBe(theme.getColorHex("accent").toLowerCase());
	});

	it("backs titanium link down to mdLink", () => {
		const theme = loadThemeSync("titanium");
		expect(theme.getColorHex("link").toLowerCase()).toBe(theme.getColorHex("mdLink").toLowerCase());
	});

	it("prefers explicit quiet token values over the fallbacks", () => {
		const dark = loadThemeSync("dark");
		expect(dark.getColorHex("shareAccent").toLowerCase()).toBe("#4a84c9");
	});
});
