import { expect, test } from "bun:test";
import { MAX_TINY_MESSAGE_CHARS, preprocessTinyMessage } from "./message-preproc";

test("pathological unclosed tags are windowed while preserving leading request and final constraint", () => {
	const result = preprocessTinyMessage(
		`Investigate parser regression\n${"<Tag>".repeat(100_000)}\nPreserve final constraint`,
	);
	expect(result.length).toBeLessThanOrEqual(MAX_TINY_MESSAGE_CHARS);
	expect(result).toContain("Investigate parser regression");
	expect(result).toContain("Preserve final constraint");
});
