import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `eval-helpers-test:${process.pid}`;

function stubSession(cwd: string, skills?: ToolSession["skills"]): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		skills,
		settings: {
			get: (key: string) => settings.get(key),
		},
		getEvalSessionId: () => "eval-helpers-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

async function runCell(dir: string, code: string, session = stubSession(dir)) {
	const tool = new EvalTool(session);
	const result = await tool.execute("eval-helpers-test", {
		language: "py",
		code,
		title: "kernel helpers",
		timeout: 60,
	});
	return {
		status: result.details?.cells?.[0]?.status,
		output: result.details?.cells?.[0]?.output ?? "",
		statusEvents: result.details?.cells?.[0]?.statusEvents ?? [],
	};
}

async function makeDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "eval-helpers-"));
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("a Path.write_text mutation emits a write event with a hunk diff", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "mutation.txt");
		await Bun.write(target, "alpha\nbeta\ngamma\n");
		const cell = await runCell(
			dir,
			`p = Path(${JSON.stringify(target)})\ntext = p.read_text()\np.write_text(text.replace("beta", "BETA-EDITED"))`,
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

test("the stale-write guard aborts a raw write after an external mutation; re-reading re-arms", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "stale.txt");
		await Bun.write(target, "original content\n");
		const readCell = await runCell(dir, `text = Path(${JSON.stringify(target)}).read_text()\nprint(len(text))`);
		expect(readCell.status).toBe("complete");

		await Bun.write(target, "externally rewritten while the kernel held the old text\n");

		const clobber = await runCell(dir, `open(${JSON.stringify(target)}, "w").write(text + "kernel-edit\\n")`);
		expect(clobber.status).toBe("error");
		expect(clobber.output).toContain("StaleWriteError");
		expect(clobber.output).toContain("changed on disk");
		expect(await Bun.file(target).text()).toBe("externally rewritten while the kernel held the old text\n");

		// Any read re-arms the guard to the file's current state, so the same
		// mutation redone after a fresh read lands.
		const rearmed = await runCell(
			dir,
			`text = Path(${JSON.stringify(target)}).read_text()\nopen(${JSON.stringify(target)}, "w").write(text + "kernel-edit\\n")`,
		);
		expect(rearmed.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe(
			"externally rewritten while the kernel held the old text\nkernel-edit\n",
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a raw write-mode open raises StaleWriteError before truncating an armed path", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "plain-read.txt");
		await Bun.write(target, "seen by kernel\n");
		const readCell = await runCell(dir, `src = open(${JSON.stringify(target)}).read()\nprint(len(src))`);
		expect(readCell.status).toBe("complete");

		await Bun.write(target, "seen by kernel\nplus an external line the kernel never read\n");

		const cell = await runCell(dir, `open(${JSON.stringify(target)}, "w").write("clobbered\\n")`);
		expect(cell.status).toBe("error");
		expect(cell.output).toContain("StaleWriteError");
		// The guard raised out of open() itself — nothing was truncated.
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
				'open(p, "w").write("v1\\n")',
				"text = Path(p).read_text()",
				'open(p, "w").write(text + "v2\\n")',
				'open(p, "w").write("v3\\n")',
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

test("proto_path resolves ~ and scheme URLs for the raw file APIs", async () => {
	const dir = await makeDir();
	try {
		const home = path.join(dir, "home");
		await fs.mkdir(home);
		const cell = await runCell(
			dir,
			[
				"import os",
				"_home = os.environ.get('HOME')",
				`os.environ['HOME'] = ${JSON.stringify(home)}`,
				"try:",
				"    p = proto_path('~/tilde.txt')",
				"    open(p, 'w').write('one\\n')",
				"    print(p)",
				"finally:",
				"    if _home is None:",
				"        os.environ.pop('HOME', None)",
				"    else:",
				"        os.environ['HOME'] = _home",
			].join("\n"),
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain(path.join(home, "tilde.txt"));
		expect(await Bun.file(path.join(home, "tilde.txt")).text()).toBe("one\n");
		const literalTilde = await fs.access(path.join(dir, "~")).then(
			() => true,
			() => false,
		);
		expect(literalTilde, "no literal ~/ directory under the kernel cwd").toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("proto_path resolves active skill directories and their files", async () => {
	const dir = await makeDir();
	try {
		const skillDir = path.join(dir, "example-skill");
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
		const cell = await runCell(
			dir,
			[
				'print(proto_path("skill://example"))',
				'print(Path(proto_path("skill://example/notes.txt")).read_text())',
			].join("\n"),
			session,
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain(skillDir);
		expect(cell.output).toContain("skill notes");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("symbols(code=) outlines an in-memory string per language", async () => {
	const dir = await makeDir();
	try {
		const py = await runCell(
			dir,
			'print(symbols(code="def greet(name):\\n    return name\\n\\nclass Widget:\\n    pass\\n", lang="python"))',
		);
		expect(py.status).toBe("complete");
		expect(py.output).toContain("def greet(name)");
		expect(py.output).toContain("class Widget");

		const ts = await runCell(
			dir,
			'print(symbols(code="export function shout(x: string): string {\\n  return x.toUpperCase();\\n}\\n", lang="ts"))',
		);
		expect(ts.status).toBe("complete");
		expect(ts.output).toContain("function shout");

		const both = await runCell(dir, 'symbols("x.py", code="pass")');
		expect(both.status).toBe("error");
		expect(both.output).toContain("exactly one of");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("symbols(path) equals symbols(code=) for the same content", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "sample.py");
		const source = "def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n";
		await Bun.write(target, source);
		const cell = await runCell(
			dir,
			[
				`by_path = symbols(${JSON.stringify(target)})`,
				`by_code = symbols(code=${JSON.stringify(source)}, lang="python")`,
				'print("MATCH" if by_path == by_code else f"DIFFER:\\n{by_path}\\n---\\n{by_code}")',
			].join("\n"),
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain("MATCH");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
