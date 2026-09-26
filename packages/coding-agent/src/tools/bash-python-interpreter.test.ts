import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleKernelControl } from "../eval/kernel-control";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

// A `python` command runs its kernel cell on the interpreter the shell would
// run for it: a named interpreter, or whatever the cell's PATH selects.

const KERNEL_OWNER = `bash-python-interpreter-test:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getEvalSessionId: () => `bash-python-interpreter-test:${cwd}`,
		getEvalKernelOwnerId: () => KERNEL_OWNER,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/** A virtual environment on this host's Python, named so session discovery does not pick it up. */
async function makeVenv(dir: string): Promise<string> {
	const base = await fs.realpath(Bun.which("python3") ?? "python3");
	const venv = path.join(dir, "env313");
	await fs.mkdir(path.join(venv, "bin"), { recursive: true });
	await Bun.write(
		path.join(venv, "pyvenv.cfg"),
		`home = ${path.dirname(base)}\ninclude-system-site-packages = false\n`,
	);
	await fs.symlink(base, path.join(venv, "bin", "python"));
	return venv;
}

async function withDir(prefix: string, body: (dir: string, bash: BashTool) => Promise<void>): Promise<void> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	try {
		await body(dir, new BashTool(stubSession(dir)));
	} finally {
		await disposeKernelSessionsByOwner(KERNEL_OWNER);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(KERNEL_OWNER);
});

test("a python named by path runs kernel cells on it, apart from the default kernel", async () => {
	await withDir("pyinterp-path-", async (dir, bash) => {
		const venv = await makeVenv(dir);
		await bash.execute("seed", { command: "env313/bin/python -c 'import sys; held = sys.prefix'" });
		const same = await bash.execute("same", { command: "env313/bin/python -c 'print(held, \"tool\" in globals())'" });
		expect(textOf(same)).toContain(`${venv} True`);

		const bare = await bash.execute("bare", { command: "python3 -c 'print(\"held\" in globals())'" });
		expect(textOf(bare)).toContain("False");
	});
}, 60_000);

test("bare python follows the cell's PATH when it selects another interpreter", async () => {
	await withDir("pyinterp-shell-", async (dir, bash) => {
		const venv = await makeVenv(dir);
		const activated = await bash.execute("activated", {
			command: `PATH="$PWD/env313/bin:$PATH" python -c 'import sys; print("prefix", sys.prefix)'`,
		});
		expect(textOf(activated)).toContain(`prefix ${venv}`);

		const untouched = await bash.execute("untouched", {
			command: "python -c 'import sys; print(\"prefix\", sys.prefix)'",
		});
		expect(textOf(untouched)).toContain("prefix ");
		expect(textOf(untouched)).not.toContain(venv);
	});
}, 60_000);

test("an interpreter too old for kernel cells runs as a plain process, noting why once", async () => {
	await withDir("pyinterp-old-", async (dir, bash) => {
		const fake = path.join(dir, "oldbin", "python3.9");
		// Fails the kernel's version probe; otherwise behaves like a plain interpreter process.
		await Bun.write(fake, '#!/bin/sh\ncase "$2" in *version_info*) exit 3;; esac\necho "plain process: $*"\n');
		await fs.chmod(fake, 0o755);
		const command = `PATH="$PWD/oldbin:$PATH" python3.9 -c 'print(1)'`;

		const first = textOf(await bash.execute("old-1", { command }));
		expect(first).toContain(`${fake} is older than Python 3.10`);
		expect(first).toContain("plain process: -c print(1)");

		const second = textOf(await bash.execute("old-2", { command }));
		expect(second).toContain("plain process: -c print(1)");
		expect(second).not.toContain("older than Python");
	});
}, 60_000);

test("a named interpreter that does not exist fails as the shell reports it", async () => {
	await withDir("pyinterp-missing-", async (_dir, bash) => {
		const result = await bash.execute("missing", { command: "./nowhere/python -c 'print(1)'" });
		expect(result.details?.execution?.exitCode).toBe(127);
		expect(textOf(result)).toContain("./nowhere/python: No such file or directory");
	});
}, 60_000);

test("xd kernel picks one of a lane's interpreter kernels by interpreter", async () => {
	await withDir("pyinterp-control-", async (dir, bash) => {
		const venv = await makeVenv(dir);
		const session = stubSession(dir);
		await bash.execute("default", { command: "python3 -c 'x = 1'" });
		await bash.execute("named", { command: "env313/bin/python -c 'x = 2'" });

		await expect(handleKernelControl(session, { op: "inspect", language: "python" })).rejects.toThrow(
			/has kernels for .*pass interpreter/,
		);
		const picked = await handleKernelControl(session, {
			op: "inspect",
			language: "python",
			interpreter: "env313/bin/python",
		});
		expect(picked.kernel?.interpreter).toBe(path.join(venv, "bin", "python"));
	});
}, 60_000);
