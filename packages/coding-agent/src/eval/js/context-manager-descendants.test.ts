import { expect, test } from "bun:test";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./context-manager";
import { executeJs } from "./executor";

test("disposing a JS kernel confirms exit of ordinary cell descendants without touching an independently owned service", async () => {
	// Child timers only keep real OS processes alive; all assertions await lifecycle events, not elapsed time.
	const owner = `descendants:${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir: process.cwd(), inMemory: true });
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const service = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	const serviceIdentity = Process.fromPid(service.pid)!;
	let descendant: Process | null = null;
	try {
		const result = await executeJs(
			`var child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); console.log(child.pid); child.unref();`,
			{ session, sessionId: owner, kernelOwnerId: owner },
		);
		expect(result.exitCode).toBe(0);
		const pid = Number(result.output.trim());
		expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
		descendant = Process.fromPid(pid);
		expect(descendant?.status()).toBe(ProcessStatus.Running);
		await disposeVmContextsByOwner(owner);
		expect(descendant?.status()).toBe(ProcessStatus.Exited);
		expect(serviceIdentity.status()).toBe(ProcessStatus.Running);
	} finally {
		await disposeVmContextsByOwner(owner);
		await descendant?.terminate({ gracefulMs: -1, timeoutMs: 1_000 });
		await serviceIdentity.terminate({ group: true, gracefulMs: -1, timeoutMs: 1_000 });
		await service.exited;
	}
}, 30_000);

test("owner disposal waits for descendants from a previous cell even after the JS worker crashes", async () => {
	const owner = `crashed-descendants:${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir: process.cwd(), inMemory: true });
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const descendants: Process[] = [];
	try {
		const result = await executeJs(
			`var childPids = [false, true].map(detached => { var child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); child.unref(); return child.pid; }); console.log(JSON.stringify(childPids));`,
			{ session, sessionId: owner, kernelOwnerId: owner },
		);
		expect(result.exitCode).toBe(0);
		for (const pid of JSON.parse(result.output.trim()) as number[]) {
			const child = Process.fromPid(pid);
			expect(child?.status()).toBe(ProcessStatus.Running);
			if (child) descendants.push(child);
		}
		await expect(
			executeInVmContext({
				sessionKey: owner,
				sessionId: owner,
				ownerId: owner,
				cwd: process.cwd(),
				session,
				code: "process.exit(17)",
				filename: "crash.js",
				runState: {},
			}),
		).rejects.toThrow("completion is uncertain");
		await disposeVmContextsByOwner(owner);
		expect(descendants.map(child => child.status())).toEqual([ProcessStatus.Exited, ProcessStatus.Exited]);
	} finally {
		await disposeVmContextsByOwner(owner);
		await Promise.all(descendants.map(child => child.terminate({ gracefulMs: -1, timeoutMs: 1_000 })));
	}
}, 30_000);
