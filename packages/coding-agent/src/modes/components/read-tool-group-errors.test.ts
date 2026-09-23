import { expect, test } from "bun:test";
import { initThemeSync } from "../theme/theme";
import { ReadToolGroupComponent } from "./read-tool-group";

initThemeSync();

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderGroup(
	calls: Array<{ id: string; args: Record<string, unknown>; text: string; isError?: boolean }>,
): string[] {
	const group = new ReadToolGroupComponent({ requestRender: () => {} });
	for (const call of calls) {
		group.updateArgs(call.args as never, call.id);
		group.updateResult({ content: [{ type: "text", text: call.text }], isError: call.isError }, false, call.id);
	}
	return group.render(100).map(strip);
}

test("a failed read states why it failed", () => {
	const lines = renderGroup([{ id: "c1", args: { path: "/nope/missing.ts" }, text: "Path not found", isError: true }]);
	const joined = lines.join("\n");
	expect(joined).toContain("missing.ts");
	expect(joined).toContain("Path not found");
});

test("a non-string path still renders and still explains itself", () => {
	const lines = renderGroup([{ id: "c1", args: { path: 12345 }, text: "Path '12345' not found", isError: true }]);
	const joined = lines.join("\n");
	expect(joined).toContain("12345");
	expect(joined).toContain("not found");
});

test("a successful read does not gain an error line", () => {
	const lines = renderGroup([{ id: "c1", args: { path: "/tmp/ok.ts" }, text: "const a = 1;" }]);
	expect(lines.join("\n")).not.toContain("const a = 1;");
});

test("every failure in a multi-read group carries its own reason", () => {
	const lines = renderGroup([
		{ id: "c1", args: { path: "/a.ts" }, text: "boom a", isError: true },
		{ id: "c2", args: { path: "/b.ts" }, text: "boom b", isError: true },
	]);
	const joined = lines.join("\n");
	expect(joined).toContain("boom a");
	expect(joined).toContain("boom b");
});

test("a long failure reason is folded rather than dumped", () => {
	const reason = Array.from({ length: 12 }, (_, i) => `reason line ${i}`).join("\n");
	const lines = renderGroup([{ id: "c1", args: { path: "/a.ts" }, text: reason, isError: true }]);
	const joined = lines.join("\n");
	expect(joined).toContain("reason line 0");
	expect(joined).not.toContain("reason line 11");
	expect(joined).toContain("more line");
});
