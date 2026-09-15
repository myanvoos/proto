import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { sanitizeWithOptionalSixelPassthrough, splitIncompleteSixelTail } from "./sixel";

async function withSixelPassthrough<T>(fn: () => T | Promise<T>): Promise<T> {
	const previousProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const previousAllow = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
	try {
		return await fn();
	} finally {
		if (previousProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = previousProtocol;
		if (previousAllow === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = previousAllow;
	}
}

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

describe("sixel passthrough sanitization", () => {
	it("holds a trailing lone ESC that can begin a split DCS introducer", () => {
		expect(splitIncompleteSixelTail("before\x1b")).toEqual({ text: "before", heldTail: "\x1b" });
	});

	it("holds an incomplete sixel whose split point is the first ST byte", () => {
		expect(splitIncompleteSixelTail("before\x1bPqPAY\x1b")).toEqual({
			text: "before",
			heldTail: "\x1bPqPAY\x1b",
		});
	});

	it("holds a trailing ESC after a complete envelope", () => {
		const complete = "before\x1bPqPAY\x1b\\";
		expect(splitIncompleteSixelTail(`${complete}\x1b`)).toEqual({ text: complete, heldTail: "\x1b" });
	});

	it("neutralizes colliding PUA text and strips clipped placeholder fragments", async () => {
		await withSixelPassthrough(() => {
			const sequence = "\x1bPqPAY\x1b\\";
			const collidingText = "ordinary\uE000PROTO_SIXEL_0\uE001text";
			const restored = sanitizeWithOptionalSixelPassthrough(`${collidingText}${sequence}`, sanitizeText);
			expect(restored).toBe(`ordinaryPROTO_SIXEL_0text${sequence}`);
			expect(restored.match(/\x1bPqPAY\x1b\\/gu)).toHaveLength(1);

			const clipped = sanitizeWithOptionalSixelPassthrough(sequence, tokenized => tokenized.slice(0, -1));
			expect(clipped).toBe("");
			const headClipped = sanitizeWithOptionalSixelPassthrough(sequence, tokenized => tokenized.slice(1));
			expect(headClipped).toBe("");
		});
	});
});
