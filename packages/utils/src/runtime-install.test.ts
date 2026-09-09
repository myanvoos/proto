import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureRuntimeInstalled } from "./runtime-install";

const tempDirs: string[] = [];
const fileLockModulePath = path.join(import.meta.dir, "file-lock.ts");

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function makeFileDependency(root: string): Promise<{ probePackage: string; spec: string }> {
	const dependencyDir = path.join(root, "dependency");
	const probePackage = "proto-runtime-lock-fixture";
	await Bun.write(path.join(dependencyDir, "package.json"), JSON.stringify({ name: probePackage, version: "1.0.0" }));
	return { probePackage, spec: `file:${dependencyDir}` };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ensureRuntimeInstalled install lock", () => {
	test("acquires an OS-released lock after its holder is killed", async () => {
		const root = await makeTempDir("proto-runtime-lock-");
		const runtimeDir = path.join(root, "cache", "fixture-runtime");
		const holderPath = path.join(root, "hold-lock.ts");
		const { probePackage, spec } = await makeFileDependency(root);
		await Bun.write(
			holderPath,
			[
				`import { withFileLock } from ${JSON.stringify(fileLockModulePath)};`,
				`await withFileLock(${JSON.stringify(`${runtimeDir}.install`)}, async () => {`,
				'  process.stdout.write("ready\\n");',
				"  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
				"}, { retries: 1, retryDelayMs: 0 });",
			].join("\n"),
		);

		const holder = Bun.spawn([process.execPath, "--no-install", holderPath], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			const reader = holder.stdout.getReader();
			const ready = await (async () => {
				try {
					// This is a real subprocess boundary, so fake timers cannot bound native lock startup.
					return await Promise.race([
						reader.read(),
						holder.exited.then(async exitCode => {
							throw new Error(
								`lock holder exited before readiness (${exitCode}): ${await new Response(holder.stderr).text()}`,
							);
						}),
						Bun.sleep(5_000).then(() => {
							throw new Error("lock holder did not become ready within 5 seconds");
						}),
					]);
				} finally {
					reader.releaseLock();
				}
			})();
			expect(new TextDecoder().decode(ready.value)).toBe("ready\n");

			let liveOwnerError: unknown;
			try {
				await ensureRuntimeInstalled({
					runtimeDir,
					install: { dependencies: { [probePackage]: spec } },
					probePackage,
					lockAttempts: 1,
					lockSleepMs: 0,
				});
			} catch (error) {
				liveOwnerError = error;
			}

			holder.kill("SIGKILL");
			await holder.exited;
			await ensureRuntimeInstalled({
				runtimeDir,
				install: { dependencies: { [probePackage]: spec } },
				probePackage,
				lockAttempts: 1,
				lockSleepMs: 0,
			});

			expect(liveOwnerError).toBeInstanceOf(Error);
			expect(await Bun.file(path.join(runtimeDir, "node_modules", probePackage, "package.json")).exists()).toBe(
				true,
			);
		} finally {
			if (holder.exitCode === null) {
				holder.kill("SIGKILL");
				await holder.exited;
			}
		}
	}, 15_000);

	test("clears a stale legacy lock directory before installing", async () => {
		const root = await makeTempDir("proto-runtime-legacy-lock-");
		const runtimeDir = path.join(root, "cache", "fixture-runtime");
		const { probePackage, spec } = await makeFileDependency(root);
		await fs.mkdir(`${runtimeDir}.lock`, { recursive: true });

		await ensureRuntimeInstalled({
			runtimeDir,
			install: { dependencies: { [probePackage]: spec } },
			probePackage,
			lockAttempts: 1,
			lockSleepMs: 0,
		});

		expect(await Bun.file(path.join(runtimeDir, "node_modules", probePackage, "package.json")).exists()).toBe(true);
		await expect(fs.stat(`${runtimeDir}.lock`)).rejects.toThrow();
	}, 15_000);
});
