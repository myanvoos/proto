import { expect, test } from "bun:test";
import { XMLParser } from "./xml";

test("malformed end tags and stray markup parse instead of looping forever", () => {
	const parser = new XMLParser();
	expect(parser.parse("<p>text<br>more</p>")).toEqual({ p: { br: "more", "#text": "text" } });
	expect(parser.parse("</x>")).toEqual({});
	expect(parser.parse("<a><b></a>")).toEqual({ a: { b: "" } });
	expect(parser.parse("<a>x</b>y</a>")).toEqual({ a: "x" });
	expect(parser.parse("<a / >")).toEqual({ a: "" });
});
