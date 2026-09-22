import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { workerEnvFromParent } from "../subprocess/worker-client";

const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-attach-lifecycle-"));
const projectDir = path.join(tmpDir, "project");
const emptyDir = path.join(tmpDir, "empty");
const sessionFile = path.join(tmpDir, "session.jsonl");
await fs.mkdir(projectDir, { recursive: true });
await fs.mkdir(emptyDir, { recursive: true });
await fs.writeFile(
	sessionFile,
	[
		JSON.stringify({ type: "title", v: 1, title: "", updatedAt: new Date().toISOString(), pad: "" }),
		JSON.stringify({
			type: "session",
			version: 3,
			id: "00000000-0000-4000-8000-000000000006",
			timestamp: new Date().toISOString(),
			cwd: projectDir,
		}),
		"",
	].join("\n"),
);

interface RunResult {
	exitCode: number;
	output: string;
	elapsedMs: number;
}

// Every case runs the real binary: the defects were process-lifetime bugs that
// no in-process call can observe.
async function runCli(args: string[], stdin: "ignore" | string, timeoutMs = 60_000): Promise<RunResult> {
	const started = Date.now();
	const child = Bun.spawn({
		cmd: [process.execPath, cliEntry, ...args],
		env: attachEnv(),
		cwd: projectDir,
		stdin: stdin === "ignore" ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdin !== "ignore") {
		const writable = child.stdin as { write(chunk: string): void; end(): Promise<number> | number };
		writable.write(stdin);
		await writable.end();
	}
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const exitCode = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => -1)]);
	if (exitCode === -1) {
		child.kill("SIGKILL");
		await child.exited;
		throw new Error(`${args.join(" ")} did not exit within ${timeoutMs}ms`);
	}
	return { exitCode, output: `${await stdout}\n${await stderr}`, elapsedMs: Date.now() - started };
}

interface DaemonReport {
	name: string;
	state: string;
	pid?: number;
	command: string;
}

async function liveSessionHosts(): Promise<DaemonReport[]> {
	const listed = await runCli(["ps", "--json"], "ignore", 30_000);
	expect(listed.exitCode).toBe(0);
	const projects = JSON.parse(listed.output.slice(listed.output.indexOf("["), listed.output.lastIndexOf("]") + 1)) as {
		daemons?: DaemonReport[];
	}[];
	return projects
		.flatMap(entry => entry.daemons ?? [])
		.filter(daemon => daemon.command.includes(sessionFile) && daemon.state !== "exited" && daemon.state !== "failed");
}

test("attach --stop without a session names the positional argument, not a --session flag", async () => {
	const result = await runCli(["attach", "--stop", "--dir", projectDir], "ignore", 30_000);
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("attach --stop <session-id|file>");
	expect(result.output).not.toContain("--session");
}, 60_000);

test("attach without any session names the positional argument, not a --session flag", async () => {
	const result = await runCli(["attach", "--dir", emptyDir], "ignore", 30_000);
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("No sessions found");
	expect(result.output).toContain("attach <session-id|file>");
	expect(result.output).not.toContain("--session");
}, 60_000);

test("attach --stop exits instead of idling on the broker connection when no host runs", async () => {
	const result = await runCli(["attach", "--stop", sessionFile, "--dir", projectDir], "ignore", 45_000);
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("Stopped session host");
	// The bug was an open control socket holding the loop forever; anything
	// near the previous 45s-and-counting hang is a regression.
	expect(result.elapsedMs).toBeLessThan(20_000);
	expect(await liveSessionHosts()).toEqual([]);
}, 90_000);

test("a piped attach that never receives input takes back the host it started", async () => {
	const result = await runCli(["attach", sessionFile, "--dir", projectDir], "ignore", 90_000);
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("stdin closed before any input");
	expect(result.output).not.toContain("session keeps running daemon-side");
	expect(await liveSessionHosts()).toEqual([]);
}, 120_000);

test("a piped attach that receives input keeps the host running until --stop", async () => {
	const attached = await runCli(["attach", sessionFile, "--dir", projectDir], "/detach\n", 90_000);
	expect(attached.exitCode).toBe(0);
	expect(attached.output).toContain("session keeps running daemon-side");
	// Shell quoting is added only when a path needs it; the shape is what matters.
	const hint = attached.output.split("\n").find(line => line.startsWith("Reattach with: "));
	expect(hint?.replaceAll('"', "")).toBe(`Reattach with: proto attach ${sessionFile} --dir ${projectDir}`);
	const running = await liveSessionHosts();
	expect(running.length).toBe(1);
	expect(running[0]!.pid).toBeGreaterThan(0);

	// Adopting a host someone else started is not this invocation's to reclaim:
	// an empty stdin just detaches.
	const observed = await runCli(["attach", sessionFile, "--dir", projectDir], "ignore", 90_000);
	expect(observed.exitCode).toBe(0);
	expect(observed.output).toContain("session keeps running daemon-side");
	expect(observed.output).not.toContain("stdin closed before any input");
	expect((await liveSessionHosts()).length).toBe(1);

	const stopped = await runCli(["attach", "--stop", sessionFile, "--dir", projectDir], "ignore", 45_000);
	expect(stopped.exitCode).toBe(0);
	expect(stopped.elapsedMs).toBeLessThan(20_000);
	expect(await liveSessionHosts()).toEqual([]);
}, 150_000);

test("a scripted attach outlives its own input: commands answer before the process leaves", async () => {
	const marker = "WAVE6_SCRIPTED_MARKER";
	const scripted = await runCli(
		["attach", sessionFile, "--dir", projectDir],
		`/bash echo ${marker}\n/detach\n`,
		120_000,
	);
	expect(scripted.exitCode).toBe(0);
	// Piped stdin closes the instant the lines are written; the dispatched
	// command still has to be answered before the process exits.
	expect(scripted.output).toContain(marker);
	expect(scripted.output).toContain("detached — session keeps running daemon-side.");
	expect((await liveSessionHosts()).length).toBe(1);

	const stopping = await runCli(["attach", sessionFile, "--dir", projectDir], "/stop\n", 120_000);
	expect(stopping.exitCode).toBe(0);
	expect(stopping.output).toContain("session host stopped");
	expect(await liveSessionHosts()).toEqual([]);
}, 180_000);

function attachEnv(): Record<string, string> {
	return workerEnvFromParent({
		HOME: tmpDir,
		PI_CODING_AGENT_DIR: path.join(tmpDir, "agent"),
		ANTHROPIC_API_KEY: "sk-ant-dummy-attach-lifecycle-test",
		PROTO_DAEMON_IDLE_GRACE_MS: "3000",
	});
}

afterAll(async () => {
	await runCli(["attach", "--stop", sessionFile, "--dir", projectDir], "ignore", 45_000).catch(() => undefined);
	await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});
