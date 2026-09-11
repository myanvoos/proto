import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
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
		await Bun.write(result.path, data);
		await ensureDisplayPath(result.path, result.displayPath, data);
		return result;
	}

	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const result = createBlobPutResult(this.dir, data, options);
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(result.path, data);
		ensureDisplayPathSync(result.path, result.displayPath, data);
		return result;
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

export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
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
