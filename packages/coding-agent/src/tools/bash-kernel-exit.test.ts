import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

// Own kernel owner: every test file shares a per-owner interpreter budget, so kernel-heavy
// files must not keep growing one owner's count.
const KERNEL_OWNER = `bash-kernel-exit-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-kernel-exit-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

test("sys.exit ends a python cell with the interpreter's exit status and keeps kernel state", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pysh-exit-"));
	try {
		const bash = new BashTool(stubSession(dir));
		const clean = await bash.execute("zero", {
			command: 'python -c \'import sys; exit_state = 41; print("before"); sys.exit(0); print("after")\'',
		});
		expect(clean.isError ?? false).toBe(false);
		expect(clean.details?.execution?.exitCode).toBe(0);
		expect(textOf(clean)).toContain("before");
		expect(textOf(clean)).not.toContain("after");
		expect(textOf(clean)).not.toContain("SystemExit");

		const coded = await bash.execute("coded", { command: "python -c 'import sys; sys.exit(3)'" });
		expect(coded.isError).toBe(true);
		expect(coded.details?.execution?.exitCode).toBe(3);
		expect(textOf(coded)).not.toContain("Traceback");

		const message = await bash.execute("message", {
			command: "python -c 'import sys; sys.exit(\"fatal: bad input\")'",
		});
		expect(message.details?.execution?.exitCode).toBe(1);
		expect(textOf(message)).toContain("fatal: bad input");
		expect(textOf(message)).not.toContain("Traceback");

		const survived = await bash.execute("state", { command: "python -c 'print(\"state\", exit_state + 1)'" });
		expect(textOf(survived)).toContain("state 42");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

for (const lang of ["node", "bun"] as const) {
	test(`process.exit ends a ${lang} cell with its exit status and keeps kernel state`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${lang}sh-exit-`));
		try {
			const bash = new BashTool(stubSession(dir));
			const clean = await bash.execute("zero", {
				command: `${lang} -e 'globalThis.exitState = 41; console.log("before-exit"); process.exit(0); console.log("after-exit")'`,
			});
			expect(clean.isError ?? false).toBe(false);
			expect(clean.details?.execution?.exitCode).toBe(0);
			expect(textOf(clean)).toContain("before-exit");
			expect(textOf(clean)).not.toContain("after-exit");

			const coded = await bash.execute("coded", { command: `${lang} -e 'process.exit(5)'` });
			expect(coded.isError).toBe(true);
			expect(coded.details?.execution?.exitCode).toBe(5);
			expect(textOf(coded)).not.toContain("worker died");

			// Off the cell's awaited chain the exit still ends the cell at the call; its throw escapes uncaught.
			const callback = await bash.execute("callback", {
				command: `${lang} -e 'setImmediate(() => { process.exit(3); console.log("after-callback-exit") }); await new Promise(() => {})'`,
			});
			expect(callback.details?.execution?.exitCode).toBe(3);
			expect(textOf(callback)).not.toContain("after-callback-exit");

			// Work a finished cell left pending: its exit unwinds that callback, not the cell running now.
			await bash.execute("late-arm", {
				command: `${lang} -e 'globalThis.lateGate = Promise.withResolvers(); void lateGate.promise.then(() => setImmediate(() => { globalThis.lateExited = true; process.exit(7); globalThis.lateContinued = true }))'`,
			});
			const late = await bash.execute("late-fire", {
				command: `${lang} -e 'lateGate.resolve(); while (globalThis.lateExited !== true) await new Promise(resolve => setImmediate(resolve)); console.log("late", globalThis.lateContinued ?? "unwound")'`,
			});
			expect(late.details?.execution?.exitCode).toBe(0);
			expect(textOf(late)).toContain("late unwound");

			const survived = await bash.execute("state", { command: `${lang} -e 'console.log("state", exitState + 1)'` });
			expect(textOf(survived)).toContain("state 42");
			expect(textOf(survived)).not.toContain("state lost");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 60000);
}
