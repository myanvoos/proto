import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `eval-helpers-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: {
			get: (key: string) => settings.get(key),
		},
		getEvalSessionId: () => "eval-helpers-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

async function runCell(dir: string, code: string) {
	const tool = new EvalTool(stubSession(dir));
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

test("edit() applies a single anchored hunk and emits a write event with a diff", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "single.txt");
		await Bun.write(target, "alpha\nbeta\ngamma\n");
		const cell = await runCell(
			dir,
			[
				`r = edit(${JSON.stringify(target)}, "beta", "BETA-EDITED")`,
				'print(r["replacements"], r["hunks"][0]["line"])',
			].join("\n"),
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain("1 2");
		expect(await Bun.file(target).text()).toBe("alpha\nBETA-EDITED\ngamma\n");
		const writes = cell.statusEvents.filter(event => event.op === "write" && event.path === target);
		expect(writes.length).toBe(1);
		expect(String(writes[0]?.diff)).toContain("-2|beta");
		expect(String(writes[0]?.diff)).toContain("+2|BETA-EDITED");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("edit() missing anchor names the anchor and leaves the file untouched", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "missing.txt");
		const original = "one\ntwo\nthree\n";
		await Bun.write(target, original);
		const cell = await runCell(dir, `edit(${JSON.stringify(target)}, "no-such-anchor", "x")`);
		expect(cell.status).toBe("error");
		expect(cell.output).toContain("AnchorNotFoundError");
		expect(cell.output).toContain("anchor not found");
		expect(cell.output).toContain("no-such-anchor");
		expect(cell.output).toContain("missing.txt");
		expect(await Bun.file(target).text()).toBe(original);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("edit() ambiguous anchor lists every match line; count widens or replaces all", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "dup.txt");
		await Bun.write(target, "marker\nmiddle\nmarker\n");
		const ambiguous = await runCell(dir, `edit(${JSON.stringify(target)}, "marker", "replaced")`);
		expect(ambiguous.status).toBe("error");
		expect(ambiguous.output).toContain("AmbiguousAnchorError");
		expect(ambiguous.output).toContain("matches 2 times at lines 1, 3");
		expect(await Bun.file(target).text()).toBe("marker\nmiddle\nmarker\n");

		const short = await runCell(dir, `edit(${JSON.stringify(target)}, "marker", "replaced", count=3)`);
		expect(short.status).toBe("error");
		expect(short.output).toContain("AnchorNotFoundError");
		expect(short.output).toContain("found 2 time(s) at line(s) 1, 3");
		expect(short.output).toContain("expected 3");

		const all = await runCell(
			dir,
			`r = edit(${JSON.stringify(target)}, "marker", "replaced", count=None)\nprint(r["replacements"])`,
		);
		expect(all.status).toBe("complete");
		expect(all.output).toContain("2");
		expect(await Bun.file(target).text()).toBe("replaced\nmiddle\nreplaced\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("edit() multi-hunk is atomic: one bad anchor writes nothing, all good applies once", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "multi.txt");
		const original = "first line\nsecond line\nthird line\n";
		await Bun.write(target, original);
		const failed = await runCell(
			dir,
			`edit(${JSON.stringify(target)}, [("first line", "FIRST"), ("nope-anchor", "x"), ("third line", "THIRD")])`,
		);
		expect(failed.status).toBe("error");
		expect(failed.output).toContain("AnchorNotFoundError");
		expect(failed.output).toContain("nope-anchor");
		expect(await Bun.file(target).text()).toBe(original);

		const applied = await runCell(
			dir,
			[
				`r = edit(${JSON.stringify(target)}, [("first line", "FIRST"), ("third line", "THIRD")])`,
				'print(r["replacements"], [h["line"] for h in r["hunks"]])',
			].join("\n"),
		);
		expect(applied.status).toBe("complete");
		expect(applied.output).toContain("2 [1, 3]");
		expect(await Bun.file(target).text()).toBe("FIRST\nsecond line\nTHIRD\n");
		const writes = applied.statusEvents.filter(event => event.op === "write" && event.path === target);
		expect(writes.length).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("write() stale guard trips after an external mutation, guard=False bypasses", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "stale.txt");
		await Bun.write(target, "original content\n");
		const readCell = await runCell(dir, `text = read_text(${JSON.stringify(target)})\nprint(len(text))`);
		expect(readCell.status).toBe("complete");

		await Bun.write(target, "externally rewritten while the kernel held the old text\n");

		const clobber = await runCell(dir, `write(${JSON.stringify(target)}, text + "kernel-edit\\n", overwrite=True)`);
		expect(clobber.status).toBe("error");
		expect(clobber.output).toContain("StaleWriteError");
		expect(clobber.output).toContain("changed on disk");
		expect(await Bun.file(target).text()).toBe("externally rewritten while the kernel held the old text\n");

		const forced = await runCell(
			dir,
			`write(${JSON.stringify(target)}, "forced content\\n", overwrite=True, guard=False)`,
		);
		expect(forced.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("forced content\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("plain open() reads arm the guard; edit() raises stale before touching the file", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "plain-read.txt");
		await Bun.write(target, "seen by kernel\n");
		const readCell = await runCell(dir, `src = open(${JSON.stringify(target)}).read()\nprint(len(src))`);
		expect(readCell.status).toBe("complete");

		await Bun.write(target, "seen by kernel\nplus an external line the kernel never read\n");

		const editCell = await runCell(dir, `edit(${JSON.stringify(target)}, "seen by kernel", "SEEN")`);
		expect(editCell.status).toBe("error");
		expect(editCell.output).toContain("StaleWriteError");
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
				'write(p, "v1\\n")',
				"text = read_text(p)",
				'write(p, text + "v2\\n", overwrite=True)',
				'edit(p, "v2", "v2-edited")',
				'write(p, "v3\\n", overwrite=True)',
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

test("read_text() slices 1-indexed inclusive and numbers lines in diff format", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "sliced.txt");
		await Bun.write(target, "l1\nl2\nl3\nl4\nl5\n");
		const cell = await runCell(
			dir,
			[
				`p = ${JSON.stringify(target)}`,
				"print(repr(read_text(p, start=2, end=4)))",
				"print(read_text(p, start=4, numbered=True))",
				"print(repr(read_text(p)))",
			].join("\n"),
		);
		expect(cell.status).toBe("complete");
		expect(cell.output).toContain("'l2\\nl3\\nl4'");
		expect(cell.output).toContain("4|l4\n5|l5");
		expect(cell.output).toContain("'l1\\nl2\\nl3\\nl4\\nl5\\n'");

		const beyond = await runCell(dir, "read_text(p, start=99)");
		expect(beyond.status).toBe("error");
		expect(beyond.output).toContain("start line 99 is beyond end of file (5 lines)");
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
