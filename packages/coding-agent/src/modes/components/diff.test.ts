import { expect, test } from "bun:test";
import { capEventDiff } from "../../utils/diff";
import { createTheme, getBuiltinThemes } from "../theme/loader";
import { initThemeSync } from "../theme/theme";
import { renderDiff } from "./diff";

initThemeSync();

function stripSgr(value: string): string {
	return value.replace(/\x1b\[[0-9;:]*m/gu, "");
}

test("preserves leading-tab indentation markers for intra-line replacements", () => {
	const output = stripSgr(renderDiff("-1|\told\n+1|\tnew"));
	expect(output).toContain("-1│ → old");
	expect(output).toContain("+│ → new");
});

test("renders diff colors from the supplied theme", () => {
	const base = getBuiltinThemes().dark;
	const json = structuredClone(base);
	json.colors = { ...json.colors, toolDiffRemoved: "#ff0000", toolDiffAdded: "#00ff00" };
	const customTheme = createTheme(json, { mode: "256color" });
	const output = renderDiff("-1|old\n+1|new", { theme: customTheme });

	expect(output).toContain(customTheme.getFgAnsi("toolDiffRemoved"));
	expect(output).toContain(customTheme.getFgAnsi("toolDiffAdded"));
});

test("an added line keeps its number when an unrelated removal shares it", () => {
	const output = stripSgr(renderDiff("-3|old three\n-4|old four\n+4|new four\n+5|new five"));

	// Only a one-line-for-one-line replacement borrows the removed row's
	// number; a two-line block prints every number it has.
	expect(output.split("\n")).toEqual(["  -3│old three", "  -4│old four", "  +4│new four", "  +5│new five"]);
});

test("a truncated whole-file rewrite renders additions, not just deletions", () => {
	const before = Array.from({ length: 1200 }, (_, index) => `const before${index} = ${index};`).join("\n");
	const after = Array.from({ length: 1200 }, (_, index) => `const after${index} = ${index * 2};`).join("\n");
	const capped = capEventDiff(before, after);

	expect(capped?.diffTruncated).toBe(true);
	const rows = stripSgr(renderDiff(capped?.diff ?? "")).split("\n");
	expect(rows.filter(row => row.trimStart().startsWith("-")).length).toBeGreaterThan(0);
	expect(rows.filter(row => row.trimStart().startsWith("+")).length).toBeGreaterThan(0);
	// The elision is disclosed where it happens, between the two sides.
	const marker = rows.findIndex(row => row.includes("diff lines omitted"));
	expect(marker).toBeGreaterThan(0);
	expect(rows[marker - 1].trimStart().startsWith("-")).toBe(true);
	expect(rows[marker + 1].trimStart().startsWith("+")).toBe(true);
});
