import { describe, expect, test } from "bun:test";
import { latexToUnicode } from "./latex-to-unicode";

describe("latexToUnicode text styles", () => {
	test("renders text font commands as terminal attributes rather than math glyphs", () => {
		expect(latexToUnicode(String.raw`\textbf{x}`)).toBe("\x1b[1mx\x1b[22m");
		expect(latexToUnicode(String.raw`\textit{x}`)).toBe("\x1b[3mx\x1b[23m");
		expect(latexToUnicode(String.raw`\textsl{x}`)).toBe("\x1b[3mx\x1b[23m");
		expect(latexToUnicode(String.raw`\emph{x}`)).toBe("\x1b[3mx\x1b[23m");
	});

	test("restores enclosing attributes after nested text overrides", () => {
		expect(latexToUnicode(String.raw`\textbf{A\textmd{B}C}`)).toBe("\x1b[1mA\x1b[22mB\x1b[1mC\x1b[22m");
		expect(latexToUnicode(String.raw`\textit{A\textup{B}C}`)).toBe("\x1b[3mA\x1b[23mB\x1b[3mC\x1b[23m");
	});

	test("keeps attributes outside glyph transformations", () => {
		expect(latexToUnicode(String.raw`\hat{\textbf{x}}`)).toBe("\x1b[1mx̂\x1b[22m");
		expect(latexToUnicode(String.raw`\frac{\textbf{a}}{b}`)).toBe("\x1b[1ma\x1b[22m/b");
	});

	test("leaves unsupported terminal font fallbacks as plain text", () => {
		expect(latexToUnicode(String.raw`\texttt{x}\textsf{y}`)).toBe("xy");
	});
});
