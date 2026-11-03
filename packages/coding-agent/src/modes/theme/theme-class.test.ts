import { describe, expect, test } from "bun:test";
import { SYMBOL_PRESETS } from "./symbols";
import { Theme } from "./theme-class";

const FG = { dim: "#777777", success: "#00ff00" };
const BG = new Proxy({} as Record<string, string>, { get: () => "#000000" });

function themeWithOverrides(overrides: Record<string, string>): Theme {
	return new Theme(FG as never, BG as never, "truecolor", "unicode", overrides as never);
}

describe("Theme symbol overrides", () => {
	test("rejects border glyphs that are not exactly one column wide", () => {
		const preset = SYMBOL_PRESETS.unicode;
		// Box borders are laid out with `repeat(innerWidth)` and `width - 2`, so a wide
		// or multi-char glyph renders a frame far wider than the requested width.
		const theme = themeWithOverrides({
			"boxRound.horizontal": "\u754C",
			"boxSharp.vertical": "ab",
			"tree.vertical": "",
			"progress.filled": "\u754C",
		});

		expect(theme.symbol("boxRound.horizontal")).toBe(preset["boxRound.horizontal"]);
		expect(theme.symbol("boxSharp.vertical")).toBe(preset["boxSharp.vertical"]);
		expect(theme.symbol("tree.vertical")).toBe(preset["tree.vertical"]);
		expect(theme.symbol("progress.filled")).toBe(preset["progress.filled"]);
	});

	test("accepts single-column border overrides and unconstrained symbol groups", () => {
		const theme = themeWithOverrides({
			"boxRound.horizontal": "=",
			"status.success": "[ok]",
		});

		expect(theme.symbol("boxRound.horizontal")).toBe("=");
		// `status.*` is inline text, not fixed-column layout, so multi-char stays allowed.
		expect(theme.symbol("status.success")).toBe("[ok]");
	});
});

describe("Theme nested foregrounds", () => {
	test("restores outer prose color after nested foreground and full resets", () => {
		const theme = themeWithOverrides({});
		const outer = theme.getFgAnsi("dim");
		const rendered = theme.fg("dim", `${theme.fg("success", "+2")} more\x1b[0m tail`);
		expect(rendered).toContain(`\x1b[39m${outer} more`);
		expect(rendered).toContain(`\x1b[0m${outer} tail`);
		expect(rendered.endsWith("\x1b[39m")).toBe(true);
	});

	test("omitted assistant prose color preserves terminal default", () => {
		const theme = themeWithOverrides({});
		expect(theme.hasColor("assistantMessageText")).toBe(false);
		expect(theme.fg("assistantMessageText", "prose")).toBe("\x1b[39mprose\x1b[39m");
	});
});
