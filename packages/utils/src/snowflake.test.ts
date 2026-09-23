import { expect, test } from "bun:test";
import { Snowflake } from "./snowflake";

test("bounds outside the 42-bit timestamp field saturate to valid snowflakes", () => {
	const beforeEpoch = Snowflake.lowerbound(0);
	const pastRange = Snowflake.upperbound(Snowflake.EPOCH_TIMESTAMP + 2 ** 43);
	expect(beforeEpoch as string).toBe("0000000000000000");
	expect(pastRange as string).toBe("ffffffffffffffff");
	expect(Snowflake.valid(beforeEpoch) && Snowflake.valid(pastRange)).toBe(true);
	expect(Snowflake.getTimestamp(Snowflake.lowerbound(Snowflake.EPOCH_TIMESTAMP + 1234))).toBe(
		Snowflake.EPOCH_TIMESTAMP + 1234,
	);
});
