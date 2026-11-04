import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsObservationKind } from "@oh-my-pi/pi-natives";
import * as utils from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { FsObservationLedger, releaseFsObservationLedger, retainFsObservationLedger } from "../eval/fs-observations";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { disposeBashSessions, executeBash } from "../exec/bash-executor";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";

const availability = await checkPythonKernelAvailability(import.meta.dir, undefined, { forceProbe: true });
const pythonTest = availability.ok ? test : test.skip;
const pythonCommand = `'${availability.pythonPath?.replaceAll("'", "'\\''")}'`;

async function fixture(prefix: string) {
	const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	const owner = `bash-fs-observations:${crypto.randomUUID()}`;
	const tools = new Map<string, Tool>();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "bash.autoBackground.enabled": false, "bash.direnv": "off" }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => owner,
		getEvalSessionId: () => owner,
		getEvalKernelOwnerId: () => owner,
		getToolForEvalBridge: name => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()],
		toolRegistry: tools,
	};
	const bash = new BashTool(session);
	const read = new ReadTool(session);
	tools.set("bash", bash);
	tools.set("read", read);
	retainFsObservationLedger(owner, owner);
	return {
		cwd,
		session,
		bash,
		read,
		async dispose() {
			await Promise.all([disposeBashSessions(owner), disposeKernelSessionsByOwner(owner)]);
			releaseFsObservationLedger(owner, owner);
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

const GUARD_PROBE = [
	"def check(fn, *args, **kwargs):",
	"    try:",
	"        fn(*args, **kwargs)",
	'        return "ok"',
	"    except Exception as err:",
	"        return type(err).__name__",
].join("\n");

async function runPy(bash: BashTool, id: string, code: string): Promise<string> {
	const result = await bash.execute(id, {
		command: `${pythonCommand} <<'__PROTO_SOURCE__'\nimport proto_harness as harness\n${code}\n__PROTO_SOURCE__`,
	});
	const text = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
	expect(result.isError, text).not.toBe(true);
	expect(result.details?.execution?.exitCode, text).toBe(0);
	return text;
}

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
		await fs.mkdir(path.join(dir, "empty-dir"));
		const result = await executeBash(
			[
				"cat read.txt",
				"rg needle matched.txt unmatched.txt",
				"echo out > redirected.txt",
				"sed -i 's/before/after/' edited.txt",
				"rm removed.txt",
				"rm -d empty-dir",
				"rm -f absent.txt",
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
		// A write the shell itself performed carries the content snapshots the
		// bash tool turns into a receipt and a hunk; a creation has no `before`.
		expect(byPath.get(path.join(dir, "redirected.txt"))).toEqual({
			path: path.join(dir, "redirected.txt"),
			kind: FsObservationKind.Write,
			...(await stampOf("redirected.txt")),
			mutation: { existed: false, exists: true, after: "out\n" },
		});
		expect(byPath.get(path.join(dir, "edited.txt"))).toEqual({
			path: path.join(dir, "edited.txt"),
			kind: FsObservationKind.Write,
			...(await stampOf("edited.txt")),
			mutation: { existed: true, exists: true, before: "before\n", after: "after\n" },
		});
		// A removal mutates no content, so it reports no snapshots.
		expect(byPath.get(path.join(dir, "removed.txt"))).toEqual({
			path: path.join(dir, "removed.txt"),
			kind: FsObservationKind.Write,
			mtimeNs: undefined,
			size: undefined,
		});
		expect(byPath.get(path.join(dir, "empty-dir"))).toEqual({
			path: path.join(dir, "empty-dir"),
			kind: FsObservationKind.Write,
			mtimeNs: undefined,
			size: undefined,
		});
		expect(byPath.has(path.join(dir, "absent.txt"))).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

pythonTest(
	"a bash read arms the explicit harness stale-write guard",
	async () => {
		const f = await fixture("bash-read-guard-");
		const dir = f.cwd;
		try {
			const { bash } = f;
			const target = path.join(dir, "guarded.txt");
			await Bun.write(target, "original\n");

			await bash.execute("bash-read", { command: "cat guarded.txt" });
			await Bun.write(target, "externally changed\n");

			const out = await runPy(
				bash,
				"kernel-write",
				`${GUARD_PROBE}\nprint("WRITE", check(lambda: harness.fs.write_text("guarded.txt", "kernel\\n")))`,
			);
			expect(out).toContain("WRITE StaleWriteError");
			expect(await Bun.file(target).text()).toBe("externally changed\n");
		} finally {
			await f.dispose();
		}
	},
	60000,
);

pythonTest(
	"a shell write cannot disarm a harness read; an explicit harness re-read does",
	async () => {
		// The host ledger retains explicit reads across fresh Python processes.
		const f = await fixture("bash-write-rearm-");
		const dir = f.cwd;
		try {
			const { bash } = f;
			const target = path.join(dir, "guarded.txt");
			await Bun.write(target, "original\n");

			expect(await runPy(bash, "kernel-read", 'print("READ", len(harness.fs.read_text("guarded.txt")))')).toContain(
				"READ 9",
			);
			await bash.execute("bash-write", { command: "sed -i 's/original/shell-edited/' guarded.txt" });

			const blocked = await runPy(
				bash,
				"kernel-edit",
				`${GUARD_PROBE}\nprint("EDIT", check(lambda: harness.fs.write_text("guarded.txt", "kernel-edited\\n")))`,
			);
			expect(blocked).toContain("EDIT StaleWriteError");
			expect(await Bun.file(target).text()).toBe("shell-edited\n");

			const afterReread = await runPy(
				bash,
				"kernel-reread-edit",
				`${GUARD_PROBE}\nharness.fs.read_text("guarded.txt")\nprint("EDIT", check(lambda: harness.fs.write_text("guarded.txt", "kernel-edited\\n")))`,
			);
			expect(afterReread).toContain("EDIT ok");
			expect(await Bun.file(target).text()).toBe("kernel-edited\n");
		} finally {
			await f.dispose();
		}
	},
	60000,
);

pythonTest(
	"a shell read cannot launder content an earlier harness read never saw",
	async () => {
		// Shell observations cannot silently replace the explicit harness read baseline.
		const f = await fixture("bash-read-launder-");
		const dir = f.cwd;
		try {
			const { bash } = f;
			const target = path.join(dir, "guarded.txt");
			await Bun.write(target, "original\n");

			expect(await runPy(bash, "kernel-read", 'print("READ", len(harness.fs.read_text("guarded.txt")))')).toContain(
				"READ 9",
			);
			await Bun.write(target, "external edit\n");
			await bash.execute("bash-cat", { command: "cat guarded.txt" });

			const out = await runPy(
				bash,
				"kernel-write",
				`${GUARD_PROBE}\nprint("WRITE", check(lambda: harness.fs.write_text("guarded.txt", "kernel\\n")))`,
			);
			expect(out).toContain("WRITE StaleWriteError");
			expect(await Bun.file(target).text()).toBe("external edit\n");
		} finally {
			await f.dispose();
		}
	},
	60000,
);

pythonTest(
	"an actual read-tool read arms the explicit harness stale-write guard",
	async () => {
		const f = await fixture("read-tool-guard-");
		const dir = f.cwd;
		try {
			const { bash, read } = f;
			const target = path.join(dir, "guarded.txt");
			await Bun.write(target, "original\n");

			await read.execute("read-tool", { path: "guarded.txt" });
			await Bun.write(target, "externally changed\n");

			const out = await runPy(
				bash,
				"kernel-write",
				`${GUARD_PROBE}\nprint("WRITE", check(lambda: harness.fs.write_text("guarded.txt", "kernel\\n")))`,
			);
			expect(out).toContain("WRITE StaleWriteError");
		} finally {
			await f.dispose();
		}
	},
	60000,
);

for (const baseline of ["harness", "shell"] as const) {
	pythonTest(
		`a read-tool observation cannot refresh an established ${baseline} read baseline`,
		async () => {
			const f = await fixture("read-tool-launder-");
			const target = path.join(f.cwd, "guarded.txt");
			try {
				await Bun.write(target, "original\n");
				if (baseline === "harness") {
					await runPy(f.bash, "explicit-read", 'assert harness.fs.read_text("guarded.txt") == "original\\n"');
				} else {
					await f.bash.execute("shell-read", { command: "cat guarded.txt" });
				}
				await Bun.write(target, "external edit\n");
				await f.read.execute("automatic-read-tool", { path: "guarded.txt" });
				const blocked = await runPy(
					f.bash,
					"stale-replace",
					`${GUARD_PROBE}\nprint("EDIT", check(lambda: harness.fs.replace("guarded.txt", "external", "clobber")))`,
				);
				expect(blocked).toContain("EDIT StaleWriteError");
				expect(await Bun.file(target).text()).toBe("external edit\n");
				const acknowledged = await runPy(
					f.bash,
					"acknowledged-writes",
					`
assert harness.fs.read_bytes("guarded.txt") == b"external edit\\n"
harness.fs.write_text("guarded.txt", "first owned write")
harness.fs.replace("guarded.txt", "first", "second")
print("owned writes acknowledged")`,
				);
				expect(acknowledged).toContain("owned writes acknowledged");
				expect(await Bun.file(target).text()).toBe("second owned write");
			} finally {
				await f.dispose();
			}
		},
		60000,
	);
}

pythonTest(
	"a concurrent edit during atomic staging is refused before publication",
	async () => {
		const f = await fixture("bash-atomic-guard-");
		const target = path.join(f.cwd, "guarded.txt");
		const atomicWrite = utils.atomicWriteFileWith;
		let staged = false;
		const staging = spyOn(utils, "atomicWriteFileWith").mockImplementation((file, write, options) =>
			atomicWrite(
				file,
				async temporary => {
					await write(temporary);
					if (file === target) {
						staged = true;
						await Bun.write(target, "concurrent edit\n");
					}
				},
				options,
			),
		);
		try {
			await Bun.write(target, "original\n");
			await runPy(f.bash, "read-before-staging", 'assert harness.fs.read_text("guarded.txt") == "original\\n"');
			const out = await runPy(
				f.bash,
				"atomic-write",
				`${GUARD_PROBE}\nprint("WRITE", check(lambda: harness.fs.replace("guarded.txt", "original", "replacement")))`,
			);
			expect(staged).toBe(true);
			expect(out).toContain("WRITE StaleWriteError");
			expect(await Bun.file(target).text()).toBe("concurrent edit\n");
			expect(await fs.readdir(f.cwd)).toEqual(["guarded.txt"]);
		} finally {
			staging.mockRestore();
			await f.dispose();
		}
	},
	60000,
);

pythonTest(
	"filesystem helpers honor extension refusal before reading or mutating",
	async () => {
		const f = await fixture("bash-fs-policy-");
		const target = path.join(f.cwd, "guarded.txt");
		f.session.beforeEvalToolCall = async tool =>
			tool.name.startsWith("fs.") ? { block: true, reason: "filesystem access refused by extension" } : undefined;
		try {
			await Bun.write(target, "original\n");
			const out = await runPy(
				f.bash,
				"refused-fs",
				`
for operation in (
    lambda: harness.fs.read_text("guarded.txt"),
    lambda: harness.fs.write_text("guarded.txt", "replacement"),
    lambda: harness.fs.replace("guarded.txt", "original", "replacement"),
):
    try:
        operation()
    except RuntimeError as error:
        assert "filesystem access refused by extension" in str(error), error
    else:
        raise AssertionError("filesystem policy bypassed")
print("all filesystem operations refused")`,
			);
			expect(out).toContain("all filesystem operations refused");
			expect(await Bun.file(target).text()).toBe("original\n");
		} finally {
			await f.dispose();
		}
	},
	60000,
);
