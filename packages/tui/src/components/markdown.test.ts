import { describe, expect, test } from "bun:test";
import type { SymbolTheme } from "../symbols";
import { Markdown, type MarkdownTheme } from "./markdown";

const symbols: SymbolTheme = {
	cursor: ">",
	inputCursor: ">",
	boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: ">",
	hrChar: "-",
	spinnerFrames: ["-"],
};

function identity(text: string): string {
	return text;
}

const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
	symbols,
};

describe("Markdown reference links", () => {
	test("renders prototype-label references as literal text instead of crashing", () => {
		for (const label of ["constructor", "toString", "valueOf", "isPrototypeOf"]) {
			const output = new Markdown(`[x][${label}]`, 0, 0, theme).render(80).join("\n").trimEnd();
			expect(output).toBe(`[x][${label}]`);
			expect(output).not.toContain("\x1b]8;;");
		}
	});

	test("does not turn a __proto__ reference into a hyperlink", () => {
		const output = new Markdown("[x][__proto__]", 0, 0, theme).render(80).join("\n");
		expect(output).toContain("proto");
		expect(output).not.toContain("\x1b]8;;");
	});
});
