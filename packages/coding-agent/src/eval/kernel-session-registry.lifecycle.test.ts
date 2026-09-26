import { afterEach, expect, test, vi } from "bun:test";
import { KernelAdmission } from "./kernel-admission";
import { MAX_KERNEL_KEEPALIVE_MS } from "./kernel-environment";
import {
	createKernelSessionRegistry,
	type KernelSession,
	type KernelSessionRegistryOptions,
} from "./kernel-session-registry";

interface TestKernel {
	id: string;
	isAlive(): boolean;
	shutdown(): Promise<{ confirmed: boolean }>;
}

class Cancelled extends Error {
	constructor(readonly timedOut: boolean) {
		super("cancelled");
	}
}

afterEach(() => {
	vi.useRealTimers();
});

function registryHarness() {
	let starts = 0;
	let shutdowns = 0;
	const registry = createKernelSessionRegistry<
		TestKernel,
		KernelSessionRegistryOptions,
		number,
		KernelSession<TestKernel>
	>({
		languageLabel: "test",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 100,
		buildSessionKey: id => id,
		createSession: session => session,
		startKernel: async () => {
			let alive = true;
			return {
				id: String(++starts),
				isAlive: () => alive,
				shutdown: async () => {
					shutdowns++;
					alive = false;
					return { confirmed: true };
				},
			};
		},
		kernelBusy: async () => false,
		executeWithKernel: async () => 42,
	});
	return { registry, shutdowns: () => shutdowns };
}

test("explicit lease defers idle reap only until expiry and releases admission", async () => {
	vi.useFakeTimers();
	const { registry, shutdowns } = registryHarness();
	try {
		const first = await registry.startSession("/tmp", { sessionId: "one", kernelOwnerId: "owner" });
		const renewed = registry.keepaliveSession(first.sessionKey, 500);
		expect(renewed.keepAliveUntil).toBe(Date.now() + 500);
		vi.advanceTimersByTime(499);
		expect(shutdowns()).toBe(0);
		expect(registry.listSessions("owner")).toHaveLength(1);
		vi.advanceTimersByTime(1);
		// Drain the asynchronous busy probe and confirmed-shutdown promises, without wall-clock waits.
		for (let turn = 0; turn < 20 && registry.listSessions("owner").length > 0; turn++) await Promise.resolve();
		expect(shutdowns()).toBe(1);
		expect(registry.listSessions("owner")).toHaveLength(0);
		expect((await registry.startSession("/tmp", { sessionId: "two", kernelOwnerId: "owner" })).state).toBe("idle");
	} finally {
		await registry.disposeAll();
	}
});

test("renewal is bounded from now, never an additive unbounded lease", async () => {
	vi.useFakeTimers();
	const { registry } = registryHarness();
	try {
		const first = await registry.startSession("/tmp", { sessionId: "one" });
		const firstLease = registry.keepaliveSession(first.sessionKey, MAX_KERNEL_KEEPALIVE_MS);
		const repeated = registry.keepaliveSession(first.sessionKey, MAX_KERNEL_KEEPALIVE_MS);
		expect(repeated.keepAliveUntil).toBe(firstLease.keepAliveUntil);
		expect(() => registry.keepaliveSession(first.sessionKey, MAX_KERNEL_KEEPALIVE_MS + 1)).toThrow("ttlMs");
		await registry.closeSession(first.sessionKey);
		expect(registry.listSessions()).toEqual([]);
		expect(() => registry.keepaliveSession(first.sessionKey, 1)).toThrow("Unknown");
	} finally {
		await registry.disposeAll();
	}
});
