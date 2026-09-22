import { describe, expect, test } from "bun:test";
import { normalizeGeneratedTitle, stripTitleMarkdown } from "./text";

describe("stripTitleMarkdown", () => {
	test.each([
		["## Section 0", "Section 0"],
		["# Heading", "Heading"],
		["###### Deep heading", "Deep heading"],
		["# Closed heading #", "Closed heading"],
		["**Bold title**", "Bold title"],
		["*Emphasised title*", "Emphasised title"],
		["***Both***", "Both"],
		["_italic_ title", "italic title"],
		["__strong__ title", "strong title"],
		["`code title`", "code title"],
		["~~struck~~ title", "struck title"],
		["- Bullet title", "Bullet title"],
		["+ Plus bullet title", "Plus bullet title"],
		["1. Ordered title", "Ordered title"],
		["2) Paren ordered title", "Paren ordered title"],
		["> Quoted title", "Quoted title"],
		["> - **Nested markers**", "Nested markers"],
		["Fix the [parser](https://x.dev/y)", "Fix the parser"],
		["[**label**](u)", "label"],
		["![alt text](img.png)", "alt text"],
		["[ref label][1]", "ref label"],
		["<https://example.com/x>", "https://example.com/x"],
		["\\# not a heading", "# not a heading"],
	])("strips markdown from %p", (input, expected) => {
		expect(stripTitleMarkdown(input)).toBe(expected);
	});

	// Names that merely contain markdown punctuation must survive verbatim:
	// markdown requires structural whitespace or paired delimiters, and so do we.
	test.each([
		["C# refactor"],
		["Fix #123 crash"],
		["1.5 release notes"],
		["snake_case_name fix"],
		["_private_method rename"],
		["2**8 bytes budget"],
		["a * b * c product"],
		["Use *args and **kwargs"],
		[">>= operator support"],
		["-- flag parsing"],
		["a->b mapping fix"],
		["Plain ordinary title"],
	])("leaves %p untouched", input => {
		expect(stripTitleMarkdown(input)).toBe(input);
	});

	test("is idempotent", () => {
		const once = stripTitleMarkdown("> - **Fix the [parser](u)**");
		expect(once).toBe("Fix the parser");
		expect(stripTitleMarkdown(once)).toBe(once);
	});
});

describe("normalizeGeneratedTitle", () => {
	test("a markdown heading reply becomes a plain title", () => {
		expect(normalizeGeneratedTitle("## Section 0")).toBe("Section 0");
		expect(normalizeGeneratedTitle("# Heading")).toBe("Heading");
	});

	test("markdown is stripped before quotes, tags and trailing punctuation", () => {
		expect(normalizeGeneratedTitle('"## Quoted heading"')).toBe("Quoted heading");
		expect(normalizeGeneratedTitle("<title>## Tagged</title>")).toBe("Tagged");
		expect(normalizeGeneratedTitle("**Repair the streaming parser.**")).toBe("Repair the streaming parser");
	});

	test("markers alone carry no title", () => {
		expect(normalizeGeneratedTitle("#")).toBeNull();
		expect(normalizeGeneratedTitle("```")).toBeNull();
	});

	test("length limits are measured on the stripped title, not the markers", () => {
		const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
		expect(normalizeGeneratedTitle(`## ${words}`)).toBe(words);
	});

	test("casing reconciliation still runs after stripping", () => {
		expect(normalizeGeneratedTitle("## Fix the parseJson helper", "fix the parseJson helper")).toBe(
			"Fix the parseJson helper",
		);
	});
});
