import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";
import { isUploaderKind, LocalBlobBackend } from "./broker";
import {
	BLOB_BROKER_CONFIG_ENV,
	BLOB_BROKER_SOCKET_ENV,
	type BlobBrokerDoctorRequest,
	type BlobBrokerDoctorResponse,
	type BlobBrokerInfo,
	type BlobBrokerProbeRequest,
	type BlobBrokerProbeResponse,
	type BlobBrokerPurgeRequest,
	type BlobBrokerPurgeResponse,
	type BlobBrokerStatus,
	type BlobBrokerWorkerConfig,
	blobBrokerReadyBanner,
	type EnsureBlobRequest,
	type EnsureBlobResponse,
	type EnsureLazyRequest,
	RENDER_CALLBACK_PATH,
	RENDER_CALLBACK_TOKEN_HEADER,
} from "./protocol";
import { type BlobBrokerSavingsStatus, readBlobBrokerSavingsStatus } from "./savings";

const CALLBACK_TIMEOUT_MS = 30_000;

export function blobBrokerConfigKey(config: BlobBrokerWorkerConfig): string {
	return Bun.hash(JSON.stringify(config)).toString(16);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

async function backendStatus(
	backend: LocalBlobBackend,
	config: BlobBrokerWorkerConfig,
	baseUrl: string,
): Promise<BlobBrokerStatus> {
	const emptySavings: BlobBrokerSavingsStatus = {
		journalPath: config.persist?.savingsPath ?? "",
		entries: 0,
		imageCount: 0,
		inlineBytes: 0,
		referenceBytes: 0,
		savedBytes: 0,
		byDestination: {},
	};
	let savings = emptySavings;
	if (config.persist?.savingsPath) {
		try {
			savings = await readBlobBrokerSavingsStatus(config.persist.savingsPath);
		} catch {}
	}
	return {
		baseUrl,
		lazy: backend.supportsLazy,
		configKey: blobBrokerConfigKey(config),
		...backend.storeStatus(),
		savings,
	};
}

function createControlHandler(
	backend: LocalBlobBackend,
	config: BlobBrokerWorkerConfig,
	baseUrl: string,
): (request: Request) => Promise<Response> {
	return async request => {
		const pathname = new URL(request.url).pathname;
		if (request.method === "GET" && pathname === "/info") {
			const info: BlobBrokerInfo & { configKey: string } = {
				baseUrl,
				lazy: backend.supportsLazy,
				configKey: blobBrokerConfigKey(config),
			};
			return json(info);
		}
		if (request.method === "GET" && pathname === "/status") {
			return json(await backendStatus(backend, config, baseUrl));
		}
		if (request.method === "POST" && pathname === "/doctor") {
			const body = (await request.json()) as BlobBrokerDoctorRequest;
			const response: BlobBrokerDoctorResponse = {
				status: await backendStatus(backend, config, baseUrl),
				checks: [
					{ name: "control", ok: true, status: "pass", detail: "daemon control plane is responding" },
					...(await backend.doctor(body.probe !== false)),
				],
			};
			return json(response);
		}
		if (request.method === "POST" && pathname === "/probe") {
			const body = (await request.json()) as BlobBrokerProbeRequest;
			const response: BlobBrokerProbeResponse = await backend.probePublicHealth(body.timeoutMs);
			return json(response);
		}
		if (request.method === "POST" && pathname === "/purge") {
			const body = (await request.json()) as BlobBrokerPurgeRequest;
			const response: BlobBrokerPurgeResponse = await backend.purge(body);
			return json(response);
		}
		if (request.method === "POST" && pathname === "/blob") {
			const body = (await request.json()) as EnsureBlobRequest;
			if (body.data === undefined) {
				const publication = await backend.lookupBlob(body.key);
				return json((publication ? { publication } : { missing: true }) satisfies EnsureBlobResponse);
			}
			const bytes = new Uint8Array(Buffer.from(body.data, "base64"));
			const publication = await backend.ensureBlob(body.key, body.mimeType, () => bytes);
			if (!publication) return json({ error: "unavailable" }, 503);
			return json({ publication } satisfies EnsureBlobResponse);
		}
		if (request.method === "POST" && pathname === "/lazy") {
			const body = (await request.json()) as EnsureLazyRequest;
			const callback = `http://127.0.0.1:${body.callbackPort}${RENDER_CALLBACK_PATH}${encodeURIComponent(body.key)}`;
			const token = body.callbackToken;
			const publication = await backend.ensureLazy(body.key, body.mimeType, async () => {
				const response = await fetch(callback, {
					headers: { [RENDER_CALLBACK_TOKEN_HEADER]: token },
					signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
				});
				if (!response.ok) return null;
				return new Uint8Array(await response.arrayBuffer());
			});
			if (!publication) return json({ error: "unavailable" }, 503);
			return json({ publication } satisfies EnsureBlobResponse);
		}
		return json({ error: "not found" }, 404);
	};
}

export async function startBlobBrokerFromEnvironment(): Promise<void> {
	const socketPath = Bun.env[BLOB_BROKER_SOCKET_ENV];
	const configJson = Bun.env[BLOB_BROKER_CONFIG_ENV];
	if (!socketPath || !configJson) {
		throw new Error(`blob broker worker requires ${BLOB_BROKER_SOCKET_ENV} and ${BLOB_BROKER_CONFIG_ENV}`);
	}
	const config = JSON.parse(configJson) as BlobBrokerWorkerConfig;
	const backend = new LocalBlobBackend(config);

	const baseUrl = isUploaderKind(config.kind) ? "" : await backend.ensureStarted();
	if (baseUrl === null) {
		throw new Error("blob broker exposure failed to start");
	}
	try {
		fs.rmSync(socketPath, { force: true });
	} catch {}
	Bun.serve({ unix: socketPath, fetch: createControlHandler(backend, config, baseUrl) });

	process.on("SIGTERM", () => {
		backend.stop();
		process.exit(0);
	});
	logger.info("blob-broker daemon up", { kind: config.kind, baseUrl, socketPath });

	console.log(blobBrokerReadyBanner(baseUrl || `upload:${config.kind}`));

	await Promise.withResolvers<never>().promise;
}
