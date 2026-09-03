import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsObservationKind } from "@oh-my-pi/pi-natives";
import { FsObservationLedger } from "../eval/fs-observations";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { executeBash } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";
import { EvalTool } from "./eval";
import { ReadTool } from "./read";

const KERNEL_OWNER = `eval-fs-observations-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `eval-fs-observations-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

const GUARD_PROBE = [
	"def check(fn, *args, **kwargs):",
	"    try:",
	"        fn(*args, **kwargs)",
	'        return "ok"',
	"    except Exception as err:",
	"        return type(err).__name__",
].join("\n");

async function runPy(tool: EvalTool, id: string, code: string): Promise<string> {
	const result = await tool.execute(id, { language: "py", code, timeout: 60 });
	expect(result.details?.cells?.[0]?.status).toBe("complete");
	return String(result.details?.cells?.[0]?.output ?? "");
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("ledger keeps the latest observation per path and drains once", async () => {
	const ledger = new FsObservationLedger();
	ledger.record({ path: "/a", kind: "read", mtimeNs: "1", size: 1 });
	ledger.record({ path: "/b", kind: "read", mtimeNs: "2", size: 2 });
	ledger.record({ path: "/a", kind: "write", mtimeNs: "3", size: 3 });
	expect(ledger.drain()).toEqual([
		{ path: "/b", kind: "read", mtimeNs: "2", size: 2 },
		{ path: "/a", kind: "write", mtimeNs: "3", size: 3 },
	]);
	expect(ledger.drain()).toEqual([]);
});

test("shell builtins and redirects report file observations with exact stamps", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-observations-"));
	try {
		await Bun.write(path.join(dir, "read.txt"), "alpha\n");
		await Bun.write(path.join(dir, "matched.txt"), "needle\n");
		await Bun.write(path.join(dir, "unmatched.txt"), "hay\n");
		await Bun.write(path.join(dir, "edited.txt"), "before\n");
		await Bun.write(path.join(dir, "removed.txt"), "gone\n");
		const result = await executeBash(
			[
				"cat read.txt",
				"rg needle matched.txt unmatched.txt",
				"echo out > redirected.txt",
				"sed -i 's/before/after/' edited.txt",
				"rm removed.txt",
			].join("; "),
			{ cwd: dir },
		);
		expect(result.exitCode).toBe(0);
		const byPath = new Map((result.fsObservations ?? []).map(observation => [observation.path, observation]));
		const stampOf = async (name: string) => {
			const stat = await fs.stat(path.join(dir, name), { bigint: true });
			return { mtimeNs: stat.mtimeNs.toString(), size: Number(stat.size) };
		};

		expect(byPath.get(path.join(dir, "read.txt"))).toEqual({
			path: path.join(dir, "read.txt"),
			kind: FsObservationKind.Read,
			...(await stampOf("read.txt")),
		});
		expect(byPath.get(path.join(dir, "matched.txt"))?.kind).toBe(FsObservationKind.Read);
		expect(byPath.has(path.join(dir, "unmatched.txt"))).toBe(false);
		expect(byPath.get(path.join(dir, "redirected.txt"))).toEqual({
			path: path.join(dir, "redirected.txt"),
			kind: FsObservationKind.Write,
			...(await stampOf("redirected.txt")),
		});
		expect(byPath.get(path.join(dir, "edited.txt"))).toEqual({
			path: path.join(dir, "edited.txt"),
			kind: FsObservationKind.Write,
			...(await stampOf("edited.txt")),
		});
		expect(byPath.get(path.join(dir, "removed.txt"))).toEqual({
			path: path.join(dir, "removed.txt"),
			kind: FsObservationKind.Write,
			mtimeNs: undefined,
			size: undefined,
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a bash read arms the kernel stale-write guard", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-read-guard-"));
	try {
		const session = stubSession(dir);
		const bash = new BashTool(session);
		const evalTool = new EvalTool(session);
		const target = path.join(dir, "guarded.txt");
		await Bun.write(target, "original\n");

		await bash.execute("bash-read", { command: "cat guarded.txt" });
		await Bun.write(target, "externally changed\n");

		const out = await runPy(
			evalTool,
			"eval-write",
			`${GUARD_PROBE}\nprint("WRITE", check(lambda: open("guarded.txt", "w").write("kernel\\n")))`,
		);
		expect(out).toContain("WRITE StaleWriteError");
		expect(await Bun.file(target).text()).toBe("externally changed\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("a bash write re-arms the guard so the kernel's next edit passes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-rearm-"));
	try {
		const session = stubSession(dir);
		const bash = new BashTool(session);
		const evalTool = new EvalTool(session);
		const target = path.join(dir, "guarded.txt");
		await Bun.write(target, "original\n");

		expect(await runPy(evalTool, "eval-read", 'print("READ", len(Path("guarded.txt").read_text()))')).toContain(
			"READ 9",
		);
		await bash.execute("bash-write", { command: "sed -i 's/original/shell-edited/' guarded.txt" });

		const out = await runPy(
			evalTool,
			"eval-edit",
			`${GUARD_PROBE}\nprint("EDIT", check(lambda: open("guarded.txt", "w").write("kernel-edited\\n")))`,
		);
		expect(out).toContain("EDIT ok");
		expect(await Bun.file(target).text()).toBe("kernel-edited\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("a read-tool read arms the kernel stale-write guard", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-guard-"));
	try {
		const session = stubSession(dir);
		const read = new ReadTool(session);
		const evalTool = new EvalTool(session);
		const target = path.join(dir, "guarded.txt");
		await Bun.write(target, "original\n");

		await read.execute("read-tool", { path: "guarded.txt" });
		await Bun.write(target, "externally changed\n");

		const out = await runPy(
			evalTool,
			"eval-write",
			`${GUARD_PROBE}\nprint("WRITE", check(lambda: open("guarded.txt", "w").write("kernel\\n")))`,
		);
		expect(out).toContain("WRITE StaleWriteError");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);
