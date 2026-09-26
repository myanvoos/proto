import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { DaemonLog, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

await using dir = await TempDir.create("@proto-daemon-stalled-broker-");
process.env.HOME = dir.path();
setAgentDir(dir.join("agent"));
await Bun.write(dir.join("broker.token"), "stalled-log-fixture");
process.env[DAEMON_PROJECT_DIR_ENV] = dir.path();
process.env[DAEMON_RUNTIME_DIR_ENV] = dir.path();
process.env[DAEMON_IDLE_GRACE_ENV] = "10000";
const release = Promise.withResolvers<void>();
const flushed = Promise.withResolvers<void>();
let log: DaemonLog | undefined;
let writes = 0;
let flushes = 0;
const open = spyOn(DaemonLog, "open").mockImplementation(async (logDir, onAppend) => {
	await fs.promises.mkdir(logDir, { recursive: true });
	const logPath = path.join(logDir, "output.log");
	const file = Bun.file(logPath);
	const sink = file.writer();
	log = new DaemonLog(
		logPath,
		path.join(logDir, "output.previous.log"),
		file,
		{
			write(chunk) {
				writes++;
				return sink.write(chunk);
			},
			async flush() {
				if (++flushes === 1) {
					flushed.resolve();
					await release.promise;
				}
				return sink.flush();
			},
			end: () => sink.end(),
		},
		onAppend,
	);
	return log;
});
const ready = Promise.withResolvers<void>();
const endpointName = path.basename(daemonBrokerEndpoint(dir.path(), dir.path()));
const watcher = fs.watch(dir.path(), (_event, filename) => {
	if (filename === endpointName) ready.resolve();
});
const broker = startDaemonBrokerFromEnvironment();
let client: DaemonBrokerClient | undefined;
try {
	await Promise.race([
		ready.promise,
		broker.then(() => {
			throw new Error("Stalled-log broker exited before listening");
		}),
	]);
	watcher.close();
	client = await createDaemonBrokerClient(dir.path(), { runtimeDir: dir.path() });
	const start = await client.request({
		op: "start",
		spec: {
			name: "flood",
			application: process.execPath,
			args: [
				"-e",
				'import { writeSync } from "node:fs"; const chunk = Buffer.alloc(65536, "x"); for (let n = 0; n < 256; n++) writeSync(1, chunk); writeSync(1, "\\nFLOOD_READY\\n"); for await (const line of console) { if (line === "finish") break; writeSync(1, "after-gap\\n"); }',
			],
			cwd: dir.path(),
			env: {},
			pty: false,
			persist: false,
			detached: false,
			restart: "no",
			ready: { log: "FLOOD_READY", timeoutMs: 5_000 },
		},
	});
	if (start.op !== "start" || !log) throw new Error("Unexpected stalled-log start result");
	await flushed.promise;
	const beforeResume = { writes, bytes: start.daemon.outputBytes, readyMatch: start.daemon.readyMatch };
	release.resolve();
	await log.readTail(start.daemon.outputBytes);
	const gap = await client.request({ op: "logs", name: "flood", head: false, lines: 2, follow: false, timeoutMs: 0 });
	if (gap.op !== "logs") throw new Error("Unexpected gap logs response");
	await client.request({ op: "send", name: "flood", data: "next", enter: true });
	const next = await client.request({
		op: "logs",
		name: "flood",
		head: false,
		lines: 10,
		follow: true,
		cursor: gap.cursor,
		timeoutMs: 5_000,
	});
	if (next.op !== "logs") throw new Error("Unexpected follow logs response");
	await client.request({ op: "send", name: "flood", data: "finish", enter: true });
	await client.request({ op: "wait", name: "flood", for: "exit", timeoutMs: 5_000 });
	const end = await client.request({
		op: "logs",
		name: "flood",
		head: false,
		lines: 10,
		follow: true,
		cursor: next.cursor,
		timeoutMs: 0,
	});
	const savedBytes = (await fs.promises.stat(dir.join("daemons", "flood", "output.log"))).size;
	process.stdout.write(`${JSON.stringify({ beforeResume, gap, next, end, savedBytes })}\n`);
} finally {
	watcher.close();
	release.resolve();
	open.mockRestore();
	if (!client) client = await createDaemonBrokerClient(dir.path(), { runtimeDir: dir.path() });
	await client.request({ op: "stop", name: "flood", timeoutMs: 1_000 }).catch(() => undefined);
	await client.request({ op: "shutdown" });
	client.close();
	await broker;
}
