import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { EvalStatusEvent } from "../eval/types";
import { initTheme, theme } from "../modes/theme/theme";
import type { ToolSession } from ".";
import { BashTool, type BashToolDetails } from "./bash";
import { toolRenderers } from "./renderers";

await initTheme(false, false, "proto");
const OWNER = `bash-kernel-parity:${process.pid}`;

function stub(cwd: string): ToolSession {
	const m = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (k: string) => m.get(k), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-kernel-parity:${cwd}`,
		getEvalKernelOwnerId: () => OWNER,
	} as unknown as ToolSession;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Normalize the volatile bits (duration ms, tmp-dir names, truncated line
// counts) so the settled comparison is about structure/formatting, not wall clock.
const norm = (s: string) =>
	strip(s)
		.replace(/\(\d+ms\)/g, "(Nms)")
		.replace(/elapsed=\d+ms/g, "elapsed=Nms")
		.replace(/\/tmp\/[a-zA-Z]+-[\w]+/g, "/tmp/DIR")
		.replace(/… \d+ more lines/g, "… N more lines");

type Renderer = {
	renderCall: (a: unknown, o: unknown, t: unknown) => { render: (w: number) => string[] };
	renderResult: (r: unknown, o: unknown, t: unknown, a: unknown) => { render: (w: number) => string[] };
};
const bashRenderer = toolRenderers.bash as never as Renderer;

const renderBashCall = (command: string) =>
	strip(bashRenderer.renderCall({ command }, { expanded: false }, theme).render(100).join("\n"));
const renderBashResult = (res: unknown, command: string) =>
	norm(bashRenderer.renderResult(res, { expanded: false }, theme, { command }).render(90).join("\n"));

afterAll(async () => {
	await disposeKernelSessionsByOwner(OWNER);
	await disposeVmContextsByOwner(OWNER);
});

// The live/pending phase (renderCall) has no eval result to compare against, so
// assert the eval-style running cell directly (header meta + source preview).
test("kernel-cell bash renderCall shows the eval-style running cell with source preview", () => {
	const py = renderBashCall("python <<'EOF'\ndef greet(name):\n    return name\n\nclass Widget:\n    pass\nEOF");
	expect(py).not.toContain("· ast");
	expect(py).not.toContain("Module");
	expect(py).toContain("def greet(name):");
	expect(py).toContain("Widget");
	expect(renderBashCall("node <<'JS'\nfunction f(){ return 1 }\nJS")).toContain("f");
	const bun = renderBashCall("bun <<'JS'\nfunction greet(name) { return name; }\nJS");
	expect(bun).not.toContain("· ast");
	expect(bun).toContain("function greet(name) { return name; }");
	expect(renderBashCall('python -c \'edit("a","b","c")\'')).toContain("edit");
});

test("plain shell commands keep the normal $ command rendering (no AST)", () => {
	const plain = renderBashCall("rg -n foo src");
	expect(plain).toContain("rg");
	expect(plain).toContain("foo");
	expect(plain).not.toContain("· ast");
	expect(plain).not.toContain("Module");
});

test("mixed shell and kernel commands keep the full bash source", () => {
	const command = "printf 'before\\n'; python <<'PY'\nprint('kernel')\nPY\nprintf 'after\\n'";
	const preview = renderBashCall(command);
	expect(preview).toContain("printf 'before");
	expect(preview).toContain("printf 'after");
	expect(preview).toContain("Bash");
	expect(preview).not.toContain("· ast");
});

test("mixed kernel results keep status hunks and JSON alongside Bash source", () => {
	const command = "printf 'before\\n'; python <<'PY'\nprint('kernel')\nPY\nprintf 'after\\n'";
	const rendered = renderBashResult(
		{
			content: [{ type: "text", text: "before\n3\nafter\n" }],
			details: {
				statusEvents: [{ op: "write", path: "mixed.txt", diff: "@@ -1 +1 @@\n-old\n+new" }],
				jsonOutputs: [{ result: "ok" }],
			},
		},
		command,
	);
	expect(rendered).toContain("printf 'before");
	expect(rendered).toContain("printf 'after");
	expect(rendered).toContain("Bash");
	expect(rendered).toContain("Status");
	expect(rendered).toContain("mixed.txt");
	expect(rendered).toContain("result");
});

// A settled mixed call keeps its shell lines and shows the kernel block as an
// outline in place of the heredoc body, so an agent scanning the transcript
// sees the same AST view a pure cell gets.
test("settled mixed calls outline the kernel block between its shell lines", () => {
	const command = "printf 'before\\n'\npython <<'PY'\ndef greet(name):\n    return name\nPY\nprintf 'after\\n'";
	const lines = renderBashResult({ content: [{ type: "text", text: "" }] }, command).split("\n");
	expect(lines[0]).toContain("· ast");
	const before = lines.findIndex(line => line.includes("printf 'before"));
	const open = lines.findIndex(line => line.includes("python <<'PY'"));
	const outline = lines.findIndex(line => line.includes("└─ def greet(name)"));
	const close = lines.findIndex(line => /\sPY\s*$/.test(line));
	const after = lines.findIndex(line => line.includes("printf 'after"));
	expect([before, open, outline, close, after].every(index => index >= 0)).toBe(true);
	expect(before < open && open < outline && outline < close && close < after).toBe(true);
	expect(lines.some(line => line.includes("return name") && !line.includes("└─"))).toBe(false);

	const expanded = strip(
		bashRenderer
			.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: true }, theme, { command })
			.render(90)
			.join("\n"),
	);
	expect(expanded).not.toContain("· ast");
	expect(expanded).toContain("    return name");
});

test("every cell in a multi-interpreter chain is outlined in its own language", () => {
	const command =
		"python -c 'x = 1' && node -e 'function f() { return 2 }' && python <<'PY'\ndef g():\n    return 3\nPY";
	const rendered = renderBashResult({ content: [{ type: "text", text: "" }] }, command);
	expect(rendered).toContain("x ← 1");
	expect(rendered).toContain("function f()");
	expect(rendered).toContain("def g()");
	expect(rendered).toContain("&& node -e");
	expect(rendered).toContain("&& python <<'PY'");
});

test("a kernel block that does not parse keeps its source and no ast marker", () => {
	const command = "cd sub && python <<'PY'\n# only a comment\nPY\necho done";
	const rendered = renderBashResult({ content: [{ type: "text", text: "" }] }, command);
	expect(rendered).not.toContain("· ast");
	expect(rendered).toContain("# only a comment");
	expect(rendered).toContain("echo done");
});

// Settled kernel cells must render the full kernel presentation — AST outline of
// the cell source, then Output/Status sections — instead of the plain `$ command`
// shell listing a non-kernel bash call gets.
async function renderSettledCell(label: string, interpreter: string, code: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cell-${label}-`));
	const command = `${interpreter} <<'CELLEOF'\n${code}\nCELLEOF`;
	try {
		const result = await new BashTool(stub(dir)).execute(`cell-${label}`, { command });
		return renderBashResult(result, command);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("running kernel cell streams status events live (hunks withheld until settle)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
	try {
		await Bun.write(path.join(dir, "f.txt"), "a\nb\n");
		const command =
			"python <<'PYEOF'\nfrom pathlib import Path\np = Path('f.txt')\np.write_text(p.read_text().replace('b', 'B'))\nprint('done')\nPYEOF";
		const updates: Array<{ statusEvents?: unknown[] }> = [];
		await new BashTool(stub(dir)).execute(
			"live",
			{ command } as never,
			undefined,
			(u: { details?: { statusEvents?: unknown[] } }) => {
				updates.push(u.details ?? {});
			},
		);
		const streamed = updates.filter(u => (u.statusEvents?.length ?? 0) > 0);
		expect(streamed.length, "status events reach the live update stream").toBeGreaterThan(0);

		// The partial render shows the Status head (⟦+N/-M⟧ stats) AND the hunk
		// body as soon as the event is delivered — no waiting for the whole call
		// to settle. Small hunks fit the live window whole; oversized ones are
		// tail-truncated with a marker (covered in eval-render.test.ts).
		process.stdout.rows = 60;
		try {
			const partial = strip(
				bashRenderer
					.renderResult(
						{
							content: [{ type: "text", text: "done\n" }],
							details: { statusEvents: streamed.at(-1)?.statusEvents },
						},
						{ isPartial: true },
						theme,
						{ command },
					)
					.render(90)
					.join("\n"),
			);
			expect(partial).toContain("Status");
			expect(/⟦[+-]/.test(partial), "partial shows +N/-M stats").toBe(true);
			expect(/\d+│/.test(partial), "partial reveals the hunk body").toBe(true);
		} finally {
			delete (process.stdout as { rows?: number }).rows;
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bash kernel coalesces repeated agent progress in live and completed rendering", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-progress-"));
	const code = `
const emit = globalThis["__proto_" + "emit_status__"];
const alpha = ["stable", "alpha"].join("-");
const beta = ["stable", "beta"].join("-");
const mutationPath = ["shared", "mutation.txt"].join("-");
emit("agent", { id: alpha, status: "pending", taskPreview: ["stale", "preview"].join(" ") });
emit("write", { path: mutationPath, bytes: 1 });
emit("agent", { id: beta, status: "running", lastIntent: ["beta", "activity"].join(" ") });
emit("agent", { id: alpha, status: "running", currentTool: "read", lastIntent: ["latest", "activity"].join(" ") });
emit("write", { path: mutationPath, bytes: 2 });
emit("agent", { id: beta, status: "completed", durationMs: 25 });
`;
	const command = `bun <<'JSEOF'\n${code}\nJSEOF`;
	const updates: AgentToolResult<BashToolDetails>[] = [];
	try {
		const result = await new BashTool(stub(dir)).execute("agent-progress", { command }, undefined, update =>
			updates.push(update),
		);
		const live = updates.filter(update => (update.details?.statusEvents?.length ?? 0) > 0).at(-1);
		expect(live, "agent events reach the live bash update").toBeDefined();

		const completedEvents: EvalStatusEvent[] = result.details?.statusEvents ?? [];
		for (const events of [live?.details?.statusEvents ?? [], completedEvents]) {
			expect(events.filter(event => event.op === "agent" && event.id === "stable-alpha")).toEqual([
				expect.objectContaining({ status: "running", currentTool: "read", lastIntent: "latest activity" }),
			]);
			expect(events.filter(event => event.op === "agent" && event.id === "stable-beta")).toEqual([
				expect.objectContaining({ status: "completed" }),
			]);
			expect(events.filter(event => event.op === "write").map(event => event.path)).toEqual([
				"shared-mutation.txt",
				"shared-mutation.txt",
			]);
		}

		let liveRender: string;
		const originalRows = process.stdout.rows;
		process.stdout.rows = 60;
		try {
			liveRender = strip(
				bashRenderer
					.renderResult(live, { expanded: false, isPartial: true }, theme, { command })
					.render(100)
					.join("\n"),
			);
		} finally {
			if (originalRows === undefined) delete (process.stdout as { rows?: number }).rows;
			else process.stdout.rows = originalRows;
		}
		const completedRender = renderBashResult(result, command);
		for (const rendered of [liveRender, completedRender]) {
			const rows = rendered.split("\n");
			expect(
				rows.filter(row => row.includes("stable-alpha")),
				rendered,
			).toHaveLength(1);
			expect(
				rows.filter(row => row.includes("stable-beta")),
				rendered,
			).toHaveLength(1);
			expect(rendered).toContain("latest activity");
			expect(rendered).not.toContain("stale preview");
			expect(
				rows.filter(row => row.includes("shared-mutation.txt")),
				rendered,
			).toHaveLength(2);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("bun-in-bash renderResult uses the shared JavaScript AST renderer", async () => {
	const rendered = await renderSettledCell(
		"js",
		"bun",
		'function greet(name) { return name; }\nconsole.log(greet("x"))',
	);
	expect(rendered).toContain("· ast");
	expect(rendered).toContain("function greet(name)");
	expect(rendered).toContain("return name");
	expect(rendered).toContain('console.log(greet("x"))');
	expect(rendered).toContain("Output");
	expect(rendered).toContain("x");
}, 120000);

test("a settled python cell renders the AST outline above its captured output", async () => {
	const rendered = await renderSettledCell(
		"print",
		"python",
		"def greet(n):\n    return n\n\nprint('hi', greet('x'))",
	);
	expect(rendered).toContain("· ast");
	expect(rendered).toContain("def greet(n)");
	expect(rendered).toContain("return n");
	const outlineIndex = rendered.indexOf("def greet(n)");
	const outputIndex = rendered.indexOf("Output");
	expect(outlineIndex, "outline precedes the Output section").toBeLessThan(outputIndex);
	expect(rendered.slice(outputIndex)).toContain("hi x");
}, 120000);

test("display() output renders as a JSON tree, not a bare repr", async () => {
	const rendered = await renderSettledCell("display", "python", "display({'k': [1, 2, 3], 'nested': {'x': 1}})");
	expect(rendered).toContain("Output");
	expect(rendered).toContain('"nested"');
	expect(rendered).toContain("└─ ▤ x: 1");
}, 120000);

test("in-cell file edits render as Status diff hunks with the mutated path", async () => {
	const rendered = await renderSettledCell(
		"hunks",
		"python",
		"open('f.txt', 'w').write('a\\nb\\n')\ntext = open('f.txt').read()\nopen('f.txt', 'w').write(text.replace('b', 'B'))",
	);
	expect(rendered).toContain("Status");
	expect(rendered).toMatch(/write \S*f\.txt ⟦\+2⟧/);
	expect(rendered).toContain("+1│a");
	expect(rendered).toContain("+2│B");
}, 120000);

test("a raising cell renders its traceback and a failed cell marker", async () => {
	const rendered = await renderSettledCell("boom", "python", "x = 1 / 0");
	expect(rendered).toContain("✗");
	expect(rendered).toContain("ZeroDivisionError: division by zero");
	expect(rendered).toContain('File "<cell>", line 1');
}, 120000);

test("bash kernel live and rebuilt partial results preserve heredoc payload source", () => {
	const code =
		'CONTENT = <<END_CONTENT\nnew prose: keep(x,y)\n  indented **payload**\nEND_CONTENT\nPath("notes.md").write_text(CONTENT)';
	const command = `python <<'EOF'\n${code}\nEOF`;
	const call = renderBashCall(command);
	const partial = strip(
		bashRenderer
			.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: true, isPartial: true }, theme, {
				command,
			})
			.render(100)
			.join("\n"),
	);
	for (const text of [call, partial]) {
		expect(text).not.toContain("· ast");
		for (const line of code.split("\n")) expect(text).toContain(line);
	}
});

// A heredoc that writes a source file carries code exactly like a kernel cell
// does, so the settled card outlines it instead of listing the raw body — JS/TS
// file writes used to read rawer than the python cells beside them.
test("a settled .ts heredoc write is outlined between its shell lines", () => {
	const command =
		"cd /repo && cat > src/probe.ts <<'EOF'\nexport function probe(id: number): string {\n\treturn String(id);\n}\nEOF\nbun src/probe.ts";
	const lines = renderBashResult({ content: [{ type: "text", text: "" }] }, command).split("\n");
	const open = lines.findIndex(line => line.includes("cat > src/probe.ts <<'EOF'"));
	const outline = lines.findIndex(line => line.includes("└─ export function probe(id: number) → string"));
	const close = lines.findIndex(line => /\sEOF\s*$/.test(line));
	const after = lines.findIndex(line => line.includes("bun src/probe.ts"));
	expect([open, outline, close, after].every(index => index >= 0)).toBe(true);
	expect(open < outline && outline < close && close < after).toBe(true);
	expect(lines.some(line => line.includes("return String(id);"))).toBe(false);
});

// The extension picks the grammar: a python body is not valid JS, so an outline
// at all proves the write was routed to the python parser.
test("a settled .py heredoc write is outlined with the python grammar", () => {
	const rendered = renderBashResult(
		{ content: [{ type: "text", text: "" }] },
		"cat > tools/probe.py <<'EOF'\ndef probe(id):\n    return str(id)\nEOF\npython tools/probe.py",
	);
	expect(rendered).toContain("└─ def probe(id)");
	expect(rendered).toContain("python tools/probe.py");
	expect(rendered).not.toContain("def probe(id):");
});

// Extensions with no AST grammar must not be guessed at: markdown, JSON, shell
// and extensionless writes keep the literal body a raw bash listing shows.
test("heredoc writes of non-source files keep their raw body", () => {
	for (const [path, body] of [
		["notes.md", "# Title"],
		["cfg.json", '{ "a": 1 }'],
		["run.sh", "echo hello"],
		["runme", "export const x = 1;"],
	]) {
		const rendered = renderBashResult(
			{ content: [{ type: "text", text: "" }] },
			`cat > ${path} <<'EOF'\n${body}\nEOF\necho done`,
		);
		expect(rendered, path).toContain(body);
		expect(rendered, path).not.toContain("Module ·");
	}
});

// A body the parser yields nothing for still has to show its source: the
// outline is a presentation of the code, never a replacement that can go blank.
test("a .ts heredoc body with no outline falls back to its source", () => {
	const rendered = renderBashResult(
		{ content: [{ type: "text", text: "" }] },
		"cat > src/note.ts <<'EOF'\n// only a comment\nEOF\necho done",
	);
	expect(rendered).toContain("// only a comment");
	expect(rendered).toContain("echo done");
	expect(rendered).not.toContain("├─");
	expect(rendered).not.toContain("└─");
});

// Same deal a kernel cell gets: raw while the call streams (an outline swapped
// in mid-stream would rewrite rows already committed to scrollback), and ctrl+o
// expansion reveals the literal source it wrote.
test("streaming and expanded views of a heredoc write keep the literal source", () => {
	const command =
		"cat > src/probe.ts <<'EOF'\nexport function probe(id: number): string {\n\treturn String(id);\n}\nEOF";
	const streaming = strip(
		bashRenderer
			.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: true }, theme, {
				command,
			})
			.render(90)
			.join("\n"),
	);
	const expanded = strip(
		bashRenderer
			.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: true }, theme, { command })
			.render(90)
			.join("\n"),
	);
	for (const text of [renderBashCall(command), streaming, expanded]) {
		expect(text).toContain("return String(id);");
		expect(text).not.toContain("Module ·");
	}
});

// One command may both write a source file and run a kernel cell; each region
// is outlined in its own language with the shell between them intact.
test("a command that writes a source file and runs a kernel cell outlines both", () => {
	const rendered = renderBashResult(
		{ content: [{ type: "text", text: "" }] },
		"cat > src/m.ts <<'EOF'\nexport const answer = 42;\nEOF\npython <<'PY'\ndef g():\n    return 3\nPY",
	);
	expect(rendered).toContain("└─ export answer ← 42");
	expect(rendered).toContain("└─ def g()");
	expect(rendered).toContain("cat > src/m.ts <<'EOF'");
	expect(rendered).toContain("python <<'PY'");
});
