import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme, theme } from "../modes/theme/theme";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import { toolRenderers } from "./renderers";

initTheme();

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-exit-classification:${cwd}`,
		getEvalKernelOwnerId: () => `bash-exit-classification:${process.pid}`,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function renderBashResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	command: string,
): string {
	const renderer = toolRenderers.bash as never as {
		renderResult: (r: unknown, o: unknown, t: unknown, a: unknown) => { render: (w: number) => string[] };
	};
	const component = renderer.renderResult(
		result,
		{ expanded: false, isPartial: false, renderContext: { expanded: false } },
		theme,
		{ command },
	);
	return stripAnsi(component.render(90).join("\n"));
}

function exitedExecution(exitCode: number, softExit = false): Record<string, unknown> {
	return {
		state: "exited",
		exitCode,
		...(softExit ? { softExit: true } : {}),
		collector: { state: "complete" },
		renderer: { state: "complete" },
		output: { disposition: "complete" },
	};
}

test("shell exit 1 is a data result, not an error", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-exit-soft-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const result = await bash.execute("no-match", { command: "exit 1" });
		expect(result.isError ?? false).toBe(false);
		expect(result.details?.exitCode).toBe(1);
		expect(result.details?.execution?.exitCode).toBe(1);
		expect(result.details?.execution?.softExit).toBe(true);
		expect(textOf(result)).toContain("Command exited with code 1");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("hard exit codes still mark the command failed", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-exit-hard-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const result = await bash.execute("tool-error", { command: "exit 2" });
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(2);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("command not found (127) marks the command failed", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-exit-127-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const result = await bash.execute("missing", { command: "definitely-not-a-real-command-xyz" });
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(127);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("renderer marks hard failures but keeps soft exits out of failure status", async () => {
	const soft = renderBashResult(
		{
			content: [{ type: "text", text: "" }],
			details: { exitCode: 1, execution: exitedExecution(1, true) },
			isError: false,
		},
		"exit 1",
	);
	// Soft exit 1 is not a failure, and execution footers are gone entirely.
	expect(soft).not.toContain("failed");
	expect(soft).not.toMatch(/\(exit 1\)/);

	const hard = renderBashResult(
		{
			content: [{ type: "text", text: "" }],
			details: { exitCode: 2, execution: exitedExecution(2) },
			isError: true,
		},
		"exit 2",
	);
	// A failure names the tool and how it failed; a bare "failed" said neither.
	expect(hard).toContain("Bash");
	expect(hard).toContain("exit 2");
});

test("kernel cells exit 1 on a raised exception and must stay failures", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-exit-kernel-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const result = await bash.execute("kernel-raise", {
			command: "python <<'EOF'\nraise RuntimeError('boom')\nEOF",
		});
		expect(result.isError).toBe(true);
		expect(result.details?.execution?.softExit).toBeUndefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

for (const command of ["printf result", "python -c 'print(42)'"]) {
	test(`${command}: output carries the artifact id and no timing or diagnostics`, () => {
		const output = renderBashResult(
			{
				content: [{ type: "text", text: "result\n[raw output: artifact://42]" }],
				details: {
					execution: { ...exitedExecution(0), elapsedMs: 42 },
					wallTimeMs: 42,
					timeoutSeconds: 300,
				},
			},
			command,
		);
		expect(output).not.toMatch(/Execution:|collector=|renderer=|output=|Wall:|Timeout:|42ms|exit 0/i);
		if (command === "printf result") {
			// Plain shell cards keep the artifact id after stripping the notice;
			// kernel cells render their own output section without it, as before.
			expect(output).toContain("Artifact: 42");
			expect(output.indexOf("Artifact: 42")).toBeGreaterThan(output.indexOf("result"));
		} else {
			expect(output).not.toContain("artifact://42");
			expect(output).toContain("result");
		}
	});

	test(`${command}: a finished output tail uses the same earlier-lines expand notice as streaming`, () => {
		const output = renderBashResult(
			{
				content: [{ type: "text", text: Array.from({ length: 21 }, (_, i) => `line ${i}`).join("\n") }],
				details: { execution: exitedExecution(0), wallTimeMs: 42 },
			},
			command,
		);
		expect(output).toContain("… 11 earlier lines");
		expect(output).toContain("Ctrl+O expand");
		expect(output).not.toMatch(/showing \d+ of|ctrl\+o to expand/);
		expect(output).toContain("line 20");
		expect(output.indexOf("11 earlier lines")).toBeLessThan(output.indexOf("line 11"));
	});
}
