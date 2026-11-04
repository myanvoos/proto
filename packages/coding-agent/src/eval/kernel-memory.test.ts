import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { SessionManager } from "../session/session-manager";
import { captureSessionState } from "../session/state-manifest";
import { KernelMemoryResidency, measureKernelPrivateMemory } from "./kernel-memory";
import { disposeKernelSessionsByOwner, executePython, listPythonKernelSessions } from "./py/executor";
import { pythonForkserverPids, releaseIdlePythonForkservers, shutdownPythonForkservers } from "./py/forkserver";
import { checkPythonKernelAvailability, PythonKernel } from "./py/kernel";

async function start(): Promise<PythonKernel> {
	const available = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
	if (!available.ok) throw new Error(available.reason);
	return PythonKernel.start({ cwd: process.cwd(), interpreter: available.pythonPath });
}
afterAll(shutdownPythonForkservers);

describe("private-memory residency", () => {
	test("idle fork parents count toward the budget and are actually reaped under pressure", async () => {
		const kernel = await start();
		const parent = kernel.forkserverPid!;
		await kernel.shutdown();
		expect(pythonForkserverPids()).toContain(parent);
		const manager = new KernelMemoryResidency(
			async () => ({ bytes: 1, maxResidentCount: 64 }),
			() => false,
			{ pids: pythonForkserverPids, releaseIdle: releaseIdlePythonForkservers },
		);
		await manager.enforce(undefined, true);
		expect(pythonForkserverPids()).not.toContain(parent);
		expect(() => process.kill(parent, 0)).toThrow();
	}, 10_000);

	test("closing the last canonical owner confirms both child and fork parent are gone", async () => {
		const owner = `residency-owner:${crypto.randomUUID()}`;
		try {
			const result = await executePython("value=41", { cwd: process.cwd(), sessionId: owner, kernelOwnerId: owner });
			expect(result.exitCode).toBe(0);
			const info = listPythonKernelSessions(owner)[0];
			expect(info.launchMode).toBe("forkserver");
			await disposeKernelSessionsByOwner(owner);
			expect(() => process.kill(info.pid!, 0)).toThrow();
			expect(() => process.kill(info.forkserverPid!, 0)).toThrow();
		} finally {
			await disposeKernelSessionsByOwner(owner);
		}
	}, 10_000);

	test("a durable automatic boundary lets canonical named kernels park and restore without state jumps", async () => {
		using directory = TempDir.createSync("@named-kernel-lru-");
		const owner = `automatic-lru:${crypto.randomUUID()}`;
		const manager = SessionManager.inMemory(directory.path());
		const settings = Settings.isolated({
			"python.kernelMaxResidentCount": 1,
			"python.kernelMemoryBudgetBytes": 1024 ** 3,
		});
		const init = spyOn(Settings, "init").mockResolvedValue(settings);
		const available = await checkPythonKernelAvailability(directory.path(), undefined, { forceProbe: true });
		const options = { cwd: directory.path(), kernelOwnerId: owner, interpreter: available.pythonPath };
		const firstId = `python:${owner}:lane:first`;
		const secondId = `python:${owner}:lane:second`;
		try {
			expect(
				(
					await executePython(
						"class Box: pass\nvalue=Box(); value.answer=41; value.self=value; alias=value\ndef factory():\n item=value\n return lambda: item\nclosure=factory()",
						{ ...options, sessionId: firstId },
					)
				).exitCode,
			).toBe(0);
			const generation = listPythonKernelSessions(owner)[0].generation;
			manager.appendMessage({ role: "user", content: "first durable boundary", timestamp: 0 });
			await captureSessionState(manager, owner);
			expect((await executePython("other=73", { ...options, sessionId: secondId })).exitCode).toBe(0);
			expect(listPythonKernelSessions(owner).find(info => info.sessionId === firstId)?.residency).toBe("parked");
			manager.appendMessage({ role: "user", content: "second durable boundary", timestamp: 1 });
			await captureSessionState(manager, owner);
			const restored = await executePython(
				"value.answer += 1; print(value.answer, alias is value, value.self is value, closure() is value, type(value) is Box)",
				{ ...options, sessionId: firstId },
			);
			expect(restored.output.trim()).toBe("42 True True True True");
			expect(listPythonKernelSessions(owner).find(info => info.sessionId === firstId)?.generation).not.toBe(
				generation,
			);
		} finally {
			await disposeKernelSessionsByOwner(owner);
			await manager.close();
			init.mockRestore();
		}
	}, 30_000);

	test("only a durable idle LRU is parked and its exact graph can be restored", async () => {
		const safe = new Set<string>();
		let maxResidentCount = 2;
		const manager = new KernelMemoryResidency(
			async () => ({ bytes: 1024 ** 3, maxResidentCount }),
			id => safe.has(id),
		);
		const first = await manager.start(start);
		let second: PythonKernel | undefined;
		try {
			expect(
				(
					await first.execute(
						"class Box: pass\nshared=Box(); shared.items=[]; shared.items.append(shared)\nalias=shared\ndef factory():\n value=shared\n return lambda: value\nclosure=factory()",
					)
				).status,
			).toBe("ok");
			const snapshot = await first.declaredState("capture");
			safe.add(first.id);
			maxResidentCount = 1;
			second = await manager.start(start);
			expect(first.isAlive()).toBe(false);
			expect(manager.report(first.id)?.residency).toBe("parked");
			await second.declaredState("restore", snapshot);
			let result = "";
			expect(
				(
					await second.execute(
						"print(alias is shared, shared.items[0] is shared, closure() is shared, type(shared) is Box)",
						{
							onChunk(chunk) {
								result += chunk;
							},
						},
					)
				).status,
			).toBe("ok");
			expect(result.trim()).toBe("True True True True");
			const memory = await measureKernelPrivateMemory(second.pid!);
			expect(memory.bytes).toBeGreaterThan(0);
		} finally {
			await first.shutdown();
			await second?.shutdown();
		}
	}, 30_000);

	test("an unresponsive idle probe never evicts an unknown kernel under pressure", async () => {
		let budget = 1024 ** 3;
		const manager = new KernelMemoryResidency(
			async () => ({ bytes: budget, maxResidentCount: 64 }),
			() => true,
		);
		const kernel = await manager.start(start);
		try {
			budget = 1;
			process.kill(kernel.pid!, "SIGSTOP");
			await expect(manager.enforce(undefined, true)).rejects.toThrow("no safely durable idle kernel");
			expect(kernel.isAlive()).toBe(true);
		} finally {
			process.kill(kernel.pid!, "SIGCONT");
			await kernel.shutdown();
		}
	}, 10_000);

	test("busy and dirty kernels stay alive over budget and a new launch is refused", async () => {
		let budget = 1024 ** 3;
		let safe = false;
		const manager = new KernelMemoryResidency(
			async () => ({ bytes: budget, maxResidentCount: 64 }),
			() => safe,
		);
		const kernel = await manager.start(start);
		try {
			budget = 1;
			await expect(manager.enforce(undefined, true)).rejects.toThrow("no safely durable idle kernel");
			expect(kernel.isAlive()).toBe(true);
			safe = true;
			const started = Promise.withResolvers<void>();
			const stop = new AbortController();
			const run = kernel.execute("print('started',flush=True); import time; time.sleep(30)", {
				signal: stop.signal,
				onChunk(chunk) {
					if (chunk.includes("started")) started.resolve();
				},
			});
			await started.promise;
			await expect(manager.enforce(undefined, true)).rejects.toThrow("no safely durable idle kernel");
			expect(kernel.isAlive()).toBe(true);
			stop.abort();
			expect((await run).cancelled).toBe(true);
		} finally {
			await kernel.shutdown();
		}
	}, 30_000);
});
