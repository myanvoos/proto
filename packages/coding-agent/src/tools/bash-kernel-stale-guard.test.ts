import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { releaseFsObservationLedger, retainFsObservationLedger } from "../eval/fs-observations";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";

// Python guards explicit atomic harness edits; native Python file APIs stay unmodified.
// JavaScript retains its existing tracked-filesystem contract.
const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
if (!availability.ok || !availability.pythonPath) throw new Error(availability.reason ?? "Python unavailable");
const PYTHON = JSON.stringify(availability.pythonPath);
const TEMP_ROOT = await fs.realpath(os.tmpdir());

const KERNEL_OWNER = `kernel-stale-guard-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	const tools = new Map<string, Tool>();
	const session = {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `kernel-stale-guard-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
		getSessionId: () => KERNEL_OWNER,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getToolForEvalBridge: (name: string) => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
	} as unknown as ToolSession;
	tools.set("bash", new BashTool(session));
	tools.set("read", new ReadTool(session));
	return session;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function runCell(tool: BashTool, id: string, language: "python" | "node", code: string): Promise<string> {
	const interpreter =
		language === "python" ? `${PYTHON} -m proto_harness.kernel main --interpreter ${PYTHON}` : language;
	if (language === "python") code = `import proto_harness as harness\n${code}`;
	const result = await tool.execute(id, { command: `${interpreter} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__` });
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

retainFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
	releaseFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);
});

test("python kernel: atomic replace and write refuse an unseen external edit", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-stale-py-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await seed(dir);
		const read = await runCell(
			tool,
			"py-read",
			"python",
			[
				"seen = {n: harness.fs.read_text(n + '.txt') for n in ['viaReplace', 'viaTruncate', 'viaRemove', 'viaOpen']}",
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
				"def check(fn):",
				"    try:",
				"        fn()",
				"        return 'NO-GUARD'",
				"    except Exception as err:",
				"        return type(err).__name__",
				"print('replace', check(lambda: harness.fs.replace('viaReplace.txt', 'original', 'kernel')))",
				"print('truncate', check(lambda: harness.fs.write_text('viaTruncate.txt', '')))",
				"print('write', check(lambda: harness.fs.write_text('viaOpen.txt', 'kernel\\n')))",
				"print('bytes', check(lambda: harness.fs.write_bytes('viaRemove.txt', b'kernel\\n')))",
			].join("\n"),
		);
		for (const label of ["replace", "truncate", "write", "bytes"]) expect(out).toContain(`${label} StaleWriteError`);
		for (const name of TARGETS) expect(await Bun.file(path.join(dir, `${name}.txt`)).text()).toBe("EXTERNAL-EDIT\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120000);

test("python kernel: rereading permits atomic edits while native destructive APIs stay unmodified", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-stale-py-ok-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await seed(dir);
		await runCell(
			tool,
			"py-initial-read",
			"python",
			"for n in ['viaReplace', 'viaTruncate', 'viaRemove', 'viaOpen']: harness.fs.read_text(n + '.txt')",
		);
		await editExternally(dir);
		const out = await runCell(
			tool,
			"py-allowed",
			"python",
			[
				"from pathlib import Path",
				"import os",
				"harness.fs.read_text('viaReplace.txt')",
				"harness.fs.replace('viaReplace.txt', 'EXTERNAL-EDIT', 'replaced')",
				"harness.fs.read_text('viaTruncate.txt')",
				"harness.fs.write_text('viaTruncate.txt', '')",
				"Path('staged.tmp').write_text('native\\n')",
				"os.replace('staged.tmp', 'viaOpen.txt')",
				"os.truncate('viaOpen.txt', 0)",
				"open('viaOpen.txt', 'w').write('native final\\n')",
				"os.remove('viaRemove.txt')",
				"print('DONE', harness.fs.read_text('viaReplace.txt').strip(), os.path.exists('viaRemove.txt'))",
			].join("\n"),
		);
		expect(out).toContain("DONE replaced False");
		expect(await Bun.file(path.join(dir, "viaTruncate.txt")).text()).toBe("");
		expect(await Bun.file(path.join(dir, "viaOpen.txt")).text()).toBe("native final\n");
		expect(await Bun.file(path.join(dir, "viaRemove.txt")).exists()).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120000);

test("js kernel: a retained FileHandle cannot clobber an external edit from a later cell", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-stale-handle-"));
	const tool = new BashTool(stubSession(dir));
	const target = path.join(dir, "target.txt");
	try {
		await fs.writeFile(target, "original");
		const opened = await runCell(
			tool,
			"handle-open",
			"node",
			"const fs = require('node:fs'); const h = await fs.promises.open('target.txt', 'r+'); console.log('OPEN ok');",
		);
		expect(opened).toContain("OPEN ok");
		const read = await runCell(
			tool,
			"handle-read",
			"node",
			"console.log(await fs.promises.readFile('target.txt', 'utf8'));",
		);
		expect(read).toContain("original");
		await fs.writeFile(target, "external-edit");

		const rejected = await runCell(
			tool,
			"handle-reject",
			"node",
			"try { await h.writeFile('kernel-version'); console.log('NO-GUARD'); } catch (error) { console.log(error.name); }",
		);
		expect(rejected).toContain("StaleWriteError");
		expect(rejected).not.toContain("NO-GUARD");
		expect(await fs.readFile(target, "utf8")).toBe("external-edit");

		const accepted = await runCell(
			tool,
			"handle-reread",
			"node",
			"console.log(await h.readFile('utf8')); await h.truncate(0); console.log('TRUNCATE ok');",
		);
		expect(accepted).toContain("external-edit");
		expect(accepted).toContain("TRUNCATE ok");
		expect(await fs.readFile(target, "utf8")).toBe("");
	} finally {
		await runCell(tool, "handle-close", "node", "if (typeof h !== 'undefined') await h.close();");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120000);

test("js kernel: rename, truncate and unlink refuse the same unseen edit (parity reference)", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "kernel-stale-js-"));
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
