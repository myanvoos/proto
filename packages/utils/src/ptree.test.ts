import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { AbortError, type ExecResult, exec, spawn, TimeoutError, terminateProcess } from "./ptree";

// Real subprocess timing throughout: fake timers cannot drive child processes or pipe EOF.

const BLOCK_FOREVER = `${JSON.stringify(process.execPath)} -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'`;

async function expectStopped(pid: number): Promise<void> {
	// SIGKILL delivery is synchronous, but exit observation may settle on a later scheduler turn.
	const deadline = Date.now() + 1_000;
	let status = Process.fromPid(pid)?.status();
	while (status === ProcessStatus.Running && Date.now() < deadline) {
		await Bun.sleep(10);
		status = Process.fromPid(pid)?.status();
	}
	expect(status).not.toBe(ProcessStatus.Running);
}

describe("ptree child output limits", () => {
	test("kills a child that streams forever after stdout reaches the cap", async () => {
		const result = await exec(
			["sh", "-c", "while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"],
			{
				allowAbort: true,
				allowNonZero: true,
				maxStdoutBytes: 1024,
				maxStderrBytes: 1024,
			},
		);

		expect(result.ok).toBe(false);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
	});
});

describe("ptree command deadlines", () => {
	test("a timed command returns at its deadline when an orphan keeps stdout open", async () => {
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 & echo token $!"], {
				timeout: 500,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /^token (\d+)$/.exec(result.stdout.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(match, `stdout was: ${result.stdout}`).not.toBeNull();
			expect(result.ok).toBe(true);
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	test("an untimed command keeps reading output an orphan writes after the root exits", async () => {
		const result = await exec(["sh", "-c", "(sleep .2; printf token) &"], { allowNonZero: true, allowAbort: true });

		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("token");
	});

	test("a fast command under a long timeout does not hold the event loop", async () => {
		const probe = `import { exec } from ${JSON.stringify(`${import.meta.dir}/ptree.ts`)};
const result = await exec([process.execPath, "-e", "console.log('ok')"], { timeout: 10_000 });
if (result.stdout.trim() !== "ok" || !result.ok) process.exit(3);
console.log("probe-done");`;

		const start = performance.now();
		const text = await spawn([process.execPath, "-e", probe], { timeout: 15_000 }).text();
		const elapsedMs = performance.now() - start;

		expect(text).toContain("probe-done");
		expect(elapsedMs).toBeLessThan(5_000);
	});

	test("the deadline kills a detached group whose leader exited while a member holds stdout", async () => {
		let orphanPid: number | undefined;
		try {
			const result = await exec(["sh", "-c", "sleep 30 & echo $!"], {
				detached: true,
				timeout: 250,
				allowNonZero: true,
				allowAbort: true,
			});
			orphanPid = Number.parseInt(result.stdout.trim(), 10);

			expect(result.exitError).toBeInstanceOf(TimeoutError);
			expect(result.ok).toBe(false);
			await expectStopped(orphanPid);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	test("text() rejects with the timeout when the deadline fires after the root exits", async () => {
		using child = spawn(["sh", "-c", "sleep 30 & echo token"], { detached: true, timeout: 250 });

		await expect(child.text()).rejects.toBeInstanceOf(TimeoutError);
	});

	test("a timeout hard-kills a SIGTERM-ignoring descendant before its dying root orphans it", async () => {
		// A graceful phase would TERM the root, which exits and reparents the TERM-ignoring child out of the tree
		// the follow-up SIGKILL walks.
		const result = await exec(["sh", "-c", "(trap '' TERM; sleep 30) & echo $!; wait"], {
			timeout: 250,
			allowNonZero: true,
			allowAbort: true,
		});
		const descendantPid = Number.parseInt(result.stdout.trim(), 10);
		try {
			expect(result.exitError).toBeInstanceOf(TimeoutError);
			expect(Process.fromPid(descendantPid)?.status()).not.toBe(ProcessStatus.Running);
		} finally {
			Process.fromPid(descendantPid)?.killTree(9);
		}
	});
});

describe("ptree abort with inherited output pipes", () => {
	/** Spawn a root that leaves a pipe-holding descendant behind, then let its exit and stderr EOF settle. */
	async function spawnPipeHolder(detached: boolean, controller: AbortController) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ptree-abort-output-"));
		const pidFile = path.join(dir, "pid");
		const child = spawn(["/bin/sh", "-c", `${BLOCK_FOREVER} 2>/dev/null & echo $! > '${pidFile}'; echo token`], {
			detached,
			signal: controller.signal,
		});
		await child.exited;
		const orphan = Process.fromPid(Number.parseInt(await Bun.file(pidFile).text(), 10));
		if (!orphan) throw new Error("the fixture must expose its pipe-holding descendant");
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;
		return { child, orphan, dir };
	}

	test.each([false, true])("aborts a read started after the root exits (detached: %s)", async detached => {
		const controller = new AbortController();
		const { child, orphan, dir } = await spawnPipeHolder(detached, controller);
		let outcome: Promise<ExecResult> | undefined;
		try {
			// The root exit and stderr EOF have detached the signal listener; the read must re-arm cancellation for
			// inherited pipes. Without a detached group, reader cutoff alone must release wait().
			outcome = child.wait({ allowAbort: true });
			controller.abort("abort inherited output");
			expect(child.exitReason).toBeInstanceOf(AbortError);

			const result = await outcome;
			expect(result.exitError).toBeInstanceOf(AbortError);
			expect(result.stdout).toBe("token\n");
			if (detached) {
				expect(await orphan.waitForExit(), "the detached descendant must be terminated").toBe(true);
			}
		} finally {
			orphan.killTree(9);
			await orphan.waitForExit();
			child.kill();
			await outcome?.catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("aborts wait() when cancelled after root exit and stderr closure before wait() starts", async () => {
		const controller = new AbortController();
		const { child, orphan, dir } = await spawnPipeHolder(true, controller);
		let outcome: Promise<ExecResult> | undefined;
		try {
			// Cancel while no pipe reader is active, then start wait(): the retained registration must re-arm the
			// listener for the new read.
			controller.abort("abort before wait starts");
			outcome = child.wait({ allowAbort: true });
			expect(child.exitReason).toBeInstanceOf(AbortError);

			const result = await outcome;
			expect(result.exitError).toBeInstanceOf(AbortError);
			expect(await orphan.waitForExit(), "the detached descendant must be terminated").toBe(true);
		} finally {
			orphan.killTree(9);
			await orphan.waitForExit();
			child.kill();
			await outcome?.catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("owned process termination", () => {
	test("native termination failure still stops the owned child", async () => {
		const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const identity = Process.fromPid(child.pid)!;
		const broken = spyOn(identity, "terminate").mockRejectedValue(new Error("native realm unavailable"));
		try {
			expect(await terminateProcess(child, identity, { gracefulMs: 0 })).toBe(true);
			await child.exited;
			await expectStopped(child.pid);
		} finally {
			broken.mockRestore();
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	});

	test("terminates a detached orphan group within the supplied deadline", async () => {
		const child = Bun.spawn(["sh", "-c", "sleep 30 & echo $!"], { detached: true, stdout: "pipe", stderr: "pipe" });
		const identity = Process.fromPid(child.pid);
		const reader = child.stdout.getReader();
		let orphan: Process | null = null;
		try {
			const chunk = await reader.read();
			const pid = Number(new TextDecoder().decode(chunk.value).trim());
			orphan = Process.fromPid(pid);
			expect(orphan).not.toBeNull();
			await child.exited;
			const start = performance.now();
			expect(await terminateProcess(child, identity, { detached: true, hasOpenPipes: true, timeoutMs: 1_000 })).toBe(
				true,
			);
			expect(await orphan!.waitForExit({ timeoutMs: 1_000 })).toBe(true);
			expect(performance.now() - start).toBeLessThan(2_000);
		} finally {
			orphan?.killTree(9);
			await reader.cancel();
			reader.releaseLock();
		}
	});

	test("an exited descriptor without inherited pipes cannot signal a recycled process id", async () => {
		const exited = Bun.spawn(["sh", "-c", "exit"], { detached: true });
		const exitedIdentity = Process.fromPid(exited.pid);
		await exited.exited;
		const unrelated = Bun.spawn(["sh", "-c", "sleep 30"], { detached: true, stdout: "ignore", stderr: "ignore" });
		const unrelatedIdentity = Process.fromPid(unrelated.pid)!;
		try {
			// Deterministically model PID reuse rather than exhausting the host PID namespace.
			const staleDescriptor = { pid: unrelated.pid, exitCode: 0 };
			expect(await terminateProcess(staleDescriptor, exitedIdentity, { detached: true, hasOpenPipes: false })).toBe(
				true,
			);
			expect(unrelatedIdentity.status()).toBe(ProcessStatus.Running);
		} finally {
			await unrelatedIdentity.terminate({ group: true, gracefulMs: -1, timeoutMs: 1_000 });
			await unrelated.exited;
		}
	});

	test("live identity termination is bounded for a TERM-resistant child", async () => {
		const child = Bun.spawn(["sh", "-c", "trap '' TERM; echo ready; while :; do sleep 1; done"], {
			detached: true,
			stdout: "pipe",
			stderr: "ignore",
		});
		const identity = Process.fromPid(child.pid)!;
		const reader = child.stdout.getReader();
		try {
			await reader.read();
			const start = performance.now();
			expect(
				await terminateProcess(child, identity, {
					detached: true,
					hasOpenPipes: true,
					gracefulMs: 50,
					timeoutMs: 1_000,
				}),
			).toBe(true);
			await child.exited;
			expect(identity.status()).toBe(ProcessStatus.Exited);
			expect(performance.now() - start).toBeLessThan(2_000);
		} finally {
			identity.killTree(9);
			await reader.cancel();
			reader.releaseLock();
		}
	});
});
