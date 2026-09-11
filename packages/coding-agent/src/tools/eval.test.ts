import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { EvalToolDetails } from "../eval/types";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";
import { KernelTool } from "./kernel";

const KERNEL_OWNER = `eval-fs-diff-test:${process.pid}`;

test("eval and kernel schemas reject pre-execution file writes", async () => {
	const evalTool = new EvalTool(null);
	const kernelTool = new KernelTool(null);
	const evalSchema = evalTool.parameters.toJsonSchema() as { properties?: Record<string, unknown> };
	const kernelSchema = kernelTool.parameters.toJsonSchema() as { properties?: Record<string, unknown> };

	expect(evalSchema.properties ?? {}).not.toHaveProperty("files");
	expect(kernelSchema.properties ?? {}).not.toHaveProperty("files");

	const evalValidation = await evalTool.parameters["~standard"].validate({ language: "py", code: "", files: [] });
	const kernelValidation = await kernelTool.parameters["~standard"].validate({ code: "", files: [] });
	expect(evalValidation).toHaveProperty("issues");
	expect(kernelValidation).toHaveProperty("issues");
});

function stubSession(cwd: string, skills?: ToolSession["skills"]): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		skills,
		settings: {
			get: (key: string) => settings.get(key),
		},
		getEvalSessionId: () => "eval-fs-diff-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("kernel audit hook reports plain open() writes outside the walker root", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-hook-outside-"));
	const outside = path.join(os.tmpdir(), `eval-hook-out-${process.pid}-${Date.now()}.txt`);
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [
			`with open(${JSON.stringify(outside)}, "w") as f:`,
			'    f.write("brand new line\\n")',
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-hook-outside-test", {
			language: "py",
			code,
			title: "hook outside root",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");
		const event = cellEvents.find(e => e.path === outside);
		expect(event, "audit hook emits a write event for a plain open() outside session cwd").toBeDefined();
		expect(String(event?.diff)).toContain("+1|brand new line");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("kernel audit hook reports each written file exactly once per cell", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-hook-dedupe-"));
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [
			"# plain append via open()",
			'with open("plain.txt", "w") as f:',
			'    f.write("original line\\n")',
			'with open("plain.txt", "a") as f:',
			'    f.write("appended by plain open\\n")',
			"# read-mode open must not be recorded",
			'open("plain.txt").close()',
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-hook-dedupe-test", {
			language: "py",
			code,
			title: "hook dedupe",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");

		const plain = cellEvents.filter(event => event.path === path.join(dir, "plain.txt"));
		expect(plain.length, "plain open() write is reported exactly once (hook + walker dedupe)").toBe(1);
		expect(String(plain[0]?.diff)).toContain("appended by plain open");
		expect(String(plain[0]?.diff)).toContain("original line");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a file written twice in one cell reports one event with the cumulative diff", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-flush-base-"));
	try {
		await Bun.write(path.join(dir, "b.txt"), "orig\n");
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'open("a.txt", "w").write("alpha\\nbeta\\n")',
			'with open("a.txt", "a") as f:',
			'    f.write("gamma\\n")',
			'open("b.txt", "w").write("orig\\none\\n")',
			'with open("b.txt", "a") as f:',
			'    f.write("two\\n")',
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-flush-base-test", {
			language: "py",
			code,
			title: "flush base",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const eventsFor = (name: string) =>
			(result.details?.cells?.[0]?.statusEvents ?? []).filter(
				event => event.op === "write" && event.path === path.join(dir, name),
			);

		const a = eventsFor("a.txt");
		expect(a.length, "created-then-appended file reports one cumulative event").toBe(1);
		expect(String(a[0]?.diff)).toContain("+1|alpha");
		expect(String(a[0]?.diff)).toContain("+3|gamma");

		const b = eventsFor("b.txt");
		expect(b.length, "preexisting written-then-appended file reports one cumulative event").toBe(1);
		expect(String(b[0]?.diff)).toContain("+2|one");
		expect(String(b[0]?.diff)).toContain("+3|two");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("kernel audit hook reports deletes once with diff", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-hook-delete-"));
	try {
		await Bun.write(path.join(dir, "doomed.txt"), "doomed content line\n");
		const tool = new EvalTool(stubSession(dir));
		const code = `import os\nos.remove(${JSON.stringify(path.join(dir, "doomed.txt"))})\nprint("done")`;
		const result = await tool.execute("eval-hook-delete-test", {
			language: "py",
			code,
			title: "hook delete",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = result.details?.cells?.[0]?.statusEvents ?? [];
		const deletes = cellEvents.filter(event => event.op === "delete" && event.path === path.join(dir, "doomed.txt"));
		expect(deletes.length, "delete is reported exactly once (hook + walker dedupe)").toBe(1);
		expect(String(deletes[0]?.diff)).toContain("-1|doomed content line");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("kernel audit hook skips cache dirs, bytecode, and unchanged rewrites", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-hook-noise-"));
	try {
		await Bun.write(path.join(dir, "touched.txt"), "stable content\n");
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'os.makedirs(".cache", exist_ok=True)',
			'with open(".cache/noise.bin", "wb") as f:',
			'    f.write(b"x")',
			'with open("module.pyc", "wb") as f:',
			'    f.write(b"x")',
			"# rewrite identical bytes: mtime changes, sha does not",
			'f = open("touched.txt", "r+")',
			"f.seek(0)",
			'f.write("stable content\\n")',
			"f.close()",
			"# positive control: a real change is still reported",
			'with open("changed.txt", "w") as f:',
			'    f.write("real change\\n")',
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-hook-noise-test", {
			language: "py",
			code,
			title: "hook noise",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = result.details?.cells?.[0]?.statusEvents ?? [];
		const reported = cellEvents
			.filter(event => event.op === "write" || event.op === "delete")
			.map(event => String(event.path));
		expect(
			reported,
			"pruned dirs and bytecode stay unreported; only real changes and the walker's baseline-less mtime event appear",
		).toEqual([path.join(dir, "changed.txt"), path.join(dir, "touched.txt")]);
		const changed = cellEvents.find(event => event.op === "write" && event.path === path.join(dir, "changed.txt"));
		expect(String(changed?.diff)).toContain("+1|real change");
		const touched = cellEvents.find(event => event.op === "write" && event.path === path.join(dir, "touched.txt"));
		expect(touched?.diff, "content-identical rewrite carries no diff rows").toBeUndefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("js kernel fs tracker reports raw fs writes outside the walker root", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-hook-outside-"));
	const outside = path.join(os.tmpdir(), `eval-js-hook-out-${process.pid}-${Date.now()}.txt`);
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'import * as fs from "node:fs";',
			`fs.writeFileSync(${JSON.stringify(outside)}, "fresh js bytes\\n");`,
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-js-hook-outside-test", {
			language: "js",
			code,
			title: "js hook outside root",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");
		const event = cellEvents.find(e => e.path === outside);
		expect(event, "tracker emits a write event for a raw fs.writeFileSync outside session cwd").toBeDefined();
		expect(String(event?.diff)).toContain("+1|fresh js bytes");
		expect(typeof event?.sha).toBe("string");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a js kernel Bun.write emits one deduped event with diff", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-helper-"));
	const outside = path.join(os.tmpdir(), `eval-js-helper-${process.pid}-${Date.now()}.txt`);
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [`await Bun.write(${JSON.stringify(outside)}, "Bun wrote this\\n");`, 'print("done")'].join("\n");
		const result = await tool.execute("eval-js-helper-test", {
			language: "js",
			code,
			title: "js helper write",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");
		const events = cellEvents.filter(e => e.path === outside);
		expect(events.length, "the tracked write is reported exactly once").toBe(1);
		expect(String(events[0]?.diff)).toContain("+1|Bun wrote this");
		expect(typeof events[0]?.sha).toBe("string");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a js kernel file written twice reports one event with the cumulative diff", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-flush-base-"));
	const outside = path.join(os.tmpdir(), `eval-js-flush-base-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(path.join(dir, "b.txt"), "orig\n");
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'import * as fs from "node:fs";',
			`await Bun.write(${JSON.stringify(outside)}, "alpha\\nbeta\\n");`,
			`fs.appendFileSync(${JSON.stringify(outside)}, "gamma\\n");`,
			`await Bun.write(${JSON.stringify(path.join(dir, "b.txt"))}, "orig\\none\\n");`,
			`fs.appendFileSync(${JSON.stringify(path.join(dir, "b.txt"))}, "two\\n");`,
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-js-flush-base-test", {
			language: "js",
			code,
			title: "js flush base",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const eventsFor = (name: string) =>
			(result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write" && event.path === name);

		const a = eventsFor(outside);
		expect(a.length, "created-then-appended file reports one cumulative event").toBe(1);
		expect(String(a[0]?.diff)).toContain("+1|alpha");
		expect(String(a[0]?.diff)).toContain("+3|gamma");

		const b = eventsFor(path.join(dir, "b.txt"));
		expect(b.length, "preexisting written-then-appended file reports one cumulative event").toBe(1);
		expect(String(b[0]?.diff)).toContain("+2|one");
		expect(String(b[0]?.diff)).toContain("+3|two");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("js protoPath resolves a leading ~ for the raw file APIs", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-tilde-"));
	try {
		const home = path.join(dir, "home");
		await fs.mkdir(home);
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'const prevHome = await env("HOME");',
			`await env("HOME", ${JSON.stringify(home)});`,
			"try {",
			'  print(await Bun.write(protoPath("~/tilde.txt"), "from js\\n"));',
			"} finally {",
			'  if (prevHome !== undefined) await env("HOME", prevHome);',
			"}",
		].join("\n");
		const result = await tool.execute("eval-js-tilde-test", {
			language: "js",
			code,
			title: "js tilde write",
			timeout: 60,
		});
		expect(result.details?.cells?.[0]?.status).toBe("complete");
		expect(await Bun.file(path.join(home, "tilde.txt")).text()).toBe("from js\n");
		const literalTilde = await fs.access(path.join(dir, "~")).then(
			() => true,
			() => false,
		);
		expect(literalTilde, "no literal ~/ directory under the kernel cwd").toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("js protoPath resolves skills activated after the kernel starts", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-skill-"));
	try {
		const skillDir = path.join(dir, "example-skill");
		await Bun.write(path.join(skillDir, "SKILL.md"), "# Example skill\n");
		await Bun.write(path.join(skillDir, "notes.txt"), "skill notes\n");
		const session = stubSession(dir);
		const tool = new EvalTool(session);
		const started = await tool.execute("eval-js-skill-start-test", {
			language: "js",
			code: 'print("started");',
			title: "start js kernel",
			timeout: 60,
		});
		expect(started.details?.cells?.[0]?.status).toBe("complete");
		session.skills = [
			{
				name: "example",
				description: "test skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		];
		const result = await tool.execute("eval-js-skill-test", {
			language: "js",
			code: [
				'print(protoPath("skill://example"));',
				'print(await Bun.file(protoPath("skill://example/notes.txt")).text());',
			].join("\n"),
			title: "js skill path",
			timeout: 60,
		});
		const cell = result.details?.cells?.[0];
		expect(cell?.status).toBe("complete");
		expect(cell?.output).toContain(skillDir);
		expect(cell?.output).toContain("skill notes");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("js kernel fs tracker reports deletes once with diff", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-delete-"));
	const outside = path.join(os.tmpdir(), `eval-js-delete-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(outside, "doomed js line\n");
		const tool = new EvalTool(stubSession(dir));
		const code = ['import * as fs from "node:fs";', `fs.rmSync(${JSON.stringify(outside)});`, 'print("done")'].join(
			"\n",
		);
		const result = await tool.execute("eval-js-delete-test", {
			language: "js",
			code,
			title: "js delete",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = result.details?.cells?.[0]?.statusEvents ?? [];
		const deletes = cellEvents.filter(event => event.op === "delete" && event.path === outside);
		expect(deletes.length, "delete is reported exactly once with diff").toBe(1);
		expect(String(deletes[0]?.diff)).toContain("-1|doomed js line");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("js kernel fs tracker covers Bun.write and prunes cache dirs", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-bunwrite-"));
	const outside = path.join(os.tmpdir(), `eval-js-bunwrite-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(path.join(dir, "touched.txt"), "stable content\n");
		const pastSeconds = Date.now() / 1000 - 2;
		await fs.utimes(path.join(dir, "touched.txt"), pastSeconds, pastSeconds);
		const tool = new EvalTool(stubSession(dir));
		const code = [
			`await Bun.write(${JSON.stringify(outside)}, "bun wrote this\\n");`,
			'import * as fs from "node:fs";',
			'fs.mkdirSync(".cache", { recursive: true });',
			'fs.writeFileSync(".cache/noise.bin", "x");',
			'fs.writeFileSync("touched.txt", "stable content\\n");',
			'fs.writeFileSync("changed.txt", "real js change\\n");',
			'print("done")',
		].join("\n");
		const result = await tool.execute("eval-js-bunwrite-test", {
			language: "js",
			code,
			title: "js bun.write + prune",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = result.details?.cells?.[0]?.statusEvents ?? [];
		const reported = cellEvents
			.filter(event => event.op === "write" || event.op === "delete")
			.map(event => String(event.path));
		expect(
			reported.toSorted(),
			"only real changes, Bun.write, and the walker's baseline-less mtime event appear",
		).toEqual([outside, path.join(dir, "changed.txt"), path.join(dir, "touched.txt")].toSorted());
		const bunEvent = cellEvents.find(event => event.op === "write" && event.path === outside);
		expect(String(bunEvent?.diff)).toContain("+1|bun wrote this");
		const touched = cellEvents.find(event => event.op === "write" && event.path === path.join(dir, "touched.txt"));
		expect(touched?.diff, "content-identical rewrite carries no diff rows").toBeUndefined();
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("a second raw write wholly replaces the file the kernel itself wrote", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-write-guard-"));
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'open("guard.txt", "w").write("v1")',
			'open("guard.txt", "w").write("v2")',
			'print("CONTENT", Path("guard.txt").read_text())',
		].join("\n");
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code,
			title: "write replaces existing file",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const out = String(result.details?.cells?.[0]?.output ?? "");
		expect(out).toContain("CONTENT v2");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("stale-write guard stays armed past the read-seen cap via FIFO eviction", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-guard-evict-"));
	try {
		// 8192 dummy reads saturate _FS_READ_SEEN_MAX; the guarded file is read
		// last, so with eviction its record survives and an external mutation
		// between cells must trip the guard. Without eviction the record is
		// silently refused and the write succeeds unchecked.
		await Promise.all(
			Array.from({ length: 8192 }, (_, i) =>
				Bun.write(path.join(dir, `dummy-${String(i).padStart(4, "0")}.txt`), "d\n"),
			),
		);
		await Bun.write(path.join(dir, "guarded.txt"), "original\n");
		const tool = new EvalTool(stubSession(dir));
		const readCell = [
			"from pathlib import Path",
			"for i in range(8192):",
			'    Path(f"dummy-{i:04d}.txt").read_text()',
			'Path("guarded.txt").read_text()',
			"print('read-done')",
		].join("\n");
		const readResult = await tool.execute("eval-guard-evict-read", { language: "py", code: readCell, timeout: 120 });
		expect(readResult.details?.cells?.[0]?.status).toBe("complete");
		expect(String(readResult.details?.cells?.[0]?.output ?? "")).toContain("read-done");

		await Bun.write(path.join(dir, "guarded.txt"), "externally changed\n");

		const writeCell = [
			"def check(fn):",
			"    try:",
			'        open(fn, "w").write("v2")',
			'        return "ok"',
			"    except Exception as err:",
			'        return type(err).__name__ + ": " + str(err)[:200]',
			'print("RESULT", check("guarded.txt"))',
		].join("\n");
		const writeResult = await tool.execute("eval-guard-evict-write", {
			language: "py",
			code: writeCell,
			timeout: 60,
		});
		expect(writeResult.details?.cells?.[0]?.status).toBe("complete");
		const out = String(writeResult.details?.cells?.[0]?.output ?? "");
		expect(out).toContain("RESULT StaleWriteError");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("pre-mutation snapshots stop retaining text past the aggregate capture budget", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-capture-budget-"));
	try {
		const chunk = `${"x".repeat(1000)}\n`.repeat(4300);
		// Four saturating snapshots (4 x ~4.3 MB > 16 MB budget) plus a fifth file
		// whose pre-mutation content must not be retained.
		await Promise.all([
			...Array.from({ length: 4 }, (_, i) => Bun.write(path.join(dir, `big-${i}.txt`), chunk)),
			Bun.write(path.join(dir, "changed.txt"), "original\n"),
		]);
		const tool = new EvalTool(stubSession(dir));
		const cell = [
			"from pathlib import Path",
			"for i in range(4):",
			'    p = Path(f"big-{i}.txt")',
			'    p.write_text("x\\n" + p.read_text())',
			'open("changed.txt", "w").write("x")',
			"print('cell-done')",
		].join("\n");
		const result = await tool.execute("eval-capture-budget", { language: "py", code: cell, timeout: 120 });

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = result.details?.cells?.[0]?.statusEvents ?? [];
		const forPath = (name: string) =>
			cellEvents.filter(event => event.op === "write" && path.resolve(String(event.path)) === path.join(dir, name));
		const changed = forPath("changed.txt");
		expect(changed.length, "over-budget changed file is reported exactly once").toBe(1);
		expect(
			changed[0]?.diff,
			"over-budget snapshot carries no diff instead of a fake one against empty",
		).toBeUndefined();
		expect(changed[0]?.chars).toBe(1);
		expect(typeof changed[0]?.sha).toBe("string");
		for (let i = 0; i < 4; i++) {
			const big = forPath(`big-${i}.txt`);
			expect(big.length, `big-${i} is reported exactly once`).toBe(1);
			expect(String(big[0]?.diff), "in-budget snapshot still diffs").toContain("+1|x");
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("js capture budget stops retaining text past the aggregate budget but keeps sha dedupe", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-budget-"));
	const outside = `${dir}-outside`;
	try {
		await fs.mkdir(outside, { recursive: true });
		const chunk = `${"x".repeat(1000)}\n`.repeat(5000);
		// Four saturating snapshots (4 x 5 MB > 16 MB budget) plus a fifth file
		// whose pre-mutation content must not be retained, and an outside-cwd
		// file rewritten with identical content (invisible to the walker, so
		// any event for it can only come from the flush).
		await Promise.all([
			...Array.from({ length: 4 }, (_, i) => Bun.write(path.join(dir, `big-${i}.txt`), chunk)),
			Bun.write(path.join(dir, "changed.txt"), "original\n"),
			Bun.write(path.join(outside, "same.txt"), "same\n"),
		]);
		const tool = new EvalTool(stubSession(dir));
		const cell = [
			'import * as fs from "node:fs";',
			"for (let i = 0; i < 4; i++) {",
			`  const p = \`big-\${i}.txt\`;`,
			'  fs.writeFileSync(p, "x\\n" + fs.readFileSync(p, "utf8"));',
			"}",
			'fs.writeFileSync("changed.txt", "x");',
			`const OUT = ${JSON.stringify(path.join(outside, "same.txt"))};`,
			'fs.writeFileSync(OUT, "same\\n");',
			'print("cell-done")',
		].join("\n");
		const result = await tool.execute("eval-js-capture-budget", { language: "js", code: cell, timeout: 120 });

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = result.details?.cells?.[0]?.statusEvents ?? [];
		const forPath = (target: string) =>
			cellEvents.filter(event => event.op === "write" && path.resolve(String(event.path)) === target);
		const changed = forPath(path.join(dir, "changed.txt"));
		expect(changed.length, "over-budget changed file is reported exactly once").toBe(1);
		expect(
			changed[0]?.diff,
			"over-budget snapshot carries no diff instead of a fake one against empty",
		).toBeUndefined();
		expect(changed[0]?.chars).toBe(1);
		expect(typeof changed[0]?.sha).toBe("string");
		for (let i = 0; i < 4; i++) {
			const big = forPath(path.join(dir, `big-${i}.txt`));
			expect(big.length, `big-${i} is reported exactly once`).toBe(1);
			expect(String(big[0]?.diff), "in-budget snapshot still diffs").toContain("+1|x");
		}
		const same = forPath(path.join(outside, "same.txt"));
		expect(
			same.length,
			"content-identical rewrite past the budget is deduped by the kept sha, not phantom-reported",
		).toBe(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	}
}, 60000);

test("Eval execution metadata ignores timeout-looking output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-meta-success-"));
	try {
		const result = await new EvalTool(stubSession(dir)).execute("eval-meta-success", {
			language: "py",
			code: 'print("timeout: 60")',
			timeout: 30,
		});
		expect(result.isError ?? false).toBe(false);
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode).toBe(0);
		expect(result.details?.execution?.timeout).toBeUndefined();
		expect(result.details?.execution?.elapsedMs).toBeGreaterThanOrEqual(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("Eval failed status outranks checks-passed output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-meta-failure-"));
	try {
		const result = await new EvalTool(stubSession(dir)).execute("eval-meta-failure", {
			language: "py",
			code: 'raise RuntimeError("all checks passed")',
			timeout: 30,
		});
		expect(result.isError).toBe(true);
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode).toBe(1);
		expect(result.details?.execution?.timeout).toBeUndefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("Eval child timeout reports unknown process state and cell scope", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-meta-timeout-"));
	try {
		const result = await new EvalTool(stubSession(dir)).execute("eval-meta-timeout", {
			language: "py",
			code: "import time\ntime.sleep(120)",
			timeout: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.details?.execution?.state).toBe("unknown");
		expect(result.details?.execution?.exitCode).toBeUndefined();
		expect(result.details?.execution?.timeout).toMatchObject({ cause: "idle", scope: "pipeline" });
		expect(result.details?.cells?.[0]?.execution?.timeout).toMatchObject({ cause: "idle", scope: "cell" });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("Eval collector failure does not change successful process status", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-meta-collector-"));
	try {
		const session = {
			...stubSession(dir),
			allocateOutputArtifact: async () => ({ id: "collector-failure", path: "/dev/null/proto-eval-output.log" }),
		} as ToolSession;
		const result = await new EvalTool(session).execute("eval-meta-collector", {
			language: "py",
			code: 'print("x" * 60000)',
			timeout: 30,
		});
		expect(result.isError ?? false).toBe(false);
		expect(result.details?.execution?.state).toBe("exited");
		expect(result.details?.execution?.exitCode).toBe(0);
		expect(result.details?.execution?.collector.state).toBe("failed");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("running Eval updates carry pipeline metadata separately from output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-meta-running-"));
	try {
		const updates: Array<{ state?: string }> = [];
		await new EvalTool(stubSession(dir)).execute(
			"eval-meta-running",
			{ language: "py", code: 'import time\ntime.sleep(0.1)\nprint("all checks passed")', timeout: 30 },
			undefined,
			update => {
				updates.push({ state: update.details?.execution?.state });
			},
		);
		expect(updates.some(update => update.state === "running")).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30000);

// The live view must show a write's hunk when the write happens, not when the
// cell settles: a cell that edits a file and then keeps running for a while
// used to withhold every hunk until its last line printed.
for (const [language, code] of [
	[
		"py",
		[
			"import time",
			'open("live.txt", "w").write("first\\n")',
			'print("wrote")',
			"time.sleep(0.4)",
			'print("end")',
		].join("\n"),
	],
	[
		"js",
		[
			'import * as fs from "node:fs";',
			'fs.writeFileSync("live.txt", "first\\n");',
			'print("wrote");',
			"await Bun.sleep(400);",
			'print("end");',
		].join("\n"),
	],
] as const) {
	test(`${language} write hunks stream before the cell finishes`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `eval-live-${language}-`));
		try {
			const updates: Array<{ output: string; writes: number }> = [];
			const result = await new EvalTool(stubSession(dir)).execute(
				`eval-live-${language}`,
				{ language, code, timeout: 30 },
				undefined,
				update => {
					const cell = (update.details as EvalToolDetails | undefined)?.cells?.[0];
					updates.push({
						output: cell?.output ?? "",
						writes: (cell?.statusEvents ?? []).filter(event => event.op === "write").length,
					});
				},
			);
			const firstWrite = updates.find(update => update.writes > 0);
			expect(firstWrite, "a write event reaches the live update stream").toBeDefined();
			expect(firstWrite?.output ?? "", "the hunk arrives before the cell's final line prints").not.toContain("end");
			const writes = (result.details?.cells?.[0]?.statusEvents ?? []).filter(
				event => event.op === "write" && event.path === path.join(dir, "live.txt"),
			);
			expect(writes.length, "the settled cell still reports the path once").toBe(1);
			expect(String(writes[0]?.diff)).toContain("+1|first");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30000);
}
