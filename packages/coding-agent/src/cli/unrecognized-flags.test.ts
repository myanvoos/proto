import { expect, test } from "bun:test";
import { parseArgs, reportUnrecognizedFlags } from "./args";

// Launchers that take a list of arguments forward `"--flag value"` as one token. The parser must keep
// that token whole, even when the value holds "=", so the report can show the exact split it needs.
test("a flag joined to a value is reported whole, with the two arguments it should have been", () => {
	const parsed = parseArgs(["--append-system-prompt use a=b"]);
	expect(parsed.unrecognizedFlags).toEqual(["--append-system-prompt use a=b"]);
	expect(parsed.appendSystemPrompt).toBeUndefined();

	let report = "";
	expect(reportUnrecognizedFlags(parsed, text => (report += text))).toBe(true);
	expect(report).toContain('"--append-system-prompt"');
	expect(report).toContain('"use a=b"');
});

test("whitespace after '=' still belongs to the value of a --flag=value argument", () => {
	const parsed = parseArgs(["--append-system-prompt=be concise"]);
	expect(parsed.appendSystemPrompt).toBe("be concise");
	expect(parsed.unrecognizedFlags).toEqual([]);
});
