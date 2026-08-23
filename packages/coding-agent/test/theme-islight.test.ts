import { describe, expect, it } from "bun:test";
import { getThemeByName, isLightTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("Theme.isLight", () => {
	it("classifies built-in themes by their status-line surface", async () => {
		// porcelain styles a dark chat bubble (userMessageBg) on an otherwise-light
		// theme with a light status line. Session accents render on the status line,
		// so it must read as light — classifying by userMessageBg got this wrong.
		expect((await getThemeByName("porcelain"))?.isLight).toBe(true);
		expect((await getThemeByName("light-catppuccin"))?.isLight).toBe(true);
		expect((await getThemeByName("dark-catppuccin"))?.isLight).toBe(false);
	});

	it("exposes the status-line surface luminance for accent sizing", async () => {
		const light = await getThemeByName("light-catppuccin");
		const dark = await getThemeByName("dark-catppuccin");
		// Light themes hand the real surface luminance to getSessionAccentHex...
		expect(light?.accentSurfaceLuminance).toBeGreaterThan(0.5);
		// ...dark themes pass undefined so accents stay vivid.
		expect(dark?.accentSurfaceLuminance).toBeUndefined();
	});
});

describe("isLightTheme (standalone)", () => {
	// Regression for #2516: the standalone helper used to classify on
	// userMessageBg, mismatching Theme.isLight (statusLineBg). porcelain is the
	// canonical mismatch (dark bubble, light status line); sandstone/limestone
	// exercise the custom-light path.
	it.each([
		["sandstone", true],
		["limestone", true],
		["porcelain", true],
		["light", true],
		["dark", false],
		["dark-catppuccin", false],
	])("classifies %s as isLight=%s", (name, expected) => {
		expect(isLightTheme(name)).toBe(expected);
	});
});
