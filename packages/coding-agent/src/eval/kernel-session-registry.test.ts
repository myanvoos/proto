import { describe, expect, test } from "bun:test";

import {
	createKernelSessionRegistry,
	DEFAULT_KERNEL_IDLE_REAP_MS,
	type KernelReapNote,
	type KernelSession,
	type KernelSessionRegistry,
	type KernelSessionRegistryOptions,
} from "./kernel-session-registry";

const SHORT_IDLE_MS = 30;

interface StubKernel {
	isAlive: () => boolean;
	shutdown: (options?: { timeoutMs: number }) => Promise<{ confirmed: boolean }>;
	isBusy: () => Promise<boolean | undefined>;
	tag: number;
	disposed: boolean;
}

interface StubOptions extends KernelSessionRegistryOptions {
	onStatus?: (event: { op: string }) => void;
}

type StubSession = KernelSession<StubKernel>;

function createHarness(busy: boolean | undefined) {
	let nextTag = 0;
	const kernels: StubKernel[] = [];
	const reapNotes: KernelReapNote[] = [];
	let lastStatusOp: string | undefined;
	const registry: KernelSessionRegistry<StubOptions, string> = createKernelSessionRegistry<
		StubKernel,
		StubOptions,
		string,
		StubSession
	>({
		languageLabel: "Stub",
		cancelledErrorClass: class StubCancelled extends Error {} as unknown as never,
		buildSessionKey: sessionId => sessionId,
		createSession: session => session,
		startKernel: () => {
			const kernel: StubKernel = {
				tag: nextTag++,
				isAlive: () => !kernel.disposed,
				disposed: false,
				shutdown: () => {
					kernel.disposed = true;
					return Promise.resolve({ confirmed: true });
				},
				isBusy: () => Promise.resolve(busy),
			};
			kernels.push(kernel);
			return Promise.resolve(kernel);
		},
		executeWithKernel: (kernel, code, options) => {
			lastStatusOp = `ran:${kernel.tag}`;
			options?.onStatus?.({ op: lastStatusOp });
			return Promise.resolve(`${kernel.tag}:${code}`);
		},
		kernelBusy: kernel => kernel.isBusy(),
		notifySessionReaped: (_options, note) => reapNotes.push(note),
		idleReapMs: SHORT_IDLE_MS,
	});
	return { registry, kernels, reapNotes, lastStatus: () => lastStatusOp };
}

describe("kernel session registry idle reap", () => {
	test("reaps quiescent kernel after idle timeout and respawns fresh on next call", async () => {
		const harness = createHarness(false);
		const options: StubOptions = {};
		expect(await harness.registry.executeOnSession("one", "/tmp", options)).toBe("0:one");
		expect(harness.kernels).toHaveLength(1);
		await Bun.sleep(SHORT_IDLE_MS + 60);
		expect(harness.kernels[0].disposed).toBe(true);
		expect(await harness.registry.executeOnSession("two", "/tmp", options)).toBe("1:two");
		expect(harness.kernels).toHaveLength(2);
		expect(harness.reapNotes).toHaveLength(1);
		expect(harness.reapNotes[0].idleMs).toBe(SHORT_IDLE_MS);
		expect(harness.lastStatus()).toBe("ran:1");
	});

	test("does not reap while kernel reports in-flight work", async () => {
		const harness = createHarness(true);
		const options: StubOptions = {};
		await harness.registry.executeOnSession("one", "/tmp", options);
		await Bun.sleep(SHORT_IDLE_MS + 60);
		expect(harness.kernels).toHaveLength(1);
		expect(harness.kernels[0].disposed).toBe(false);
		await harness.registry.executeOnSession("two", "/tmp", options);
		expect(harness.kernels).toHaveLength(1);
		expect(harness.reapNotes).toHaveLength(0);
	});

	test("treats unknown busy state as busy", async () => {
		const harness = createHarness(undefined);
		await harness.registry.executeOnSession("one", "/tmp", {});
		await Bun.sleep(SHORT_IDLE_MS + 60);
		expect(harness.kernels[0].disposed).toBe(false);
	});

	test("does not reap while a cell is executing", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let kernel: StubKernel | undefined;
		const registry = createKernelSessionRegistry<StubKernel, StubOptions, string, StubSession>({
			languageLabel: "Stub",
			cancelledErrorClass: class StubCancelled extends Error {} as unknown as never,
			buildSessionKey: sessionId => sessionId,
			createSession: session => session,
			startKernel: () => {
				kernel = {
					tag: 0,
					isAlive: () => !kernel?.disposed,
					disposed: false,
					shutdown: () => {
						if (kernel) kernel.disposed = true;
						return Promise.resolve({ confirmed: true });
					},
					isBusy: () => Promise.resolve(false),
				};
				return Promise.resolve(kernel);
			},
			executeWithKernel: () => gate.then(() => "done"),
			kernelBusy: kernelArg => kernelArg.isBusy(),
			idleReapMs: SHORT_IDLE_MS,
		});
		const execution = registry.executeOnSession("code", "/tmp", {} as StubOptions);
		await Bun.sleep(SHORT_IDLE_MS * 3);
		expect(kernel?.disposed).toBe(false);
		release?.();
		expect(await execution).toBe("done");
		await Bun.sleep(SHORT_IDLE_MS + 60);
		// After the cell settles, the quiescent kernel is reaped.
		expect(kernel?.disposed).toBe(true);
	});

	test("activity re-arms the idle timer", async () => {
		const harness = createHarness(false);
		const options: StubOptions = {};
		await harness.registry.executeOnSession("one", "/tmp", options);
		await Bun.sleep(SHORT_IDLE_MS - 5);
		await harness.registry.executeOnSession("two", "/tmp", options);
		await Bun.sleep(SHORT_IDLE_MS - 10);
		expect(harness.kernels).toHaveLength(1);
		await Bun.sleep(SHORT_IDLE_MS + 40);
		expect(harness.kernels[0].disposed).toBe(true);
	});

	test("default idle reap is 15 minutes and explicit zero disables", async () => {
		expect(DEFAULT_KERNEL_IDLE_REAP_MS).toBe(15 * 60_000);
		let shutDown = false;
		const registry = createKernelSessionRegistry<StubKernel, StubOptions, string, StubSession>({
			languageLabel: "Stub",
			cancelledErrorClass: class StubCancelled extends Error {} as unknown as never,
			buildSessionKey: sessionId => sessionId,
			createSession: session => session,
			startKernel: () =>
				Promise.resolve({
					tag: 0,
					isAlive: () => !shutDown,
					disposed: false,
					shutdown: () => {
						shutDown = true;
						return Promise.resolve({ confirmed: true });
					},
					isBusy: () => Promise.resolve(false),
				}),
			executeWithKernel: (_kernel, code) => Promise.resolve(code),
			idleReapMs: 0,
		});
		await registry.executeOnSession("one", "/tmp", {} as StubOptions);
		await Bun.sleep(60);
		expect(shutDown).toBe(false);
	});
});
