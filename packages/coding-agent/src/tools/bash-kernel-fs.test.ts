import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { releaseFsObservationLedger, retainFsObservationLedger } from "../eval/fs-observations";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { Tool, ToolSession } from ".";
import { BashTool, type BashToolDetails } from "./bash";
import { ReadTool } from "./read";

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
if (!availability.ok || !availability.pythonPath) throw new Error(availability.reason ?? "Python unavailable");
const PYTHON = JSON.stringify(availability.pythonPath);
const TEMP_ROOT = await fs.realpath(os.tmpdir());

const KERNEL_OWNER = `eval-fs-diff-test:${process.pid}`;

function stubSession(cwd: string, skills?: ToolSession["skills"]): ToolSession {
	const settings = new Map<string, unknown>();
	const tools = new Map<string, Tool>();
	const session = {
		cwd,
		skills,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `fs-test:${cwd}`,
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

type CellInput = {
	language: "py" | "node" | "bun";
	code: string;
	env?: Record<string, string>;
	timeout?: number;
};

function cellCommand(language: CellInput["language"], code: string): string {
	const interpreter = language === "py" ? `${PYTHON} -m proto_harness.kernel main --interpreter ${PYTHON}` : language;
	if (language === "py") code = `import proto_harness as harness\n${code}`;
	return `${interpreter} <<'__PROTO_CELL__'\n${code}\n__PROTO_CELL__`;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function expectCellComplete(result: {
	isError?: boolean;
	details?: BashToolDetails;
	content: Array<{ type: string; text?: string }>;
}): void {
	expect(result.isError ?? false).toBe(false);
	expect(result.details?.execution?.state).toBe("exited");
	expect(result.details?.execution?.exitCode, textOf(result)).toBe(0);
}

async function executeCell(
	tool: BashTool,
	id: string,
	input: CellInput,
	onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
) {
	return await tool.execute(
		id,
		{
			command: cellCommand(input.language, input.code),
			env: input.env,
			...(input.timeout === undefined ? {} : { timeout: input.timeout }),
		},
		undefined,
		onUpdate,
	);
}

retainFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);

afterAll(async () => {
	await Promise.all([disposeKernelSessionsByOwner(KERNEL_OWNER), disposeVmContextsByOwner(KERNEL_OWNER)]);
	releaseFsObservationLedger(KERNEL_OWNER, KERNEL_OWNER);
});

test("explicit filesystem writes report mutations outside the working directory", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-hook-outside-"));
	const outside = path.join(TEMP_ROOT, `eval-hook-out-${process.pid}-${Date.now()}.txt`);
	try {
		const result = await executeCell(new BashTool(stubSession(dir)), "eval-hook-outside-test", {
			language: "py",
			code: `harness.fs.write_text(${JSON.stringify(outside)}, "brand new line\\n")`,
			timeout: 60,
		});
		expectCellComplete(result);
		const events = (result.details?.statusEvents ?? []).filter(
			event => event.op === "write" && event.path === outside,
		);
		expect(events).toHaveLength(1);
		expect(String(events[0]?.diff)).toContain("+1|brand new line");
		expect(await Bun.file(outside).text()).toBe("brand new line\n");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("explicit filesystem writes report each committed operation but not reads", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-hook-dedupe-"));
	try {
		const result = await executeCell(new BashTool(stubSession(dir)), "eval-hook-dedupe-test", {
			language: "py",
			code: [
				'harness.fs.write_text("plain.txt", "original line\\n")',
				'text = harness.fs.read_text("plain.txt")',
				'harness.fs.write_text("plain.txt", text + "appended by explicit edit\\n")',
				'harness.fs.read_text("plain.txt")',
			].join("\n"),
			timeout: 60,
		});
		expectCellComplete(result);
		const events = (result.details?.statusEvents ?? []).filter(
			event => event.op === "write" && event.path === path.join(dir, "plain.txt"),
		);
		expect(events).toHaveLength(2);
		expect(String(events[0]?.diff)).toContain("original line");
		expect(String(events[1]?.diff)).toContain("appended by explicit edit");
		expect(await Bun.file(path.join(dir, "plain.txt")).text()).toBe("original line\nappended by explicit edit\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("two atomic edits retain their separate committed diffs", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-flush-base-"));
	try {
		await Bun.write(path.join(dir, "b.txt"), "orig\n");
		const result = await executeCell(new BashTool(stubSession(dir)), "eval-flush-base-test", {
			language: "py",
			code: [
				'harness.fs.write_text("a.txt", "alpha\\nbeta\\n")',
				'harness.fs.write_text("a.txt", harness.fs.read_text("a.txt") + "gamma\\n")',
				'harness.fs.read_text("b.txt")',
				'harness.fs.write_text("b.txt", "orig\\none\\n")',
				'harness.fs.write_text("b.txt", harness.fs.read_text("b.txt") + "two\\n")',
			].join("\n"),
			timeout: 60,
		});
		expectCellComplete(result);
		const eventsFor = (name: string) =>
			(result.details?.statusEvents ?? []).filter(
				event => event.op === "write" && event.path === path.join(dir, name),
			);
		const a = eventsFor("a.txt");
		expect(a).toHaveLength(2);
		expect(String(a[0]?.diff)).toContain("+1|alpha");
		expect(String(a[1]?.diff)).toContain("+3|gamma");
		const b = eventsFor("b.txt");
		expect(b).toHaveLength(2);
		expect(String(b[0]?.diff)).toContain("+2|one");
		expect(String(b[1]?.diff)).toContain("+3|two");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("native Python deletes stay native without harness mutation events", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-hook-delete-"));
	try {
		await Bun.write(path.join(dir, "doomed.txt"), "doomed content line\n");
		const result = await executeCell(new BashTool(stubSession(dir)), "eval-hook-delete-test", {
			language: "py",
			code: 'import os\nos.remove("doomed.txt")\nprint("done")',
			timeout: 60,
		});
		expectCellComplete(result);
		expect((result.details?.statusEvents ?? []).filter(event => event.op === "delete")).toEqual([]);
		expect(await Bun.file(path.join(dir, "doomed.txt")).exists()).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("native Python writes do not install hidden filesystem tracking", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-hook-noise-"));
	try {
		await Bun.write(path.join(dir, "touched.txt"), "stable content\n");
		const result = await executeCell(new BashTool(stubSession(dir)), "eval-hook-noise-test", {
			language: "py",
			code: [
				"import os",
				'os.makedirs(".cache", exist_ok=True)',
				'open(".cache/noise.bin", "wb").write(b"x")',
				'open("module.pyc", "wb").write(b"x")',
				'open("touched.txt", "w").write("stable content\\n")',
				'open("changed.txt", "w").write("real change\\n")',
			].join("\n"),
			timeout: 60,
		});
		expectCellComplete(result);
		expect(
			(result.details?.statusEvents ?? []).filter(event => event.op === "write" || event.op === "delete"),
		).toEqual([]);
		expect(await Bun.file(path.join(dir, "changed.txt")).text()).toBe("real change\n");
		expect(await Bun.file(path.join(dir, "touched.txt")).text()).toBe("stable content\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("js kernel fs tracker reports raw fs writes outside the walker root", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-hook-outside-"));
	const outside = path.join(TEMP_ROOT, `eval-js-hook-out-${process.pid}-${Date.now()}.txt`);
	try {
		const tool = new BashTool(stubSession(dir));
		const code = [
			'import * as fs from "node:fs";',
			`fs.writeFileSync(${JSON.stringify(outside)}, "fresh js bytes\\n");`,
			'print("done")',
		].join("\n");
		const result = await executeCell(tool, "eval-js-hook-outside-test", {
			language: "node",
			code,
			timeout: 60,
		});

		expectCellComplete(result);
		const cellEvents = (result.details?.statusEvents ?? []).filter(event => event.op === "write");
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
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-helper-"));
	const outside = path.join(TEMP_ROOT, `eval-js-helper-${process.pid}-${Date.now()}.txt`);
	try {
		const tool = new BashTool(stubSession(dir));
		const code = [`await Bun.write(${JSON.stringify(outside)}, "Bun wrote this\\n");`, 'print("done")'].join("\n");
		const result = await executeCell(tool, "eval-js-helper-test", {
			language: "bun",
			code,
			timeout: 60,
		});

		expectCellComplete(result);
		const cellEvents = (result.details?.statusEvents ?? []).filter(event => event.op === "write");
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
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-flush-base-"));
	const outside = path.join(TEMP_ROOT, `eval-js-flush-base-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(path.join(dir, "b.txt"), "orig\n");
		const tool = new BashTool(stubSession(dir));
		const code = [
			'import * as fs from "node:fs";',
			`await Bun.write(${JSON.stringify(outside)}, "alpha\\nbeta\\n");`,
			`fs.appendFileSync(${JSON.stringify(outside)}, "gamma\\n");`,
			`await Bun.write(${JSON.stringify(path.join(dir, "b.txt"))}, "orig\\none\\n");`,
			`fs.appendFileSync(${JSON.stringify(path.join(dir, "b.txt"))}, "two\\n");`,
			'print("done")',
		].join("\n");
		const result = await executeCell(tool, "eval-js-flush-base-test", {
			language: "bun",
			code,
			timeout: 60,
		});

		expectCellComplete(result);
		const eventsFor = (name: string) =>
			(result.details?.statusEvents ?? []).filter(event => event.op === "write" && event.path === name);

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

for (const language of ["node", "bun"] as const) {
	test(`${language} receives shell-resolved skills activated after the kernel starts`, async () => {
		const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-skill-"));
		try {
			const skillDir = path.join(dir, "example-skill");
			await Bun.write(path.join(skillDir, "SKILL.md"), "# Example skill\n");
			await Bun.write(path.join(skillDir, "notes.txt"), "skill notes\n");
			const session = stubSession(dir);
			const tool = new BashTool(session);
			const started = await executeCell(tool, `eval-${language}-skill-start-test`, {
				language,
				code: 'print("started");',
				timeout: 60,
			});
			expectCellComplete(started);
			session.skills = [
				{
					name: "example",
					description: "test skill",
					filePath: path.join(skillDir, "SKILL.md"),
					baseDir: skillDir,
					source: "test",
				},
			];
			const result = await executeCell(tool, `eval-${language}-skill-test`, {
				env: { SKILL_DIR: "skill://example", SKILL_FILE: "skill://example/notes.txt" },
				language,
				code: [
					'import * as fs from "node:fs";',
					'print(env("SKILL_DIR"));',
					'print(fs.readFileSync(env("SKILL_FILE"), "utf8"));',
				].join("\n"),
				timeout: 60,
			});
			expectCellComplete(result);
			const output = textOf(result);
			expect(output).toContain(skillDir);
			expect(output).toContain("skill notes");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}

test("js kernel fs tracker reports deletes once with diff", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-delete-"));
	const outside = path.join(TEMP_ROOT, `eval-js-delete-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(outside, "doomed js line\n");
		const tool = new BashTool(stubSession(dir));
		const code = ['import * as fs from "node:fs";', `fs.rmSync(${JSON.stringify(outside)});`, 'print("done")'].join(
			"\n",
		);
		const result = await executeCell(tool, "eval-js-delete-test", {
			language: "node",
			code,
			timeout: 60,
		});

		expectCellComplete(result);
		const cellEvents = result.details?.statusEvents ?? [];
		const deletes = cellEvents.filter(event => event.op === "delete" && event.path === outside);
		expect(deletes.length, "delete is reported exactly once with diff").toBe(1);
		expect(String(deletes[0]?.diff)).toContain("-1|doomed js line");
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("js kernel fs tracker covers Bun.write and prunes cache dirs", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-bunwrite-"));
	const outside = path.join(TEMP_ROOT, `eval-js-bunwrite-${process.pid}-${Date.now()}.txt`);
	try {
		await Bun.write(path.join(dir, "touched.txt"), "stable content\n");
		const pastSeconds = Date.now() / 1000 - 2;
		await fs.utimes(path.join(dir, "touched.txt"), pastSeconds, pastSeconds);
		const tool = new BashTool(stubSession(dir));
		const code = [
			`await Bun.write(${JSON.stringify(outside)}, "bun wrote this\\n");`,
			'import * as fs from "node:fs";',
			'fs.mkdirSync(".cache", { recursive: true });',
			'fs.writeFileSync(".cache/noise.bin", "x");',
			'fs.writeFileSync("touched.txt", "stable content\\n");',
			'fs.writeFileSync("changed.txt", "real js change\\n");',
			'print("done")',
		].join("\n");
		const result = await executeCell(tool, "eval-js-bunwrite-test", {
			language: "bun",
			code,
			timeout: 60,
		});

		expectCellComplete(result);
		const cellEvents = result.details?.statusEvents ?? [];
		const reported = cellEvents
			.filter(event => event.op === "write" || event.op === "delete")
			.map(event => String(event.path));
		expect(
			reported.toSorted(),
			"cache dirs and content-identical rewrites stay unreported; Bun.write and real changes remain visible",
		).toEqual([outside, path.join(dir, "changed.txt")].toSorted());
		const bunEvent = cellEvents.find(event => event.op === "write" && event.path === outside);
		expect(String(bunEvent?.diff)).toContain("+1|bun wrote this");
		const touched = cellEvents.find(event => event.op === "write" && event.path === path.join(dir, "touched.txt"));
		expect(touched?.diff, "content-identical rewrite carries no diff rows").toBeUndefined();
	} finally {
		await fs.rm(outside, { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("a second explicit write wholly replaces the file the kernel itself wrote", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-write-guard-"));
	try {
		const tool = new BashTool(stubSession(dir));
		const code = [
			'harness.fs.write_text("guard.txt", "v1")',
			'harness.fs.write_text("guard.txt", "v2")',
			'print("CONTENT", harness.fs.read_text("guard.txt"))',
		].join("\n");
		const result = await executeCell(tool, "eval-fs-diff-test", {
			language: "py",
			code,
			timeout: 60,
		});

		expectCellComplete(result);
		const out = textOf(result);
		expect(out).toContain("CONTENT v2");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("explicit stale-write guard retains newest reads beyond its observation cap", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-guard-evict-"));
	try {
		// The newest explicit read remains guarded after older observations exceed the ledger cap.
		await Promise.all(
			Array.from({ length: 8192 }, (_, i) =>
				Bun.write(path.join(dir, `dummy-${String(i).padStart(4, "0")}.txt`), "d\n"),
			),
		);
		await Bun.write(path.join(dir, "guarded.txt"), "original\n");
		const tool = new BashTool(stubSession(dir));
		// Stay within each authenticated run's request bound while exercising the session ledger cap.
		for (let offset = 0; offset < 8192; offset += 2048) {
			const readResult = await executeCell(tool, `eval-guard-evict-read-${offset}`, {
				language: "py",
				code: `for i in range(${offset}, ${offset + 2048}):\n    harness.fs.read_text(f"dummy-{i:04d}.txt")`,
				timeout: 120,
			});
			expectCellComplete(readResult);
		}
		const readResult = await executeCell(tool, "eval-guard-evict-read-newest", {
			language: "py",
			code: 'harness.fs.read_text("guarded.txt")\nprint("read-done")',
			timeout: 60,
		});
		expectCellComplete(readResult);
		expect(textOf(readResult)).toContain("read-done");

		await Bun.write(path.join(dir, "guarded.txt"), "externally changed\n");

		const writeCell = [
			"def check(fn):",
			"    try:",
			'        harness.fs.write_text(fn, "v2")',
			'        return "ok"',
			"    except Exception as err:",
			'        return type(err).__name__ + ": " + str(err)[:200]',
			'print("RESULT", check("guarded.txt"))',
		].join("\n");
		const writeResult = await executeCell(tool, "eval-guard-evict-write", {
			language: "py",
			code: writeCell,
			timeout: 60,
		});
		expectCellComplete(writeResult);
		const out = textOf(writeResult);
		expect(out).toContain("RESULT StaleWriteError");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("large explicit edits retain independent per-operation mutation receipts", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-capture-budget-"));
	try {
		const chunk = `${"x".repeat(1000)}\n`.repeat(4300);
		// Earlier large atomic edits must not suppress a later file's independent receipt.
		await Promise.all([
			...Array.from({ length: 4 }, (_, i) => Bun.write(path.join(dir, `big-${i}.txt`), chunk)),
			Bun.write(path.join(dir, "changed.txt"), "original\n"),
		]);
		const tool = new BashTool(stubSession(dir));
		const cell = [
			"from pathlib import Path",
			"for i in range(4):",
			'    p = f"big-{i}.txt"',
			'    harness.fs.write_text(p, "x\\n" + harness.fs.read_text(p))',
			'harness.fs.write_text("changed.txt", "x")',
			"print('cell-done')",
		].join("\n");
		const result = await executeCell(tool, "eval-capture-budget", { language: "py", code: cell, timeout: 120 });

		expectCellComplete(result);
		const cellEvents = result.details?.statusEvents ?? [];
		const forPath = (name: string) =>
			cellEvents.filter(event => event.op === "write" && path.resolve(String(event.path)) === path.join(dir, name));
		const changed = forPath("changed.txt");
		expect(changed.length, "the later edit is reported exactly once").toBe(1);
		expect(String(changed[0]?.diff), "earlier edits do not erase a later edit's baseline").toContain("-1|original");
		expect(changed[0]?.chars).toBe(1);
		expect(await Bun.file(path.join(dir, "changed.txt")).text()).toBe("x");
		for (let i = 0; i < 4; i++) {
			const big = forPath(`big-${i}.txt`);
			expect(big.length, `big-${i} is reported exactly once`).toBe(1);
			expect(String(big[0]?.diff), "each large edit has its own diff").toContain("+1|x");
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("js capture budget stops retaining text past the aggregate budget but keeps sha dedupe", async () => {
	const dir = await fs.mkdtemp(path.join(TEMP_ROOT, "eval-js-budget-"));
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
		const tool = new BashTool(stubSession(dir));
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
		const result = await executeCell(tool, "eval-js-capture-budget", { language: "node", code: cell, timeout: 120 });

		expectCellComplete(result);
		const cellEvents = result.details?.statusEvents ?? [];
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

// The live view must show a write's hunk when the write happens, not when the
// cell settles: a cell that edits a file and then keeps running for a while
// used to withhold every hunk until its last line printed.
for (const [language, code] of [
	[
		"py",
		[
			"import time",
			'harness.fs.write_text("live.txt", "first\\n")',
			'print("wrote")',
			"time.sleep(0.4)",
			'print("end")',
		].join("\n"),
	],
	[
		"node",
		[
			'import * as fs from "node:fs";',
			'import { setTimeout as sleep } from "node:timers/promises";',
			'fs.writeFileSync("live.txt", "first\\n");',
			'print("wrote");',
			"await sleep(400);",
			'print("end");',
		].join("\n"),
	],
	[
		"bun",
		[
			'import * as fs from "node:fs";',
			'import { setTimeout as sleep } from "node:timers/promises";',
			'fs.writeFileSync("live.txt", "first\\n");',
			'print("wrote");',
			"await sleep(400);",
			'print("end");',
		].join("\n"),
	],
] as const) {
	test(`${language} write hunks stream before the cell finishes`, async () => {
		const dir = await fs.mkdtemp(path.join(TEMP_ROOT, `eval-live-${language}-`));
		try {
			const updates: Array<{ output: string; writes: number }> = [];
			const result = await executeCell(
				new BashTool(stubSession(dir)),
				`eval-live-${language}`,
				{ language, code, timeout: 30 },
				update => {
					updates.push({
						output: textOf(update),
						writes: (update.details?.statusEvents ?? []).filter(event => event.op === "write").length,
					});
				},
			);
			expectCellComplete(result);
			const firstWrite = updates.find(update => update.writes > 0);
			expect(firstWrite, "a write event reaches the live update stream").toBeDefined();
			expect(firstWrite?.output ?? "", "the hunk arrives before the cell's final line prints").not.toContain("end");
			const writes = (result.details?.statusEvents ?? []).filter(
				event => event.op === "write" && event.path === path.join(dir, "live.txt"),
			);
			expect(writes.length, "the settled cell still reports the path once").toBe(1);
			expect(String(writes[0]?.diff)).toContain("+1|first");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30000);
}
