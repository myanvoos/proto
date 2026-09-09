import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeKernelSessionsByOwner, executePython } from "./executor";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";

describe("PythonKernel status probe", () => {
	test("reports in-flight request tasks and quiescence", async () => {
		// Real probe (bun-test flag normally short-circuits availability checks).
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) {
			console.warn("skipping Python kernel status test: no local Python interpreter");
			return;
		}
		const kernel = await PythonKernel.start({ cwd: process.cwd() });
		try {
			expect(await kernel.execute("status_probe_var = 41 + 1")).toMatchObject({ status: "ok" });
			expect(await kernel.isBusy()).toBe(false);

			const slow = kernel.execute("import asyncio\nawait asyncio.sleep(0.4)");
			await Bun.sleep(150);
			expect(await kernel.isBusy()).toBe(true);
			expect(await slow).toMatchObject({ status: "ok" });
			await Bun.sleep(50);
			expect(await kernel.isBusy()).toBe(false);

			// Session state survives across cells (probe never touched user namespace).
			expect(await kernel.execute("status_probe_var")).toMatchObject({ status: "ok" });

			expect((await kernel.shutdown()).confirmed).toBe(true);
		} finally {
			if (kernel.isAlive()) await kernel.shutdown().catch(() => {});
		}
	});

	test("does not replay a crashed cell after the Python kernel reports uncertain completion", async () => {
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) return;

		using tempDir = TempDir.createSync("@python-kernel-crash-");
		const ownerId = `test-owner:${crypto.randomUUID()}`;
		const sessionId = `test-session:${crypto.randomUUID()}`;
		const effectsPath = path.join(tempDir.path(), "effects.txt");
		const options = {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: ownerId,
			kernelMode: "session" as const,
			timeoutMs: 10_000,
		};

		try {
			const crashed = await executePython(
				[
					"import os",
					"with open('effects.txt', 'a') as effects:",
					"    effects.write('once\\n')",
					"    effects.flush()",
					"print('before crash', flush=True)",
					"os._exit(17)",
				].join("\n"),
				options,
			);

			expect(crashed.cancelled).toBe(true);
			expect(crashed.output).toContain("before crash");
			expect(crashed.output).toContain("completion is uncertain");
			expect(crashed.output).toContain("not replayed");
			expect(await Bun.file(effectsPath).text()).toBe("once\n");

			const next = await executePython("print(21 * 2)", options);
			expect(next.exitCode).toBe(0);
			expect(next.output.trim()).toBe("42");
			expect(await Bun.file(effectsPath).text()).toBe("once\n");
		} finally {
			await disposeKernelSessionsByOwner(ownerId);
		}
	}, 30_000);

	test("owner-scoped disposal releases the retained kernel and its state", async () => {
		const availability = await checkPythonKernelAvailability(process.cwd(), undefined, { forceProbe: true });
		if (!availability.ok) {
			console.warn("skipping kernel owner-disposal test: no local Python interpreter");
			return;
		}
		const ownerId = `test-owner:${crypto.randomUUID()}`;
		const sessionId = `test-session:${crypto.randomUUID()}`;
		const run = (code: string) =>
			executePython(code, {
				cwd: process.cwd(),
				sessionId,
				kernelOwnerId: ownerId,
				kernelMode: "session",
			});
		try {
			expect((await run("owner_disposal_probe = 7")).exitCode).toBe(0);
			// Same retained kernel: state visible.
			expect((await run("owner_disposal_probe")).exitCode).toBe(0);

			// This is the call AgentSession.dispose() makes when a subagent
			// is parked, killed, or evicted.
			await disposeKernelSessionsByOwner(ownerId);

			// Fresh kernel on next call: prior state is gone.
			const fresh = await run("owner_disposal_probe");
			expect(fresh.output).toContain("NameError");
		} finally {
			await disposeKernelSessionsByOwner(ownerId);
		}
	});
});
