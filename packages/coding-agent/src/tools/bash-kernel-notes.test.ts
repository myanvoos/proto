import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

// Contract (prompts/tools/bash.md): "Net-mutated paths emit one compact `<kernel> note:` line
// per path in cell output." Status events feed the TUI and the fs ledger but are invisible to
// the model, so the note has to be in the cell's own text — in every kernel language.
const KERNEL_OWNER = `kernel-note-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `kernel-note-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

async function runCommand(tool: BashTool, id: string, command: string): Promise<string> {
	const result = await tool.execute(id, { command });
	return result.content
		.filter(block => block.type === "text")
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function heredoc(interpreter: string, code: string): string {
	return `${interpreter} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`;
}

function noteLines(output: string): string[] {
	return output
		.split("\n")
		.filter(line => line.startsWith("<kernel> note:"))
		.map(line => line.trim());
}

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

test("every kernel entry point reports its net mutations in model-visible text", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-note-entry-"));
	try {
		const tool = new BashTool(stubSession(dir));
		const cases: Array<{ id: string; command: string; file: string }> = [
			{
				id: "node-heredoc",
				file: "node-heredoc.txt",
				command: heredoc("node", "require('node:fs').writeFileSync('node-heredoc.txt', 'a\\n');"),
			},
			{
				id: "bun-heredoc",
				file: "bun-heredoc.txt",
				command: heredoc("bun", "require('node:fs').writeFileSync('bun-heredoc.txt', 'a\\n');"),
			},
			{
				id: "node-dash-e",
				file: "node-dash-e.txt",
				command: `node -e "require('node:fs').writeFileSync('node-dash-e.txt', 'a\\n');"`,
			},
			{
				id: "python-heredoc",
				file: "python-heredoc.txt",
				command: heredoc("python", "open('python-heredoc.txt', 'w').write('a\\n')"),
			},
		];
		for (const testCase of cases) {
			const output = await runCommand(tool, testCase.id, testCase.command);
			expect(noteLines(output), `${testCase.id} output: ${output}`).toEqual([
				`<kernel> note: created ${testCase.file} (1 line)`,
			]);
			expect(await Bun.file(path.join(dir, testCase.file)).text()).toBe("a\n");
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 180000);

test("js and python kernels word overwrite and delete notes identically", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-note-parity-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(path.join(dir, "js.txt"), "one\ntwo\n");
		await Bun.write(path.join(dir, "py.txt"), "one\ntwo\n");
		await Bun.write(path.join(dir, "js-gone.txt"), "bye\n");
		await Bun.write(path.join(dir, "py-gone.txt"), "bye\n");

		const jsOutput = await runCommand(
			tool,
			"js-notes",
			heredoc(
				"node",
				[
					"const fs = require('node:fs');",
					"fs.readFileSync('js.txt', 'utf8');",
					"fs.writeFileSync('js.txt', 'one\\nthree\\n');",
					"fs.readFileSync('js-gone.txt', 'utf8');",
					"fs.unlinkSync('js-gone.txt');",
				].join("\n"),
			),
		);
		const pyOutput = await runCommand(
			tool,
			"py-notes",
			heredoc(
				"python",
				[
					"from pathlib import Path",
					"import os",
					"Path('py.txt').read_text()",
					"Path('py.txt').write_text('one\\nthree\\n')",
					"Path('py-gone.txt').read_text()",
					"os.remove('py-gone.txt')",
				].join("\n"),
			),
		);
		expect(noteLines(jsOutput).sort()).toEqual([
			"<kernel> note: deleted js-gone.txt",
			"<kernel> note: wrote js.txt (+1 −1)",
		]);
		expect(noteLines(pyOutput).sort()).toEqual([
			"<kernel> note: deleted py-gone.txt",
			"<kernel> note: wrote py.txt (+1 −1)",
		]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 180000);

test("a js cell whose net effect is nothing emits no note at all", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-note-revert-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(path.join(dir, "keep.txt"), "same\n");
		const output = await runCommand(
			tool,
			"js-revert",
			heredoc(
				"node",
				[
					"const fs = require('node:fs');",
					"fs.writeFileSync('keep.txt', 'changed\\n');",
					"fs.writeFileSync('keep.txt', 'same\\n');",
					"console.log('done');",
				].join("\n"),
			),
		);
		expect(output).toContain("done");
		// Notes describe net mutations: a file restored to its pre-cell content is not one.
		expect(noteLines(output)).toEqual([]);
		expect(await Bun.file(path.join(dir, "keep.txt")).text()).toBe("same\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 180000);
