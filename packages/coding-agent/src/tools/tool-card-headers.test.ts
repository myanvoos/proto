import { expect, test } from "bun:test";
import { initThemeSync, theme } from "../modes/theme/theme";
import { bashToolRenderer } from "./bash";
import { renderShellWithCellOutlines } from "./eval-render";

initThemeSync();

function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderBash(
	args: Record<string, unknown>,
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	options: Record<string, unknown> = {},
): string {
	const component = bashToolRenderer.renderResult(
		result as never,
		{ expanded: false, isPartial: false, ...options } as never,
		theme,
		args as never,
	);
	return strip(component.render(100).join("\n"));
}

const FAILED_RESULT = {
	content: [{ type: "text", text: "ls: cannot access '/nope': No such file or directory" }],
	details: { execution: { state: "exited", exitCode: 3 } },
	isError: true,
};

test("a failed bash card names the tool and its exit code", () => {
	const rendered = renderBash({ command: "ls /nope; exit 3" }, FAILED_RESULT);
	expect(rendered).toContain("Bash");
	expect(rendered).toContain("exit 3");
	expect(rendered).not.toMatch(/^\s*\S\s+failed\s*$/m);
});

test("a failed bash card states the intent the call declared", () => {
	const rendered = renderBash({ command: "ls /nope; exit 3" }, FAILED_RESULT, { intent: "Running failing command" });
	expect(rendered).toContain("Running failing command");
});

test("a successful bash card stays free of failure chrome", () => {
	const rendered = renderBash(
		{ command: "echo ok", i: "Echoing" },
		{ content: [{ type: "text", text: "ok" }], details: { execution: { state: "exited", exitCode: 0 } } },
	);
	expect(rendered).not.toContain("exit 0");
	expect(rendered).not.toContain("Echoing");
});

test("a heredoc outline is captioned and indented so it cannot read as shell", () => {
	const source = "cat > sample.py <<'EOF'\ndef add(a, b):\n    return a + b\nEOF\necho written";
	const body = "def add(a, b):\n    return a + b\n";
	const start = source.indexOf(body);
	const rendered = renderShellWithCellOutlines(
		source,
		[{ start, end: start + body.length, code: body, language: "python", label: "sample.py" }],
		"bash",
		theme,
		80,
		false,
	);
	expect(rendered).toBeDefined();
	if (!rendered) return;
	const lines = rendered.lines.map(strip);
	const caption = lines.findIndex(line => line.includes("outline of sample.py"));
	expect(caption).toBeGreaterThan(0);
	expect(lines[caption - 1]).toContain("<<'EOF'");

	const outline = lines.slice(caption).filter(line => line.includes("Module ·") || line.includes("def add"));
	expect(outline.length).toBeGreaterThan(0);
	for (const line of outline) expect(line.startsWith("  ")).toBe(true);

	// The literal shell lines around the body keep their own column.
	expect(lines.some(line => line === "EOF")).toBe(true);
	expect(lines.some(line => line === "echo written")).toBe(true);
});

test("an unlabeled kernel cell outline is not captioned or indented", () => {
	const body = "x = 1\n";
	const source = `python - <<'PY'\n${body}PY`;
	const start = source.indexOf(body);
	const rendered = renderShellWithCellOutlines(
		source,
		[{ start, end: start + body.length, code: body, language: "python" }],
		"bash",
		theme,
		80,
		false,
	);
	expect(rendered).toBeDefined();
	if (!rendered) return;
	expect(rendered.lines.map(strip).some(line => line.includes("outline of"))).toBe(false);
});
