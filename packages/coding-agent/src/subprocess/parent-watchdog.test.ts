import { expect, test } from "bun:test";

const watchdogPath = new URL("./parent-watchdog.ts", import.meta.url).pathname;

test("a worker blocked on its main thread is reaped after its parent exits", async () => {
	const childCode = `
		import { startParentWatchdog } from ${JSON.stringify(watchdogPath)};
		startParentWatchdog(process.ppid);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
	`;
	const parent = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		const child = Bun.spawn([process.execPath, "--eval", ${JSON.stringify(childCode)}], { stdout: "ignore", stderr: "ignore" });
		process.stdout.write(String(child.pid));
		await child.exited;
	`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	let childPid: number | undefined;
	try {
		const reader = parent.stdout.getReader();
		const first = await reader.read();
		reader.releaseLock();
		childPid = Number(new TextDecoder().decode(first.value));
		expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
		await Bun.sleep(500);
		parent.kill("SIGKILL");
		await parent.exited;
		const deadline = Date.now() + 5_000;
		let alive = true;
		while (alive && Date.now() < deadline) {
			try {
				process.kill(childPid, 0);
			} catch {
				alive = false;
			}
			if (alive) await Bun.sleep(50);
		}
		expect(alive).toBe(false);
	} finally {
		parent.kill("SIGKILL");
		await parent.exited;
		if (childPid) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {}
		}
	}
}, 10_000);
