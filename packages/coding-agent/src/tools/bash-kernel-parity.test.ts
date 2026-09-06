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
import { EvalTool } from "./eval";
import { toolRenderers } from "./renderers";

await initTheme(false, false, "dark-hybrid-slate-cool");
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
const kernelRenderer = toolRenderers.kernel as never as Renderer;

const renderBashCall = (command: string) =>
	strip(bashRenderer.renderCall({ command }, { expanded: false }, theme).render(100).join("\n"));
const renderKernelResult = (res: unknown, code: string) =>
	norm(kernelRenderer.renderResult(res, { expanded: false }, theme, { code, title: "t" }).render(90).join("\n"));
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

// The settled phase (renderResult) is compared byte-for-byte against the eval
// tool rendering the same code, so the two can never drift.
async function assertJavaScriptParity(label: string, code: string): Promise<void> {
	const dirE = await fs.mkdtemp(path.join(os.tmpdir(), "jsE-"));
	const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "jsB-"));
	const command = `bun <<'JSEOF'\n${code}\nJSEOF`;
	try {
		const er = await new EvalTool(stub(dirE)).execute(`e-js-${label}`, { language: "js", code, timeout: 60 });
		const br = await new BashTool(stub(dirB)).execute(`b-js-${label}`, { command });
		expect(renderBashResult(br, command), label).toBe(renderKernelResult(er, code));
	} finally {
		await fs.rm(dirE, { recursive: true, force: true });
		await fs.rm(dirB, { recursive: true, force: true });
	}
}
async function assertParity(label: string, code: string): Promise<void> {
	const dirE = await fs.mkdtemp(path.join(os.tmpdir(), "pE-"));
	const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "pB-"));
	try {
		const er = await new EvalTool(stub(dirE)).execute(`e-${label}`, { language: "py", code, timeout: 60 });
		const br = await new BashTool(stub(dirB)).execute(`b-${label}`, { command: `python <<'PYEOF'\n${code}\nPYEOF` });
		expect(renderBashResult(br, `python <<'PYEOF'\n${code}\nPYEOF`), label).toBe(renderKernelResult(er, code));
	} finally {
		await fs.rm(dirE, { recursive: true, force: true });
		await fs.rm(dirB, { recursive: true, force: true });
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
	await assertJavaScriptParity("code+console", 'function greet(name) { return name; }\nconsole.log(greet("x"))');
}, 120000);
test("python-in-bash renderResult is identical to the eval/kernel tool", async () => {
	await assertParity("code+print", "def greet(n):\n    return n\n\nprint('hi', greet('x'))");
	await assertParity("json-display", "display({'k': [1, 2, 3], 'nested': {'x': 1}})");
	await assertParity(
		"edit-hunks",
		"open('f.txt', 'w').write('a\\nb\\n')\ntext = open('f.txt').read()\nopen('f.txt', 'w').write(text.replace('b', 'B'))",
	);
	await assertParity("traceback", "x = 1 / 0");
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
