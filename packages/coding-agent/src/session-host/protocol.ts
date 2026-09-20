import * as path from "node:path";

import { canonicalProjectDir } from "../launch/paths";

/** Worker selector dispatched by cli.ts before the command registry loads. */
export const SESSION_HOST_WORKER_ARG = "__proto_worker_session";

/** Broker spec env var carrying the unix socket path the host listens on. */
export const SESSION_HOST_SOCKET_ENV = "SESSION_HOST_SOCKET";

/** Line the host prints to (broker-captured) stdout once its socket is listening. */
export const SESSION_HOST_READY_PATTERN = "session-host-ready";

const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

export function sessionHostReadyTimeoutMs(): number {
	return READY_TIMEOUT_MS;
}

export function sessionHostProbeTimeoutMs(): number {
	return PROBE_TIMEOUT_MS;
}

/**
 * Deterministic per-session daemon name so `proto attach` across processes and
 * broker restarts converge on the same supervised worker.
 */
export async function sessionHostDaemonName(sessionFile: string): Promise<string> {
	const canonical = await canonicalProjectDir(sessionFile);
	const hash = Bun.hash(canonical).toString(36);
	return `session-${hash.slice(0, 12)}`;
}

export function sessionHostEndpoint(runtimeDir: string, name: string): string {
	return path.join(runtimeDir, `${name}.sock`);
}
