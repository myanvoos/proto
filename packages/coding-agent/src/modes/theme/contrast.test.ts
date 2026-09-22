import { expect, test } from "bun:test";
import { colorLuma, hexToHsv } from "@oh-my-pi/pi-utils";
import { resolveThemeColors } from "./color";
import { CANONICAL_BACKGROUND, contrastRatio, liftToContrast, READABILITY_FLOORS } from "./contrast";
import { createTheme, getBuiltinThemes } from "./loader";
import type { ThemeColor } from "./schema";

/** Bundled themes whose palette is fixed in the JSON rather than lifted at load. */
const SHIPPED_AT_THE_FLOOR = ["proto", "light", "dark"];

test("every bundled theme loads", () => {
	const themes = Object.entries(getBuiltinThemes());
	expect(themes.length).toBeGreaterThan(50);
	for (const [name, json] of themes) {
		// A theme that throws here is a theme the user cannot select at all.
		expect(() => createTheme(json, { mode: "truecolor" }), name).not.toThrow();
	}
});

test("every bundled theme meets the readability floors", () => {
	const misses: string[] = [];
	for (const [name, json] of Object.entries(getBuiltinThemes())) {
		const theme = createTheme(json, { mode: "truecolor" });
		const background = theme.isLight ? CANONICAL_BACKGROUND.light : CANONICAL_BACKGROUND.dark;
		for (const [role, floor] of Object.entries(READABILITY_FLOORS)) {
			const ratio = contrastRatio(theme.getColorHex(role as ThemeColor), background);
			if (ratio + 0.005 < floor) misses.push(`${name}.${role} ${ratio.toFixed(2)} < ${floor}`);
		}
	}
	expect(misses).toEqual([]);
});

test.each(SHIPPED_AT_THE_FLOOR)("%s ships at the floor instead of relying on the load-time lift", name => {
	const json = getBuiltinThemes()[name]!;
	// Resolve the palette exactly as it is written, with no correction applied.
	const resolved = resolveThemeColors(json.colors, json.vars ?? {});
	const luma = colorLuma(resolved.statusLineBg ?? "");
	const background = luma !== undefined && luma > 0.5 ? CANONICAL_BACKGROUND.light : CANONICAL_BACKGROUND.dark;
	for (const [role, floor] of Object.entries(READABILITY_FLOORS)) {
		const value = resolved[role as keyof typeof resolved];
		if (typeof value !== "string" || !value.startsWith("#")) continue;
		expect(contrastRatio(value, background), `${name}.${role}`).toBeGreaterThanOrEqual(floor - 0.005);
	}
});

test("a lift clears the floor while keeping the colour recognisable", () => {
	for (const [color, background, floor] of [
		["#2b2825", CANONICAL_BACKGROUND.dark, 4.5],
		["#5C616A", CANONICAL_BACKGROUND.dark, 4.5],
		["#8c8fa1", CANONICAL_BACKGROUND.light, 4.5],
		["#fe640b", CANONICAL_BACKGROUND.light, 4.5],
		["#1a1816", CANONICAL_BACKGROUND.dark, 1.5],
	] as const) {
		const lifted = liftToContrast(color, background, floor);
		expect(contrastRatio(lifted, background), color).toBeGreaterThanOrEqual(floor - 0.005);
		// Hue is the theme's identity; only lightness pays for the correction.
		// Near-greys are excluded because 8-bit rounding, not the lift, decides
		// their hue: one unit of red in #1a1816 swings it by degrees.
		const before = hexToHsv(color);
		const after = hexToHsv(lifted);
		if (before.s > 0.25) expect(Math.abs(after.h - before.h), color).toBeLessThan(2);
		// The correction is the smallest one that works: undo a tenth of it and
		// the colour falls back under its floor.
		const overshoot = contrastRatio(lifted, background) - floor;
		expect(overshoot, color).toBeLessThan(0.5);
	}
});

test("a colour already above its floor is returned untouched", () => {
	expect(liftToContrast("#FAFAFA", CANONICAL_BACKGROUND.dark, 4.5)).toBe("#FAFAFA");
	expect(liftToContrast("#111111", CANONICAL_BACKGROUND.light, 4.5)).toBe("#111111");
});

test("colours the terminal owns are never rewritten", () => {
	const json = structuredClone(getBuiltinThemes().proto!);
	// "" means the terminal's default foreground and a number is an index into
	// the user's own palette: neither has a background this process can know.
	json.colors.muted = "";
	json.colors.dim = 240;
	const theme = createTheme(json, { mode: "truecolor" });
	expect(theme.getFgAnsi("dim")).toBe("\x1b[38;5;240m");
	expect(theme.getColorHex("muted")).toBe("#e5e5e7");
});

test("a hostile theme is lifted to the floor at load", () => {
	const json = structuredClone(getBuiltinThemes().proto!);
	json.colors.muted = "#0a0a0a";
	json.colors.syntaxComment = "#101010";
	json.colors.border = "#050505";
	const theme = createTheme(json, { mode: "truecolor" });
	for (const role of ["muted", "syntaxComment", "border"] as const) {
		expect(contrastRatio(theme.getColorHex(role), CANONICAL_BACKGROUND.dark), role).toBeGreaterThanOrEqual(
			READABILITY_FLOORS[role]! - 0.005,
		);
	}
});
