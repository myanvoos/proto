import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeKernelSessionsByOwner, executePython } from "./executor";
import { checkPythonKernelAvailability, type KernelDisplayOutput, PythonKernel } from "./kernel";

describe("PythonKernel status probe", () => {
	test("output coerces numbered IDs and explains bash artifact lookup", async () => {
		using tempDir = TempDir.createSync("@python-kernel-output-");
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "8.md"), "numbered agent output\n");
		const ownerId = `test-owner:${crypto.randomUUID()}`;
		const options = {
			cwd: tempDir.path(),
			artifactsDir,
			sessionId: `test-session:${crypto.randomUUID()}`,
			kernelOwnerId: ownerId,
			kernelMode: "session" as const,
			timeoutMs: 10_000,
		};

		try {
			const numbered = await executePython("print(output(8))", options);
			expect(numbered.output).toContain("numbered agent output");

			const missing = await executePython(
				"try:\n    output(9)\nexcept Exception as error:\n    print(type(error).__name__)\n    print(error)",
				options,
			);
			expect(missing.output).toContain("FileNotFoundError");
			expect(missing.output).toContain("output() reads an agent/task output id such as 'scout_0'");
			expect(missing.output).toContain("read artifact://9:A-B");
			expect(missing.output).toContain('tool.read({"path": "artifact://9:A-B"})');
		} finally {
			await disposeKernelSessionsByOwner(ownerId);
		}
	});

	test("reports in-flight request tasks and quiescence", async () => {
		// Real probe (bun-test flag normally short-circuits availability checks).
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) {
			console.warn("skipping Python kernel status test: no local Python interpreter");
			return;
		}
		const kernel = await PythonKernel.start({ cwd: process.cwd() });
		try {
			expect(await kernel.execute("status_probe_var = 41 + 1")).toMatchObject({ status: "ok" });
			expect(await kernel.isBusy()).toBe(false);

			const slow = kernel.execute("import asyncio\nawait asyncio.sleep(0.4)");
			await Bun.sleep(150);
			expect(await kernel.isBusy()).toBe(true);
			expect(await slow).toMatchObject({ status: "ok" });
			await Bun.sleep(50);
			expect(await kernel.isBusy()).toBe(false);

			// Session state survives across cells (probe never touched user namespace).
			expect(await kernel.execute("status_probe_var")).toMatchObject({ status: "ok" });

			expect((await kernel.shutdown()).confirmed).toBe(true);
		} finally {
			if (kernel.isAlive()) await kernel.shutdown().catch(() => {});
		}
	});

	test("does not replay a crashed cell after the Python kernel reports uncertain completion", async () => {
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) return;

		using tempDir = TempDir.createSync("@python-kernel-crash-");
		const ownerId = `test-owner:${crypto.randomUUID()}`;
		const sessionId = `test-session:${crypto.randomUUID()}`;
		const effectsPath = path.join(tempDir.path(), "effects.txt");
		const options = {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: ownerId,
			kernelMode: "session" as const,
			timeoutMs: 10_000,
		};

		try {
			const crashed = await executePython(
				[
					"import os",
					"with open('effects.txt', 'a') as effects:",
					"    effects.write('once\\n')",
					"    effects.flush()",
					"print('before crash', flush=True)",
					"os._exit(17)",
				].join("\n"),
				options,
			);

			expect(crashed.cancelled).toBe(true);
			expect(crashed.output).toContain("before crash");
			expect(crashed.output).toContain("completion is uncertain");
			expect(crashed.output).toContain("not replayed");
			expect(await Bun.file(effectsPath).text()).toBe("once\n");

			const next = await executePython("print(21 * 2)", options);
			expect(next.exitCode).toBe(0);
			expect(next.output.trim()).toBe("42");
			expect(await Bun.file(effectsPath).text()).toBe("once\n");
		} finally {
			await disposeKernelSessionsByOwner(ownerId);
		}
	}, 30_000);

	test("owner-scoped disposal releases the retained kernel and its state", async () => {
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) {
			console.warn("skipping kernel owner-disposal test: no local Python interpreter");
			return;
		}
		const ownerId = `test-owner:${crypto.randomUUID()}`;
		const sessionId = `test-session:${crypto.randomUUID()}`;
		const run = (code: string) =>
			executePython(code, {
				cwd: process.cwd(),
				sessionId,
				kernelOwnerId: ownerId,
				kernelMode: "session",
			});
		try {
			expect((await run("owner_disposal_probe = 7")).exitCode).toBe(0);
			// Same retained kernel: state visible.
			expect((await run("owner_disposal_probe")).exitCode).toBe(0);

			// This is the call AgentSession.dispose() makes when a subagent
			// is parked, killed, or evicted.
			await disposeKernelSessionsByOwner(ownerId);

			// Fresh kernel on next call: prior state is gone.
			const fresh = await run("owner_disposal_probe");
			expect(fresh.output).toContain("NameError");
		} finally {
			await disposeKernelSessionsByOwner(ownerId);
		}
	});
});

test("delayed child stdout stays with its originating Python cell after that cell completes", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	const kernel = await PythonKernel.start({ cwd: process.cwd() });
	const firstOutput: string[] = [];
	const secondOutput: string[] = [];
	try {
		await kernel.execute(
			'import subprocess; child = subprocess.Popen(["bash", "-c", "sleep 0.15; echo FROM_CELL1"])',
			{
				onChunk: chunk => {
					firstOutput.push(chunk);
				},
			},
		);
		await kernel.execute('import time; time.sleep(0.3); print("CELL2")', {
			onChunk: chunk => {
				secondOutput.push(chunk);
			},
		});

		expect(firstOutput.join("")).toContain("FROM_CELL1");
		expect(secondOutput.join("")).toBe("CELL2\n");
	} finally {
		await kernel.shutdown().catch(() => {});
	}
}, 15_000);

test("child stderr is returned in the agent-visible Python cell result", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	const result = await executePython(
		'import subprocess; result = subprocess.run(["bash", "-c", "echo CHILD_ERR >&2"])',
		{ cwd: process.cwd(), kernelMode: "per-call" },
	);
	expect(result.output).toContain("CHILD_ERR");
}, 15_000);

test("invalid UTF-8 stdout is reported without replacement-character corruption", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	const result = await executePython('import os; written = os.write(1, b"\\xff")', {
		cwd: process.cwd(),
		kernelMode: "per-call",
	});
	expect(result.output).toContain("\\xff");
	expect(result.output).not.toContain("�");
}, 15_000);

test("same-metadata external edits still trigger the Python stale-write guard", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	using tempDir = TempDir.createSync("@python-stale-hash-");
	const target = path.join(tempDir.path(), "same-metadata.txt");
	const fixedTime = new Date(1_700_000_000_000);
	await Bun.write(target, "OLD1");
	await fs.utimes(target, fixedTime, fixedTime);
	const kernel = await PythonKernel.start({ cwd: tempDir.path() });
	try {
		await kernel.execute(`open(${JSON.stringify(target)}).read()`);
		await Bun.write(target, "EVIL");
		await fs.utimes(target, fixedTime, fixedTime);
		const output: string[] = [];
		const result = await kernel.execute(`open(${JSON.stringify(target)}, "w").write("MINE")`, {
			onChunk: chunk => {
				output.push(chunk);
			},
		});
		expect(result.status).toBe("error");
		expect(output.join("")).toContain("StaleWriteError");
		expect(await Bun.file(target).text()).toBe("EVIL");
	} finally {
		await kernel.shutdown().catch(() => {});
	}
}, 15_000);

test("host-observed content hashes detect timestamp-preserving edits before Python writes", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	using tempDir = TempDir.createSync("@python-host-stale-hash-");
	const target = path.join(tempDir.path(), "host-observed.txt");
	const fixedTime = new Date(1_700_000_000_000);
	await Bun.write(target, "OLD1");
	await fs.utimes(target, fixedTime, fixedTime);
	const stat = await fs.stat(target, { bigint: true });
	const sha = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(target).bytes())
		.digest("hex")
		.slice(0, 16);
	const kernel = await PythonKernel.start({ cwd: tempDir.path() });
	try {
		await kernel.execute("pass", {
			fsObservations: [
				{
					path: target,
					kind: "read",
					mtimeNs: stat.mtimeNs.toString(),
					size: Number(stat.size),
					sha,
				},
			],
		});
		await Bun.write(target, "EVIL");
		await fs.utimes(target, fixedTime, fixedTime);
		const output: string[] = [];
		const result = await kernel.execute(`open(${JSON.stringify(target)}, "w").write("MINE")`, {
			onChunk: chunk => {
				output.push(chunk);
			},
		});
		expect(result.status).toBe("error");
		expect(output.join("")).toContain("StaleWriteError");
		expect(await Bun.file(target).text()).toBe("EVIL");
	} finally {
		await kernel.shutdown().catch(() => {});
	}
}, 15_000);

test("oversized Python result frames are rejected before JSON parsing", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	const result = await executePython('"x" * 40_000_000', {
		cwd: process.cwd(),
		kernelMode: "per-call",
	});
	expect(result.output).toContain("frame exceeded");
	expect(result.output.length).toBeLessThan(100_000);
}, 15_000);

test("UTF-16 surrogate frames are reassembled before reaching the output client", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	const result = await executePython(
		'import sys; sys.stdout.write("\\ud83d"); sys.stdout.flush(); sys.stdout.write("\\ude00"); sys.stdout.flush()',
		{ cwd: process.cwd(), kernelMode: "per-call" },
	);
	expect(result.output).toBe("😀");
}, 15_000);

test("late partial Python prints are evicted visibly instead of leaking per-cell buffers", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	const kernel = await PythonKernel.start({ cwd: process.cwd() });
	const outputs = Array.from({ length: 70 }, () => [] as string[]);
	try {
		await kernel.execute("import asyncio; late_partial_gate = asyncio.Event()");
		for (let index = 0; index < outputs.length; index++) {
			await kernel.execute(
				[
					`async def late_partial_${index}():`,
					"    await late_partial_gate.wait()",
					`    print("PARTIAL_${index}", end="")`,
					`asyncio.create_task(late_partial_${index}())`,
				].join("\n"),
				{
					onChunk: chunk => {
						outputs[index]!.push(chunk);
					},
				},
			);
		}
		await kernel.execute("late_partial_gate.set(); await asyncio.sleep(0); await asyncio.sleep(0)");
		expect(outputs[0]!.join("")).toContain("PARTIAL_0");
	} finally {
		await kernel.shutdown().catch(() => {});
	}
}, 20_000);

test("serializes concurrent cells and keeps filesystem attribution with the originating cell", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	using tempDir = TempDir.createSync("@python-kernel-fifo-");
	const cwd = tempDir.path();
	const release = path.join(cwd, "release-a");
	const order = path.join(cwd, "order.txt");
	const aFile = path.join(cwd, "a.txt");
	const bFile = path.join(cwd, "b.txt");
	const aDisplays: KernelDisplayOutput[] = [];
	const bDisplays: KernelDisplayOutput[] = [];
	const ready = Promise.withResolvers<void>();
	const kernel = await PythonKernel.start({ cwd });

	try {
		const runA = kernel.execute(
			[
				"import asyncio",
				"from pathlib import Path",
				`release = Path(${JSON.stringify(release)})`,
				`order = Path(${JSON.stringify(order)})`,
				'order.write_text("A-start\\n")',
				'print("A-ready", flush=True)',
				"while not release.exists():",
				"    await asyncio.sleep(0.01)",
				`Path(${JSON.stringify(aFile)}).write_text("A")`,
				'order.write_text(order.read_text() + "A-end\\n")',
			].join("\n"),
			{
				onChunk: chunk => {
					if (chunk.includes("A-ready")) ready.resolve();
				},
				onDisplay: output => {
					aDisplays.push(output);
				},
			},
		);
		await ready.promise;

		const runB = kernel.execute(
			[
				"from pathlib import Path",
				`order = Path(${JSON.stringify(order)})`,
				`Path(${JSON.stringify(bFile)}).write_text("B")`,
				'order.write_text(order.read_text() + "B\\n")',
			].join("\n"),
			{
				onDisplay: output => {
					bDisplays.push(output);
				},
			},
		);

		// Status replies cross the process boundary and give the old concurrent scheduler ample turns
		// without guessing a wall-clock delay. A serialized runner keeps B queued through every probe.
		for (let probe = 0; probe < 20 && !(await Bun.file(bFile).exists()); probe++) {
			await kernel.requestStatus();
		}
		await Bun.write(release, "go");

		expect(await Promise.all([runA, runB])).toEqual([
			expect.objectContaining({ status: "ok", cancelled: false }),
			expect.objectContaining({ status: "ok", cancelled: false }),
		]);
		expect(await Bun.file(order).text()).toBe("A-start\nA-end\nB\n");

		const writePaths = (outputs: KernelDisplayOutput[]): unknown[] =>
			outputs.flatMap(output =>
				output.type === "status" && output.event.op === "write" ? [output.event.path] : [],
			);
		expect(writePaths(aDisplays)).toContain(aFile);
		expect(writePaths(bDisplays)).toContain(bFile);
	} finally {
		await Bun.write(release, "go").catch(() => undefined);
		if (kernel.isAlive()) await kernel.shutdown().catch(() => {});
	}
}, 15_000);

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

function killDetachedProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processExists(pid)) {
		if (Date.now() >= deadline) return false;
		// This integration check observes an OS process, so fake timers cannot advance it.
		await Bun.sleep(20);
	}
	return true;
}

test("shutdown terminates subprocesses started by a Python cell", async () => {
	if (process.platform === "win32") return;
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	using tempDir = TempDir.createSync("@python-kernel-tree-");
	const childPidPath = path.join(tempDir.path(), "child.pid");
	const kernel = await PythonKernel.start({ cwd: tempDir.path() });
	let childPid: number | undefined;

	try {
		const result = await kernel.execute(
			[
				"import subprocess, sys",
				"from pathlib import Path",
				"child = subprocess.Popen(",
				'    [sys.executable, "-c", "import time; time.sleep(9999)"],',
				"    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,",
				")",
				`Path(${JSON.stringify(childPidPath)}).write_text(str(child.pid))`,
			].join("\n"),
		);
		expect(result).toMatchObject({ status: "ok", cancelled: false });
		childPid = Number.parseInt(await Bun.file(childPidPath).text(), 10);
		expect(processExists(childPid)).toBe(true);

		expect(await kernel.shutdown()).toEqual({ confirmed: true });
		expect(await waitForProcessExit(childPid, 1_500)).toBe(true);
	} finally {
		if (kernel.isAlive()) await kernel.shutdown().catch(() => {});
		if (childPid !== undefined && processExists(childPid)) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {}
		}
	}
}, 15_000);

async function createControllableInterpreter(
	dir: string,
	name: string,
): Promise<{ executable: string; pidPath: string; childPidPath: string; allowPath: string }> {
	const executable = path.join(dir, name);
	const pidPath = path.join(dir, `${name}.pid`);
	const childPidPath = path.join(dir, `${name}.child.pid`);
	const allowPath = path.join(dir, `${name}.allow`);
	await Bun.write(
		executable,
		[
			"#!/bin/sh",
			`echo $$ > ${JSON.stringify(pidPath)}`,
			`if [ -f ${JSON.stringify(allowPath)} ]; then exit 0; fi`,
			"trap 'kill \"$child\" 2>/dev/null; exit 143' TERM INT",
			"sleep 9999 &",
			"child=$!",
			`echo $child > ${JSON.stringify(childPidPath)}`,
			'wait "$child"',
		].join("\n"),
	);
	await fs.chmod(executable, 0o755);
	return { executable, pidPath, childPidPath, allowPath };
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await Bun.file(filePath).exists())) {
		if (Date.now() >= deadline) throw new Error(`Path did not appear within ${timeoutMs}ms: ${filePath}`);
		// This integration check waits on another OS process; fake timers cannot drive it.
		await Bun.sleep(10);
	}
}

test("bounds a hanging availability probe and evicts it before retry", async () => {
	if (process.platform === "win32") return;
	using tempDir = TempDir.createSync("@python-probe-timeout-");
	const { executable, pidPath, childPidPath, allowPath } = await createControllableInterpreter(
		tempDir.path(),
		"python",
	);

	const firstProbe = checkPythonKernelAvailability(tempDir.path(), executable, { forceProbe: true });
	const firstOutcome = await Promise.race([
		firstProbe.then(result => ({ kind: "result" as const, result })),
		// The production probe must beat this hard test guard; fake timers cannot drive an OS process.
		Bun.sleep(1_500).then(() => ({ kind: "stuck" as const })),
	]);

	let probePid: number | undefined;
	let probeChildPid: number | undefined;
	if (await Bun.file(pidPath).exists()) probePid = Number.parseInt(await Bun.file(pidPath).text(), 10);
	if (await Bun.file(childPidPath).exists()) {
		probeChildPid = Number.parseInt(await Bun.file(childPidPath).text(), 10);
	}
	if (firstOutcome.kind === "stuck" && probePid !== undefined && processExists(probePid)) {
		killDetachedProcessGroup(probePid, "SIGTERM");
		await Promise.race([firstProbe, Bun.sleep(1_000)]);
	}

	await Bun.write(allowPath, "ready");
	const retryOutcome = await Promise.race([
		checkPythonKernelAvailability(tempDir.path(), executable, { forceProbe: true }).then(result => ({
			kind: "result" as const,
			result,
		})),
		Bun.sleep(1_500).then(() => ({ kind: "stuck" as const })),
	]);

	try {
		expect(firstOutcome.kind).toBe("result");
		if (firstOutcome.kind === "result") {
			expect(firstOutcome.result.ok).toBe(false);
			expect(firstOutcome.result.reason).toMatch(/timed out/i);
		}
		if (probeChildPid !== undefined) expect(await waitForProcessExit(probeChildPid, 1_000)).toBe(true);
		expect(retryOutcome).toMatchObject({ kind: "result", result: { ok: true } });
	} finally {
		if (probePid !== undefined) killDetachedProcessGroup(probePid, "SIGKILL");
	}
}, 10_000);

test("caller abort stops an availability probe tree and leaves the cache retryable", async () => {
	if (process.platform === "win32") return;
	using tempDir = TempDir.createSync("@python-probe-abort-");
	const { executable, pidPath, childPidPath, allowPath } = await createControllableInterpreter(
		tempDir.path(),
		"python",
	);
	const controller = new AbortController();
	const probe = checkPythonKernelAvailability(tempDir.path(), executable, {
		forceProbe: true,
		signal: controller.signal,
	});
	await Promise.all([waitForPath(pidPath, 1_000), waitForPath(childPidPath, 1_000)]);
	const probePid = Number.parseInt(await Bun.file(pidPath).text(), 10);
	const probeChildPid = Number.parseInt(await Bun.file(childPidPath).text(), 10);
	controller.abort(new Error("probe cancelled by caller"));

	const abortOutcome = await Promise.race([
		probe.then(
			() => ({ kind: "resolved" as const }),
			error => ({ kind: "rejected" as const, error }),
		),
		// Caller cancellation must beat both the production hard timeout and this test guard.
		Bun.sleep(750).then(() => ({ kind: "stuck" as const })),
	]);

	try {
		expect(abortOutcome).toMatchObject({
			kind: "rejected",
			error: expect.objectContaining({ message: "probe cancelled by caller" }),
		});
		expect(await waitForProcessExit(probePid, 1_000)).toBe(true);
		expect(await waitForProcessExit(probeChildPid, 1_000)).toBe(true);
		await Bun.write(allowPath, "ready");
		const retry = await checkPythonKernelAvailability(tempDir.path(), executable, { forceProbe: true });
		expect(retry.ok).toBe(true);
	} finally {
		killDetachedProcessGroup(probePid, "SIGKILL");
	}
}, 10_000);

test("interrupts only the active Python cell and continues with the queued cell", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;
	using tempDir = TempDir.createSync("@python-kernel-cancel-");
	const nextCellPath = path.join(tempDir.path(), "next-cell.txt");
	const kernel = await PythonKernel.start({ cwd: tempDir.path() });
	const controller = new AbortController();
	const ready = Promise.withResolvers<void>();

	try {
		const active = kernel.execute("import asyncio\nprint('ready', flush=True)\nawait asyncio.Event().wait()", {
			signal: controller.signal,
			onChunk: chunk => {
				if (chunk.includes("ready")) ready.resolve();
			},
		});
		await ready.promise;
		const queued = kernel.execute(
			`from pathlib import Path\nPath(${JSON.stringify(nextCellPath)}).write_text("healthy")`,
		);
		controller.abort(new Error("cancel active Python cell"));

		expect(await active).toMatchObject({ status: "error", cancelled: true, timedOut: false });
		expect(await queued).toMatchObject({ status: "ok", cancelled: false });
		expect(await Bun.file(nextCellPath).text()).toBe("healthy");
	} finally {
		controller.abort();
		if (kernel.isAlive()) await kernel.shutdown().catch(() => {});
	}
}, 10_000);

test("cancelling a queued Python cell does not interrupt the active cell", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;
	using tempDir = TempDir.createSync("@python-kernel-queued-cancel-");
	const releasePath = path.join(tempDir.path(), "release-active");
	const activePath = path.join(tempDir.path(), "active-finished.txt");
	const queuedPath = path.join(tempDir.path(), "queued-ran.txt");
	const kernel = await PythonKernel.start({ cwd: tempDir.path() });
	const queuedController = new AbortController();
	const ready = Promise.withResolvers<void>();

	try {
		const active = kernel.execute(
			[
				"import asyncio",
				"from pathlib import Path",
				'print("active-ready", flush=True)',
				`while not Path(${JSON.stringify(releasePath)}).exists():`,
				"    await asyncio.sleep(0.01)",
				`Path(${JSON.stringify(activePath)}).write_text("finished")`,
			].join("\n"),
			{
				onChunk: chunk => {
					if (chunk.includes("active-ready")) ready.resolve();
				},
			},
		);
		await ready.promise;
		const queued = kernel.execute(`from pathlib import Path\nPath(${JSON.stringify(queuedPath)}).write_text("ran")`, {
			signal: queuedController.signal,
		});
		queuedController.abort(new Error("cancel queued Python cell"));
		await Bun.write(releasePath, "go");

		expect(await active).toMatchObject({ status: "ok", cancelled: false });
		expect(await queued).toMatchObject({ status: "error", cancelled: true });
		expect(await Bun.file(activePath).text()).toBe("finished");
		expect(await Bun.file(queuedPath).exists()).toBe(false);
	} finally {
		queuedController.abort();
		await Bun.write(releasePath, "go").catch(() => undefined);
		if (kernel.isAlive()) await kernel.shutdown().catch(() => {});
	}
}, 10_000);

test("a failed Python output consumer reports an error without wedging the kernel", async () => {
	const kernel = await PythonKernel.start({ cwd: process.cwd() });
	try {
		const failed = await kernel.execute("consumer_probe = 42\nprint('first')\nprint('second')", {
			timeoutMs: 500,
			onChunk: () => {
				throw new Error("output storage unavailable");
			},
		});
		expect(failed).toMatchObject({
			status: "error",
			cancelled: false,
			timedOut: false,
			error: { name: "OutputError", value: "output storage unavailable" },
		});
		let output = "";
		expect(
			await kernel.execute("print(consumer_probe)", {
				onChunk: text => {
					output += text;
				},
			}),
		).toMatchObject({ status: "ok" });
		expect(output.trim()).toBe("42");
	} finally {
		await kernel.shutdown();
	}
}, 10_000);

test("a rejected async Python display consumer leaves later cells usable", async () => {
	const kernel = await PythonKernel.start({ cwd: process.cwd() });
	try {
		const failed = await kernel.execute("__proto_display({'application/json': {'visible': True}}, raw=True)", {
			onDisplay: async () => {
				throw new Error("display consumer unavailable");
			},
			timeoutMs: 500,
		});
		expect(failed).toMatchObject({
			status: "error",
			cancelled: false,
			timedOut: false,
			error: { name: "OutputError", value: "display consumer unavailable" },
		});
		expect(await kernel.execute("assert 6 * 7 == 42")).toMatchObject({ status: "ok" });
	} finally {
		await kernel.shutdown();
	}
}, 10_000);

test("a Python transport write failure cannot be reported as a successful cell", async () => {
	const kernel = new PythonKernel("unstarted-transport");
	try {
		expect(await kernel.execute("print('must not run')")).toMatchObject({
			status: "error",
			cancelled: true,
			error: { name: "TransportError" },
		});
	} finally {
		await kernel.shutdown();
	}
});

test("a truncated whole-file rewrite from Python reports both sides of the diff", async () => {
	const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!availability.ok) return;

	using tempDir = TempDir.createSync("@python-diff-cap-");
	const target = path.join(tempDir.path(), "rewrite.py");
	await Bun.write(target, Array.from({ length: 1200 }, (_, index) => `before${index} = ${index}`).join("\n"));
	const events: { op: string; path?: string; diff?: string; diffTruncated?: boolean }[] = [];

	await executePython(
		`from pathlib import Path\nPath(${JSON.stringify(target)}).write_text("\\n".join(f"after{i} = {i * 2}" for i in range(1200)))`,
		{ cwd: tempDir.path(), kernelMode: "per-call", onStatus: event => events.push(event) },
	);

	const event = events.find(candidate => candidate.path === target && typeof candidate.diff === "string");
	expect(event?.diffTruncated).toBe(true);
	const rows = (event?.diff ?? "").split("\n");
	// The Python prelude keeps its own copy of the cap; it must trim like the
	// JS tracker, keeping head and tail so a rewrite is never shown as a delete.
	expect(rows.filter(row => row.startsWith("-")).length).toBeGreaterThan(0);
	expect(rows.filter(row => row.startsWith("+")).length).toBeGreaterThan(0);
	expect(rows.filter(row => row.includes("diff lines omitted"))).toHaveLength(1);
	expect(rows.length).toBeLessThanOrEqual(400);
}, 30_000);
