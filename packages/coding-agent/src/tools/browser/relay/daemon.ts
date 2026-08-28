import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForGlobal } from "../../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd } from "../../../subprocess/worker-client";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpStatus } from "../attach";

const RELAY_DAEMON_NAME = "proto.browser.relay";
const RELAY_BROKER_SCOPE = "browser-relay";

const READY_LOG_PATTERN = String.raw`browser relay listening on http://\S+`;
const READY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;

const ENSURE_ATTEMPTS = 3;

export async function probeRelayServer(cdpUrl: string): Promise<boolean> {
	const status = await probeCdpStatus(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status === 503 || (status !== null && status >= 200 && status < 300);
}

export function isLoopbackRelayUrl(cdpUrl: string): boolean {
	try {
		const { hostname } = new URL(cdpUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

export async function ensureRelayDaemon(opts: { cdpUrl: string; signal?: AbortSignal }): Promise<boolean> {
	let port: string;
	try {
		port = String(new URL(opts.cdpUrl).port || 80);
	} catch {
		return false;
	}

	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	throwIfAborted(opts.signal);
	await client.request({ op: "ping" }, opts.signal);
	if (await probeRelayServer(opts.cdpUrl)) return true;
	const spawn = resolveWorkerSpawnCmd("browser-relay");
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);

		if (await probeRelayServer(opts.cdpUrl)) return true;
		const existing = await describeQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
			if (await probeRelayServer(opts.cdpUrl)) return true;

			await stopQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: RELAY_DAEMON_NAME,
						application: spawn.cmd[0]!,
						args: [...spawn.cmd.slice(1), "--port", port],
						env: {},
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			if (await probeRelayServer(opts.cdpUrl)) return true;
			await stopQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);

			logger.debug("Browser relay start contention", {
				name: RELAY_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return false;
}
