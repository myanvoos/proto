import { expect, test } from "bun:test";
import { formatDuration } from "./format";

test("sub-second durations render whole milliseconds instead of floating-point noise", () => {
	expect(formatDuration(123.45600000001)).toBe("123ms");
});
