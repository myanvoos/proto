import { describe, expect, test } from "bun:test";
import { Lexer, Marked, type Token } from "./core";

function collectLinks(tokens: readonly Token[]): Token[] {
	const links: Token[] = [];
	for (const token of tokens) {
		if (token.type === "link") links.push(token);
		if ("tokens" in token && Array.isArray(token.tokens)) links.push(...collectLinks(token.tokens));
	}
	return links;
}

test("code spans close at backslash-preceded backticks but not longer runs", () => {
	const marked = new Marked();
	expect(marked.parse("`a\\`")).toBe("<p><code>a\\</code></p>\n");
	expect(marked.parse("`a``b`")).toBe("<p><code>a``b</code></p>\n");
});

test("Unicode line separators and invalid backtick fence info remain visible prose", () => {
	const marked = new Marked();
	expect(marked.parse("before\u2028after\u2029end")).toBe("<p>before\u2028after\u2029end</p>\n");
	expect(marked.parse("```bad`info\nbody")).not.toContain("<pre>");
	expect(marked.parse("```bad`info\nbody")).toContain("body");
});

describe("reference link labels", () => {
	for (const label of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
		test(`does not resolve inherited ${label} as a link definition`, () => {
			const source = `[text][${label}]`;
			expect(collectLinks(Lexer.lex(source))).toEqual([]);
			expect(new Marked().parse(source)).not.toContain("<a ");
		});
	}

	test("still resolves an own definition named constructor", () => {
		const tokens = collectLinks(Lexer.lex("[text][constructor]\n\n[constructor]: https://example.com"));
		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toMatchObject({ type: "link", href: "https://example.com" });
	});
});
