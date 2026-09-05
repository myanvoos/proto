import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { EvalCellResult, EvalStatusEvent } from "../eval/types";
import type { ToolSession } from ".";
import { EvalTool } from "./eval";

const KERNEL_OWNER = `eval-patch-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings: Record<string, unknown> = {};
	return {
		cwd,
		settings: {
			get: (key: string) => settings[key],
		},
		getEvalSessionId: () => "eval-patch-test",
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

interface PatchCellResult {
	status: EvalCellResult["status"] | undefined;
	output: string;
	statusEvents: EvalStatusEvent[];
}

async function runCell(dir: string, code: string): Promise<PatchCellResult> {
	const result = await new EvalTool(stubSession(dir)).execute("eval-patch-test", {
		language: "py",
		code,
		title: "apply patch",
		timeout: 60,
	});
	return {
		status: result.details?.cells?.[0]?.status,
		output: result.details?.cells?.[0]?.output ?? "",
		statusEvents: result.details?.cells?.[0]?.statusEvents ?? [],
	};
}

async function makeDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "eval-patch-"));
}

function writeCalls(cell: PatchCellResult, target: string): EvalStatusEvent[] {
	return cell.statusEvents.filter(event => event.op === "write" && event.path === target);
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("apply_patch applies separated exact hunks in source order", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "separated.txt");
		await Bun.write(target, "intro\nold one\nbetween\nold two\noutro\n");
		const patch = ["@@", "-old one", "+new one", "@@", "-old two", "+new two"].join("\n");
		const cell = await runCell(dir, `apply_patch(${JSON.stringify(target)}, ${JSON.stringify(patch)})`);
		expect(cell.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("intro\nnew one\nbetween\nnew two\noutro\n");
		const writes = writeCalls(cell, target);
		expect(writes).toHaveLength(1);
		expect(String(writes[0]?.diff)).toContain("-2|old one");
		expect(String(writes[0]?.diff)).toContain("+2|new one");
		expect(String(writes[0]?.diff)).toContain("-4|old two");
		expect(String(writes[0]?.diff)).toContain("+4|new two");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("apply_patch validates every hunk before writing", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "invalid.txt");
		const source = "repeat\nrepeat\nfirst\nsecond\nthird\n";
		await Bun.write(target, source);
		const cases = [
			{
				name: "ambiguous",
				patch: ["@@", " repeat", "+insert"].join("\n"),
				index: "hunk 1",
			},
			{
				name: "anchorless",
				patch: ["@@", "+insert"].join("\n"),
				index: "hunk 1",
			},
			{
				name: "nul",
				patch: `@@\n-first\0\n+FIRST`,
				index: "hunk 1",
			},
			{
				name: "missing",
				patch: ["@@", " nowhere", "+insert"].join("\n"),
				index: "hunk 1",
			},
			{
				name: "late",
				patch: ["@@", " repeat", "-first", "+FIRST", " second", "@@", " nowhere", "-nowhere", "+NOWHERE"].join(
					"\n",
				),
				index: "hunk 2",
			},
			{
				name: "malformed",
				patch: ["@@ -1 +1 @@", " first", "-first", "+FIRST"].join("\n"),
				index: "hunk 1",
			},
		];
		for (const { name, patch, index } of cases) {
			const cell = await runCell(dir, `apply_patch(${JSON.stringify(target)}, ${JSON.stringify(patch)})`);
			expect(cell.status, name).toBe("error");
			expect(cell.output, name).toContain(target);
			expect(cell.output, name).toContain(index);
			expect(writeCalls(cell, target), name).toHaveLength(0);
			expect(await Bun.file(target).text(), name).toBe(source);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a failed match does not arm the private source read as stale", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "failed-read.txt");
		await Bun.write(target, "before\n");
		const missing = await runCell(
			dir,
			`apply_patch(${JSON.stringify(target)}, ${JSON.stringify(["@@", " nowhere", "+insert"].join("\n"))})`,
		);
		expect(missing.status).toBe("error");
		await Bun.write(target, "after\n");
		const applied = await runCell(
			dir,
			`apply_patch(${JSON.stringify(target)}, ${JSON.stringify(["@@", "-after", "+done"].join("\n"))})`,
		);
		expect(applied.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("done\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("apply_patch checks the stale stamp before its private source read", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "stale.txt");
		await Bun.write(target, "original\n");
		const read = await runCell(dir, `seen = Path(${JSON.stringify(target)}).read_text()`);
		expect(read.status).toBe("complete");
		await Bun.write(target, "external replacement\n");
		const patch = ["@@", " original", "-original", "+kernel"].join("\n");
		const cell = await runCell(dir, `apply_patch(${JSON.stringify(target)}, ${JSON.stringify(patch)})`);
		expect(cell.status).toBe("error");
		expect(cell.output).toContain("StaleWriteError");
		expect(cell.output).toContain(target);
		expect(await Bun.file(target).text()).toBe("external replacement\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("apply_patch preserves mixed endings and a missing final newline", async () => {
	const dir = await makeDir();
	try {
		const target = path.join(dir, "endings.txt");
		await Bun.write(target, "alpha\r\nbeta\r\ngamma");

		const insert = await runCell(
			dir,
			[
				`patch_target = ${JSON.stringify(target)}`,
				`apply_patch(patch_target, ${JSON.stringify(["@@", " gamma", "+delta"].join("\n"))})`,
			].join("\n"),
		);
		expect(insert.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("alpha\r\nbeta\r\ngamma\r\ndelta");
		expect((await Bun.file(target).text()).endsWith("\n")).toBe(false);
		expect(String(writeCalls(insert, target)[0]?.diff)).toContain("+4|delta");

		const remove = await runCell(
			dir,
			`apply_patch(${JSON.stringify(target)}, ${JSON.stringify(["@@", " gamma", "-delta"].join("\n"))})`,
		);
		expect(remove.status).toBe("complete");
		expect(await Bun.file(target).text()).toBe("alpha\r\nbeta\r\ngamma");
		expect(String(writeCalls(remove, target)[0]?.diff)).toContain("-4|delta");

		const mixedTarget = path.join(dir, "mixed.txt");
		await Bun.write(mixedTarget, "one\r\ntwo\nthree");
		const mixed = await runCell(
			dir,
			`apply_patch(${JSON.stringify(mixedTarget)}, ${JSON.stringify(["@@", " one", "-two", "+TWO", " three"].join("\n"))})`,
		);
		expect(mixed.status).toBe("complete");
		expect(await Bun.file(mixedTarget).text()).toBe("one\r\nTWO\nthree");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
