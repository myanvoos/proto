import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";

// A kernel cell stands in for a fresh `python` process: imports must see
// project source as it is on disk now, resolved from the cell's own cwd/env.

const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
const kernelTest = availability.ok ? test : test.skip;
if (!availability.ok) console.warn("skipping python import freshness tests: no local Python interpreter");

interface CellRun {
	status: "ok" | "error";
	stdout: string;
	stderr: string;
	traceback: string[];
}

async function run(
	kernel: PythonKernel,
	code: string,
	options: { cwd?: string; shellEnv?: Record<string, string> } = {},
): Promise<CellRun> {
	let stdout = "";
	let stderr = "";
	const result = await kernel.execute(code, {
		...options,
		onStream: (text, stream) => {
			if (stream === "stdout") stdout += text;
			else stderr += text;
		},
	});
	return { status: result.status, stdout, stderr, traceback: result.error?.traceback ?? [] };
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

describe("python kernel import freshness", () => {
	kernelTest(
		"a module edited between cells imports fresh; earlier bindings are named, libraries stay",
		async () => {
			await withKernel("@py-import-edit-", async (kernel, dir) => {
				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "v1"\nclass Thing: pass\n');
				const first = await run(kernel, "import json\nimport probe_mod\nthing = probe_mod.Thing()\nlib = json");
				expect(first.status).toBe("ok");

				await Bun.write(path.join(dir, "probe_mod.py"), 'VALUE = "v2-edited"\nclass Thing: pass\n');
				const second = await run(kernel, "import json\nimport probe_mod\nprint(probe_mod.VALUE, json is lib)");

				expect(second.stdout).toContain("v2-edited True");
				// Only `thing` is stale: the cell rebinds probe_mod itself, and json is a library.
				expect(second.stderr).toContain(
					"probe_mod changed on disk; imports load the new source, but names from earlier cells still hold the old code: thing\n",
				);
			});
		},
		60_000,
	);

	kernelTest(
		"a cell that rewrites an already-imported module imports its own rewrite",
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
				expect(kernelWrite.stdout).toContain("kernel-write");

				const childWrite = await run(
					kernel,
					[
						"import subprocess, sys",
						"subprocess.run([sys.executable, '-c', \"open('probe_mod.py', 'w').write('VALUE = 3')\"], check=True)",
						"import probe_mod",
						"print('child', probe_mod.VALUE)",
					].join("\n"),
				);
				expect(childWrite.stdout).toContain("child 3");
			});
		},
		60_000,
	);

	kernelTest(
		"a cwd change re-resolves top-level modules and drops the previous cwd from sys.path",
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
				expect(fromB.stdout).toContain("b False");

				await fs.rm(path.join(a, "util.py"));
				await fs.rm(path.join(b, "util.py"));
				const gone = await run(kernel, "import util", { cwd: b });
				expect(gone.status).toBe("error");
				expect(gone.traceback.join("\n")).toContain("ModuleNotFoundError");
			});
		},
		60_000,
	);

	kernelTest(
		"PYTHONPATH from the cell's environment applies to that cell only",
		async () => {
			await withKernel("@py-import-pythonpath-", async (kernel, dir) => {
				const lib = path.join(dir, "lib");
				await Bun.write(path.join(lib, "extra_mod.py"), 'NAME = "extra"\n');

				const withPath = await run(kernel, "import extra_mod\nprint(extra_mod.NAME)", {
					shellEnv: { PYTHONPATH: lib },
				});
				expect(withPath.stdout).toContain("extra");

				const without = await run(kernel, "import extra_mod", { shellEnv: {} });
				expect(without.status).toBe("error");
				expect(without.traceback.join("\n")).toContain("No module named 'extra_mod'");
			});
		},
		60_000,
	);

	kernelTest(
		"importlib.reload of an evicted module updates that module object in place",
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
				expect(frames).toEqual(['  File "<cell>", line 2, in <module>']);
			});
		},
		60_000,
	);
});
