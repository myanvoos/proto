import { afterEach, expect, test, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { KernelAdmission } from "./kernel-admission";
import {
	createKernelSessionRegistry,
	type KernelSession,
	type KernelSessionRegistryOptions,
} from "./kernel-session-registry";

class Cancelled extends Error {
	constructor(readonly timedOut: boolean) {
		super("cancelled");
	}
}

afterEach(() => vi.useRealTimers());

test("shared kernel startup and replacement readers do not inherit a caller session", async () => {
	const events: logger.LogEvent[] = [];
	const unregister = logger.registerLogSink(event => {
		if (event.message.startsWith("shared-kernel-")) events.push(event);
	});
	let alive = true;
	interface Kernel {
		isAlive(): boolean;
		shutdown(): Promise<{ confirmed: boolean }>;
	}
	const registry = createKernelSessionRegistry<Kernel, KernelSessionRegistryOptions, void, KernelSession<Kernel>>({
		languageLabel: "LogTest",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 0,
		buildSessionKey: () => "shared",
		createSession: session => session,
		startKernel: async () => {
			logger.info("shared-kernel-start");
			await Promise.resolve();
			logger.info("shared-kernel-reader");
			alive = true;
			return { isAlive: () => alive, shutdown: async () => ({ confirmed: true }) };
		},
		executeWithKernel: async () => {
			logger.info("shared-kernel-cell");
		},
	});
	try {
		await logger.withContext({ sessionId: "first-caller" }, () => registry.executeOnSession("one", "/tmp", {}));
		alive = false;
		await logger.withContext({ sessionId: "second-caller" }, () => registry.executeOnSession("two", "/tmp", {}));
		expect(events.map(event => [event.message, event.context?.sessionId])).toEqual([
			["shared-kernel-start", undefined],
			["shared-kernel-reader", undefined],
			["shared-kernel-cell", "first-caller"],
			["shared-kernel-start", undefined],
			["shared-kernel-reader", undefined],
			["shared-kernel-cell", "second-caller"],
		]);
	} finally {
		unregister();
		await registry.disposeAll();
	}
});

test("idle release logs identify a kernel without claiming the caller's conversation", async () => {
	vi.useFakeTimers();
	const events: logger.LogEvent[] = [];
	const unregister = logger.registerLogSink(event => {
		if (event.message === "LogTest kernel released after idle timeout") events.push(event);
	});
	interface Kernel {
		isAlive(): boolean;
		shutdown(): Promise<{ confirmed: boolean }>;
	}
	const registry = createKernelSessionRegistry<Kernel, KernelSessionRegistryOptions, void, KernelSession<Kernel>>({
		languageLabel: "LogTest",
		cancelledErrorClass: Cancelled,
		admission: new KernelAdmission(1, 1),
		idleReapMs: 100,
		buildSessionKey: () => "shared",
		createSession: session => session,
		startKernel: async () => ({ isAlive: () => true, shutdown: async () => ({ confirmed: true }) }),
		kernelBusy: async () => false,
		executeWithKernel: async () => {},
	});
	try {
		await logger.withContext({ sessionId: "conversation" }, () =>
			registry.startSession("/tmp", { sessionId: "kernel" }),
		);
		vi.advanceTimersByTime(100);
		for (let tick = 0; tick < 20 && registry.listSessions().length > 0; tick++) await Promise.resolve();
		expect(events.map(event => event.context)).toEqual([
			{ sessionKey: "shared", kernelSessionId: "kernel", idleReapMs: 100 },
		]);
	} finally {
		unregister();
		await registry.disposeAll();
	}
});
