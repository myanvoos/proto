import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { releaseFsObservationLedger, retainFsObservationLedger } from "../eval/fs-observations";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";

// Mutation receipts must be model-visible, not only structured TUI events.
// Python receipts accompany explicit atomic fs operations; JS retains net-cell notes.
const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
if (!availability.ok || !availability.pythonPath) throw new Error(availability.reason ?? "Python unavailable");
const PYTHON = JSON.stringify(availability.pythonPath);
const TEMP_ROOT = await fs.realpath(os.tmpdir());

const KERNEL_OWNER = `kernel-note-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	const tools = new Map<string, Tool>();
	const session = {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `kernel-note-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
		getSessionId: () => KERNEL_OWNER,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getToolForEvalBridge: (name: string) => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
	} as unknown as ToolSession;
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	return session;
}

async function runCommand(tool: BashTool, id: string, command: string): Promise<string> {
	const result = await tool.execute(id, { command });
	return result.content
		.filter(block => block.type === "text")
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function heredoc(interpreter: string, code: string): string {
	if (interpreter === "python") {
		interpreter = `${PYTHON} -m proto_harness.kernel main --interpreter ${PYTHON}`;
		code = `import proto_harness as harness\n${code}`;
	}
	return `${interpreter} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`;
}

function noteLines(output: string): string[] {
	return output
		.split("\n")
		.filter(line => line.startsWith("<kernel> note:"))
		.map(line => line.trim());
}

retainFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
	releaseFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);
});

test("kernel entry points report explicit mutations in model-visible text", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-note-entry-"));
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
				command: heredoc("python", "harness.fs.write_text('python-heredoc.txt', 'a\\n')"),
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

test("explicit Python overwrite receipts match JS notes without auditing native deletes", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-note-parity-"));
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
					"harness.fs.read_text('py.txt')",
					"harness.fs.write_text('py.txt', 'one\\nthree\\n')",
					"harness.fs.read_text('py-gone.txt')",
					"os.remove('py-gone.txt')",
				].join("\n"),
			),
		);
		expect(noteLines(jsOutput).sort()).toEqual([
			"<kernel> note: deleted js-gone.txt",
			"<kernel> note: wrote js.txt (+1 −1)",
		]);
		expect(noteLines(pyOutput)).toEqual(["<kernel> note: wrote py.txt (+1 −1)"]);
		expect(await Bun.file(path.join(dir, "py-gone.txt")).exists()).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 180000);

test("notes count every changed line when the status-event diff is capped", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-note-capped-"));
	try {
		const tool = new BashTool(stubSession(dir));
		// 1000 rows exceed the diff row cap; 150 rewritten 250-char lines exceed only the char cap.
		const wide = (tag: string) =>
			`${Array.from({ length: 150 }, (_, i) => `${tag}${i}`.padEnd(250, "x")).join("\n")}\n`;
		await Bun.write(path.join(dir, "js-wide.txt"), wide("old"));
		await Bun.write(path.join(dir, "py-wide.txt"), wide("old"));

		const jsOutput = await runCommand(
			tool,
			"js-capped",
			heredoc(
				"node",
				[
					"const fs = require('node:fs');",
					"fs.writeFileSync('js-rows.txt', Array.from({ length: 1000 }, (_, i) => 'row ' + i + '\\n').join(''));",
					"fs.readFileSync('js-wide.txt', 'utf8');",
					"fs.writeFileSync('js-wide.txt', Array.from({ length: 150 }, (_, i) => ('new' + i).padEnd(250, 'x') + '\\n').join(''));",
				].join("\n"),
			),
		);
		const pyOutput = await runCommand(
			tool,
			"py-capped",
			heredoc(
				"python",
				[
					"from pathlib import Path",
					"harness.fs.write_text('py-rows.txt', ''.join(f'row {i}\\n' for i in range(1000)))",
					"harness.fs.read_text('py-wide.txt')",
					"harness.fs.write_text('py-wide.txt', ''.join(f'new{i}'.ljust(250, 'x') + '\\n' for i in range(150)))",
				].join("\n"),
			),
		);
		expect(noteLines(jsOutput).sort()).toEqual([
			"<kernel> note: created js-rows.txt (1000 lines)",
			"<kernel> note: wrote js-wide.txt (+150 −150)",
		]);
		expect(noteLines(pyOutput).sort()).toEqual([
			"<kernel> note: created py-rows.txt (1000 lines)",
			"<kernel> note: wrote py-wide.txt (+150 −150)",
		]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 180000);

test("a js cell whose net effect is nothing emits no note at all", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-note-revert-"));
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
