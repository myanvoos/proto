import type { BlobDestinationId } from "./destinations";
import type { BlobPublication, BlobUploadRequest, RemoteDeleteAction } from "./publication";

export type DestinationOptionValue = string | number | boolean;

export type FetchInput = string | URL | Request;

export type FetchImpl = (input: FetchInput, init?: RequestInit) => Promise<Response>;

export interface DestinationRuntimeConfig {
	readonly options: Readonly<Record<string, DestinationOptionValue>>;

	readonly credentials: Readonly<Record<string, string>>;

	readonly fetch?: FetchImpl;
}

interface PublicationExtras {
	readonly expiresAt?: number;

	readonly delete?: RemoteDeleteAction;

	readonly remoteId?: string;
}

export class DestinationUnavailableError extends Error {
	readonly destination: BlobDestinationId;

	constructor(destination: BlobDestinationId, reason: string) {
		super(`${destination} is unavailable: ${reason}`);
		this.name = "DestinationUnavailableError";
		this.destination = destination;
	}
}

export function requireOption(config: DestinationRuntimeConfig, key: string): DestinationOptionValue {
	const value = config.options[key];
	if (value === undefined) throw new Error(`Missing required destination option: ${key}`);
	return value;
}

export function optionString(config: DestinationRuntimeConfig, key: string, fallback?: string): string | undefined {
	const value = config.options[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string") throw new Error(`Destination option ${key} must be a string`);
	return value;
}

export function optionNumber(config: DestinationRuntimeConfig, key: string, fallback?: number): number | undefined {
	const value = config.options[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Destination option ${key} must be a finite number`);
	}
	return value;
}

export function optionBoolean(config: DestinationRuntimeConfig, key: string, fallback?: boolean): boolean | undefined {
	const value = config.options[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`Destination option ${key} must be a boolean`);
	return value;
}

export function credentialString(config: DestinationRuntimeConfig, key: string): string | undefined {
	const value = config.credentials[key];
	return value === "" ? undefined : value;
}

export function requireCredential(config: DestinationRuntimeConfig, key: string): string {
	const value = credentialString(config, key);
	if (value === undefined) throw new Error(`Missing required destination credential: ${key}`);
	return value;
}

export function fetchFor(config: DestinationRuntimeConfig): FetchImpl {
	return config.fetch ?? globalThis.fetch;
}

export function fileNameFor(request: BlobUploadRequest): string {
	const preferred = request.filename?.trim().replaceAll("\\", "/").split("/").pop();
	if (preferred && preferred !== "." && preferred !== "..") return preferred;
	const extension = request.extension.replace(/^\.+/, "");
	return extension ? `upload.${extension}` : "upload";
}

export function multipartFile(
	request: BlobUploadRequest,
	fieldName = "file",
	fields: Readonly<Record<string, string>> = {},
): FormData {
	const form = new FormData();
	for (const key in fields) form.append(key, fields[key]);
	const file = new File([request.bytes], fileNameFor(request), { type: request.mimeType });
	form.append(fieldName, file);
	return form;
}

export async function expectOk(response: Response, destination: BlobDestinationId | string): Promise<Response> {
	if (!response.ok) {
		const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
		throw new Error(`${destination} upload failed with HTTP ${status}`);
	}
	return response;
}

export function publication(
	destination: BlobDestinationId,
	request: BlobUploadRequest,
	url: string,
	extras: PublicationExtras = {},
): BlobPublication {
	return {
		url,
		destination,
		bytes: request.bytes.byteLength,
		...(extras.expiresAt === undefined ? {} : { expiresAt: extras.expiresAt }),
		...(extras.delete === undefined ? {} : { delete: extras.delete }),
		...(extras.remoteId === undefined ? {} : { remoteId: extras.remoteId }),
	};
}
