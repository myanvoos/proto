import { describe, expect, test } from "bun:test";
import { isCompiledBinary, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeVmContextsByOwner } from "./context-manager";
import { executeJs } from "./executor";
import { buildJsKernel } from "./node-runtime";

describe("standalone JS kernel bundle", () => {
	// Release builds embed the native addon archive into the natives package; a Node kernel bundle that still
	// pulled in the addon loader then emitted that archive as a second output and broke `bun run build`.
	test("carries no native addon loader", async () => {
		const source = await buildJsKernel();
		expect(source).toContain("native bindings are unavailable in standalone JS kernels");
		expect(source).not.toContain("__PI_NATIVE_VARIANT_CACHE");
		expect(source).not.toContain("embeddedAddon");
	});

	test("runs the staged bundle under explicit Bun with native output, lexical state, and self-spawn", async () => {
		using directory = TempDir.createSync("@js-staged-bun-");
		const interpreter = Bun.which("bun");
		expect(interpreter).not.toBeNull();
		const owner = `staged-bun:${crypto.randomUUID()}`;
		const session: ToolSession = {
			cwd: directory.path(),
			hasUI: false,
			settings: await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.path(), inMemory: true }),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const code = `
			let stagedCounter = 2; const readStaged = () => stagedCounter; const fixedStaged = 7;
			try { eval("fixedStaged = 8"); } catch (error) { console.log(error.name); }
			try { console.log(typeof StagedLater); } catch (error) { console.log(error.name); } class StagedLater {}
			console.log({ runtime: typeof Bun, value: fixedStaged });
			process.stdout.write(Buffer.from([0, 255])); process.stderr.write("staged stderr\\n");
			require("node:child_process").spawnSync(process.execPath, ["-e", "console.log(process.execPath, Bun.version)"], { stdio: "inherit" });
			42;
		`;
		const native = Bun.spawn([interpreter!, "-e", code], { cwd: directory.path(), stdout: "pipe", stderr: "pipe" });
		const [nativeStdout, nativeStderr, nativeExit] = await Promise.all([
			new Response(native.stdout).arrayBuffer(),
			new Response(native.stderr).arrayBuffer(),
			native.exited,
		]);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const options = {
			runtime: "bun" as const,
			interpreter: interpreter!,
			cwd: directory.path(),
			session,
			sessionId: owner,
			kernelOwnerId: owner,
		};
		try {
			const result = await executeJs(code, {
				...options,
				onBytes: (bytes, stream) => {
					(stream === "stdout" ? stdout : stderr).push(Buffer.from(bytes));
				},
			});
			expect(nativeExit).toBe(0);
			expect(result.exitCode, result.output).toBe(nativeExit);
			expect(Buffer.concat(stdout)).toEqual(Buffer.from(nativeStdout));
			expect(Buffer.concat(stderr)).toEqual(Buffer.from(nativeStderr));
			expect(result.displayOutputs).toContainEqual({ type: "text", text: "42\n" });
			const next = await executeJs(
				`stagedCounter++; console.log(readStaged(), kernelState().runtime.implementation);`,
				options,
			);
			expect(next.exitCode, next.output).toBe(0);
			expect(next.output).toBe("3 bun\n");
		} finally {
			await disposeVmContextsByOwner(owner);
		}
	}, 20_000);

	// Exercised by the compiled release test command; an ordinary Bun host has no launcher boundary.
	(isCompiledBinary() ? test : test.skip)(
		"keeps a normalized compiled launcher on its internal worker entry",
		async () => {
			using directory = TempDir.createSync("@js-compiled-launcher-");
			const owner = `compiled-launcher:${crypto.randomUUID()}`;
			const session: ToolSession = {
				cwd: directory.path(),
				hasUI: false,
				settings: await Settings.loadReadOnly({
					cwd: directory.path(),
					agentDir: directory.path(),
					inMemory: true,
				}),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			};
			// BUN_BE_BUN is only the test runner's entry switch, never a user/worker environment setting.
			const runnerMode = process.env.BUN_BE_BUN;
			delete process.env.BUN_BE_BUN;
			try {
				const result = await executeJs(`console.log(kernelState().runtime.implementation);`, {
					runtime: "bun",
					interpreter: process.execPath,
					cwd: directory.path(),
					session,
					sessionId: owner,
					kernelOwnerId: owner,
				});
				expect(result.exitCode, result.output).toBe(0);
				expect(result.output).toBe("bun\n");
			} finally {
				await disposeVmContextsByOwner(owner);
				if (runnerMode !== undefined) process.env.BUN_BE_BUN = runnerMode;
			}
		},
		20_000,
	);
});
