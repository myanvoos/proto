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
