import { describe, expect, it } from "bun:test";
import { splitIncompleteSixelTail } from "./sixel";

describe("splitIncompleteSixelTail", () => {
	it("keeps text without escape introducers intact", () => {
		expect(splitIncompleteSixelTail("plain output\nmore")).toEqual({ text: "plain output\nmore", heldTail: "" });
	});

	it("holds a trailing introducer still accumulating parameters", () => {
		const result = splitIncompleteSixelTail("ok\x1bP1;");
		expect(result.text).toBe("ok");
		expect(result.heldTail).toBe("\x1bP1;");
	});

	it("holds a trailing introducer whose payload has no terminator", () => {
		const result = splitIncompleteSixelTail("ok\x1bP0;1q#0;2;0#1;2;0");
		expect(result.text).toBe("ok");
		expect(result.heldTail).toBe("\x1bP0;1q#0;2;0#1;2;0");
	});

	it("does not hold a complete sixel sequence", () => {
		const complete = "a\x1bP0;1q#0;2;0\x1b\\";
		expect(splitIncompleteSixelTail(complete)).toEqual({ text: complete, heldTail: "" });
	});

	it("does not hold when a complete sequence precedes a later incomplete one", () => {
		const complete = "\x1bP0;1q#0;2;0\x1b\\";
		const result = splitIncompleteSixelTail(`${complete}text\x1bP0;1q#9`);
		expect(result.text).toBe(`${complete}text`);
		expect(result.heldTail).toBe("\x1bP0;1q#9");
	});

	it("ignores a non-sixel DCS introducer", () => {
		const text = "data\x1bP;other";
		expect(splitIncompleteSixelTail(text)).toEqual({ text, heldTail: "" });
	});
});
