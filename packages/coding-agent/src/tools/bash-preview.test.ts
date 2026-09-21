import { expect, test } from "bun:test";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { initTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "./renderers";

await initTheme(false, false, "proto");

// The session event stream hands renderers loosely-typed arg records; the
// shape exercised here is pinned by the calls below.
type BashRenderer = {
	renderCall: (
		args: Record<string, unknown>,
		options: Record<string, unknown>,
		theme: unknown,
	) => { render: (width: number) => readonly string[] };
};
const renderer = toolRenderers.bash as unknown as BashRenderer;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function firstCommandLine(args: Record<string, unknown>): string {
	const lines = renderer.renderCall(args, { expanded: false }, theme).render(100);
	return strip(lines[0] ?? "");
}

function livePreviewLines(command: string): readonly string[] {
	return renderer.renderCall({ command }, { expanded: false, spinnerFrame: 0 }, theme).render(100);
}

function lineContaining(lines: readonly string[], text: string): string {
	const found = lines.find(line => strip(line).includes(text));
	if (found === undefined) throw new Error(`no rendered line contains ${JSON.stringify(text)}`);
	return found;
}

/** Recoloring must never rewrite the source it colors: every command line survives verbatim. */
function expectSourceIntact(lines: readonly string[], command: string): void {
	const rendered = lines.map(strip);
	for (const line of command.split("\n")) {
		expect(rendered.some(candidate => candidate.includes(line))).toBe(true);
	}
}

// The workdir prefix announces the cwd param; a command that opens with a cd
// to the same directory is a no-op at execution time and must not render
// twice. Regression: settled view showed `cd X && cd X && …`.
test("settled preview collapses a leading cd matching the cwd param into the workdir prefix", () => {
	const dir = path.resolve(getProjectDir(), "packages/tui");
	const line = firstCommandLine({ command: `cd ${dir} && bun test`, cwd: dir });
	expect(line).toContain("$ cd packages/tui && bun test");
	expect(line).not.toContain("&& cd");
});

// A leading cd that changes directory is real execution semantics: dropping
// it would misrepresent where the command runs.
test("settled preview keeps a leading cd targeting a different directory than cwd", () => {
	const dir = path.resolve(getProjectDir(), "packages/tui");
	const line = firstCommandLine({ command: `cd ${dir}/src && ls`, cwd: dir });
	expect(line).toContain("$ cd packages/tui && cd ");
	expect(line).toContain("&& ls");
});

// While the argument JSON streams, `cwd`/`env` arrive truncated or after
// `command`; rendering a prefix from them rewrote the line head through
// `cd pac &&` → `cd packages &&` → … at end of stream. The prefix must wait
// for complete arguments.
test("streaming preview with partial args renders the command verbatim without synthetic prefixes", () => {
	const dir = path.resolve(getProjectDir(), "packages/tui");
	const command = `cd ${dir} && bun test`;
	const partialJson = `{"command": ${JSON.stringify(command)}, "cwd": "packages/t", "env": {"CI": "1"}`;
	const line = firstCommandLine({ command, cwd: "packages/t", env: { CI: "1" }, __partialJson: partialJson });
	expect(line.endsWith(`$ ${command}`)).toBe(true);
	expect(line).not.toContain("$ cd packages/t &&");
	expect(line).not.toContain("CI=");
});

// Complement of the streaming gate: once arguments are complete the env
// assignments join the dim prefix as before.
test("settled preview keeps the env-assignment prefix", () => {
	const line = firstCommandLine({ command: "bun test", env: { CI: "1" } });
	expect(line).toContain('$ CI="1" bun test');
});

// A heredoc body is one string token to the shell grammar, so a 40-line file
// write used to render as a single green block. The write target names the
// language, so the body is highlighted with that language's grammar.
test("live preview highlights a heredoc body with the written file's language", () => {
	const lines = livePreviewLines("cat > /tmp/preview.py <<'PY'\nimport os\nPY");
	const body = lineContaining(lines, "import os");
	expect(body).toContain(theme.getFgAnsi("syntaxKeyword"));
	expect(body).not.toContain(theme.getFgAnsi("syntaxString"));
	expectSourceIntact(lines, "cat > /tmp/preview.py <<'PY'\nimport os\nPY");
});

// The same body written to a path with no grammar has no language to switch
// to, so it keeps the shell's own string coloring.
test("live preview leaves a heredoc body with an unknown target extension shell-colored", () => {
	const body = lineContaining(livePreviewLines("cat > /tmp/preview.zzz <<'EOF'\nimport os\nEOF"), "import os");
	expect(body).toContain(theme.getFgAnsi("syntaxString"));
	expect(body).not.toContain(theme.getFgAnsi("syntaxKeyword"));
});

// A kernel cell inside a larger shell command renders the shell source while
// it runs; the interpreter names the body's language.
test("live preview of a mixed kernel cell highlights the cell body as its interpreter's language", () => {
	const lines = livePreviewLines("cd /tmp && python <<'PY'\nimport os\nPY\necho done");
	const body = lineContaining(lines, "import os");
	expect(body).toContain(theme.getFgAnsi("syntaxKeyword"));
	expect(body).not.toContain(theme.getFgAnsi("syntaxString"));
	// Shell source around the cell keeps shell coloring.
	expect(strip(lineContaining(lines, "echo done"))).toContain("echo done");
	expect(lineContaining(lines, "echo done")).toContain(theme.getFgAnsi("syntaxFunction"));
});

// Only whole lines a region covers may be recolored: an inline `-c` word sits
// mid-line, and splitting it would hand both halves to a parser as unbalanced
// fragments.
test("live preview keeps an inline interpreter -c word on one shell-colored line", () => {
	const lines = livePreviewLines("python -c 'import os' && echo done");
	expectSourceIntact(lines, "python -c 'import os' && echo done");
	expect(lineContaining(lines, "import os")).toContain(theme.getFgAnsi("syntaxString"));
});
