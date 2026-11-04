import { logger } from "@oh-my-pi/pi-utils";
import type { DaemonBrokerClient } from "../launch/client";
import { daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { daemonRuntimeDir } from "../launch/paths";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { connectSessionRpc, type SessionRpcConnection } from "./client";
import { NODE_PROTOCOL_VERSION } from "./node-protocol";
import {
	SESSION_HOST_BROKER_RUNTIME_ENV,
	SESSION_HOST_INTERACTIVE_ENV,
	SESSION_HOST_READY_PATTERN,
	SESSION_HOST_SOCKET_ENV,
	SESSION_HOST_WORKER_ARG,
	sessionHostDaemonName,
	sessionHostEndpoint,
	sessionHostProbeTimeoutMs,
	sessionHostReadyTimeoutMs,
} from "./protocol";

const ENSURE_ATTEMPTS = 3;

export interface LiveSessionHost {
	name: string;
	socket: string;
	/** True when this call started the host; false when an existing one was adopted. */
	created: boolean;
}

export type SessionHostProbe = "live" | "connecting" | "refused";

interface NegotiateResult {
	socket: SessionHostProbe;
	response?: unknown;
}

/**
 * Connects to the host socket and performs the RPC negotiate handshake.
 * - "live": the host answered the handshake (RPC loop serving).
 * - "connecting": socket accepts but the handshake did not complete within the
 *   timeout — the worker is listening but still bootstrapping the session.
 * - "refused": no listener (worker dead or not started yet).
 */
export async function negotiateSessionHost(
	socket: string,
	timeoutMs: number,
	protocolVersion = 2,
): Promise<NegotiateResult> {
	let connection: SessionRpcConnection | undefined;
	let connected = false;
	try {
		connection = await connectSessionRpc(socket);
		connected = true;
		connection.sendCommand({ type: "negotiate_protocol", protocolVersion, id: "probe" });
		const response = await connection.frames.findResponse("probe", timeoutMs);
		const data = response.data;
		const compatible =
			response.type === "response" &&
			response.command === "negotiate_protocol" &&
			response.success === true &&
			typeof data === "object" &&
			data !== null &&
			"protocolVersion" in data &&
			data.protocolVersion === protocolVersion;
		return compatible ? { socket: "live", response } : { socket: "refused", response };
	} catch (error) {
		logger.debug("session host probe failed", {
			socket,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			socket:
				connected && error instanceof Error && error.message.startsWith("timed out waiting")
					? "connecting"
					: "refused",
		};
	} finally {
		connection?.close();
	}
}

export async function probeSessionHost(socket: string, protocolVersion = 2): Promise<boolean> {
	return (await negotiateSessionHost(socket, sessionHostProbeTimeoutMs(), protocolVersion)).socket === "live";
}

/**
 * Ensures a daemon-supervised session host exists for the given session file
 * and is serving RPC. Converges on the same worker across processes via the
 * deterministic daemon name.
 */
export interface EnsureSessionHostOptions {
	/** Overrides the shared per-project broker client (tests, custom scopes). */
	client?: DaemonBrokerClient;
	/** Explicit host environment overrides (isolated embedding/test scopes). */
	env?: Record<string, string>;
	/** Full TUI arguments after session selection; the same host owns rendering and node operations. */
	interactive?: { argv: readonly string[] };
}

export async function ensureSessionHost(
	projectDir: string,
	sessionFile: string,
	options: EnsureSessionHostOptions = {},
): Promise<LiveSessionHost> {
	const client = options.client ?? (await daemonClientForProject(projectDir));
	const name = await sessionHostDaemonName(sessionFile);
	const runtimeDir = client.runtimeDir ?? daemonRuntimeDir(client.projectDir);
	const socket = sessionHostEndpoint(runtimeDir, name);
	const spawn = resolveWorkerSpawnCmd(SESSION_HOST_WORKER_ARG);
	const protocolVersion = options.interactive ? NODE_PROTOCOL_VERSION : 2;

	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		const first = await negotiateSessionHost(socket, sessionHostProbeTimeoutMs(), protocolVersion);
		if (first.socket === "live") return { name, socket, created: false };
		if (first.socket === "connecting") {
			// Listener up but the RPC loop is still bootstrapping; give it the full
			// ready window before concluding the worker is wedged.
			const retry = await negotiateSessionHost(socket, sessionHostReadyTimeoutMs(), protocolVersion);
			if (retry.socket === "live") return { name, socket, created: false };
			await stopQuietly(client, name, "session host");
		}

		const existing = await describeQuietly(client, name, "session host");
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			const described = await client.request({ op: "describe", name, expectedId: existing.id });
			if (described.op !== "describe") throw new Error("Unexpected session host description");
			const actualProtocol = described.spec.pty ? NODE_PROTOCOL_VERSION : 2;
			if (actualProtocol !== protocolVersion) {
				const live = await negotiateSessionHost(socket, sessionHostReadyTimeoutMs(), actualProtocol);
				if (live.socket === "live") {
					if (options.interactive)
						throw new Error(
							"This session is already hosted without a terminal; its running work was not interrupted. Use proto attach to control it, or stop the host explicitly before opening the full interface.",
						);
					return { name, socket, created: false };
				}
			}
			if (existing.readyAt === undefined) {
				await waitReady(client, name, "session host", undefined, sessionHostReadyTimeoutMs());
			}
			let adopted = await negotiateSessionHost(socket, sessionHostProbeTimeoutMs(), protocolVersion);
			if (adopted.socket === "connecting") {
				adopted = await negotiateSessionHost(socket, sessionHostReadyTimeoutMs(), protocolVersion);
			}
			if (adopted.socket === "live") return { name, socket, created: false };
			await stopQuietly(client, name, "session host");
			continue;
		}

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name,
					application: spawn.cmd[0]!,
					args: [
						...spawn.cmd.slice(1),
						...(options.interactive?.argv ?? ["--resume", sessionFile, "--mode", "rpc"]),
					],
					env: workerEnvFromParent({
						...options.env,
						[SESSION_HOST_SOCKET_ENV]: socket,
						[SESSION_HOST_BROKER_RUNTIME_ENV]: runtimeDir,
						[SESSION_HOST_INTERACTIVE_ENV]: options.interactive ? "1" : "",
					}),
					inheritEnv: false,
					cwd: client.projectDir,
					pty: options.interactive !== undefined,
					ready: { log: SESSION_HOST_READY_PATTERN, timeoutMs: sessionHostReadyTimeoutMs() },
					restart: "on-failure",
					persist: options.interactive !== undefined,
					detached: false,
				},
			});
			if (started.op !== "start") continue;
			const probe = await negotiateSessionHost(socket, sessionHostReadyTimeoutMs(), protocolVersion);
			if (probe.socket === "live") return { name, socket, created: true };
			await stopQuietly(client, name, "session host");
		} catch (error) {
			logger.debug("session host start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	throw new Error(`session host ${name} failed to become ready after ${ENSURE_ATTEMPTS} attempts`);
}

/**
 * Stops the daemon-supervised session host for the given session file. Safe to
 * call when no host exists.
 */
export async function stopSessionHost(
	projectDir: string,
	sessionFile: string,
	options: EnsureSessionHostOptions = {},
): Promise<void> {
	const client = options.client ?? (await daemonClientForProject(projectDir));
	const name = await sessionHostDaemonName(sessionFile);
	await stopQuietly(client, name, "session host");
}
