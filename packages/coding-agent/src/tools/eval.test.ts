import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `eval-fs-diff-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
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

test("cell fs walker emits write events with diffs for raw filesystem writes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-fs-diff-"));
	try {
		expect((await git.runUnchecked(dir, ["init"])).exitCode).toBe(0);
		await Bun.write(path.join(dir, "tracked.txt"), "original line\n");
		await git.runUnchecked(dir, ["add", "."]);
		expect(
			(
				await git.runUnchecked(dir, [
					"-c",
					"user.email=test@example.com",
					"-c",
					"user.name=test",
					"commit",
					"-m",
					"init",
				])
			).exitCode,
		).toBe(0);

		const tool = new EvalTool(stubSession(dir));
		const code = [
			"from pathlib import Path",
			'Path("created-by-cell.txt").write_text("fresh content line\\n")',
			'p = Path("tracked.txt")',
			'p.write_text(p.read_text().replace("original", "EDITED-BY-CELL"))',
			'print("cell-done")',
		].join("\n");
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code,
			title: "fs-diff regression",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");

		const created = cellEvents.find(event => event.path === path.join(dir, "created-by-cell.txt"));
		expect(created, "walker emits write event for file created during cell").toBeDefined();
		expect(String(created?.diff)).toContain("fresh content line");

		const modified = cellEvents.filter(event => event.path === path.join(dir, "tracked.txt"));
		expect(modified.length).toBe(1);
		expect(String(modified[0]?.diff)).toContain("EDITED-BY-CELL");
		expect(String(modified[0]?.diff)).toContain("original line");

		const topLevel = result.details?.statusEvents ?? [];
		expect(topLevel.some(event => event.op === "write" && event.path === path.join(dir, "created-by-cell.txt"))).toBe(
			true,
		);
		expect(topLevel.some(event => event.op === "write" && event.path === path.join(dir, "tracked.txt"))).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
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

test("kernel audit hook dedupes against walker and write() helper", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-hook-dedupe-"));
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [
			"# plain append via open()",
			'with open("plain.txt", "w") as f:',
			'    f.write("original line\\n")',
			'with open("plain.txt", "a") as f:',
			'    f.write("appended by plain open\\n")',
			"# helper write()",
			'write("helper.txt", "helper content\\n")',
			"# read-mode open must not be recorded",
			'open("helper.txt").close()',
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

		const helper = cellEvents.filter(event => event.path === path.join(dir, "helper.txt"));
		expect(helper.length, "write() helper emits exactly one event (no hook duplicate)").toBe(1);
		expect(String(helper[0]?.diff)).toContain("helper content");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("kernel flush diffs from last reported content after helper writes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-flush-base-"));
	try {
		await Bun.write(path.join(dir, "b.txt"), "orig\n");
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'write("a.txt", "alpha\\nbeta\\n")',
			'with open("a.txt", "a") as f:',
			'    f.write("gamma\\n")',
			'write("b.txt", "orig\\none\\n", overwrite=True)',
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
		expect(a.length, "created-then-appended file reports two events").toBe(2);
		expect(String(a[0]?.diff)).toContain("+1|alpha");
		expect(String(a[1]?.diff), "flush shows only the appended line, not the helper's hunks again").toContain(
			"+3|gamma",
		);
		expect(String(a[1]?.diff), "flush must not re-print hunks the write() event already showed").not.toContain(
			"+1|alpha",
		);

		const b = eventsFor("b.txt");
		expect(b.length, "preexisting written-then-appended file reports two events").toBe(2);
		expect(String(b[0]?.diff)).toContain("+2|one");
		expect(String(b[1]?.diff), "flush shows only the appended line").toContain("+3|two");
		expect(String(b[1]?.diff), "flush must not re-print the helper's hunk").not.toContain("+2|one");
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

test("js kernel write() helper emits one deduped event with diff", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-helper-"));
	const outside = path.join(os.tmpdir(), `eval-js-helper-${process.pid}-${Date.now()}.txt`);
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [`await write(${JSON.stringify(outside)}, "helper wrote this\\n");`, 'print("done")'].join("\n");
		const result = await tool.execute("eval-js-helper-test", {
			language: "js",
			code,
			title: "js helper write",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");
		const events = cellEvents.filter(e => e.path === outside);
		expect(events.length, "helper write is reported exactly once (helper + flush dedupe)").toBe(1);
		expect(String(events[0]?.diff)).toContain("+1|helper wrote this");
		expect(typeof events[0]?.sha).toBe("string");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("js kernel flush diffs from last reported content after helper writes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-js-flush-base-"));
	const outside = path.join(os.tmpdir(), `eval-js-flush-base-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(path.join(dir, "b.txt"), "orig\n");
		const tool = new EvalTool(stubSession(dir));
		const code = [
			'import * as fs from "node:fs";',
			`await write(${JSON.stringify(outside)}, "alpha\\nbeta\\n");`,
			`fs.appendFileSync(${JSON.stringify(outside)}, "gamma\\n");`,
			`await write(${JSON.stringify(path.join(dir, "b.txt"))}, "orig\\none\\n");`,
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
		expect(a.length, "created-then-appended file reports two events").toBe(2);
		expect(String(a[0]?.diff)).toContain("+1|alpha");
		expect(String(a[1]?.diff), "flush shows only the appended line, not the helper's hunks again").toContain(
			"+3|gamma",
		);
		expect(String(a[1]?.diff), "flush must not re-print hunks the write() event already showed").not.toContain(
			"+1|alpha",
		);

		const b = eventsFor(path.join(dir, "b.txt"));
		expect(b.length, "preexisting written-then-appended file reports two events").toBe(2);
		expect(String(b[0]?.diff)).toContain("+2|one");
		expect(String(b[1]?.diff), "flush shows only the appended line").toContain("+3|two");
		expect(String(b[1]?.diff), "flush must not re-print the helper's hunk").not.toContain("+2|one");
	} finally {
		await fs.rm(outside, { force: true });
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
		expect(reported, "only real changes, Bun.write, and the walker's baseline-less mtime event appear").toEqual([
			outside,
			path.join(dir, "changed.txt"),
			path.join(dir, "touched.txt"),
		]);
		const bunEvent = cellEvents.find(event => event.op === "write" && event.path === outside);
		expect(String(bunEvent?.diff)).toContain("+1|bun wrote this");
		const touched = cellEvents.find(event => event.op === "write" && event.path === path.join(dir, "touched.txt"));
		expect(touched?.diff, "content-identical rewrite carries no diff rows").toBeUndefined();
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("kernel write guard: refuses overwrite without overwrite=True, replaces with it", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-write-guard-"));
	try {
		const tool = new EvalTool(stubSession(dir));
		const code = [
			"def check(fn, *args, **kwargs):",
			"    try:",
			"        fn(*args, **kwargs)",
			'        return "ok"',
			"    except Exception as err:",
			'        return type(err).__name__ + ": " + str(err)[:200]',
			'write("guard.txt", "v1")',
			'r1 = check(write, "guard.txt", "v2")',
			'write("guard.txt", "v2", overwrite=True)',
			'print("R1", r1)',
			'print("CONTENT", Path("guard.txt").read_text())',
		].join("\n");
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code,
			title: "write overwrite guard",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const out = String(result.details?.cells?.[0]?.output ?? "");
		expect(out).toContain("R1 RuntimeError");
		expect(out).toContain("write() refusing to overwrite existing");
		expect(out).toContain("CONTENT v2");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("prelude file helpers report one absolute-path event without a walker duplicate", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-fs-diff-"));
	try {
		expect((await git.runUnchecked(dir, ["init"])).exitCode).toBe(0);
		await Bun.write(path.join(dir, "tracked.txt"), "original line\n");
		await git.runUnchecked(dir, ["add", "."]);
		expect(
			(
				await git.runUnchecked(dir, [
					"-c",
					"user.email=test@example.com",
					"-c",
					"user.name=test",
					"commit",
					"-m",
					"init",
				])
			).exitCode,
		).toBe(0);

		const tool = new EvalTool(stubSession(dir));
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code: ['write("tracked.txt", "PRELUDE-REPLACED\\n", overwrite=True)', 'print("cell-done")'].join("\n"),
			title: "prelude dedupe regression",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const fileEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");
		const forTracked = fileEvents.filter(event => path.resolve(String(event.path)) === path.join(dir, "tracked.txt"));
		expect(forTracked.length, "prelude write is reported exactly once for the changed file").toBe(1);
		expect(forTracked[0]?.op).toBe("write");
		expect(path.isAbsolute(String(forTracked[0]?.path)), "prelude event paths are absolute").toBe(true);
		expect(String(forTracked[0]?.diff)).toContain("PRELUDE-REPLACED");

		const topLevel = result.details?.statusEvents ?? [];
		expect(topLevel.filter(event => event.op === "write" && String(event.path).endsWith("tracked.txt")).length).toBe(
			1,
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("fs walker dedupes prelude writes above the diff cap and reports byte sizes for untext-able files", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-fs-diff-"));
	try {
		expect((await git.runUnchecked(dir, ["init"])).exitCode).toBe(0);
		const filler = `${"x".repeat(80)}\n`.repeat(3400);
		await Bun.write(path.join(dir, "big.txt"), `${filler}MARKER original\n`);
		await git.runUnchecked(dir, ["add", "."]);
		expect(
			(
				await git.runUnchecked(dir, [
					"-c",
					"user.email=test@example.com",
					"-c",
					"user.name=test",
					"commit",
					"-m",
					"init",
				])
			).exitCode,
		).toBe(0);

		const tool = new EvalTool(stubSession(dir));
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code: [
				'write("big.txt", Path("big.txt").read_text().replace("MARKER original", "MARKER replaced"), overwrite=True)',
				'Path("big-created.txt").write_text("\\n".join(["x" * 50] * 800) + "\\n")',
				'print("cell-done")',
			].join("\n"),
			title: "oversized dedupe regression",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const fileEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");

		const bigEdit = fileEvents.filter(event => path.resolve(String(event.path)) === path.join(dir, "big.txt"));
		expect(bigEdit.length, "oversized prelude write is reported exactly once").toBe(1);
		expect(bigEdit[0]?.op).toBe("write");
		expect(String(bigEdit[0]?.diff)).toContain("MARKER replaced");
		expect(bigEdit[0]?.diffTruncated).toBeUndefined();

		const created = fileEvents.filter(
			event => path.resolve(String(event.path)) === path.join(dir, "big-created.txt"),
		);
		expect(created.length).toBe(1);
		expect(created[0]?.op).toBe("write");
		expect(created[0]?.chars).toBe(40800);
		expect(String(created[0]?.diff)).toContain("xxxxx");
		expect(created[0]?.diffTruncated).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("files materialized before the cell keep their write events in the final cell result", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-fs-diff-"));
	try {
		expect((await git.runUnchecked(dir, ["init"])).exitCode).toBe(0);
		const tool = new EvalTool(stubSession(dir));
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code: 'print("cell-done")',
			title: "files param regression",
			timeout: 60,
			files: [{ path: "generated.txt", content: "hello\nworld\n" }],
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const cellEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(event => event.op === "write");
		const generated = cellEvents.filter(
			event => path.resolve(String(event.path)) === path.join(dir, "generated.txt"),
		);
		expect(generated.length, "files[] write is reported exactly once in the final cell result").toBe(1);
		expect(String(generated[0]?.diff)).toContain("hello");
		expect(typeof generated[0]?.sha).toBe("string");

		const topLevel = result.details?.statusEvents ?? [];
		expect(
			topLevel.filter(event => event.op === "write" && String(event.path).endsWith("generated.txt")).length,
		).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
