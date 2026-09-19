import { describe, expect, test } from "bun:test";
import { latexToBlock } from "./latex-block";
import { latexToUnicode } from "./latex-to-unicode";

describe("latexToBlock text styles", () => {
	test("preserves terminal bold across a stacked fraction", () => {
		expect(latexToBlock(String.raw`\textbf{\frac{a}{b}}`)).toEqual([
			" \x1b[1ma\x1b[22m ",
			"───",
			" \x1b[1mb\x1b[22m ",
		]);
	});
});

describe("latexToBlock environment name boundaries", () => {
	// Regression: environment scanning matched any control word whose name merely
	// starts with \begin/\end (e.g. \begingroup, \endhead) as an environment
	// delimiter, truncating the body and leaking the name tail ("group", "head")
	// into rendered text. TeX control words are maximal letter runs, so
	// \begin/\end match only when the next character is not a letter.
	test("\\end-prefixed commands do not close the environment", () => {
		expect(latexToBlock(String.raw`\begin{matrix}\endgroup a & b\end{matrix} TAIL`)).toEqual(["endgroup a  b TAIL"]);
		expect(latexToBlock(String.raw`\begin{matrix}a\endhead b\end{matrix} TAIL`)).toEqual(["aendhead b TAIL"]);
	});

	test("\\begin-prefixed commands do not open a nested environment", () => {
		expect(latexToBlock(String.raw`\begin{matrix}\begingroup a & b\end{matrix} TAIL`)).toEqual([
			"begingroup a  b TAIL",
		]);
	});

	test("matched \\begin/\\end still produce aligned matrix cells and rows", () => {
		expect(latexToBlock(String.raw`\begin{matrix}a & b\end{matrix}`)).toEqual(["a  b"]);
		expect(latexToBlock(String.raw`\begin{matrix}a\\b\end{matrix}`)).toEqual(["a", " ", "b"]);
	});
});

describe("latexToUnicode environment name boundaries", () => {
	// The inline renderer scanned for \end with a bare startsWith, so \endgroup closed the
	// environment early and its name tail plus the following raw argument character were eaten.
	test("keeps content after a control word that starts with \\end", () => {
		expect(latexToUnicode(String.raw`\begin{matrix}\endgroup a & b\end{matrix} TAIL`)).toContain("TAIL");
		expect(latexToUnicode(String.raw`\begin{matrix}a \endhead b\end{matrix} TAIL`)).toContain("b");
	});

	test("a real \\end still terminates the environment", () => {
		expect(latexToUnicode(String.raw`\begin{matrix}a & b\end{matrix} TAIL`)).toBe("a    b TAIL");
	});
});
