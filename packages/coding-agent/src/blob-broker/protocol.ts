import * as path from "node:path";
import type { BlobDestinationId } from "./destinations";
import type { BlobPublication, RemoteDeleteAction } from "./publication";
import type { BlobBrokerSavingsStatus } from "./savings";
import type { DestinationRuntimeConfig } from "./uploader-runtime";

export const BLOB_BROKER_WORKER_ARG = "__proto_worker_blob_broker";

export const BLOB_BROKER_SOCKET_ENV = "PROTO_BLOB_BROKER_SOCKET";

export const BLOB_BROKER_CONFIG_ENV = "PROTO_BLOB_BROKER_CONFIG";

export const BLOB_BROKER_DAEMON_NAME = "proto.blob.broker";

export const BLOB_BROKER_READY_PATTERN = String.raw`proto blob broker serving \S+`;

export function blobBrokerReadyBanner(baseUrl: string): string {
	return `proto blob broker serving ${baseUrl}`;
}

export function blobBrokerEndpoint(runtimeDir: string): string {
	return path.join(runtimeDir, "blob-broker.sock");
}

export interface BlobBrokerWorkerConfig {
	kind: BlobDestinationId;

	options: DestinationRuntimeConfig["options"];

	credentials: DestinationRuntimeConfig["credentials"];
	publicBaseUrl?: string;
	bindHost: string;
	sshTarget?: string;
	sshRemotePort?: number;

	persist?: {
		blobsDir: string;
		indexPath: string;
		savingsPath: string;
		ttlMs: number;
	};
}

export interface BlobBrokerInfo {
	baseUrl: string;

	lazy: boolean;
}

export interface EnsureBlobRequest {
	key: string;
	mimeType: string;

	data?: string;
}

export interface EnsureLazyRequest {
	key: string;
	mimeType: string;

	callbackPort: number;

	callbackToken: string;
}

export interface EnsureBlobResponse {
	publication?: BlobPublication;

	missing?: boolean;
}

export const BLOB_FETCH_EVENT_LIMIT = 100;

export interface BlobBrokerMetrics {
	activeBlobs: number;

	eagerBlobs: number;

	lazyBlobs: number;

	residentBytes: number;

	diskBytes: number;

	bytesServed: number;

	hits: number;

	misses: number;

	duplicateTokenGets: number;
}

export interface BlobFetchAttributionEvent {
	fetcherId: string | null;

	corroborated: boolean;

	timestamp: number;

	method: "GET" | "HEAD";

	found: boolean;

	tokenSuffix: string | null;
}

export interface BlobStoreStatus {
	metrics: BlobBrokerMetrics;

	recentFetches: readonly BlobFetchAttributionEvent[];
}

export interface BlobBrokerStatus extends BlobBrokerInfo, BlobStoreStatus {
	configKey: string;

	savings: BlobBrokerSavingsStatus;
}

export interface BlobBrokerDoctorCheck {
	name: string;

	ok: boolean;

	status: "pass" | "warn" | "fail";

	detail: string;
}

export interface BlobBrokerDoctorRequest {
	probe?: boolean;
}

export interface BlobBrokerDoctorResponse {
	status: BlobBrokerStatus;

	checks: readonly BlobBrokerDoctorCheck[];
}

export interface BlobBrokerProbeRequest {
	timeoutMs?: number;
}

export interface BlobBrokerProbeResponse {
	ok: boolean;

	durationMs: number;

	detail: string;
}

export interface BlobBrokerPurgeRequest {
	apply?: boolean;

	all?: boolean;

	expiredOnly?: boolean;

	before?: number;
}

export interface BlobBrokerPurgeResponse {
	applied: boolean;

	purgedBlobs: number;

	reclaimedBytes: number;

	publications: readonly BlobPublication[];

	remoteDeletes: readonly RemoteDeleteAction[];

	attempted: number;

	deleted: number;

	errors: readonly string[];
}

export const RENDER_CALLBACK_PATH = "/render/";

export const RENDER_CALLBACK_TOKEN_HEADER = "x-proto-blob-token";
