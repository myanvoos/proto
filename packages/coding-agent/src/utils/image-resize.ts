import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;

	minDimension?: number;
	maxBytes?: number;
	jpegQuality?: number;
	excludeWebP?: boolean;
}

export interface ResizedImage {
	buffer: Uint8Array;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	decodeFailed?: boolean;
	get data(): string;
}

const DEFAULT_MAX_BYTES = 500 * 1024;

const DEFAULT_MIN_DIMENSION = 200;

const DEFAULT_OPTIONS: Required<Omit<ImageResizeOptions, "excludeWebP">> = {
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
	minDimension: DEFAULT_MIN_DIMENSION,
};

interface ImageHeaderDimensions {
	width: number;
	height: number;
	mimeType: string;
}

function readUint16BE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] << 8) | buffer[offset + 1];
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

function readPngHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
	if (buffer.length < 24) return undefined;
	if (
		buffer[0] !== 0x89 ||
		buffer[1] !== 0x50 ||
		buffer[2] !== 0x4e ||
		buffer[3] !== 0x47 ||
		buffer[4] !== 0x0d ||
		buffer[5] !== 0x0a ||
		buffer[6] !== 0x1a ||
		buffer[7] !== 0x0a
	) {
		return undefined;
	}
	if (readUint32BE(buffer, 8) !== 13) return undefined;
	if (buffer[12] !== 0x49 || buffer[13] !== 0x48 || buffer[14] !== 0x44 || buffer[15] !== 0x52) return undefined;
	const width = readUint32BE(buffer, 16);
	const height = readUint32BE(buffer, 20);
	if (width === 0 || height === 0) return undefined;
	return { width, height, mimeType: "image/png" };
}

function isJpegStartOfFrame(marker: number): boolean {
	return (
		(marker >= 0xc0 && marker <= 0xc3) ||
		(marker >= 0xc5 && marker <= 0xc7) ||
		(marker >= 0xc9 && marker <= 0xcb) ||
		(marker >= 0xcd && marker <= 0xcf)
	);
}

function readJpegHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
	let offset = 2;
	while (offset + 3 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset++;
			continue;
		}
		while (offset < buffer.length && buffer[offset] === 0xff) offset++;
		if (offset >= buffer.length) return undefined;
		const marker = buffer[offset++];
		if (marker === 0xd9 || marker === 0xda) return undefined;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 1 >= buffer.length) return undefined;
		const segmentLength = readUint16BE(buffer, offset);
		if (segmentLength < 2) return undefined;
		if (isJpegStartOfFrame(marker)) {
			if (offset + 7 >= buffer.length) return undefined;
			const height = readUint16BE(buffer, offset + 3);
			const width = readUint16BE(buffer, offset + 5);
			if (width === 0 || height === 0) return undefined;
			return { width, height, mimeType: "image/jpeg" };
		}
		offset += segmentLength;
	}
	return undefined;
}

function readImageHeaderDimensions(buffer: Uint8Array): ImageHeaderDimensions | undefined {
	return readPngHeaderDimensions(buffer) ?? readJpegHeaderDimensions(buffer);
}

function isWebPExcluded(): boolean {
	const raw = Bun.env.PROTO_NO_WEBP;
	if (raw === undefined) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true";
}

function pickSmallest(...candidates: Array<{ buffer: Uint8Array; mimeType: string }>): {
	buffer: Uint8Array;
	mimeType: string;
} {
	return candidates.reduce((best, c) => (c.buffer.length < best.buffer.length ? c : best));
}

Buffer.prototype.toBase64 = function (this: Buffer) {
	return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).toBase64();
};

export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
	const excludeWebP = options?.excludeWebP ?? isWebPExcluded();
	const opts = { ...DEFAULT_OPTIONS, ...options, excludeWebP };
	const inputBuffer = Buffer.from(img.data, "base64");

	try {
		const { width: originalWidth, height: originalHeight, format } = await new Bun.Image(inputBuffer).metadata();

		const sourceMime = format ? `image/${format}` : img.mimeType;

		const originalSize = inputBuffer.length;
		const comfortableSize = opts.maxBytes / 4;

		const minDimension = Math.min(opts.minDimension, opts.maxWidth, opts.maxHeight);
		if (
			originalWidth >= minDimension &&
			originalHeight >= minDimension &&
			originalWidth <= opts.maxWidth &&
			originalHeight <= opts.maxHeight &&
			originalSize <= comfortableSize &&
			!(opts.excludeWebP && sourceMime === "image/webp")
		) {
			return {
				buffer: inputBuffer,
				mimeType: sourceMime,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
				get data() {
					return img.data;
				},
			};
		}

		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		if (targetWidth < minDimension || targetHeight < minDimension) {
			const shortEdge = Math.min(targetWidth, targetHeight);
			const upscale = Math.min(minDimension / shortEdge, opts.maxWidth / targetWidth, opts.maxHeight / targetHeight);
			if (upscale > 1) {
				targetWidth = Math.round(targetWidth * upscale);
				targetHeight = Math.round(targetHeight * upscale);
			}
			targetWidth = Math.min(opts.maxWidth, Math.max(minDimension, targetWidth));
			targetHeight = Math.min(opts.maxHeight, Math.max(minDimension, targetHeight));
		}

		async function encodeSmallest(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const candidates = await Promise.all([
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.png()
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/png" })),
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
				...(opts.excludeWebP
					? []
					: [
							new Bun.Image(inputBuffer)
								.resize(width, height)
								.webp({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/webp" })),
						]),
			]);
			return pickSmallest(...candidates);
		}

		async function encodeLossy(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const candidates = await Promise.all([
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
				...(opts.excludeWebP
					? []
					: [
							new Bun.Image(inputBuffer)
								.resize(width, height)
								.webp({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/webp" })),
						]),
			]);
			return pickSmallest(...candidates);
		}

		const qualitySteps = [70, 60, 50, 40];
		const scaleSteps = [1.0, 0.75, 0.5, 0.35, 0.25];

		let best: { buffer: Uint8Array; mimeType: string };
		let finalWidth = targetWidth;
		let finalHeight = targetHeight;

		best = await encodeSmallest(targetWidth, targetHeight, opts.jpegQuality);

		if (best.buffer.length <= opts.maxBytes) {
			return {
				buffer: best.buffer,
				mimeType: best.mimeType,
				originalWidth,
				originalHeight,
				width: finalWidth,
				height: finalHeight,
				wasResized: true,
				get data() {
					return Buffer.from(best.buffer).toBase64();
				},
			};
		}

		for (const quality of qualitySteps) {
			best = await encodeLossy(targetWidth, targetHeight, quality);

			if (best.buffer.length <= opts.maxBytes) {
				return {
					buffer: best.buffer,
					mimeType: best.mimeType,
					originalWidth,
					originalHeight,
					width: finalWidth,
					height: finalHeight,
					wasResized: true,
					get data() {
						return Buffer.from(best.buffer).toBase64();
					},
				};
			}
		}

		for (const scale of scaleSteps) {
			finalWidth = Math.round(targetWidth * scale);
			finalHeight = Math.round(targetHeight * scale);

			if (finalWidth < 100 || finalHeight < 100) {
				break;
			}

			for (const quality of qualitySteps) {
				best = await encodeLossy(finalWidth, finalHeight, quality);

				if (best.buffer.length <= opts.maxBytes) {
					return {
						buffer: best.buffer,
						mimeType: best.mimeType,
						originalWidth,
						originalHeight,
						width: finalWidth,
						height: finalHeight,
						wasResized: true,
						get data() {
							return Buffer.from(best.buffer).toBase64();
						},
					};
				}
			}
		}

		return {
			buffer: best.buffer,
			mimeType: best.mimeType,
			originalWidth,
			originalHeight,
			width: finalWidth,
			height: finalHeight,
			wasResized: true,
			get data() {
				return Buffer.from(best.buffer).toBase64();
			},
		};
	} catch {
		const headerDimensions = readImageHeaderDimensions(inputBuffer);
		const fallbackMimeType = img.mimeType ?? headerDimensions?.mimeType ?? "application/octet-stream";

		if (excludeWebP && (fallbackMimeType === "image/webp" || (!img.mimeType && !headerDimensions))) {
			throw new Error("resizeImage: failed to decode image and cannot honor excludeWebP for a WebP source");
		}
		return {
			buffer: inputBuffer,
			mimeType: fallbackMimeType,
			originalWidth: headerDimensions?.width ?? 0,
			originalHeight: headerDimensions?.height ?? 0,
			width: headerDimensions?.width ?? 0,
			height: headerDimensions?.height ?? 0,
			wasResized: false,
			decodeFailed: true,
			get data() {
				return img.data;
			},
		};
	}
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}
	if (!result.originalWidth || !result.originalHeight || !result.width || !result.height) {
		return undefined;
	}
	if (result.width === result.originalWidth && result.height === result.originalHeight) {
		return undefined;
	}
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
