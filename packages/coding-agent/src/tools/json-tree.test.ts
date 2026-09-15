import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import { formatArgsInline, renderJsonTreeLines } from "./json-tree";

initThemeSync();
const ANSI = /\u001b\[[0-9;]*m/g;

function plainLines(value: unknown, maxDepth = 4, maxLines = 50): string[] {
	return renderJsonTreeLines(value, theme, maxDepth, maxLines, 200).lines.map(line => line.replace(ANSI, ""));
}

test("top-level object keys get branch/last connectors like nested levels", () => {
	// Every top-level key previously rendered with the last-connector, so a
	// multi-key display() object showed a chain of └─ instead of a tree.
	const lines = plainLines({ hello: "world", nested: { deep: [1, 2] } });
	expect(lines[0]).toContain("├─");
	expect(lines[0]).toContain("hello");
	expect(lines[1]).toContain("└─");
	expect(lines[1]).toContain("nested");
});

test("single-key objects and arrays keep their tree shape", () => {
	const object = plainLines({ only: 1 });
	expect(object).toHaveLength(1);
	expect(object[0]).toContain("└─");
	const array = plainLines([1, 2, 3]);
	expect(array[0]).toContain("├─");
	expect(array[2]).toContain("└─");
});

test("sanitizes multiline values and keys before tree and inline rendering", () => {
	const hostileKey = "key\x1b]0;PWN\x07tail";
	const value = `first\nsecond\x1b]0;VALUE\x07visible\u009b\tend`;
	const tree = renderJsonTreeLines({ [hostileKey]: value }, theme, 4, 50, 200).lines;
	const inline = formatArgsInline({ [hostileKey]: value }, 200);

	for (const rendered of [...tree, inline]) {
		expect(rendered).not.toContain("\x1b]");
		expect(rendered).not.toContain("\x07");
	}
	expect(tree.join("\n")).toContain("keytail");
	expect(tree.join("\n")).toContain("visible");
	expect(inline).toContain("keytail=");
	expect(inline).toContain("visible");
});
