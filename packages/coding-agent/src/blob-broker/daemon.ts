import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { daemonRuntimeDir } from "../launch/paths";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";
import type { BlobBackend } from "./broker";
import {
	BLOB_BROKER_CONFIG_ENV,
	BLOB_BROKER_DAEMON_NAME,
	BLOB_BROKER_READY_PATTERN,
	BLOB_BROKER_SOCKET_ENV,
	BLOB_BROKER_WORKER_ARG,
	type BlobBrokerDoctorRequest,
	type BlobBrokerDoctorResponse,
	type BlobBrokerInfo,
	type BlobBrokerProbeRequest,
	type BlobBrokerProbeResponse,
	type BlobBrokerPurgeRequest,
	type BlobBrokerPurgeResponse,
	type BlobBrokerStatus,
	type BlobBrokerWorkerConfig,
	blobBrokerEndpoint,
	type EnsureBlobResponse,
} from "./protocol";
import type { BlobPublication } from "./publication";
import { blobBrokerConfigKey } from "./server";
import type { LazyBlobFetcher } from "./store";

const PROBE_TIMEOUT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 45_000;

const ENSURE_ATTEMPTS = 3;

type DaemonInfo = BlobBrokerInfo & { configKey: string };

export interface RenderCallbackHost {
	ensure(): Promise<{ port: number; token: string } | null>;

	register(key: string, fetcher: LazyBlobFetcher): void;
}

async function fetchUnix<T>(socket: string, input: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
	const response = await fetch(`http://blob-broker.local${input}`, {
		...init,
		unix: socket,
		signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`blob daemon ${input} responded ${response.status}`);
	return (await response.json()) as T;
}

async function probeDaemon(socket: string): Promise<DaemonInfo | null> {
	try {
		return await fetchUnix<DaemonInfo>(socket, "/info", { timeoutMs: PROBE_TIMEOUT_MS });
	} catch {
		return null;
	}
}

async function liveBlobBrokerSocket(projectDir: string): Promise<string | null> {
	try {
		const client = await daemonClientForProject(projectDir);
		await client.request({ op: "ping" });
		const socket = blobBrokerEndpoint(daemonRuntimeDir(client.projectDir));
		return (await probeDaemon(socket)) ? socket : null;
	} catch {
		return null;
	}
}

export async function queryBlobBrokerStatus(projectDir: string): Promise<BlobBrokerStatus | null> {
	const socket = await liveBlobBrokerSocket(projectDir);
	return socket ? fetchUnix<BlobBrokerStatus>(socket, "/status") : null;
}

export async function queryBlobBrokerDoctor(
	projectDir: string,
	request: BlobBrokerDoctorRequest = {},
): Promise<BlobBrokerDoctorResponse | null> {
	const socket = await liveBlobBrokerSocket(projectDir);
	if (!socket) return null;
	return fetchUnix<BlobBrokerDoctorResponse>(socket, "/doctor", {
		method: "POST",
		body: JSON.stringify(request),
	});
}

export async function queryBlobBrokerProbe(
	projectDir: string,
	config: BlobBrokerWorkerConfig,
	request: BlobBrokerProbeRequest = {},
): Promise<BlobBrokerProbeResponse | null> {
	const info = await ensureBlobDaemon(projectDir, config);
	if (!info) return null;
	const socket = await liveBlobBrokerSocket(projectDir);
	if (!socket) return null;
	return fetchUnix<BlobBrokerProbeResponse>(socket, "/probe", {
		method: "POST",
		body: JSON.stringify(request),
	});
}

export async function queryBlobBrokerPurge(
	projectDir: string,
	request: BlobBrokerPurgeRequest = {},
): Promise<BlobBrokerPurgeResponse | null> {
	const socket = await liveBlobBrokerSocket(projectDir);
	if (!socket) return null;
	return fetchUnix<BlobBrokerPurgeResponse>(socket, "/purge", {
		method: "POST",
		body: JSON.stringify(request),
	});
}

async function ensureBlobDaemon(projectDir: string, config: BlobBrokerWorkerConfig): Promise<DaemonInfo | null> {
	const client = await daemonClientForProject(projectDir);
	const socket = blobBrokerEndpoint(daemonRuntimeDir(client.projectDir));

	await client.request({ op: "ping" });
	const wantKey = blobBrokerConfigKey(config);
	const spawn = resolveWorkerSpawnCmd(BLOB_BROKER_WORKER_ARG);
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		const live = await probeDaemon(socket);
		if (live) {
			if (live.configKey === wantKey) return live;

			await stopQuietly(client, BLOB_BROKER_DAEMON_NAME, "blob broker");
		}
		const existing = await describeQuietly(client, BLOB_BROKER_DAEMON_NAME, "blob broker");
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) {
				await waitReady(client, BLOB_BROKER_DAEMON_NAME, "blob broker", undefined, READY_TIMEOUT_MS);
			}
			const adopted = await probeDaemon(socket);
			if (adopted?.configKey === wantKey) return adopted;

			await stopQuietly(client, BLOB_BROKER_DAEMON_NAME, "blob broker");
			continue;
		}
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: BLOB_BROKER_DAEMON_NAME,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					env: {
						[BLOB_BROKER_SOCKET_ENV]: socket,
						[BLOB_BROKER_CONFIG_ENV]: JSON.stringify(config),
					},
					cwd: spawn.cwd ?? client.projectDir,
					pty: false,
					ready: { log: BLOB_BROKER_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") continue;
			const info = await probeDaemon(socket);
			if (info?.configKey === wantKey) return info;
			await stopQuietly(client, BLOB_BROKER_DAEMON_NAME, "blob broker");
		} catch (error) {
			logger.debug("blob daemon start contention", {
				name: BLOB_BROKER_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}

class DaemonBlobBackend implements BlobBackend {
	#socket: string;
	#callbacks: RenderCallbackHost;
	readonly supportsLazy: boolean;

	constructor(socket: string, info: DaemonInfo, callbacks: RenderCallbackHost) {
		this.#socket = socket;
		this.#callbacks = callbacks;
		this.supportsLazy = info.lazy;
	}

	async ensureBlob(key: string, mimeType: string, getBytes: () => Uint8Array): Promise<BlobPublication | null> {
		try {
			const probe = await fetchUnix<EnsureBlobResponse>(this.#socket, "/blob", {
				method: "POST",
				body: JSON.stringify({ key, mimeType }),
			});
			if (probe.publication) return probe.publication;
			const { publication } = await fetchUnix<EnsureBlobResponse>(this.#socket, "/blob", {
				method: "POST",
				body: JSON.stringify({ key, mimeType, data: Buffer.from(getBytes()).toString("base64") }),
			});
			return publication ?? null;
		} catch (error) {
			logger.debug("blob daemon ensure failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async ensureLazy(key: string, mimeType: string, fetcher: LazyBlobFetcher): Promise<BlobPublication | null> {
		if (!this.supportsLazy) return null;
		const callback = await this.#callbacks.ensure();
		if (!callback) return null;
		this.#callbacks.register(key, fetcher);
		try {
			const { publication } = await fetchUnix<EnsureBlobResponse>(this.#socket, "/lazy", {
				method: "POST",
				body: JSON.stringify({
					key,
					mimeType,
					callbackPort: callback.port,
					callbackToken: callback.token,
				}),
			});
			return publication ?? null;
		} catch (error) {
			logger.debug("blob daemon lazy ensure failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	stop(): void {}
}

export async function connectDaemonBlobBackend(
	projectDir: string,
	config: BlobBrokerWorkerConfig,
	callbacks: RenderCallbackHost,
): Promise<BlobBackend | null> {
	try {
		const client = await daemonClientForProject(projectDir);
		const socket = blobBrokerEndpoint(daemonRuntimeDir(client.projectDir));
		const info = await ensureBlobDaemon(projectDir, config);
		if (!info) return null;
		return new DaemonBlobBackend(socket, info, callbacks);
	} catch (error) {
		logger.debug("Shared blob daemon unavailable; falling back to in-process broker", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
