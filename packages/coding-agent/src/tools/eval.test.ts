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
