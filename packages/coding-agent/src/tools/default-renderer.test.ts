import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import { formatDefaultToolExecution } from "./default-renderer";

initThemeSync();

test("sanitizes extension labels before rendering the default status row", () => {
	const rendered = formatDefaultToolExecution(
		{
			label: "label\x1b]0;PWN\x07tail",
			args: {},
			options: { expanded: false, isPartial: false },
			result: { output: "ok" },
		},
		80,
		theme,
	);

	expect(rendered).not.toContain("\x1b]0;");
	expect(rendered).not.toContain("\x07");
	expect(rendered).toContain("labeltail");
});
