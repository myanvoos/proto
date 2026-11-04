import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { measureKernelPrivateMemory } from "../kernel-memory";
import { stageRunnerScript } from "../runner-cache";
import { forkPythonKernel, pythonForkserverPids, shutdownPythonForkservers } from "./forkserver";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";
import { PYTHON_RUNNER_SOURCE } from "./runner-source";
import { stagePythonRuntimeAssets } from "./runtime-assets";

async function start(): Promise<PythonKernel> {
	const available = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!available.ok) throw new Error(available.reason);
	return PythonKernel.start({ cwd: process.cwd(), interpreter: available.pythonPath });
}
async function output(kernel: PythonKernel, code: string): Promise<string> {
	let text = "";
	const result = await kernel.execute(code, {
		onChunk(chunk) {
			text += chunk;
		},
	});
	if (result.status !== "ok") throw new Error(JSON.stringify(result.error));
	return text.trim();
}
afterAll(shutdownPythonForkservers);

describe("local CPython forkserver", () => {
	test("default SDK named kernels start under long TMPDIR and dispose their real fork parent and socket", async () => {
		using root = TempDir.createSync("@forkserver-long-tmp-");
		const longTmp = root.join("long-runtime-directory-".repeat(6), "tmp");
		await fs.mkdir(longTmp, { recursive: true });
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "forkserver-sdk.fixture.ts"), root.path()],
			{
				env: { ...process.env, TMPDIR: longTmp, TMP: longTmp, TEMP: longTmp },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		const report: {
			output: string;
			parents: number[];
			sockets: string[];
			remaining: number[];
			alive: number[];
			socketModes: number[];
			socketDirectoryExists: boolean[];
		} = JSON.parse(stdout.trim());
		expect(report.output).toBe("42");
		expect(report.parents.length).toBe(1);
		expect(report.sockets.length).toBe(1);
		expect(Buffer.byteLength(report.sockets[0])).toBeLessThan(process.platform === "darwin" ? 104 : 108);
		expect(report.remaining).toEqual([]);
		expect(report.alive).toEqual([]);
		expect(report.socketModes).toEqual([0o700]);
		expect(report.socketDirectoryExists).toEqual([false]);
	}, 30_000);

	test("failed real server startup reports Python stderr after its process and socket directory are removed", async () => {
		await shutdownPythonForkservers();
		using directory = TempDir.createSync("@forkserver-bad-runner-");
		const runnerPath = directory.join("bad.py");
		await Bun.write(runnerPath, "def broken(:\n");
		const available = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		const failed: unknown = await forkPythonKernel({
			interpreter: available.pythonPath!,
			runnerPath,
			cwd: directory.path(),
			env: {},
		}).then(
			() => undefined,
			error => error,
		);
		if (!(failed instanceof Error)) throw new Error("Invalid Python runner unexpectedly started");
		expect(failed.message).toContain("SyntaxError");
		expect(failed.message).toContain("bad.py");
		const cause = failed.cause;
		if (
			!cause ||
			typeof cause !== "object" ||
			!("pid" in cause) ||
			typeof cause.pid !== "number" ||
			!("socketPath" in cause) ||
			typeof cause.socketPath !== "string"
		)
			throw new Error("Missing startup process diagnostic");
		const pid = cause.pid;
		expect(() => process.kill(pid, 0)).toThrow();
		await expect(fs.access(path.dirname(cause.socketPath))).rejects.toMatchObject({ code: "ENOENT" });
		expect(pythonForkserverPids()).toEqual([]);
	}, 10_000);

	test("named runtimes are actual siblings and child writes do not dirty sibling private pages", async () => {
		const first = await start();
		const second = await start();
		try {
			expect(first.launchMode).toBe("forkserver");
			expect(second.forkserverPid).toBe(first.forkserverPid);
			expect(first.pid).not.toBe(second.pid);
			expect(
				JSON.parse(await output(first, "import os,json; print(json.dumps([os.getpid(),os.getppid()]))")),
			).toEqual([first.pid, first.forkserverPid]);
			expect(
				JSON.parse(await output(second, "import os,json; print(json.dumps([os.getpid(),os.getppid()]))")),
			).toEqual([second.pid, first.forkserverPid]);
			const before = await measureKernelPrivateMemory(first.pid!);
			const siblingBefore = await measureKernelPrivateMemory(second.pid!);
			await output(first, "allocation=bytearray(64*1024*1024); allocation[::4096]=b'x'*(len(allocation)//4096)");
			const after = await measureKernelPrivateMemory(first.pid!);
			const siblingAfter = await measureKernelPrivateMemory(second.pid!);
			expect(before.bytes).not.toBeNull();
			expect(after.bytes! - before.bytes!).toBeGreaterThan(48 * 1024 ** 2);
			expect(Math.abs(siblingAfter.bytes! - siblingBefore.bytes!)).toBeLessThan(16 * 1024 ** 2);
			console.info("forkserver measured", {
				serverPid: first.forkserverPid,
				children: [first.pid, second.pid],
				startupMs: [first.startupMs, second.startupMs],
				privateBytes: [before.bytes, siblingBefore.bytes],
				serverPrivate: await measureKernelPrivateMemory(first.forkserverPid!),
			});
		} finally {
			await Promise.all([first.shutdown(), second.shutdown()]);
		}
	}, 30_000);

	test("four initialized fork children share a lower measured private footprint than four independent interpreters", async () => {
		const available = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		const script = await stageRunnerScript("proto-python-runner", "py", PYTHON_RUNNER_SOURCE);
		const packageRoot = await stagePythonRuntimeAssets();
		const forked: PythonKernel[] = [];
		const independent: PythonKernel[] = [];
		try {
			let began = performance.now();
			for (let i = 0; i < 4; i++) forked.push(await start());
			const forkStartupMs = performance.now() - began;
			began = performance.now();
			for (let i = 0; i < 4; i++) {
				const kernel = new PythonKernel(`baseline-${i}`);
				kernel.setProcess(
					Bun.spawn([available.pythonPath!, "-u", script], {
						cwd: process.cwd(),
						detached: true,
						env: {
							...process.env,
							PYTHONPATH: [packageRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
						},
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					}),
				);
				independent.push(kernel);
				expect((await kernel.requestStatus(10_000))?.executionCount).toBe(0);
			}
			const independentStartupMs = performance.now() - began;
			const server = await measureKernelPrivateMemory(forked[0].forkserverPid!);
			let forkBytes = server.bytes!;
			let independentBytes = 0;
			for (const kernel of forked) forkBytes += (await measureKernelPrivateMemory(kernel.pid!)).bytes!;
			for (const kernel of independent) independentBytes += (await measureKernelPrivateMemory(kernel.pid!)).bytes!;
			expect(forkBytes).toBeLessThan(independentBytes);
			console.info("forkserver versus independent measured", {
				forkBytes,
				independentBytes,
				forkStartupMs,
				independentStartupMs,
			});
		} finally {
			await Promise.all([...forked, ...independent].map(kernel => kernel.shutdown()));
		}
	}, 30_000);

	test("large control writes survive socket backpressure and cancellation leaves the sibling alive", async () => {
		const first = await start();
		const second = await start();
		try {
			expect(await output(first, `payload=${JSON.stringify("é".repeat(1024 * 1024))}; print(len(payload))`)).toBe(
				"1048576",
			);
			await output(
				first,
				"import subprocess,sys; survivor=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])",
			);
			await output(
				second,
				"import subprocess,sys; survivor=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])",
			);
			const stop = new AbortController();
			const started = Promise.withResolvers<void>();
			const run = first.execute("print('started',flush=True); import time; time.sleep(30)", {
				signal: stop.signal,
				onChunk(chunk) {
					if (chunk.includes("started")) started.resolve();
				},
			});
			await started.promise;
			stop.abort();
			expect((await run).cancelled).toBe(true);
			expect(await output(second, "print(6*7)")).toBe("42");
			expect(await output(first, "print(survivor.poll() is None)")).toBe("True");
			expect(await output(second, "print(survivor.poll() is None)")).toBe("True");
			expect((await first.shutdown()).confirmed).toBe(true);
		} finally {
			await Promise.all([first.shutdown(), second.shutdown()]);
		}
	}, 30_000);

	test("forkserver death kills its running children and the next start gets a new server", async () => {
		const kernel = await start();
		const oldServer = kernel.forkserverPid!;
		const started = Promise.withResolvers<void>();
		const run = kernel.execute("print('started',flush=True); import time; time.sleep(30)", {
			onChunk(chunk) {
				if (chunk.includes("started")) started.resolve();
			},
		});
		await started.promise;
		process.kill(oldServer, "SIGKILL");
		expect((await run).kernelKilled).toBe(true);
		expect((await kernel.shutdown()).confirmed).toBe(true);
		const recovered = await start();
		try {
			expect(recovered.forkserverPid).not.toBe(oldServer);
			expect(await output(recovered, "print('recovered')")).toBe("recovered");
		} finally {
			await recovered.shutdown();
		}
	}, 30_000);
});
