import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../tools";
import { executeLaunch } from "../tools/fleet/launch";
import { closeDaemonClients, daemonClientForProject } from "./client";
import { daemonRuntimeDir } from "./paths";

function testSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: (key: string) => (key === "launch.enabled" ? true : undefined) },
		getSessionId: () => `launch-transport-test:${cwd}`,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

async function cleanupDaemon(
	cwd: string,
	runtimeDir: string,
	session: ToolSession,
	name: string,
	started: boolean,
): Promise<void> {
	if (started) {
		await executeLaunch(session, { op: "stop", name, timeout: 5 }).catch(() => undefined);
		const client = await daemonClientForProject(cwd).catch(() => undefined);
		await client?.request({ op: "shutdown" }).catch(() => undefined);
	}
	await closeDaemonClients();
	await fs.rm(runtimeDir, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
}

test("non-PTY launch send appends a line feed for line-oriented stdin and preserves raw input", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "proto-launch-transport-"));
	const runtimeDir = daemonRuntimeDir(cwd);
	const session = testSession(cwd);
	const name = "non-pty-newline";
	let started = false;
	try {
		await fs.rm(runtimeDir, { recursive: true, force: true });
		const application = process.execPath;
		const script = 'for await (const line of console) console.log("echo:" + line)';
		const start = await executeLaunch(session, {
			op: "start",
			name,
			application,
			args: ["-e", script],
			pty: false,
		});
		started = true;
		const cursor = start.details?.daemon?.outputBytes ?? 0;
		const send = await executeLaunch(session, { op: "send", name, text: "marker" });
		expect(send.details?.daemon?.name).toBe(name);
		const logs = await executeLaunch(session, {
			op: "logs",
			name,
			follow: true,
			cursor,
			timeout: 2,
		});
		expect(textOf(logs)).toContain("echo:marker");

		const rawCursor = logs.details?.cursor ?? cursor;
		await executeLaunch(session, { op: "send", name, text: "raw\r", enter: false });
		const rawLogs = await executeLaunch(session, {
			op: "logs",
			name,
			follow: true,
			cursor: rawCursor,
			timeout: 0.2,
		});
		expect(textOf(rawLogs)).toContain("follow timed out");
		expect(textOf(rawLogs)).not.toContain("echo:raw");

		const completedCursor = rawLogs.details?.cursor ?? rawCursor;
		await executeLaunch(session, { op: "send", name, text: "\n", enter: false });
		const completed = await executeLaunch(session, {
			op: "logs",
			name,
			follow: true,
			cursor: completedCursor,
			timeout: 2,
		});
		expect(textOf(completed)).toContain("echo:raw");
	} finally {
		await cleanupDaemon(cwd, runtimeDir, session, name, started);
	}
}, 30000);

test("PTY launch send keeps terminal Enter as carriage return", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "proto-launch-pty-"));
	const runtimeDir = daemonRuntimeDir(cwd);
	const session = testSession(cwd);
	const name = "pty-enter";
	let started = false;
	try {
		await fs.rm(runtimeDir, { recursive: true, force: true });
		const start = await executeLaunch(session, {
			op: "start",
			name,
			application: process.execPath,
			args: ["-e", 'for await (const line of console) console.log("echo:" + line)'],
			pty: true,
		});
		started = true;
		await executeLaunch(session, { op: "send", name, text: "marker" });
		const logs = await executeLaunch(session, {
			op: "logs",
			name,
			follow: true,
			cursor: start.details?.daemon?.outputBytes ?? 0,
			timeout: 2,
		});
		expect(textOf(logs)).toContain("echo:marker");
	} finally {
		await cleanupDaemon(cwd, runtimeDir, session, name, started);
	}
}, 30000);
