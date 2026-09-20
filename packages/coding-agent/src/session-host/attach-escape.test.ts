import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PtySession } from "@oh-my-pi/pi-natives";

import { createDaemonBrokerClient } from "../launch/client";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { stopSessionHost } from "./ensure";

const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-attach-escape-"));
const projectDir = path.join(tmpDir, "project");
const sessionFile = path.join(tmpDir, "session.jsonl");
await fs.mkdir(projectDir, { recursive: true });
await fs.writeFile(
	sessionFile,
	[
		JSON.stringify({ type: "title", v: 1, title: "", updatedAt: new Date().toISOString(), pad: "" }),
		JSON.stringify({
			type: "session",
			version: 3,
			id: "00000000-0000-4000-8000-000000000007",
			timestamp: new Date().toISOString(),
			cwd: projectDir,
		}),
		"",
	].join("\n"),
);

test("Escape aborts the turn and detaches under a real TTY", async () => {
	const marker = "esc-regression-marker-42";
	const pty = new PtySession();
	let output = "";
	type Waiter = { needles: string[]; resolve: () => void };
	const waiters = new Set<Waiter>();
	const run = pty.startArgv(
		{
			application: process.execPath,
			args: [cliEntry, "attach", sessionFile, "--dir", projectDir],
			cwd: projectDir,
			env: workerEnvFromParent({
				HOME: tmpDir,
				PI_CODING_AGENT_DIR: path.join(tmpDir, "agent"),
				ANTHROPIC_API_KEY: "sk-ant-dummy-attach-escape-test",
				PROTO_DAEMON_IDLE_GRACE_MS: "5000",
				TERM: "xterm-256color",
			}),
			cols: 100,
			rows: 30,
		},
		(_error, chunk) => {
			output += chunk;
			for (const waiter of [...waiters]) {
				if (waiter.needles.every(needle => output.includes(needle))) {
					waiters.delete(waiter);
					waiter.resolve();
				}
			}
		},
	);

	// Push-based: chunk arrival resolves the waiter. The only timer is the
	// bounded deadline against a live subprocess, which fake timers cannot
	// drive (the pty child runs on the platform clock).
	const waitFor = async (...needles: string[]): Promise<void> => {
		if (needles.every(needle => output.includes(needle))) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const waiter: Waiter = { needles, resolve };
		waiters.add(waiter);
		try {
			await Promise.race([
				promise,
				Bun.sleep(90_000).then(() => {
					throw new Error(`pty output missing ${JSON.stringify(needles)}\n${output}`);
				}),
			]);
		} finally {
			waiters.delete(waiter);
		}
	};

	await waitFor("commands: /bash");
	pty.write(`/bash echo ${marker}\n`);
	// Line-start marker: distinguishes rendered output from the pty echo of
	// the typed command (where the marker follows "echo ").
	await waitFor(`\r\n${marker}`);
	// A lone ESC byte: the attach client must abort and detach in one press.
	pty.write("\x1b");
	await waitFor("esc — aborted and detached");

	const result = await Promise.race([
		run,
		Bun.sleep(15_000).then(() => ({ timedOut: true, exitCode: -1, cancelled: true })),
	]);
	expect(result.exitCode).toBe(0);
	try {
		pty.kill();
	} catch {
		// session already exited — kill() throws once the pty is gone
	}
}, 180_000);

afterAll(async () => {
	try {
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir: path.join(tmpDir, "run") });
		await stopSessionHost(projectDir, sessionFile, { client });
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
	} catch {
		// broker may already be gone
	}
	await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});
