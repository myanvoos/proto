import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonRpcResult,
} from "../../src/launch/protocol";

function option(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} requires a positive integer`);
	return value;
}

interface LifecycleResult {
	publishedAfterClose: number;
	cancelledStartPublished: boolean;
	stoppedAfterLastClose: boolean;
	parallelStreams: DaemonRpcResult[];
	historicalWait: DaemonRpcResult;
	recoveredWait: DaemonRpcResult;
	previousGenerationWait: DaemonRpcResult;
	recoveredPreviousGenerationWait: DaemonRpcResult;
}

const clientCount = option("--clients", 4);
const terminalCount = option("--terminal", 1);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-daemon-lifecycle-"));
process.env.HOME = dir;
setAgentDir(path.join(dir, "agent"));
await Bun.write(path.join(dir, "broker.token"), "lifecycle-fixture-token");
process.env[DAEMON_PROJECT_DIR_ENV] = dir;
process.env[DAEMON_RUNTIME_DIR_ENV] = dir;
process.env[DAEMON_IDLE_GRACE_ENV] = "100";
const broker = startDaemonBrokerFromEnvironment();
const clients: DaemonBrokerClient[] = [];
let stopped = false;
let brokerError: unknown;
void broker.then(
	() => {
		stopped = true;
	},
	error => {
		brokerError = error;
	},
);
try {
	const deadline = Date.now() + 10_000;
	while (!(await fs.stat(daemonBrokerEndpoint(dir, dir)).catch(() => undefined))) {
		if (brokerError) throw brokerError;
		if (Date.now() >= deadline) throw new Error("Isolated broker did not become ready");
		await Bun.sleep(10);
	}
	for (let index = 0; index < 4; index++) {
		const client = await createDaemonBrokerClient(dir, { runtimeDir: dir });
		clients.push(client);
		client.onCompletion(`session-${index}`, () => undefined);
		await client.request({
			op: "start",
			owner: `session-${index}`,
			spec: {
				name: `stream-${index}`,
				application: process.execPath,
				args: ["-e", 'setInterval(() => process.stdout.write("stream\\n"), 10)'],
				cwd: dir,
				env: {},
				pty: false,
				persist: false,
				detached: false,
				restart: "no",
				ready: { log: "stream", timeoutMs: 5_000 },
			},
		});
	}
	let publishedAfterClose = 0;
	for (let batch = 0; batch < 4; batch++) {
		const pending: Promise<void>[] = [];
		for (let index = 0; index < Math.ceil(clientCount / 4); index++) {
			const client = await createDaemonBrokerClient(dir, { runtimeDir: dir });
			pending.push(
				client.request({ op: "ping" }).then(
					() => {
						publishedAfterClose++;
					},
					() => undefined,
				),
			);
			client.close();
		}
		await Promise.all(pending);
	}
	for (let batch = 0; batch < 2; batch++) {
		for (let index = 0; index < terminalCount; index++) {
			const name = `terminal-${batch}-${index}`;
			await clients[0]!.request({
				op: "start",
				spec: {
					name,
					application: process.execPath,
					args: ["-e", 'process.stdout.write(crypto.randomUUID().repeat(1800) + "\\nDONE\\n")'],
					cwd: dir,
					env: {},
					pty: false,
					persist: false,
					detached: false,
					restart: "no",
				},
			});
			await clients[0]!.request({ op: "wait", name, for: "exit", timeoutMs: 5_000 });
		}
	}
	const historicalWait = await clients[0]!.request({
		op: "wait",
		name: "terminal-0-0",
		pattern: "DONE",
		for: "exit",
		timeoutMs: 0,
	});
	const parallelStreams = await Promise.all(
		clients.map((client, index) =>
			client.request({
				op: "logs",
				name: `stream-${index}`,
				head: false,
				lines: 2,
				follow: false,
				timeoutMs: 0,
			}),
		),
	);
	const cancelled = await createDaemonBrokerClient(dir, { runtimeDir: dir });
	const controller = new AbortController();
	const cancelledStart = cancelled.request(
		{
			op: "start",
			spec: {
				name: "cancelled-start",
				application: process.execPath,
				args: ["-e", 'process.stdout.write("unexpected")'],
				cwd: dir,
				env: {},
				pty: false,
				persist: false,
				detached: false,
				restart: "no",
			},
		},
		controller.signal,
	);
	controller.abort();
	const cancelledStartPublished = await cancelledStart.then(
		() => true,
		() => false,
	);
	cancelled.close();
	await clients[0]!.request({
		op: "start",
		spec: {
			name: "generation-boundary",
			application: process.execPath,
			args: [
				"-e",
				'if (!(await Bun.file("once").exists())) { await Bun.write("once", "done"); process.stdout.write("first-generation\\n"); }',
			],
			cwd: dir,
			env: {},
			pty: false,
			persist: false,
			detached: false,
			restart: "no",
		},
	});
	await clients[0]!.request({ op: "wait", name: "generation-boundary", for: "exit", timeoutMs: 5_000 });
	await clients[0]!.request({ op: "restart", name: "generation-boundary" });
	await clients[0]!.request({ op: "wait", name: "generation-boundary", for: "exit", timeoutMs: 5_000 });
	const previousGenerationWait = await clients[0]!.request({
		op: "wait",
		name: "generation-boundary",
		pattern: "first-generation",
		for: "exit",
		timeoutMs: 0,
	});
	for (const client of clients) client.close();
	await Bun.sleep(500);
	const stoppedAfterLastClose = stopped;
	if (!stopped) {
		const cleanup = await createDaemonBrokerClient(dir, { runtimeDir: dir });
		await cleanup.request({ op: "shutdown" });
		cleanup.close();
	}
	await broker;
	process.env[DAEMON_PROJECT_DIR_ENV] = dir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = dir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "10000";
	const recoveredBroker = startDaemonBrokerFromEnvironment();
	const recoveryDeadline = Date.now() + 10_000;
	while (!(await fs.stat(daemonBrokerEndpoint(dir, dir)).catch(() => undefined))) {
		if (Date.now() >= recoveryDeadline) throw new Error("Recovered broker did not become ready");
		await Bun.sleep(10);
	}
	const recoveredClient = await createDaemonBrokerClient(dir, { runtimeDir: dir });
	let recoveredWait: DaemonRpcResult;
	let recoveredPreviousGenerationWait: DaemonRpcResult;
	try {
		recoveredWait = await recoveredClient.request({
			op: "wait",
			name: "terminal-0-0",
			pattern: "DONE",
			for: "exit",
			timeoutMs: 0,
		});
		recoveredPreviousGenerationWait = await recoveredClient.request({
			op: "wait",
			name: "generation-boundary",
			pattern: "first-generation",
			for: "exit",
			timeoutMs: 0,
		});
		await recoveredClient.request({ op: "shutdown" });
	} finally {
		recoveredClient.close();
		await recoveredBroker;
	}
	const result: LifecycleResult = {
		publishedAfterClose,
		cancelledStartPublished,
		stoppedAfterLastClose,
		parallelStreams,
		historicalWait,
		recoveredWait,
		previousGenerationWait,
		recoveredPreviousGenerationWait,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	if (!stopped) {
		const cleanup = await createDaemonBrokerClient(dir, { runtimeDir: dir });
		await cleanup.request({ op: "shutdown" });
		cleanup.close();
	}
	for (const client of clients) client.close();
	await broker;
	await fs.rm(dir, { recursive: true, force: true });
}
