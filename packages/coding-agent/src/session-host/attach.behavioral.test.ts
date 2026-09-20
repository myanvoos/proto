import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createDaemonBrokerClient } from "../launch/client";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { stopSessionHost } from "./ensure";

const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-attach-behavioral-"));
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
			id: "00000000-0000-4000-8000-000000000004",
			timestamp: new Date().toISOString(),
			cwd: projectDir,
		}),
		"",
	].join("\n"),
);

test("proto attach runs commands daemon-side, detaches without stopping the host, and replays on reattach", async () => {
	const marker = "attach-behavioral-marker-8173";
	const first = await runAttach(async ({ write, waitFor }) => {
		await waitFor("commands: /bash");
		await write(`/bash echo ${marker}`);
		await waitFor(marker);
		await write("/detach");
		await waitFor("session keeps running daemon-side");
	});
	expect(first.exitCode).toBe(0);
	expect(first.output).toContain(marker);

	// Reattach: the replay must surface the earlier bash execution.
	const second = await runAttach(async ({ write, waitFor }) => {
		await waitFor("bash: $ echo", marker);
		await write("/detach");
		await waitFor("session keeps running daemon-side");
	});
	expect(second.exitCode).toBe(0);
	expect(second.output).toContain(marker);
}, 180_000);

interface AttachDriver {
	write(...lines: string[]): Promise<void>;
	waitFor(...needles: string[]): Promise<void>;
}

async function runAttach(driver: (api: AttachDriver) => Promise<void>): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, "attach", sessionFile, "--dir", projectDir],
		env: attachEnv(),
		cwd: projectDir,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let output = "";
	const stdoutDone = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
	})();
	let stderr = "";
	const stderrDone = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
	})();

	const stdin = child.stdin;
	const write = async (...lines: string[]): Promise<void> => {
		for (const line of lines) {
			stdin.write(`${line}\n`);
			await Bun.sleep(150);
		}
	};
	const waitFor = async (...needles: string[]): Promise<void> => {
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (needles.every(needle => output.includes(needle))) return;
			await Bun.sleep(100);
		}
		throw new Error(`attach output missing ${JSON.stringify(needles)}\nstdout:\n${output}\nstderr:\n${stderr}`);
	};

	await driver({ write, waitFor });
	const exitCode = await Promise.race([child.exited, Bun.sleep(30_000).then(() => -1)]);
	await Promise.race([Promise.all([stdoutDone, stderrDone]), Bun.sleep(2_000)]);
	if (exitCode === -1) throw new Error(`attach did not exit in time\nstdout:\n${output}\nstderr:\n${stderr}`);
	return { exitCode, output: `${output}\n${stderr}` };
}

function attachEnv(): Record<string, string> {
	return workerEnvFromParent({
		HOME: tmpDir,
		PI_CODING_AGENT_DIR: path.join(tmpDir, "agent"),
		ANTHROPIC_API_KEY: "sk-ant-dummy-attach-behavioral-test",
		PROTO_DAEMON_IDLE_GRACE_MS: "5000",
	});
}

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
