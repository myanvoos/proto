import { expect, test } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { setTerminalHyperlinks, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Settings } from "../config/settings";
import { getMarkdownTheme, initThemeSync } from "../modes/theme/theme";
import { safeHyperlinkUri, urlHyperlinkAlways } from "./hyperlink";

await Settings.init();
initThemeSync();

test("a URI carrying a C1 control is rejected by the safety guard", () => {
	// \x9c is the C1 ST: inside an OSC 8 payload it would terminate the
	// sequence early and inject the remainder as raw terminal input.
	expect(safeHyperlinkUri("https://example.invalid/\x9cpayload")).toBeUndefined();
	expect(safeHyperlinkUri("https://example.invalid/\x1b]0;x\x07")).toBeUndefined();
	expect(safeHyperlinkUri("https://example.invalid/ok")).toBe("https://example.invalid/ok");
});

test("a clean URI is wrapped with the display text", () => {
	const result = urlHyperlinkAlways("https://example.invalid/x", "link");
	expect(result).toContain("https://example.invalid/x");
	expect(result).toContain("link");
});

test("the tui.hyperlinks setting gates OSC 8 on rendered Markdown links", () => {
	const detected = TERMINAL.hyperlinks;
	const scoped = Settings.isolated();
	const render = () => new Markdown("see [docs](https://example.invalid/docs)", 0, 0, getMarkdownTheme()).render(80);
	try {
		scoped.set("tui.hyperlinks", "off");
		expect(render().join("\n")).not.toContain("\x1b]8;");
		scoped.set("tui.hyperlinks", "always");
		expect(render().join("\n")).toContain("\x1b]8;");
	} finally {
		setTerminalHyperlinks(detected);
	}
});
