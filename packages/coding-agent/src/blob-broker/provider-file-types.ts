import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import type { ProviderFileReference } from "@oh-my-pi/pi-ai";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { RemoteDeleteAction } from "./publication";

export type ProviderFileProvider = "openai" | "anthropic" | "google";

export interface ProviderFileUploadRequest {
	readonly bytes: Uint8Array;

	readonly mimeType: string;

	readonly filename?: string;

	readonly signal?: AbortSignal;
}

export interface ProviderFileHandle {
	readonly provider: ProviderFileProvider;

	readonly id?: string;

	readonly uri?: string;

	readonly mimeType: string;

	readonly bytes: number;

	readonly expiresAt?: number;

	readonly delete: RemoteDeleteAction;
}

export interface ProviderFileClient {
	readonly provider: ProviderFileProvider;

	upload(request: ProviderFileUploadRequest): Promise<ProviderFileHandle>;

	delete(handle: ProviderFileHandle): Promise<void>;
}

export interface ProviderFileCacheEntry {
	readonly provider: ProviderFileProvider;

	readonly credentialHash: string;

	readonly contentHash: string;

	readonly handle: ProviderFileHandle;
}

export interface ProviderFileCacheStatus {
	readonly indexPath: string;

	readonly entries: number;

	readonly bytes: number;

	readonly providers: Readonly<Record<ProviderFileProvider, number>>;

	readonly dirty: boolean;

	readonly lastSavedAt?: number;

	readonly lastError?: string;
}

interface ProviderFileCacheOptions {
	readonly saveDebounceMs?: number;

	readonly now?: () => number;
}

interface PersistedProviderFileIndex {
	readonly version: 1;
	readonly entries: readonly ProviderFileCacheEntry[];
}

const DEFAULT_SAVE_DEBOUNCE_MS = 250;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SENSITIVE_DELETE_HEADERS: Readonly<Record<string, true>> = {
	authorization: true,
	"api-key": true,
	"x-api-key": true,
	"x-goog-api-key": true,
};
const SENSITIVE_QUERY_PARAMETERS: Readonly<Record<string, true>> = {
	access_token: true,
	"api-key": true,
	api_key: true,
	key: true,
	token: true,
};

const PersistedDeleteActionSchema = type({
	method: "'DELETE' | 'GET' | 'POST'",
	url: "string > 0",
	"headers?": { "[string]": "string" },
	"body?": "string",
});
const PersistedHandleSchema = type({
	provider: "'openai' | 'anthropic' | 'google'",
	"id?": "string > 0",
	"uri?": "string > 0",
	mimeType: "string > 0",
	bytes: "number.integer >= 0",
	"expiresAt?": "number",
	delete: PersistedDeleteActionSchema,
});
const PersistedEntrySchema = type({
	provider: "'openai' | 'anthropic' | 'google'",
	credentialHash: "string > 0",
	contentHash: "string > 0",
	handle: PersistedHandleSchema,
});
const PersistedIndexSchema = type({
	version: "1",
	entries: PersistedEntrySchema.array(),
});

export function hashProviderFileCredential(credential: string): string {
	return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function hashProviderFileContent(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function toProviderFileReference(handle: ProviderFileHandle): ProviderFileReference {
	return {
		provider: handle.provider,
		...(handle.id === undefined ? {} : { id: handle.id }),
		...(handle.uri === undefined ? {} : { uri: handle.uri }),
		...(handle.expiresAt === undefined ? {} : { expiresAt: handle.expiresAt }),
	};
}

function cacheKey(provider: ProviderFileProvider, credentialHash: string, contentHash: string): string {
	return JSON.stringify([provider, credentialHash, contentHash]);
}

function normalizeContentHash(contentHash: string): string {
	const normalized = contentHash.toLowerCase();
	if (!SHA256_HEX_PATTERN.test(normalized)) {
		throw new Error("Provider file content hash must be a lowercase or uppercase SHA-256 hex digest");
	}
	return normalized;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function containsCredential(value: string, credential: string): boolean {
	return credential.length > 0 && value.includes(credential);
}

function sanitizeDeleteAction(action: RemoteDeleteAction, credential: string): RemoteDeleteAction {
	let url: URL;
	try {
		url = new URL(action.url);
	} catch {
		if (containsCredential(action.url, credential)) {
			throw new Error("Provider delete URL must not embed an account credential");
		}
		url = new URL(action.url, "https://provider-file.invalid");
	}
	if (containsCredential(url.origin + url.pathname + url.hash, credential)) {
		throw new Error("Provider delete URL must not embed an account credential");
	}
	for (const name of [...url.searchParams.keys()]) {
		const values = url.searchParams.getAll(name);
		if (
			SENSITIVE_QUERY_PARAMETERS[name.toLowerCase()] ||
			values.some(value => containsCredential(value, credential))
		) {
			url.searchParams.delete(name);
		}
	}
	let headers: Record<string, string> | undefined;
	if (action.headers) {
		for (const name in action.headers) {
			const value = action.headers[name];
			if (SENSITIVE_DELETE_HEADERS[name.toLowerCase()] || containsCredential(value, credential)) continue;
			headers ??= {};
			headers[name] = value;
		}
	}
	const body = action.body !== undefined && !containsCredential(action.body, credential) ? action.body : undefined;
	return {
		method: action.method,
		url: url.origin === "https://provider-file.invalid" ? `${url.pathname}${url.search}${url.hash}` : url.toString(),
		...(headers ? { headers } : {}),
		...(body === undefined ? {} : { body }),
	};
}

function sanitizeHandle(handle: ProviderFileHandle, credential: string): ProviderFileHandle {
	return {
		provider: handle.provider,
		...(handle.id === undefined ? {} : { id: handle.id }),
		...(handle.uri === undefined ? {} : { uri: handle.uri }),
		mimeType: handle.mimeType,
		bytes: handle.bytes,
		...(handle.expiresAt === undefined ? {} : { expiresAt: handle.expiresAt }),
		delete: sanitizeDeleteAction(handle.delete, credential),
	};
}

export class ProviderFileCache {
	readonly #indexPath: string;
	readonly #saveDebounceMs: number;
	readonly #now: () => number;
	readonly #entries = new Map<string, ProviderFileCacheEntry>();
	#saveTimer: Timer | undefined;
	#dirty = false;
	#lastSavedAt: number | undefined;
	#lastError: string | undefined;

	constructor(indexPath: string, options: ProviderFileCacheOptions = {}) {
		if (indexPath.length === 0) throw new Error("Provider file cache index path must not be empty");
		const saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
		if (!Number.isFinite(saveDebounceMs) || saveDebounceMs < 0) {
			throw new Error("Provider file cache save debounce must be a non-negative finite number");
		}
		this.#indexPath = indexPath;
		this.#saveDebounceMs = saveDebounceMs;
		this.#now = options.now ?? Date.now;
		const discarded = this.#loadIndex();
		if (discarded > 0) {
			this.#dirty = true;
			this.#scheduleSave();
		}
	}

	get(provider: ProviderFileProvider, credential: string, contentHash: string): ProviderFileHandle | undefined {
		const credentialHash = hashProviderFileCredential(credential);
		const key = cacheKey(provider, credentialHash, normalizeContentHash(contentHash));
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (this.#expired(entry.handle)) {
			this.#entries.delete(key);
			this.#changed();
			return undefined;
		}
		return entry.handle;
	}

	set(provider: ProviderFileProvider, credential: string, contentHash: string, handle: ProviderFileHandle): void {
		const normalizedContentHash = normalizeContentHash(contentHash);
		if (handle.provider !== provider) throw new Error("Provider file handle does not match its cache provider");
		const credentialHash = hashProviderFileCredential(credential);
		const key = cacheKey(provider, credentialHash, normalizedContentHash);
		if (this.#expired(handle)) {
			if (this.#entries.delete(key)) this.#changed();
			return;
		}
		const entry: ProviderFileCacheEntry = {
			provider,
			credentialHash,
			contentHash: normalizedContentHash,
			handle: sanitizeHandle(handle, credential),
		};
		this.#entries.set(key, entry);
		this.#changed();
	}

	delete(provider: ProviderFileProvider, credential: string, contentHash: string): ProviderFileCacheEntry | undefined {
		const credentialHash = hashProviderFileCredential(credential);
		const key = cacheKey(provider, credentialHash, normalizeContentHash(contentHash));
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		this.#entries.delete(key);
		this.#changed();
		return entry;
	}

	purgeExpired(): readonly ProviderFileCacheEntry[] {
		const removed: ProviderFileCacheEntry[] = [];
		for (const [key, entry] of this.#entries) {
			if (!this.#expired(entry.handle)) continue;
			this.#entries.delete(key);
			removed.push(entry);
		}
		if (removed.length > 0) this.#changed();
		return removed;
	}

	entries(): readonly ProviderFileCacheEntry[] {
		this.purgeExpired();
		return [...this.#entries.values()].sort(
			(left, right) =>
				left.provider.localeCompare(right.provider) ||
				left.credentialHash.localeCompare(right.credentialHash) ||
				left.contentHash.localeCompare(right.contentHash),
		);
	}

	status(): ProviderFileCacheStatus {
		this.purgeExpired();
		const providers: Record<ProviderFileProvider, number> = { openai: 0, anthropic: 0, google: 0 };
		let bytes = 0;
		for (const entry of this.#entries.values()) {
			providers[entry.provider]++;
			bytes += entry.handle.bytes;
		}
		return {
			indexPath: this.#indexPath,
			entries: this.#entries.size,
			bytes,
			providers,
			dirty: this.#dirty,
			...(this.#lastSavedAt === undefined ? {} : { lastSavedAt: this.#lastSavedAt }),
			...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
		};
	}

	deleteAll(): readonly ProviderFileCacheEntry[] {
		const removed = [...this.#entries.values()];
		if (removed.length === 0) return removed;
		this.#entries.clear();
		this.#changed();
		return removed;
	}

	save(): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (!this.#dirty) return;
		try {
			this.#saveIndex();
		} catch (error) {
			this.#lastError = errorMessage(error);
			throw error;
		}
	}

	#loadIndex(): number {
		let source: string;
		try {
			source = fs.readFileSync(this.#indexPath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return 0;
			this.#lastError = errorMessage(error);
			return 0;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(source) as unknown;
		} catch (error) {
			this.#lastError = errorMessage(error);
			return 0;
		}
		const checked = PersistedIndexSchema(parsed);
		if (checked instanceof OmpErrors) {
			this.#lastError = "Unsupported or malformed provider file cache index";
			return 0;
		}
		let discarded = 0;
		for (const entry of checked.entries) {
			if (
				entry.handle.provider !== entry.provider ||
				!SHA256_HEX_PATTERN.test(entry.credentialHash) ||
				!SHA256_HEX_PATTERN.test(entry.contentHash) ||
				this.#expired(entry.handle)
			) {
				discarded++;
				continue;
			}
			this.#entries.set(cacheKey(entry.provider, entry.credentialHash, entry.contentHash), entry);
		}
		return discarded;
	}

	#saveIndex(): void {
		const index: PersistedProviderFileIndex = { version: 1, entries: [...this.#entries.values()] };
		const directory = path.dirname(this.#indexPath);
		const temporaryPath = `${this.#indexPath}.${process.pid}.${Date.now()}.tmp`;
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		try {
			fs.writeFileSync(temporaryPath, JSON.stringify(index), { encoding: "utf8", mode: 0o600 });
			fs.renameSync(temporaryPath, this.#indexPath);
		} catch (error) {
			try {
				fs.unlinkSync(temporaryPath);
			} catch {}
			throw error;
		}
		this.#dirty = false;
		this.#lastSavedAt = this.#now();
		this.#lastError = undefined;
	}

	#changed(): void {
		this.#dirty = true;
		this.#scheduleSave();
	}

	#scheduleSave(): void {
		if (this.#saveTimer) return;
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			try {
				this.#saveIndex();
			} catch (error) {
				this.#lastError = errorMessage(error);
			}
		}, this.#saveDebounceMs);
		this.#saveTimer.unref?.();
	}

	#expired(handle: ProviderFileHandle): boolean {
		return handle.expiresAt !== undefined && handle.expiresAt <= this.#now();
	}
}
