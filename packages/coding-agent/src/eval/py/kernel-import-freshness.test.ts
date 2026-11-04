import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";

// Explicit warm kernels retain CPython sys.modules; only an explicit reload
// or removal from the cache changes an already imported module.

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
const kernelTest = availability.ok ? test : test.skip;
if (!availability.ok) console.warn("skipping python import freshness tests: no local Python interpreter");

interface CellRun {
	status: "ok" | "error";
	stdout: string;
	stderr: string;
	notes: string[];
	traceback: string[];
}

async function run(
	kernel: PythonKernel,
	code: string,
	options: { cwd?: string; shellEnv?: Record<string, string> } = {},
): Promise<CellRun> {
	let stdout = "";
	let stderr = "";
	const notes: string[] = [];
	const result = await kernel.execute(code, {
		...options,
		onDisplay: output => {
			if (output.type === "status" && output.event.op === "note") notes.push(String(output.event.text));
		},
		onStream: (text, stream) => {
			if (stream === "stdout") stdout += text;
			else stderr += text;
		},
	});
	return { status: result.status, stdout, stderr, notes, traceback: result.error?.traceback ?? [] };
}

async function withKernel(prefix: string, body: (kernel: PythonKernel, dir: string) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync(prefix);
	const kernel = await PythonKernel.start({ cwd: tempDir.path() });
	try {
		await body(kernel, tempDir.path());
	} finally {
		await kernel.shutdown().catch(() => {});
	}
}

describe("explicit Python kernel native import caching", () => {
	kernelTest(
		"an edited module stays cached with its earlier bindings until explicitly reloaded",
		async () => {
			await withKernel("@py-import-edit-", async (kernel, dir) => {
				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "v1"\nclass Thing: pass\n');
				const first = await run(kernel, "import json\nimport probe_mod\nthing = probe_mod.Thing()\nlib = json");
				expect(first.status).toBe("ok");

				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "v2-edited"\nclass Thing: pass\n');
				const second = await run(kernel, "import json\nimport probe_mod\nprint(probe_mod.VALUE, json is lib)");

				expect(second.stdout).toContain("v1 True");
				expect(second.stderr).toBe("");
				expect(second.notes).toEqual([]);
				expect((await run(kernel, "assert isinstance(thing, probe_mod.Thing)")).status).toBe("ok");
			});
		},
		60_000,
	);

	kernelTest(
		"rewriting a cached module from Python or a subprocess does not implicitly reload it",
		async () => {
			await withKernel("@py-import-rewrite-", async (kernel, dir) => {
				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "v1"\n');
				expect((await run(kernel, "import probe_mod")).status).toBe("ok");

				const kernelWrite = await run(
					kernel,
					[
						"from pathlib import Path",
						"Path('probe_mod.py').write_text('VALUE = \"kernel-write\"\\n')",
						"import probe_mod",
						"print(probe_mod.VALUE)",
					].join("\n"),
				);
				expect(kernelWrite.stdout).toContain("v1");

				const childWrite = await run(
					kernel,
					[
						"import subprocess, sys",
						"subprocess.run([sys.executable, '-c', \"open('probe_mod.py', 'w').write('VALUE = 3')\"], check=True)",
						"import probe_mod",
						"print('child', probe_mod.VALUE)",
					].join("\n"),
				);
				expect(childWrite.stdout).toContain("child v1");
			});
		},
		60_000,
	);

	kernelTest(
		"a cwd change updates search paths without replacing cached modules",
		async () => {
			await withKernel("@py-import-cwd-", async (kernel, dir) => {
				const a = path.join(dir, "a");
				const b = path.join(dir, "b");
				await Bun.write(path.join(a, "util.py"), 'WHERE = "a"\n');
				await Bun.write(path.join(b, "util.py"), 'WHERE = "b"\n');

				expect((await run(kernel, "import util\nprint(util.WHERE)", { cwd: a })).stdout).toContain("a");
				const fromB = await run(kernel, `import sys, util\nprint(util.WHERE, ${JSON.stringify(a)} in sys.path)`, {
					cwd: b,
				});
				expect(fromB.stdout).toContain("a False");

				await fs.rm(path.join(a, "util.py"));
				await fs.rm(path.join(b, "util.py"));
				expect((await run(kernel, "import util; print(util.WHERE)", { cwd: b })).stdout).toContain("a");
				const gone = await run(kernel, "del sys.modules['util']; import util", { cwd: b });
				expect(gone.status).toBe("error");
				expect(gone.traceback.join("\n")).toContain("ModuleNotFoundError");
			});
		},
		60_000,
	);

	kernelTest(
		"PYTHONPATH updates search paths without evicting an imported module",
		async () => {
			await withKernel("@py-import-pythonpath-", async (kernel, dir) => {
				const lib = path.join(dir, "lib");
				await Bun.write(path.join(lib, "extra_mod.py"), 'NAME = "extra"\n');

				const withPath = await run(kernel, "import extra_mod\nprint(extra_mod.NAME)", {
					shellEnv: { PYTHONPATH: lib },
				});
				expect(withPath.stdout).toContain("extra");

				expect((await run(kernel, "import extra_mod; print(extra_mod.NAME)", { shellEnv: {} })).stdout).toContain(
					"extra",
				);
				const without = await run(kernel, "import sys; del sys.modules['extra_mod']; import extra_mod", {
					shellEnv: {},
				});
				expect(without.status).toBe("error");
				expect(without.traceback.join("\n")).toContain("No module named 'extra_mod'");
			});
		},
		60_000,
	);

	kernelTest(
		"explicit importlib.reload updates the cached module object in place",
		async () => {
			await withKernel("@py-import-reload-", async (kernel, dir) => {
				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "v1"\n');
				expect((await run(kernel, "import importlib\nimport probe_mod as held")).status).toBe("ok");

				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "reloaded"\n');
				const reloaded = await run(kernel, "importlib.reload(held)\nprint(held.VALUE)");
				expect(reloaded.status).toBe("ok");
				expect(reloaded.stdout).toContain("reloaded");
			});
		},
		60_000,
	);

	kernelTest(
		"a failed import's traceback shows only the cell's frames",
		async () => {
			await withKernel("@py-import-traceback-", async kernel => {
				const failed = await run(kernel, "x = 1\nimport probe_missing_module_for_traceback");
				expect(failed.status).toBe("error");
				const frames = failed.traceback.filter(line => line.trimStart().startsWith("File "));
				expect(frames).toEqual(['  File "<string>", line 2, in <module>']);
			});
		},
		60_000,
	);
});
