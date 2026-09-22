import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import { ChecklistTool } from "./checklist";
import { formatErrorDetail, formatErrorMessage } from "./render-utils";

initThemeSync();

const VALIDATION_MESSAGE = [
	'Validation failed for tool "monitor":',
	'  - op: op must be "start", "list" or "stop" (was "watch")',
	"",
	"Received arguments:",
	"{",
	'  "op": "watch"',
	"}",
].join("\n");

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("every line of a multi-line tool error carries the detail indent", () => {
	const rows = strip(formatErrorDetail(VALIDATION_MESSAGE, theme)).split("\n");
	const nonBlank = rows.filter(row => row.trim().length > 0);
	expect(nonBlank.length).toBeGreaterThan(3);
	for (const row of nonBlank) {
		expect(row.startsWith("  ")).toBe(true);
	}
	// The message's own bullet indent survives on top of the detail indent.
	expect(rows.some(row => row.startsWith("    - op:"))).toBe(true);
});

test("a multi-line tool error is not truncated as if it were one line", () => {
	const detail = strip(formatErrorDetail(VALIDATION_MESSAGE, theme));
	expect(detail).toContain("Received arguments:");
	expect(detail).toContain('"op": "watch"');
});

test("the single-line error headline stays on one row", () => {
	const headline = formatErrorMessage(VALIDATION_MESSAGE, theme);
	expect(headline.includes("\n")).toBe(false);
});

test("an empty error still reports something", () => {
	expect(strip(formatErrorDetail("", theme)).trim()).toBe("Unknown error");
});

test("a bad checklist op names the operations the tool accepts", async () => {
	const session = {
		getChecklistPhases: () => [],
		setChecklistPhases: () => {},
		getSessionFile: () => undefined,
	} as unknown as ToolSession;
	const result = await new ChecklistTool(session).execute("call-1", { op: "create", items: ["a"] } as never);
	const text = result.content.find(content => content.type === "text")?.text ?? "";

	for (const op of ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"]) {
		expect(text).toContain(`"${op}"`);
	}
	expect(text).not.toContain("op must be operation to apply");
});
