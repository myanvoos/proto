import { expect, test } from "bun:test";
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
