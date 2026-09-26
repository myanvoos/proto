import { expect, test } from "bun:test";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { disposeVmContextsByOwner, executeInVmContext } from "./js/context-manager";
import { KernelAdmission, KernelStartupCleanupError, kernelAdmission } from "./kernel-admission";
import {
	createKernelSessionRegistry,
	type KernelSession,
	type KernelSessionRegistryOptions,
} from "./kernel-session-registry";
import { disposeKernelSessionsByOwner, executePython } from "./py/executor";
import { type KernelExecuteResult, PythonKernel } from "./py/kernel";

interface Kernel {
	isAlive(): boolean;
	shutdown(): Promise<{ confirmed: boolean }>;
}

class Cancelled extends Error {
	constructor(readonly timedOut: boolean) {
		super("cancelled");
	}
}

test("interpreter admission counts concurrent startups across registries and releases only confirmed shutdowns", async () => {
	const admission = new KernelAdmission(2, 1);
	const startup = Promise.withResolvers<void>();
	let starts = 0;
	let confirmed = false;
	const create = () =>
		createKernelSessionRegistry<Kernel, KernelSessionRegistryOptions, number, KernelSession<Kernel>>({
			languageLabel: "test",
			cancelledErrorClass: Cancelled,
			admission,
			idleReapMs: 0,
			buildSessionKey: id => id,
			createSession: session => session,
			startKernel: async () => {
				starts++;
				await startup.promise;
				return { isAlive: () => true, shutdown: async () => ({ confirmed }) };
			},
			executeWithKernel: async () => 42,
		});
	const first = create();
	const second = create();
	const pending = first.executeOnSession("", "/tmp", { sessionId: "first", kernelOwnerId: "one" });
	try {
		await expect(second.executeOnSession("", "/tmp", { sessionId: "other", kernelOwnerId: "one" })).rejects.toThrow(
			"Interpreter limit",
		);
		const other = second.executeOnSession("", "/tmp", { sessionId: "second", kernelOwnerId: "two" });
		await expect(first.executeOnSession("", "/tmp", { sessionId: "third", kernelOwnerId: "three" })).rejects.toThrow(
			"Interpreter limit",
		);
		expect(starts).toBe(2);
		startup.resolve();
		expect(await pending).toBe(42);
		expect(await other).toBe(42);
		await first.disposeByOwner("one");
		await expect(first.executeOnSession("", "/tmp", { sessionId: "third", kernelOwnerId: "three" })).rejects.toThrow(
			"Interpreter limit",
		);
		confirmed = true;
		await first.disposeByOwner("one");
		expect(await first.executeOnSession("", "/tmp", { sessionId: "third", kernelOwnerId: "three" })).toBe(42);
		expect(starts).toBe(3);
	} finally {
		startup.resolve();
		confirmed = true;
		await pending.catch(() => {});
		await Promise.all([first.disposeAll(), second.disposeAll()]);
	}
});

test("failed interpreter startup returns its admission slot", async () => {
	let starts = 0;
	const registry = createKernelSessionRegistry<Kernel, KernelSessionRegistryOptions, number, KernelSession<Kernel>>({
		languageLabel: "test",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 0,
		buildSessionKey: id => id,
		createSession: session => session,
		startKernel: async () => {
			if (++starts === 1) throw new Error("startup failed");
			return { isAlive: () => true, shutdown: async () => ({ confirmed: true }) };
		},
		executeWithKernel: async () => 42,
	});
	try {
		await expect(registry.executeOnSession("", "/tmp", { sessionId: "failed" })).rejects.toThrow("startup failed");
		expect(await registry.executeOnSession("", "/tmp", { sessionId: "replacement" })).toBe(42);
	} finally {
		await registry.disposeAll();
	}
});

test("a crashed Python kernel is reaped despite its unknown busy status and frees interpreter admission", async () => {
	let shutdowns = 0;
	const reaped = Promise.withResolvers<void>();
	const registry = createKernelSessionRegistry<
		PythonKernel,
		KernelSessionRegistryOptions,
		KernelExecuteResult,
		KernelSession<PythonKernel>
	>({
		languageLabel: "Python",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 25,
		buildSessionKey: id => id,
		createSession: session => session,
		startKernel: cwd => PythonKernel.start({ cwd }),
		executeWithKernel: (kernel, code) => kernel.execute(code),
		kernelBusy: kernel => kernel.isBusy(),
		shutdownSession: async session => {
			const result = await session.kernel.shutdown();
			shutdowns++;
			reaped.resolve();
			return result;
		},
	});
	try {
		const crashed = await registry.executeOnSession("import os; os._exit(17)", process.cwd(), {
			sessionId: "crashed",
		});
		expect(crashed.cancelled).toBe(true);
		expect(crashed.kernelKilled).toBe(true);
		// Real subprocess/TCP lifecycle needs platform time; this timer only bounds a failed reap.
		await Promise.race([
			reaped.promise,
			Bun.sleep(5_000).then(() => {
				throw new Error("dead kernel never reaped");
			}),
		]);
		await Promise.resolve();
		expect(shutdowns).toBe(1);
		await registry.executeOnSession("assert 6 * 7 == 42", process.cwd(), { sessionId: "replacement" });
	} finally {
		await registry.disposeAll();
	}
}, 20_000);

test("JS and per-call Python share owner admission and return capacity after confirmed disposal", async () => {
	const owner = `admission:${crypto.randomUUID()}`;
	const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir: process.cwd(), inMemory: true });
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const reservations = Array.from({ length: kernelAdmission.maxKernelsPerOwner }, () =>
		kernelAdmission.reserve(owner),
	);
	const js = () =>
		executeInVmContext({
			sessionKey: owner,
			sessionId: owner,
			ownerId: owner,
			session,
			cwd: process.cwd(),
			code: "globalThis.admitted = 42",
			filename: "admission.js",
			runState: {},
		});
	const python = () =>
		executePython("print(6 * 7)", { sessionId: owner, kernelOwnerId: owner, kernelMode: "per-call" });
	try {
		await expect(js()).rejects.toThrow("Interpreter limit");
		await expect(python()).rejects.toThrow("Interpreter limit");
		reservations[0]();
		await js();
		await expect(python()).rejects.toThrow("Interpreter limit");
		await disposeVmContextsByOwner(owner);
		for (let call = 0; call < 2; call++) {
			const result = await python();
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("42");
		}
	} finally {
		await Promise.all([disposeVmContextsByOwner(owner), disposeKernelSessionsByOwner(owner)]);
		for (const release of reservations) release();
	}
}, 30_000);

test("a failed startup keeps its reservation until its retained process cleanup confirms exit", async () => {
	let starts = 0;
	let confirmed = false;
	const registry = createKernelSessionRegistry<Kernel, KernelSessionRegistryOptions, number, KernelSession<Kernel>>({
		languageLabel: "test",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 0,
		buildSessionKey: id => id,
		createSession: session => session,
		startKernel: async () => {
			if (++starts === 1) throw new KernelStartupCleanupError(new Error("init failed"), async () => ({ confirmed }));
			return { isAlive: () => true, shutdown: async () => ({ confirmed: true }) };
		},
		executeWithKernel: async () => 42,
	});
	try {
		await expect(registry.executeOnSession("", "/tmp", { sessionId: "owner" })).rejects.toThrow("init failed");
		await registry.disposeByOwner("owner");
		await expect(registry.executeOnSession("", "/tmp", { sessionId: "owner" })).rejects.toThrow("Interpreter limit");
		expect(starts).toBe(1);
		confirmed = true;
		expect(await registry.executeOnSession("", "/tmp", { sessionId: "owner" })).toBe(42);
		expect(starts).toBe(2);
	} finally {
		confirmed = true;
		await registry.disposeAll();
	}
});

test("cancelling a startup waiter does not orphan the starting interpreter from owner disposal", async () => {
	const startup = Promise.withResolvers<void>();
	const cancelWaiter = Promise.withResolvers<never>();
	let shutdowns = 0;
	const registry = createKernelSessionRegistry<Kernel, KernelSessionRegistryOptions, number, KernelSession<Kernel>>({
		languageLabel: "test",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 0,
		buildSessionKey: id => id,
		createSession: session => session,
		startKernel: async () => {
			await startup.promise;
			return {
				isAlive: () => true,
				shutdown: async () => {
					shutdowns++;
					return { confirmed: true };
				},
			};
		},
		waitForStartup: (promise, options) => (options.signal ? Promise.race([promise, cancelWaiter.promise]) : promise),
		executeWithKernel: async () => 42,
	});
	const pending = registry.executeOnSession("", "/tmp", { sessionId: "owner", signal: new AbortController().signal });
	try {
		cancelWaiter.reject(new Cancelled(false));
		await expect(pending).rejects.toThrow("cancelled");
		const disposed = registry.disposeByOwner("owner");
		startup.resolve();
		await disposed;
		expect(shutdowns).toBe(1);
		expect(await registry.executeOnSession("", "/tmp", { sessionId: "replacement" })).toBe(42);
	} finally {
		startup.resolve();
		await registry.disposeAll();
	}
});
