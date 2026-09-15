import { expect, test } from "bun:test";
import { Settings } from "../config/settings";
import { safeHyperlinkUri, urlHyperlinkAlways } from "./hyperlink";

await Settings.init();

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
