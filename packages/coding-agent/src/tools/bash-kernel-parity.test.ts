import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { initTheme, theme } from "../modes/theme/theme";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
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

// Normalize the two volatile bits (duration ms, tmp-dir names, truncated line
// counts) so the comparison is about structure/formatting, not wall clock.
const norm = (s: string) =>
	s
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\(\d+ms\)/g, "(Nms)")
		.replace(/\/tmp\/[a-zA-Z]+-[\w]+/g, "/tmp/DIR")
		.replace(/… \d+ more lines/g, "… N more lines");

const rEval = (res: unknown, code: string) =>
	norm(
		(
			toolRenderers.kernel as never as {
				renderResult: (r: unknown, o: unknown, t: unknown, a: unknown) => { render: (w: number) => string[] };
			}
		)
			.renderResult(res, { expanded: false }, theme, { code, title: "t" })
			.render(90)
			.join("\n"),
	);
const rBash = (res: unknown, command: string) =>
	norm(
		(
			toolRenderers.bash as never as {
				renderResult: (r: unknown, o: unknown, t: unknown, a: unknown) => { render: (w: number) => string[] };
			}
		)
			.renderResult(res, { expanded: false }, theme, { command })
			.render(90)
			.join("\n"),
	);

afterAll(async () => {
	await disposeKernelSessionsByOwner(OWNER);
});

async function assertParity(label: string, code: string): Promise<void> {
	const dirE = await fs.mkdtemp(path.join(os.tmpdir(), "pE-"));
	const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "pB-"));
	try {
		const er = await new EvalTool(stub(dirE)).execute(`e-${label}`, { language: "py", code, timeout: 60 });
		const br = await new BashTool(stub(dirB)).execute(`b-${label}`, { command: `python <<'PYEOF'\n${code}\nPYEOF` });
		expect(rBash(br, `python <<'PYEOF'\n${code}\nPYEOF`), label).toBe(rEval(er, code));
	} finally {
		await fs.rm(dirE, { recursive: true, force: true });
		await fs.rm(dirB, { recursive: true, force: true });
	}
}

test("python-in-bash renders identically to the eval/kernel tool", async () => {
	await assertParity("code+print", "def greet(n):\n    return n\n\nprint('hi', greet('x'))");
	await assertParity("json-display", "display({'k': [1, 2, 3], 'nested': {'x': 1}})");
	await assertParity("edit-hunks", "write('f.txt', 'a\\nb\\n')\nedit('f.txt', 'b', 'B')");
	await assertParity("traceback", "x = 1 / 0");
}, 120000);
