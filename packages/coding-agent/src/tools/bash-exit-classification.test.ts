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

test("renderer marks hard failures, keeps soft exits as neutral stats", async () => {
	const soft = renderBashResult(
		{
			content: [{ type: "text", text: "" }],
			details: { exitCode: 1, execution: exitedExecution(1, true) },
			isError: false,
		},
		"exit 1",
	);
	expect(soft).not.toContain("failed");
	expect(soft).toContain("Exit: 1");

	const hard = renderBashResult(
		{
			content: [{ type: "text", text: "" }],
			details: { exitCode: 2, execution: exitedExecution(2) },
			isError: true,
		},
		"exit 2",
	);
	expect(hard).toContain("failed");
	expect(hard).toContain("Exit: 2");
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
