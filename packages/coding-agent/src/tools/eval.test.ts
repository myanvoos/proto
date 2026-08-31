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
test("kernel edit family guards: write refuses overwrite, edit guards by occurrence count and divergence", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-edit-family-"));
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
			'r2 = check(edit, "guard.txt")',
			'edit("guard.txt", "v2", "v3")',
			'r3 = check(edit, "guard.txt", "v3", "v4", 2)',
			'write("multi.txt", "alpha\\nbeta\\n")',
			'r4 = check(edit, "multi.txt", "alpha\\nGONE\\n", "x")',
			'edit("multi.txt", "alpha\\nbeta\\n", "alpha\\ngamma\\n")',
			'print("R1", r1)',
			'print("R2", r2)',
			'print("R3", r3)',
			'print("R4", r4)',
			'print("CONTENT", Path("multi.txt").read_text())',
		].join("\n");
		const result = await tool.execute("eval-fs-diff-test", {
			language: "py",
			code,
			title: "edit family guards",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const out = String(result.details?.cells?.[0]?.output ?? "");
		expect(out).toContain("R1 RuntimeError");
		expect(out).toContain("R2 TypeError");
		expect(out).toContain("R3 RuntimeError");
		expect(out).toContain("expected 2 occurrence(s)");
		expect(out).toContain("R4 RuntimeError");
		expect(out).toContain("first difference at line 2: current 'beta', expected 'GONE'");
		expect(out).toContain("CONTENT alpha\ngamma");
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
			code: ['edit("tracked.txt", "original line", "PRELUDE-REPLACED")', 'print("cell-done")'].join("\n"),
			title: "prelude dedupe regression",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const fileEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(
			event => event.op === "write" || event.op === "edit",
		);
		const forTracked = fileEvents.filter(event => path.resolve(String(event.path)) === path.join(dir, "tracked.txt"));
		expect(forTracked.length, "prelude edit is reported exactly once for the changed file").toBe(1);
		expect(forTracked[0]?.op).toBe("edit");
		expect(path.isAbsolute(String(forTracked[0]?.path)), "prelude event paths are absolute").toBe(true);
		expect(String(forTracked[0]?.diff)).toContain("PRELUDE-REPLACED");

		const topLevel = result.details?.statusEvents ?? [];
		expect(
			topLevel.filter(
				event => (event.op === "write" || event.op === "edit") && String(event.path).endsWith("tracked.txt"),
			).length,
		).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("fs walker dedupes prelude edits above the diff cap and reports byte sizes for untext-able files", async () => {
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
				'edit("big.txt", "MARKER original", "MARKER replaced")',
				'Path("big-created.txt").write_text("\\n".join(["x" * 50] * 800) + "\\n")',
				'print("cell-done")',
			].join("\n"),
			title: "oversized dedupe regression",
			timeout: 60,
		});

		expect(result.details?.cells?.[0]?.status).toBe("complete");
		const fileEvents = (result.details?.cells?.[0]?.statusEvents ?? []).filter(
			event => event.op === "write" || event.op === "edit",
		);

		const bigEdit = fileEvents.filter(event => path.resolve(String(event.path)) === path.join(dir, "big.txt"));
		expect(bigEdit.length, "oversized prelude edit is reported exactly once").toBe(1);
		expect(bigEdit[0]?.op).toBe("edit");
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
