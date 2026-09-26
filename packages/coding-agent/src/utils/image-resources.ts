import { parseImageMetadata } from "@oh-my-pi/pi-utils";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 32_000_000;
export const MAX_ACTIVE_IMAGE_PIXELS = 64_000_000;
export const MAX_ACTIVE_IMAGE_OPERATIONS = 2;
export const MAX_PENDING_IMAGE_INPUTS = 8;
export const MAX_PENDING_IMAGE_BYTES = 160 * 1024 * 1024;

export class ImageResourceLimitError extends Error {
	constructor(
		readonly reason: "oversized" | "busy",
		detail: string,
	) {
		super(`Image ${reason === "busy" ? "processing busy" : "resource limit exceeded"}: ${detail}`);
		this.name = "ImageResourceLimitError";
	}
}

export interface ImageResourceLease {
	release(): void;
}

let pendingBytes = 0;
let pendingCount = 0;
let activePixels = 0;
let activeCount = 0;

export function assertImageInputSize(bytes: number): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_IMAGE_INPUT_BYTES) {
		throw new ImageResourceLimitError("oversized", `encoded input exceeds ${MAX_IMAGE_INPUT_BYTES} bytes`);
	}
}

/** Reserve before reading or retaining a payload. No queue owns rejected work. */
export function reserveImageInput(bytes: number): ImageResourceLease {
	assertImageInputSize(bytes);
	// Raw bytes plus the worst-case UTF-16 base64 representation can coexist.
	const residentBytes = bytes + Math.ceil(bytes / 3) * 8;
	if (pendingCount >= MAX_PENDING_IMAGE_INPUTS || pendingBytes + residentBytes > MAX_PENDING_IMAGE_BYTES) {
		throw new ImageResourceLimitError("busy", "pending image count or encoded byte budget is full");
	}
	pendingCount++;
	pendingBytes += residentBytes;
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			pendingCount--;
			pendingBytes -= residentBytes;
		},
	};
}

export function assertImagePixelSize(width: number, height: number): number {
	const pixels = width * height;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		pixels > MAX_IMAGE_PIXELS
	) {
		throw new ImageResourceLimitError("oversized", `image dimensions exceed ${MAX_IMAGE_PIXELS} pixels`);
	}
	return pixels;
}

export async function withImageInput<T>(
	data: string | Uint8Array,
	run: (buffer: Uint8Array) => Promise<T>,
): Promise<T> {
	// Bound the string itself, including whitespace ignored by base64 decoders.
	if (typeof data === "string" && data.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4) {
		throw new ImageResourceLimitError("oversized", "base64 input is too large");
	}
	const lease = reserveImageInput(typeof data === "string" ? Buffer.byteLength(data, "base64") : data.byteLength);
	try {
		return await run(typeof data === "string" ? Buffer.from(data, "base64") : data);
	} finally {
		lease.release();
	}
}

/** Header inspection is JS-only; no native decoder is started without a pixel reservation. */
export async function withImagePixels<T>(
	buffer: Uint8Array,
	run: (dimensions: { width: number; height: number; mimeType: string }) => Promise<T>,
	targetPixels = 0,
): Promise<T> {
	if (!Number.isSafeInteger(targetPixels) || targetPixels < 0 || targetPixels > MAX_IMAGE_PIXELS) {
		throw new ImageResourceLimitError("oversized", `target dimensions exceed ${MAX_IMAGE_PIXELS} pixels`);
	}
	const metadata = parseImageMetadata(buffer);
	if (!metadata?.width || !metadata.height) throw new Error("Image dimensions unavailable in supported image header");
	const pixels = assertImagePixelSize(metadata.width, metadata.height) + targetPixels;
	if (activeCount >= MAX_ACTIVE_IMAGE_OPERATIONS || activePixels + pixels > MAX_ACTIVE_IMAGE_PIXELS) {
		throw new ImageResourceLimitError("busy", "native image concurrency or decoded pixel budget is full");
	}
	activeCount++;
	activePixels += pixels;
	try {
		return await run({ width: metadata.width, height: metadata.height, mimeType: metadata.mimeType });
	} finally {
		// Native promises cannot be preempted: never release capacity on a timeout/race.
		activeCount--;
		activePixels -= pixels;
	}
}

export function withImageDecode<T>(
	data: string | Uint8Array,
	run: (buffer: Uint8Array, dimensions: { width: number; height: number; mimeType: string }) => Promise<T>,
): Promise<T> {
	return withImageInput(data, buffer => withImagePixels(buffer, dimensions => run(buffer, dimensions)));
}
