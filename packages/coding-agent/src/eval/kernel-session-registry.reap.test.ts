import { expect, test, vi } from "bun:test";
import {
	createKernelSessionRegistry,
	type KernelSession,
	type KernelSessionRegistry,
	type KernelSessionRegistryOptions,
} from "./kernel-session-registry";

interface Kernel {
	isAlive(): boolean;
	shutdown(): Promise<{ confirmed: boolean }>;
}
interface Options extends KernelSessionRegistryOptions {}
type Session = KernelSession<Kernel>;

test("idle reap retains ownership through unconfirmed and rejected shutdowns", async () => {
	vi.useFakeTimers();
	try {
		let starts = 0;
		let shutdowns = 0;
		const registry = createKernelSessionRegistry<Kernel, Options, number, Session>({
			languageLabel: "Test",
			cancelledErrorClass: class extends Error {} as unknown as never,
			buildSessionKey: sessionId => sessionId,
			createSession: session => session,
			startKernel: () => {
				starts += 1;
				return Promise.resolve({
					isAlive: () => true,
					shutdown: () => {
						shutdowns += 1;
						if (shutdowns === 1) return Promise.resolve({ confirmed: false });
						if (shutdowns === 2) return Promise.reject(new Error("shutdown failed"));
						return Promise.resolve({ confirmed: true });
					},
				});
			},
			executeWithKernel: async (_kernel, _code) => starts,
			kernelBusy: async () => false,
			idleReapMs: 10,
		});
		await registry.executeOnSession("one", "/tmp", { sessionId: "one" });
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdowns).toBe(1);
		await registry.executeOnSession("still tracked", "/tmp", { sessionId: "one" });
		expect(starts).toBe(1);
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdowns).toBe(2);
		await registry.executeOnSession("still tracked", "/tmp", { sessionId: "one" });
		expect(starts).toBe(1);
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdowns).toBe(3);
		await registry.executeOnSession("replacement", "/tmp", { sessionId: "one" });
		expect(starts).toBe(2);
	} finally {
		vi.useRealTimers();
	}
});

test("idle reap stops automatic retries after the bounded shutdown attempts", async () => {
	vi.useFakeTimers();
	try {
		let starts = 0;
		let shutdowns = 0;
		const registry = createKernelSessionRegistry<Kernel, Options, number, Session>({
			languageLabel: "Test",
			cancelledErrorClass: class extends Error {} as unknown as never,
			buildSessionKey: sessionId => sessionId,
			createSession: session => session,
			startKernel: () => {
				starts += 1;
				return Promise.resolve({
					isAlive: () => true,
					shutdown: async () => {
						shutdowns += 1;
						return { confirmed: false };
					},
				});
			},
			executeWithKernel: async () => starts,
			kernelBusy: async () => false,
			idleReapMs: 10,
		});
		await registry.executeOnSession("one", "/tmp", { sessionId: "one" });
		vi.advanceTimersByTime(10 + 20 + 40 + 80 + 1_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdowns).toBe(4);
		await registry.executeOnSession("still tracked", "/tmp", { sessionId: "one" });
		expect(starts).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test("unsafe declared state stays resident until capture is safe while explicit close remains available", async () => {
	vi.useFakeTimers();
	let registry: KernelSessionRegistry<Options, number> | undefined;
	try {
		let starts = 0;
		let shutdowns = 0;
		let safe = false;
		registry = createKernelSessionRegistry<Kernel, Options, number, Session>({
			languageLabel: "State safety",
			cancelledErrorClass: class extends Error {} as unknown as never,
			buildSessionKey: sessionId => sessionId,
			createSession: session => session,
			startKernel: async () => {
				starts++;
				return {
					isAlive: () => true,
					shutdown: async () => {
						shutdowns++;
						return { confirmed: true };
					},
				};
			},
			executeWithKernel: async () => starts,
			kernelBusy: async () => false,
			kernelSafeToReap: () => safe,
			idleReapMs: 10,
		});
		await registry.executeOnSession("dirty namespace", "/tmp", { sessionId: "state-reap" });
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdowns).toBe(0);
		expect(await registry.executeOnSession("same namespace", "/tmp", { sessionId: "state-reap" })).toBe(1);
		safe = true;
		vi.advanceTimersByTime(10);
		await Promise.resolve();
		await Promise.resolve();
		expect(shutdowns).toBe(1);
		expect(await registry.executeOnSession("new generation", "/tmp", { sessionId: "state-reap" })).toBe(2);
		safe = false;
		await registry.closeSession("state-reap");
		expect(shutdowns).toBe(2);
	} finally {
		await registry?.disposeAll();
		vi.useRealTimers();
	}
});
