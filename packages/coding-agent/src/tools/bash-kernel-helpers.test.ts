import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { releaseFsObservationLedger, retainFsObservationLedger } from "../eval/fs-observations";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
if (!availability.ok || !availability.pythonPath) throw new Error(availability.reason ?? "Python unavailable");
const PYTHON = JSON.stringify(availability.pythonPath);
const TEMP_ROOT = await fs.realpath(os.tmpdir());

const KERNEL_OWNER = `eval-helpers-test:${process.pid}`;

function stubSession(cwd: string, skills?: ToolSession["skills"]): ToolSession {
	const settings = new Map<string, unknown>();
	const tools = new Map<string, Tool>();
	const session = {
		cwd,
		skills,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionId: () => KERNEL_OWNER,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getToolForEvalBridge: (name: string) => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
		getEvalSessionId: () => `helpers-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	return session;
}

function cellCommand(code: string): string {
	return `${PYTHON} -m proto_harness.kernel main --interpreter ${PYTHON} <<'__PROTO_CELL__'\nimport proto_harness as harness\n${code}\n__PROTO_CELL__`;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function runCell(dir: string, code: string, session = stubSession(dir)) {
	const result = await new BashTool(session).execute("bash-kernel-helpers-test", {
		command: cellCommand(code),
		timeout: 60,
	});
	return {
		status: result.isError || result.details?.execution?.exitCode !== 0 ? "error" : "complete",
		output: textOf(result),
		statusEvents: result.details?.statusEvents ?? [],
	};
}

async function makeDir(): Promise<string> {
	return await fs.mkdtemp(path.join(TEMP_ROOT, "eval-helpers-"));
}

retainFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
	releaseFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);
});

test("a harness.fs.write_text mutation emits a write event with a hunk diff", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "mutation.txt");
		await Bun.write(target, "alpha\nbeta\ngamma\n");
		const cell = await runCell(
			dir,
			`p = ${JSON.stringify(target)}\ntext = harness.fs.read_text(p)\nharness.fs.write_text(p, text.replace("beta", "BETA-EDITED"))`,
		);
		expect(cell.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("alpha\nBETA-EDITED\ngamma\n");
		const writes = cell.statusEvents.filter(event => event.op === "write" && event.path === target);
		expect(writes.length).toBe(1);
		expect(String(writes[0]?.diff)).toContain("-2|beta");
		expect(String(writes[0]?.diff)).toContain("+2|BETA-EDITED");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("the stale-write guard aborts a guarded write after an external mutation; re-reading re-arms", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "stale.txt");
		await Bun.write(target, "original content\n");
		const readCell = await runCell(dir, `text = harness.fs.read_text(${JSON.stringify(target)})\nprint(len(text))`);
		expect(readCell.status).toBe("complete");

		await Bun.write(target, "externally rewritten while the kernel held the old text\n");

		const clobber = await runCell(dir, `harness.fs.write_text(${JSON.stringify(target)}, text + "kernel-edit\\n")`);
		expect(clobber.status).toBe("error");
		expect(clobber.output).toContain("StaleWriteError");
		expect(clobber.output).toContain("changed since its last read");
		expect(await Bun.file(target).text()).toBe("externally rewritten while the kernel held the old text\n");

		// An explicit harness read re-arms the guard to the file's current state, so the same
		// mutation redone after a fresh read lands.
		const rearmed = await runCell(
			dir,
			`text = harness.fs.read_text(${JSON.stringify(target)})\nharness.fs.write_text(${JSON.stringify(target)}, text + "kernel-edit\\n")`,
		);
		expect(rearmed.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe(
			"externally rewritten while the kernel held the old text\nkernel-edit\n",
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("an atomic write raises StaleWriteError before truncating an armed path", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "plain-read.txt");
		await Bun.write(target, "seen by kernel\n");
		const readCell = await runCell(dir, `src = harness.fs.read_text(${JSON.stringify(target)})\nprint(len(src))`);
		expect(readCell.status).toBe("complete");

		await Bun.write(target, "seen by kernel\nplus an external line the kernel never read\n");

		const cell = await runCell(dir, `harness.fs.write_text(${JSON.stringify(target)}, "clobbered\\n")`);
		expect(cell.status).toBe("error");
		expect(cell.output).toContain("StaleWriteError");
		// The atomic helper refuses the edit before replacing any content.
		expect(await Bun.file(target).text()).toBe("seen by kernel\nplus an external line the kernel never read\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("the kernel's own writes never trip the guard; untracked new files are unaffected", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "own-writes.txt");
		const cell = await runCell(
			dir,
			[
				`p = ${JSON.stringify(target)}`,
				'harness.fs.write_text(p, "v1\\n")',
				"text = harness.fs.read_text(p)",
				'harness.fs.write_text(p, text + "v2\\n")',
				'harness.fs.write_text(p, "v3\\n")',
				'print("all-writes-ok")',
			].join("\n"),
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain("all-writes-ok");
		expect(await Bun.file(target).text()).toBe("v3\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("Python raw file APIs consume shell-resolved skill paths", async () => {
	const dir = await makeDir();
	try {
		const skillDir = path.join(dir, "example skill");
		await Bun.write(path.join(skillDir, "SKILL.md"), "# Example skill\n");
		await Bun.write(path.join(skillDir, "notes.txt"), "skill notes\n");
		const session = stubSession(dir, [
			{
				name: "example",
				description: "test skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		const result = await new BashTool(session).execute("skill-path-handoff", {
			command: `${PYTHON} <<'__PROTO_CELL__'\nimport os\nfrom pathlib import Path\nprint(Path(os.environ["SKILL_DIR"]).name)\nprint(Path(os.environ["SKILL_FILE"]).read_text())\n__PROTO_CELL__`,
			env: { SKILL_DIR: "skill://example", SKILL_FILE: "skill://example/notes.txt" },
		});
		expect(result.isError, textOf(result)).not.toBe(true);
		expect(textOf(result)).toContain("example skill");
		expect(textOf(result)).toContain("skill notes");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("harness.symbols(code=) outlines an in-memory string per language", async () => {
	const dir = await makeDir();
	try {
		const py = await runCell(
			dir,
			'print(harness.symbols(code="def greet(name):\\n    return name\\n\\nclass Widget:\\n    pass\\n", lang="python"))',
		);
		expect(py.status).toBe("complete");
		expect(py.output).toContain("def greet(name)");
		expect(py.output).toContain("class Widget");

		const ts = await runCell(
			dir,
			'print(harness.symbols(code="export function shout(x: string): string {\\n  return x.toUpperCase();\\n}\\n", lang="ts"))',
		);
		expect(ts.status).toBe("complete");
		expect(ts.output).toContain("function shout");

		const both = await runCell(dir, 'harness.symbols("x.py", code="pass")');
		expect(both.status).toBe("error");
		expect(both.output).toContain("exactly one of");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("harness.symbols(path) equals harness.symbols(code=) for the same content", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "sample.py");
		const source = "def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n";
		await Bun.write(target, source);
		const cell = await runCell(
			dir,
			[
				`by_path = harness.symbols(${JSON.stringify(target)})`,
				`by_code = harness.symbols(code=${JSON.stringify(source)}, lang="python")`,
				'print("MATCH" if by_path == by_code else f"DIFFER:\\n{by_path}\\n---\\n{by_code}")',
			].join("\n"),
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain("MATCH");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
