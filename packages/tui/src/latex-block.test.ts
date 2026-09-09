import { describe, expect, test } from "bun:test";
import { latexToBlock } from "./latex-block";

describe("latexToBlock text styles", () => {
	test("preserves terminal bold across a stacked fraction", () => {
		expect(latexToBlock(String.raw`\textbf{\frac{a}{b}}`)).toEqual([
			" \x1b[1ma\x1b[22m ",
			"───",
			" \x1b[1mb\x1b[22m ",
		]);
	});
});
