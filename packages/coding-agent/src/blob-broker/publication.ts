import type { BlobDestinationId } from "./destinations";

export interface RemoteDeleteAction {
	method: "DELETE" | "GET" | "POST";

	url: string;

	headers?: Readonly<Record<string, string>>;

	body?: string;
}

export interface BlobPublication {
	url: string;

	destination: BlobDestinationId;

	bytes: number;

	expiresAt?: number;

	delete?: RemoteDeleteAction;

	remoteId?: string;
}

export interface BlobUploadRequest {
	bytes: Uint8Array;

	mimeType: string;

	extension: string;

	filename?: string;
}

export interface BlobUploader {
	readonly destination: BlobDestinationId;

	upload(request: BlobUploadRequest): Promise<BlobPublication>;
}
