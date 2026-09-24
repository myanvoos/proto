import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

const BLOB_PREFIX = "blob:sha256:";

export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export interface BlobPutOptions {
	extension?: string;
}

export interface BlobPutResult {
	hash: string;

	path: string;

	displayPath: string;
	get ref(): string;
}

export type BlobReader = (hash: string) => Promise<Buffer | null>;

const inFlightBlobWrites = new Set<string>();
const blobClaims = new Map<string, { locked: boolean; waiters: Array<() => void> }>();

function tryClaimBlob(key: string): (() => void) | null {
	let claim = blobClaims.get(key);
	if (claim?.locked) return null;
	if (!claim) {
		claim = { locked: true, waiters: [] };
		blobClaims.set(key, claim);
	}
	return () => releaseBlobClaim(key, claim!);
}

async function claimBlob(key: string): Promise<() => void> {
	const release = tryClaimBlob(key);
	if (release) return release;
	const claim = blobClaims.get(key)!;
	await new Promise<void>(resolve => claim.waiters.push(resolve));
	return () => releaseBlobClaim(key, claim);
}

function releaseBlobClaim(key: string, claim: { locked: boolean; waiters: Array<() => void> }): void {
	const next = claim.waiters.shift();
	if (next) {
		next();
		return;
	}
	claim.locked = false;
	if (blobClaims.get(key) === claim) blobClaims.delete(key);
}

export interface BlobSweepResult {
	marked: number;
	removed: number;
	keptYoung: number;
	aborted: boolean;
}

const DEFAULT_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_RECORDS = 100_000;
const MAX_ARCHIVE_RECORD_BYTES = 1024 * 1024;

async function collectBlobReferences(sessionsDir: string): Promise<Set<string> | null> {
	const references = new Set<string>();
	const pending = [sessionsDir];
	try {
		while (pending.length > 0) {
			const directory = pending.pop();
			if (!directory) continue;
			for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
				const entryPath = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					pending.push(entryPath);
					continue;
				}
				if (!entry.isFile()) continue;
				if (entry.name.endsWith(".archive.jsonl.gz")) {
					const archiveStat = await fsp.stat(entryPath);
					if (!archiveStat.isFile() || archiveStat.size > MAX_ARCHIVE_FILE_BYTES) {
						logger.warn("Blob sweep skipped because a session archive exceeds the scan limit", {
							archivePath: entryPath,
							size: archiveStat.size,
							limit: MAX_ARCHIVE_FILE_BYTES,
						});
						return null;
					}
					const encoded = (await fsp.readFile(entryPath)).toString("utf8").trim();
					let archive: unknown;
					try {
						const decoded = gunzipSync(Buffer.from(encoded, "base64"), {
							maxOutputLength: MAX_ARCHIVE_DECODED_BYTES,
						}).toString("utf8");
						archive = JSON.parse(decoded);
					} catch {
						return null;
					}
					if (typeof archive !== "object" || archive === null) return null;
					const envelope = archive as {
						version?: unknown;
						sessionId?: unknown;
						sessionFile?: unknown;
						records?: unknown;
					};
					if (
						envelope.version !== 1 ||
						typeof envelope.sessionId !== "string" ||
						typeof envelope.sessionFile !== "string" ||
						!Array.isArray(envelope.records) ||
						envelope.records.length > MAX_ARCHIVE_RECORDS
					) {
						return null;
					}
					for (const record of envelope.records) {
						if (
							typeof record !== "object" ||
							record === null ||
							typeof record.id !== "string" ||
							!(record.beforeId === null || typeof record.beforeId === "string") ||
							typeof record.line !== "string" ||
							Buffer.byteLength(record.line, "utf8") > MAX_ARCHIVE_RECORD_BYTES
						) {
							return null;
						}
						let value: unknown;
						try {
							value = JSON.parse(record.line);
						} catch {
							return null;
						}
						if (typeof value !== "object" || value === null || !("id" in value) || value.id !== record.id)
							return null;
						collectRefs(value, references);
					}
					continue;
				}
				if (!entry.name.endsWith(".jsonl")) continue;
				const contents = await fsp.readFile(entryPath, "utf8");
				for (const line of contents.split("\n")) {
					if (!line.trim()) continue;
					let value: unknown;
					try {
						value = JSON.parse(line);
					} catch {
						return null;
					}
					collectRefs(value, references);
				}
			}
		}
	} catch {
		return null;
	}
	return references;
}

function collectRefs(value: unknown, references: Set<string>): void {
	if (typeof value === "string") {
		const hash = parseBlobRef(value);
		if (hash) references.add(hash);
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) collectRefs(child, references);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const child of Object.values(value)) collectRefs(child, references);
}

/** Remove only old, hash-addressed blobs absent from every persisted session transcript. */
export async function sweepUnreferencedBlobs(
	blobDir: string,
	sessionsDir: string,
	options: { graceMs?: number; now?: number } = {},
): Promise<BlobSweepResult> {
	const references = await collectBlobReferences(sessionsDir);
	if (!references) {
		logger.warn("Blob sweep skipped because the persisted-session reference scan was incomplete", { sessionsDir });
		return { marked: 0, removed: 0, keptYoung: 0, aborted: true };
	}
	const cutoff = (options.now ?? Date.now()) - (options.graceMs ?? DEFAULT_BLOB_GRACE_MS);
	let marked = 0;
	let removed = 0;
	let keptYoung = 0;
	let aborted = false;
	const candidates: Array<{
		name: string;
		path: string;
		dev: number;
		ino: number;
		size: number;
		mtimeMs: number;
		ctimeMs: number;
	}> = [];
	try {
		for (const entry of await fsp.readdir(blobDir, { withFileTypes: true })) {
			if (!entry.isFile() || !BLOB_HASH_RE.test(entry.name) || references.has(entry.name)) continue;
			marked++;
			const candidate = path.join(blobDir, entry.name);
			if (inFlightBlobWrites.has(candidate)) {
				keptYoung++;
				continue;
			}
			try {
				const stat = await fsp.stat(candidate);
				if (!stat.isFile() || stat.mtimeMs > cutoff) {
					keptYoung++;
					continue;
				}
				candidates.push({
					name: entry.name,
					path: candidate,
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
				});
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		const batchSize = 32;
		for (let offset = 0; offset < candidates.length; offset += batchSize) {
			const batch = candidates.slice(offset, offset + batchSize);
			const currentReferences = await collectBlobReferences(sessionsDir);
			if (!currentReferences) {
				keptYoung += batch.length;
				aborted = true;
				break;
			}
			for (const candidate of batch) {
				const release = tryClaimBlob(candidate.path);
				if (!release) {
					keptYoung++;
					continue;
				}
				try {
					try {
						const current = await fsp.stat(candidate.path);
						if (!current.isFile() || current.mtimeMs > cutoff) {
							keptYoung++;
							continue;
						}
					} catch (error) {
						if (!isEnoent(error)) throw error;
						continue;
					}
					const latestReferences = await collectBlobReferences(sessionsDir);
					if (!latestReferences) {
						keptYoung++;
						aborted = true;
						break;
					}
					if (inFlightBlobWrites.has(candidate.path) || latestReferences.has(candidate.name)) {
						keptYoung++;
						continue;
					}
					// Recheck after the final reference scan; putSync may have atomically
					// replaced this path while that scan was awaiting filesystem I/O.
					try {
						const current = fs.statSync(candidate.path);
						if (
							!current.isFile() ||
							current.dev !== candidate.dev ||
							current.ino !== candidate.ino ||
							current.size !== candidate.size ||
							current.mtimeMs !== candidate.mtimeMs ||
							current.ctimeMs !== candidate.ctimeMs ||
							current.mtimeMs > cutoff
						) {
							keptYoung++;
							continue;
						}
						// Keep validation and unlink in one non-yielding sequence so putSync
						// cannot replace this path between the identity check and deletion.
						// Cross-process replacement needs separate coordination.
						fs.unlinkSync(candidate.path);
						removed++;
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
				} finally {
					release();
				}
				// Yield after the non-yielding validation+unlink window so a large
				// batch cannot monopolize the event loop on slow filesystems.
				await Bun.sleep(0);
				if (aborted) break;
			}
			if (aborted) break;
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Blob sweep stopped after filesystem error", { error: String(error) });
			aborted = true;
		}
	}
	logger.info("Blob sweep completed", { marked, removed, keptYoung, aborted });
	return { marked, removed, keptYoung, aborted };
}

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

function normalizeBlobExtension(extension: string | undefined): string | undefined {
	if (!extension) return undefined;
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
	if (normalized.length === 0 || normalized.length > 32) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
	return normalized.toLowerCase();
}

function createBlobPutResult(dir: string, data: Buffer, options?: BlobPutOptions): BlobPutResult {
	const hash = new Bun.SHA256().update(data).digest("hex");
	const blobPath = path.join(dir, hash);
	const extension = normalizeBlobExtension(options?.extension);
	const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
	return {
		hash,
		path: blobPath,
		displayPath,
		get ref() {
			return `${BLOB_PREFIX}${hash}`;
		},
	};
}

function ensureDisplayPathWithIo(
	blobPath: string,
	displayPath: string,
	link: () => void | Promise<void>,
	copy: () => void | Promise<void>,
): void | Promise<void> {
	if (displayPath === blobPath) return;
	const handleLinkError = (err: unknown): void | Promise<void> => {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") return;
		logger.debug("Blob display hardlink failed; falling back to copy", {
			blobPath,
			displayPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return copy();
	};
	try {
		const result = link();
		return result ? result.then(() => undefined, handleLinkError) : undefined;
	} catch (err) {
		return handleLinkError(err);
	}
}

async function writeBlobAtomically(blobPath: string, data: Buffer): Promise<void> {
	const temporaryPath = `${blobPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporaryPath, data);
		await fsp.rename(temporaryPath, blobPath);
	} finally {
		await fsp.rm(temporaryPath, { force: true }).catch(() => {});
	}
}

function writeBlobAtomicallySync(blobPath: string, data: Buffer): void {
	const temporaryPath = `${blobPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, data);
		fs.renameSync(temporaryPath, blobPath);
	} finally {
		try {
			fs.rmSync(temporaryPath, { force: true });
		} catch {}
	}
}

async function ensureDisplayPath(blobPath: string, displayPath: string, data: Buffer): Promise<void> {
	await ensureDisplayPathWithIo(
		blobPath,
		displayPath,
		() => fsp.link(blobPath, displayPath),
		() => Bun.write(displayPath, data).then(() => undefined),
	);
}

function ensureDisplayPathSync(blobPath: string, displayPath: string, data: Buffer): void {
	ensureDisplayPathWithIo(
		blobPath,
		displayPath,
		() => fs.linkSync(blobPath, displayPath),
		() => fs.writeFileSync(displayPath, data),
	);
}

export function blobExtensionForImageMimeType(mimeType: string | undefined): string | undefined {
	if (!mimeType) return undefined;
	const lower = mimeType.toLowerCase();
	const known = IMAGE_EXTENSION_BY_MIME[lower];
	if (known) return known;
	if (!lower.startsWith("image/")) return undefined;
	const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
	return normalizeBlobExtension(subtype);
}

export class BlobStore {
	constructor(readonly dir: string) {}

	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		const result = createBlobPutResult(this.dir, data, options);
		const release = await claimBlob(result.path);
		inFlightBlobWrites.add(result.path);
		try {
			await writeBlobAtomically(result.path, data);
			await ensureDisplayPath(result.path, result.displayPath, data);
			return result;
		} finally {
			inFlightBlobWrites.delete(result.path);
			release();
		}
	}

	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const result = createBlobPutResult(this.dir, data, options);
		inFlightBlobWrites.add(result.path);
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			writeBlobAtomicallySync(result.path, data);
			ensureDisplayPathSync(result.path, result.displayPath, data);
			return result;
		} finally {
			inFlightBlobWrites.delete(result.path);
		}
	}

	async get(hash: string): Promise<Buffer | null> {
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	getSync(hash: string): Buffer | null {
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async has(hash: string): Promise<boolean> {
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}
}

export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	if (!BLOB_HASH_RE.test(hash)) {
		logger.warn("Rejected malformed blob reference", { suffix: hash });
		return null;
	}
	return hash;
}

export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putSync(Buffer.from(dataUrl, "utf8")).ref;
}

export async function externalizeImageData(
	blobStore: BlobStore,
	base64Data: string,
	mimeType?: string,
): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer, {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return ref;
}

export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string, mimeType?: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putSync(Buffer.from(base64Data, "base64"), {
		extension: blobExtensionForImageMimeType(mimeType),
	}).ref;
}

export async function resolveImageDataUrl(
	blobStore: BlobStore,
	data: string,
	readBlob: BlobReader = hash => blobStore.get(hash),
): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await readBlob(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

export async function resolveImageData(
	blobStore: BlobStore,
	data: string,
	readBlob: BlobReader = hash => blobStore.get(hash),
): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await readBlob(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}

export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}
