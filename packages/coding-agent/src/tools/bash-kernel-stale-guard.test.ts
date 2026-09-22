import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

// Contract: the stale-write guard covers every way a kernel cell can destroy content it has
// not re-read — not just write-mode opens. os.replace is the recommended atomic-write idiom,
// os.truncate and os.remove destroy a file without ever opening it for writing, and the JS
// kernel already guards the whole set through TRACKED_NAMES in eval/js/shared/fs-tracker.ts.
const KERNEL_OWNER = `kernel-stale-guard-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `kernel-stale-guard-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function runCell(tool: BashTool, id: string, language: "python" | "node", code: string): Promise<string> {
	const result = await tool.execute(id, { command: `${language} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__` });
	return textOf(result);
}

const TARGETS = ["viaReplace", "viaTruncate", "viaRemove", "viaOpen"] as const;

async function seed(dir: string): Promise<void> {
	for (const name of TARGETS) await Bun.write(path.join(dir, `${name}.txt`), "original\n");
}

/** Edited by this test process: the kernel never sees it, exactly like a third-party editor. */
async function editExternally(dir: string): Promise<void> {
	for (const name of TARGETS) await Bun.write(path.join(dir, `${name}.txt`), "EXTERNAL-EDIT\n");
}

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
});

test("python kernel: os.replace, os.truncate and os.remove refuse to destroy an unseen edit", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-stale-py-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await seed(dir);
		const read = await runCell(
			tool,
			"py-read",
			"python",
			[
				"from pathlib import Path",
				"import os",
				"seen = {n: Path(n + '.txt').read_text() for n in ['viaReplace', 'viaTruncate', 'viaRemove', 'viaOpen']}",
				"print('READ', sorted(seen))",
			].join("\n"),
		);
		expect(read).toContain("READ");

		await editExternally(dir);

		const out = await runCell(
			tool,
			"py-destructive",
			"python",
			[
				"from pathlib import Path",
				"import os",
				"def check(fn):",
				"    try:",
				"        fn()",
				"        return 'NO-GUARD'",
				"    except Exception as err:",
				"        return type(err).__name__",
				"Path('staged.tmp').write_text('kernel\\n')",
				"print('replace', check(lambda: os.replace('staged.tmp', 'viaReplace.txt')))",
				"print('truncate', check(lambda: os.truncate('viaTruncate.txt', 0)))",
				"print('remove', check(lambda: os.remove('viaRemove.txt')))",
				"print('open', check(lambda: open('viaOpen.txt', 'w').write('kernel\\n')))",
			].join("\n"),
		);
		expect(out).toContain("replace StaleWriteError");
		expect(out).toContain("truncate StaleWriteError");
		expect(out).toContain("remove StaleWriteError");
		expect(out).toContain("open StaleWriteError");
		for (const name of TARGETS) {
			expect(await Bun.file(path.join(dir, `${name}.txt`)).text()).toBe("EXTERNAL-EDIT\n");
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120000);

test("python kernel: the same destructive ops still run once the cell re-reads the file", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-stale-py-ok-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(path.join(dir, "a.txt"), "one\n");
		await Bun.write(path.join(dir, "b.txt"), "two\n");
		const out = await runCell(
			tool,
			"py-allowed",
			"python",
			[
				"from pathlib import Path",
				"import os",
				"Path('a.txt').read_text()",
				"Path('staged.tmp').write_text('replaced\\n')",
				"os.replace('staged.tmp', 'a.txt')",
				"Path('b.txt').read_text()",
				"os.remove('b.txt')",
				"print('DONE', Path('a.txt').read_text().strip(), os.path.exists('b.txt'))",
			].join("\n"),
		);
		expect(out).toContain("DONE replaced False");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120000);

test("js kernel: rename, truncate and unlink refuse the same unseen edit (parity reference)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-stale-js-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await seed(dir);
		const read = await runCell(
			tool,
			"js-read",
			"node",
			[
				"const fs = require('node:fs');",
				"for (const n of ['viaReplace', 'viaTruncate', 'viaRemove', 'viaOpen']) fs.readFileSync(n + '.txt', 'utf8');",
				"console.log('READ ok');",
			].join("\n"),
		);
		expect(read).toContain("READ ok");

		await editExternally(dir);

		const out = await runCell(
			tool,
			"js-destructive",
			"node",
			[
				"const fs = require('node:fs');",
				"const check = fn => { try { fn(); return 'NO-GUARD'; } catch (err) { return err.name; } };",
				"fs.writeFileSync('staged.tmp', 'kernel\\n');",
				"console.log('rename', check(() => fs.renameSync('staged.tmp', 'viaReplace.txt')));",
				"console.log('truncate', check(() => fs.truncateSync('viaTruncate.txt', 0)));",
				"console.log('unlink', check(() => fs.unlinkSync('viaRemove.txt')));",
				"console.log('write', check(() => fs.writeFileSync('viaOpen.txt', 'kernel\\n')));",
			].join("\n"),
		);
		for (const label of ["rename", "truncate", "unlink", "write"]) {
			expect(out).toContain(`${label} StaleWriteError`);
		}
		for (const name of TARGETS) {
			expect(await Bun.file(path.join(dir, `${name}.txt`)).text()).toBe("EXTERNAL-EDIT\n");
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120000);
