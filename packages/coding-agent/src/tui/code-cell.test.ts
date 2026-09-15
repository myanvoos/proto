import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import { renderCodeCell, renderMarkdownCell } from "./code-cell";

initThemeSync();

test("sanitizes raw code-cell titles without stripping terminal-safe code", () => {
	const raw = renderCodeCell(
		{ code: "value", title: "Read \x1b]0;PWN\x07tail", status: "complete", width: 80 },
		theme,
	).join("\n");
	expect(raw).not.toContain("\x1b]0;");
	expect(raw).not.toContain("\x07");
	expect(raw).toContain("tail");
});

test("preserves trusted read title hyperlink and warning styling", () => {
	const hyperlink = "\x1b]8;id=read;file:///tmp/example\x1b\\example\x1b]8;;\x1b\\";
	const trustedTitle = `Read ${hyperlink} \x1b[2m(corrected)\x1b[22m`;
	const code = renderCodeCell(
		{ code: "value", title: trustedTitle, status: "complete", outputTrusted: true, width: 80 },
		theme,
	).join("\n");
	const markdown = renderMarkdownCell(
		{ content: "value", title: trustedTitle, status: "complete", outputTrusted: true, width: 80 },
		theme,
	).join("\n");
	expect(code).toContain(hyperlink);
	expect(code).toContain("\x1b[2m(corrected)\x1b[22m");
	expect(markdown).toContain(hyperlink);
});
