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

function expandedResult(output: string): string {
	return Bun.stripANSI(
		formatDefaultToolExecution(
			{
				label: "Device",
				args: {},
				options: { expanded: true, isPartial: false },
				result: { output },
			},
			100,
			theme,
		),
	);
}

test("expanded generic cards preserve unsafe integer digits and result metadata-named keys", () => {
	expect(expandedResult('{"id":9007199254740993}')).toContain("9007199254740993");
	const rendered = expandedResult('{"i":"result intent","__partialJson":"result data"}');
	expect(rendered).toContain("result intent");
	expect(rendered).toContain("result data");
});

test("expanded generic cards fall back to raw JSON when depth or scalar limits would hide data", () => {
	const scalar = "detail".repeat(2000);
	expect(expandedResult(JSON.stringify({ message: scalar })).replaceAll("\n", "")).toContain(scalar);
	const nested = { a: { b: { c: { d: { e: { f: { g: { h: { visibleTail: "FINISH" } } } } } } } } };
	expect(expandedResult(JSON.stringify(nested))).toContain("FINISH");
});
