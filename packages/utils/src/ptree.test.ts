import { describe, expect, test } from "bun:test";
import { exec } from "./ptree";

describe("ptree child output limits", () => {
	test("kills a child that streams forever after stdout reaches the cap", async () => {
		const result = await exec(
			["sh", "-c", "while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"],
			{
				allowAbort: true,
				allowNonZero: true,
				maxStdoutBytes: 1024,
				maxStderrBytes: 1024,
			},
		);

		expect(result.ok).toBe(false);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
	});
});
