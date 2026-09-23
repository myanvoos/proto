import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { workerHostEntry } from "@oh-my-pi/pi-utils";

import { createDaemonBrokerClient, type DaemonBrokerClient } from "../launch/client";
import { daemonBrokerEndpoint } from "../launch/paths";
import {
	DAEMON_BROKER_WORKER_ARG,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
} from "../launch/protocol";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { connectSessionRpc } from "./client";
import { ensureSessionHost, negotiateSessionHost, stopSessionHost } from "./ensure";

const PROBE_TIMEOUT_MS = 30_000;

let tmpDir: string;
let projectDir: string;
let brokerSocketDir: string;
let broker: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
let brokerStderr = "";
let client: DaemonBrokerClient | undefined;
let sessionFile: string;
let sessionHostSocket: string;
let sessionHostName: string;

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-session-host-broker-"));
	projectDir = path.join(tmpDir, "project");
	brokerSocketDir = path.join(tmpDir, "run");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(brokerSocketDir, { recursive: true });

	// Sandbox all config/HOME-derived state so the test never touches the
	// developer's real daemon runtime directories.
	const sandboxEnv = workerEnvFromParent({
		HOME: tmpDir,
		PI_CODING_AGENT_DIR: path.join(tmpDir, "agent"),
		// Session bootstrap requires a selectable model; a dummy key satisfies
		// discovery without network access (get_state never calls the provider).
		ANTHROPIC_API_KEY: "sk-ant-dummy-session-host-test",
		[DAEMON_PROJECT_DIR_ENV]: projectDir,
		[DAEMON_RUNTIME_DIR_ENV]: brokerSocketDir,
		[DAEMON_IDLE_GRACE_ENV]: "120000",
	});

	// The broker reads the runtime token created by clients — create it first.
	client = await createDaemonBrokerClient(projectDir, { runtimeDir: brokerSocketDir });

	// Observe this child's listener before issuing a client request: the client
	// auto-spawns on connection refusal and would otherwise race our sandboxed child.
	const readinessAbort = new AbortController();
	const readinessTimeout = setTimeout(
		() => readinessAbort.abort(new Error("broker listener timed out")),
		PROBE_TIMEOUT_MS,
	);
	const endpoint = daemonBrokerEndpoint(projectDir, brokerSocketDir);
	const listenerReady = (async () => {
		for await (const event of fs.watch(brokerSocketDir, { signal: readinessAbort.signal })) {
			if (event.filename !== path.basename(endpoint)) continue;
			const accepts = await new Promise<boolean>(resolve => {
				const socket = net.createConnection(endpoint);
				socket.once("connect", () => {
					socket.destroy();
					resolve(true);
				});
				socket.once("error", () => {
					socket.destroy();
					resolve(false);
				});
			});
			if (accepts) return;
		}
	})();

	const hostEntry = workerHostEntry() ?? path.resolve(import.meta.dir, "..", "cli.ts");
	broker = Bun.spawn({
		cmd: [process.execPath, hostEntry, DAEMON_BROKER_WORKER_ARG],
		env: sandboxEnv,
		cwd: projectDir,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of broker.stderr) {
			brokerStderr += decoder.decode(chunk, { stream: true });
			if (brokerStderr.length > 64_000) brokerStderr = brokerStderr.slice(-32_000);
		}
	})();

	const brokerExited = broker.exited.then(code => {
		throw new Error(`daemon broker exited (code ${code}) before accepting connections\n${brokerStderr}`);
	});
	try {
		await Promise.race([listenerReady, brokerExited]);
		expect((await client.request({ op: "ping" })).op).toBe("ping");
	} finally {
		clearTimeout(readinessTimeout);
		readinessAbort.abort();
	}

	// Hand-written minimal session file — creating one via SessionManager would
	// write into the real (unsandboxed) config root from the test process.
	sessionFile = path.join(tmpDir, "session.jsonl");
	await fs.writeFile(
		sessionFile,
		[
			JSON.stringify({ type: "title", v: 1, title: "", updatedAt: new Date().toISOString(), pad: "" }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "00000000-0000-4000-8000-000000000001",
				timestamp: new Date().toISOString(),
				cwd: projectDir,
			}),
			"",
		].join("\n"),
	);
	const ensured = await ensureSessionHost(projectDir, sessionFile, { client });
	sessionHostSocket = ensured.socket;
	sessionHostName = ensured.name;
}, 240_000);

afterAll(async () => {
	try {
		if (broker?.exitCode === null && client) await client.request({ op: "shutdown" });
	} finally {
		client?.close();
		if (broker?.exitCode === null) broker.kill();
		await broker?.exited;
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test("ensure starts a broker-supervised host, crash restart recovers the session, stop tears it down", async () => {
	// Host is live and serving the session over its socket.
	const first = await connectSessionRpc(sessionHostSocket);
	first.sendCommand({ id: "b-state-1", type: "get_state" });
	const state1 = await first.frames.findResponse("b-state-1", PROBE_TIMEOUT_MS);
	expect(state1.success).toBe(true);
	expect((state1.data as { sessionFile?: string }).sessionFile).toBe(path.resolve(sessionFile));
	first.close();

	// Kill -9 the worker process: the broker must restart it (on-failure)
	// and the recovered host must serve the same session file.
	if (!client) throw new Error("broker client not initialized");
	const described = await client.request({ op: "describe", name: sessionHostName });
	expect(described.op).toBe("describe");
	const snapshot = (described as { daemon: { pid: number } }).daemon;
	expect(snapshot.pid).toBeGreaterThan(0);
	process.kill(snapshot.pid, "SIGKILL");

	const ensured = await ensureSessionHost(projectDir, sessionFile, { client });
	expect(ensured.socket).toBe(sessionHostSocket);

	const second = await connectSessionRpc(sessionHostSocket);
	second.sendCommand({ id: "b-state-2", type: "get_state" });
	const state2 = await second.frames.findResponse("b-state-2", PROBE_TIMEOUT_MS);
	expect(state2.success).toBe(true);
	expect((state2.data as { sessionFile?: string }).sessionFile).toBe(path.resolve(sessionFile));
	second.close();

	// Explicit stop tears the host down; the socket stops answering.
	await stopSessionHost(projectDir, sessionFile, { client });
	const probe = await negotiateSessionHost(sessionHostSocket, 5_000);
	expect(probe.socket).not.toBe("live");
}, 120_000);
