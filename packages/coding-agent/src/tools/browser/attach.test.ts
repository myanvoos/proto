import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { findReusableCdp, resolveSpawnArgs } from "./attach";
import { acquireBrowser } from "./registry";

describe("spawned app reuse", () => {
	let tempDir: string;
	let executable: string;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-browser-app-path-"));
		const copy = path.join(tempDir, path.basename(process.execPath));
		await Bun.write(copy, Bun.file(process.execPath));
		await fs.chmod(copy, 0o755);
		executable = await fs.realpath(copy);
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function spawnExisting(args: string[] = []): Promise<{ pid: number; close(): Promise<void> }> {
		const child = Bun.spawn(
			[executable, "--eval", 'process.stdout.write("ready\\n"); await Bun.stdin.text()', ...args],
			{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
		);
		const readiness = child.stdout.getReader();
		await readiness.read();
		readiness.releaseLock();
		return {
			pid: child.pid,
			async close() {
				child.kill();
				await child.exited;
			},
		};
	}

	test("refuses to replace a running same-executable process", async () => {
		const existing = await spawnExisting();
		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: executable },
					{ cwd: process.cwd(), signal: AbortSignal.timeout(2_000) },
				),
			).rejects.toThrow("already running without a reusable CDP endpoint");
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await existing.close();
		}
	}, 10_000);

	test("reuses a live CDP endpoint only for the requested profile", async () => {
		const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
		const profile = path.join(tempDir, "profile");
		const existing = await spawnExisting([`--user-data-dir=${profile}`, `--remote-debugging-port=${cdp.port}`]);
		try {
			expect(await findReusableCdp(executable, { appArgs: [`--user-data-dir=${profile}-other`] })).toBeNull();
			expect(await findReusableCdp(executable, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
				cdpUrl: `http://127.0.0.1:${cdp.port}`,
				pid: existing.pid,
			});
		} finally {
			await existing.close();
			cdp.stop(true);
		}
	}, 10_000);
});

describe("resolveSpawnArgs", () => {
	test("normalizes separated and relative Chromium profiles into an absolute switch value", () => {
		const args = resolveSpawnArgs(
			"/usr/bin/google-chrome-stable",
			["--user-data-dir", "profile", "--incognito"],
			"/tmp",
		);
		expect(args).toEqual(["--incognito", `--user-data-dir=${path.resolve("/tmp", "profile")}`]);
	});

	test("isolates Chromium launchers on a proto-owned profile and leaves other apps untouched", () => {
		const args = resolveSpawnArgs("/var/lib/flatpak/exports/bin/com.google.Chrome", []);
		expect(args).toContain("--no-first-run");
		expect(args.some(arg => arg.startsWith("--user-data-dir="))).toBe(true);
		expect(resolveSpawnArgs("/Applications/Slack.app/Contents/MacOS/Slack", ["--foo"])).toEqual(["--foo"]);
	});
});
