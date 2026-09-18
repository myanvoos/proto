import { expect, test } from "bun:test";
import { OmpTypeError, type } from "./index";

test("quoted literal parsing decodes escapes and rejects a trailing escape", () => {
	const escapedBackslash = type(String.raw`'a\\b'`);
	expect(escapedBackslash.allows(String.raw`a\b`)).toBe(true);
	expect(escapedBackslash.allows(String.raw`a\\b`)).toBe(false);
	expect(() => type(String.raw`'trailing\'`)).toThrow(OmpTypeError);
});
