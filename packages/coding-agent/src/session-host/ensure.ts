import { logger } from "@oh-my-pi/pi-utils";
import type { DaemonBrokerClient } from "../launch/client";
import { daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { daemonRuntimeDir } from "../launch/paths";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";
import {
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
export async function negotiateSessionHost(socket: string, timeoutMs: number): Promise<NegotiateResult> {
	const { promise, resolve } = Promise.withResolvers<NegotiateResult>();
	let settled = false;
	const finish = (result: NegotiateResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};
	const timer = setTimeout(() => finish({ socket: "connecting" }), timeoutMs);

	try {
		const socket_conn = await Bun.connect({
			unix: socket,
			socket: {
				data(_socket, chunk) {
					const text = new TextDecoder().decode(chunk);
					for (const line of text.split("\n")) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						try {
							const parsed: unknown = JSON.parse(trimmed);
							if (
								typeof parsed === "object" &&
								parsed !== null &&
								"type" in parsed &&
								parsed.type === "response"
							) {
								finish({ socket: "live", response: parsed });
							}
						} catch {
							// non-JSON line: ignore, keep waiting
						}
					}
				},
				error() {
					finish({ socket: "refused" });
				},
				close() {
					finish({ socket: "refused" });
				},
			},
		});
		socket_conn.write(`${JSON.stringify({ type: "negotiate_protocol", protocolVersion: 2, id: "probe" })}\n`);
	} catch (error) {
		logger.debug("session host probe failed", {
			socket,
			error: error instanceof Error ? error.message : String(error),
		});
		finish({ socket: "refused" });
	}

	return promise;
}

export async function probeSessionHost(socket: string): Promise<boolean> {
	return (await negotiateSessionHost(socket, sessionHostProbeTimeoutMs())).socket === "live";
}

/**
 * Ensures a daemon-supervised session host exists for the given session file
 * and is serving RPC. Converges on the same worker across processes via the
 * deterministic daemon name.
 */
export interface EnsureSessionHostOptions {
	/** Overrides the shared per-project broker client (tests, custom scopes). */
	client?: DaemonBrokerClient;
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

	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		const first = await negotiateSessionHost(socket, sessionHostProbeTimeoutMs());
		if (first.socket === "live") return { name, socket };
		if (first.socket === "connecting") {
			// Listener up but the RPC loop is still bootstrapping; give it the full
			// ready window before concluding the worker is wedged.
			const retry = await negotiateSessionHost(socket, sessionHostReadyTimeoutMs());
			if (retry.socket === "live") return { name, socket };
			await stopQuietly(client, name, "session host");
		}

		const existing = await describeQuietly(client, name, "session host");
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) {
				await waitReady(client, name, "session host", undefined, sessionHostReadyTimeoutMs());
			}
			const adopted = await negotiateSessionHost(socket, sessionHostProbeTimeoutMs());
			if (adopted.socket === "live") return { name, socket };
			await stopQuietly(client, name, "session host");
			continue;
		}

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name,
					application: spawn.cmd[0]!,
					args: [...spawn.cmd.slice(1), "--resume", sessionFile, "--mode", "rpc"],
					env: {
						[SESSION_HOST_SOCKET_ENV]: socket,
					},
					cwd: client.projectDir,
					pty: false,
					ready: { log: SESSION_HOST_READY_PATTERN, timeoutMs: sessionHostReadyTimeoutMs() },
					restart: "on-failure",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") continue;
			const probe = await negotiateSessionHost(socket, sessionHostReadyTimeoutMs());
			if (probe.socket === "live") return { name, socket };
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
