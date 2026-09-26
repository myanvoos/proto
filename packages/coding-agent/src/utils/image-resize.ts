import type { ImageContent } from "@oh-my-pi/pi-ai";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";
import { assertImagePixelSize, ImageResourceLimitError, withImageInput, withImagePixels } from "./image-resources";

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

export class ImageResizeMaxBytesError extends Error {
	readonly maxBytes: number;
	readonly smallestBytes: number;

	constructor(maxBytes: number, smallestBytes: number) {
		super(`Unable to resize image within ${maxBytes} bytes; smallest encoded candidate was ${smallestBytes} bytes`);
		this.name = "ImageResizeMaxBytesError";
		this.maxBytes = maxBytes;
		this.smallestBytes = smallestBytes;
	}
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
	const targetPixels = assertImagePixelSize(opts.maxWidth, opts.maxHeight);
	return withImageInput(img.data, async inputBuffer => {
		try {
			return await withImagePixels(
				inputBuffer,
				async () => {
					const {
						width: originalWidth,
						height: originalHeight,
						format,
					} = await new Bun.Image(inputBuffer).metadata();
					assertImagePixelSize(originalWidth, originalHeight);
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
						const upscale = Math.min(
							minDimension / shortEdge,
							opts.maxWidth / targetWidth,
							opts.maxHeight / targetHeight,
						);
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
						const png = {
							buffer: await new Bun.Image(inputBuffer).resize(width, height).png().bytes(),
							mimeType: "image/png",
						};
						return pickSmallest(png, await encodeLossy(width, height, quality));
					}

					async function encodeLossy(
						width: number,
						height: number,
						quality: number,
					): Promise<{ buffer: Uint8Array; mimeType: string }> {
						const jpeg = {
							buffer: await new Bun.Image(inputBuffer).resize(width, height).jpeg({ quality }).bytes(),
							mimeType: "image/jpeg",
						};
						if (opts.excludeWebP) return jpeg;
						const webp = {
							buffer: await new Bun.Image(inputBuffer).resize(width, height).webp({ quality }).bytes(),
							mimeType: "image/webp",
						};
						return pickSmallest(jpeg, webp);
					}

					const qualitySteps = [70, 60, 50, 40];
					const scaleSteps = [0.75, 0.5, 0.35, 0.25];

					let best: { buffer: Uint8Array; mimeType: string };
					let finalWidth = targetWidth;
					let finalHeight = targetHeight;

					best = await encodeSmallest(targetWidth, targetHeight, opts.jpegQuality);
					let smallestOversizedBytes = best.buffer.length;

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
						smallestOversizedBytes = Math.min(smallestOversizedBytes, best.buffer.length);

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
							smallestOversizedBytes = Math.min(smallestOversizedBytes, best.buffer.length);

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

					throw new ImageResizeMaxBytesError(opts.maxBytes, smallestOversizedBytes);
				},
				targetPixels,
			);
		} catch (error) {
			if (error instanceof ImageResizeMaxBytesError || error instanceof ImageResourceLimitError) throw error;
			const headerDimensions = parseImageMetadata(inputBuffer);
			const fallbackMimeType = img.mimeType ?? headerDimensions?.mimeType ?? "application/octet-stream";

			if (excludeWebP && (fallbackMimeType === "image/webp" || (!img.mimeType && !headerDimensions))) {
				throw new Error("resizeImage: failed to decode image and cannot honor excludeWebP for a WebP source");
			}
			if (inputBuffer.length > opts.maxBytes) {
				throw new ImageResizeMaxBytesError(opts.maxBytes, inputBuffer.length);
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
	});
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
