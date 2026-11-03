import { afterEach, expect, spyOn, test } from "bun:test";
import { BaseKernel } from "./kernel-base";

class TestKernel extends BaseKernel {
	constructor(buildPayload = (_code: string, id: string) => JSON.stringify({ id })) {
		super("transport-test", {
			languageName: "Test",
			traceIpc: false,
			exitPayload: "{}",
			interruptEscalationMs: 10,
			shutdownGraceMs: 10,
			detachedProcessTree: false,
			buildPayload,
		});
	}
}

const kernels: TestKernel[] = [];
afterEach(async () => {
	for (const kernel of kernels.splice(0)) await kernel.shutdown();
});

function startKernel(buildPayload?: (code: string, id: string) => string) {
	const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const kernel = new TestKernel(buildPayload);
	kernel.setProcess(proc);
	kernels.push(kernel);
	return { kernel, proc };
}

for (const failure of ["write", "flush"] as const) {
	test(`${failure} failures settle every pending execution and retire the kernel`, async () => {
		const { kernel, proc } = startKernel();
		const pending = kernel.execute("pending");
		const status = kernel.requestStatus(1000);
		const method = spyOn(proc.stdin, failure);
		if (failure === "write")
			method.mockImplementation(() => {
				throw new Error("broken pipe");
			});
		else method.mockImplementation(() => Promise.reject(new Error("broken pipe")));
		try {
			const failed = kernel.execute("failed");
			for (const result of await Promise.all([pending, failed])) {
				expect(result.status).toBe("error");
				expect(result.kernelKilled).toBe(true);
				expect(result.error?.name).toBe("TransportError");
			}
			expect(await status).toBeUndefined();
			expect(kernel.isAlive()).toBe(false);
			expect(await kernel.shutdown()).toEqual({ confirmed: true });
		} finally {
			method.mockRestore();
		}
	});
}

test("serialization failures leave the transport usable", async () => {
	const { kernel } = startKernel(() => {
		throw new Error("cannot serialize");
	});
	await expect(kernel.execute("bad payload")).rejects.toThrow("cannot serialize");
	expect(kernel.isAlive()).toBe(true);
});

test("a blocked flush does not prevent execution cancellation or shared shutdown", async () => {
	const { kernel, proc } = startKernel();
	const blocked = Promise.withResolvers<number>();
	const flush = spyOn(proc.stdin, "flush").mockImplementation(() => blocked.promise);
	try {
		const controller = new AbortController();
		const execution = kernel.execute("blocked", { signal: controller.signal });
		controller.abort();
		const first = kernel.shutdown();
		expect(kernel.shutdown()).toBe(first);
		expect((await execution).cancelled).toBe(true);
		expect(await first).toEqual({ confirmed: true });
	} finally {
		blocked.resolve(0);
		flush.mockRestore();
	}
});
