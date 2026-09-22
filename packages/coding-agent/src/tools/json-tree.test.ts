import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import { formatArgsInline, renderJsonTreeLines } from "./json-tree";

initThemeSync();
const ANSI = /\u001b\[[0-9;]*m/g;

function plainLines(value: unknown, maxDepth = 4, maxLines = 50): string[] {
	return renderJsonTreeLines(value, theme, maxDepth, maxLines, 200, 200).lines.map(line => line.replace(ANSI, ""));
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
	const tree = renderJsonTreeLines({ [hostileKey]: value }, theme, 4, 50, 200, 200).lines;
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

test("narrow multiline Unicode values retain content and closing quotes across physical rows", () => {
	const tree = renderJsonTreeLines({ key: "日本語😀\ncontinuation" }, theme, 4, 50, 200, 8);
	const visible = tree.lines
		.map(line => line.replace(ANSI, ""))
		.join("")
		.replaceAll(" ", "");
	expect(visible).toContain('"日本語😀continuation"');
	expect(tree.truncated).toBe(false);
});

test("a value cut by the row cap ends with an explicit truncation marker", () => {
	const tree = renderJsonTreeLines({ result: "abcdefghijklmnopqrstuvwxyz" }, theme, 2, 2, 60, 10);
	expect(tree.truncated).toBe(true);
	const visible = tree.lines.map(line => line.replace(ANSI, ""));
	expect(visible.join("")).toContain("abc");
	expect(visible.at(-1)).toEndWith("…");
});
