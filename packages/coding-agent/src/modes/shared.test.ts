import { expect, test } from "bun:test";
import { sanitizeHookStatusText } from "./shared";

test("hook statuses keep color but remove terminal commands and normalize visible whitespace", () => {
	const result = sanitizeHookStatusText("  \x1b[32mgreen\x1b[39m  \x1b]0;injected\x07red\n tail ");
	expect(Bun.stripANSI(result)).toBe("green red tail");
	expect(result).toContain("\x1b[32m");
	expect(result).not.toContain("\x1b]0;");
	expect(result.endsWith("\x1b[0m")).toBe(true);
});

test("hook statuses discard OSC links and C1 sequences without discarding their visible labels", () => {
	const result = sanitizeHookStatusText(
		"\x1b[1m\x1b]8;;https://example.invalid\x07docs\x1b]8;;\x07 \x9b31mred\x9b0m\x1b[22m",
	);
	expect(Bun.stripANSI(result)).toBe("docs red");
	expect(result).not.toContain("https:");
	expect(result).not.toContain("31mred");
});
