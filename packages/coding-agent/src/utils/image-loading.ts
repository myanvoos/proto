import type { Context, ImageContent, Message, Model, ProviderPayload, TextContent } from "@oh-my-pi/pi-ai";
import {
	formatBytes,
	isRecord,
	logger,
	parseImageMetadata,
	readImageMetadata,
	SUPPORTED_IMAGE_MIME_TYPES,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, type ImageResizeOptions, type ResizedImage, resizeImage } from "./image-resize";
import { ImageResourceLimitError, MAX_IMAGE_INPUT_BYTES, reserveImageInput, withImageDecode } from "./image-resources";

export { MAX_IMAGE_INPUT_BYTES } from "./image-resources";

const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;
const MODEL_BOUNDARY_IMAGE_CACHE_MAX_SIZE = 64 * 1024 * 1024;
const MODEL_BOUNDARY_IMAGE_CACHE_MAX_ENTRIES = 128;
type NormalizedImagePayload = Pick<ImageContent, "data" | "mimeType">;
const modelBoundaryImageCache = new LRUCache<string, NormalizedImagePayload | null>({
	max: MODEL_BOUNDARY_IMAGE_CACHE_MAX_ENTRIES,
	maxSize: MODEL_BOUNDARY_IMAGE_CACHE_MAX_SIZE,
	sizeCalculation: payload => Math.max(1, payload?.data.length ?? 1),
});
const modelBoundaryImageNormalizations = new Map<string, Promise<NormalizedImagePayload | null>>();
const UNDECODABLE_STB_IMAGE_OMISSION_TEXT = "[image omitted: WebP could not be decoded for this model]";

function createUndecodableStbImageOmission(): TextContent {
	return { type: "text", text: UNDECODABLE_STB_IMAGE_OMISSION_TEXT };
}

function createNativeUndecodableStbImageOmission(): Record<string, unknown> {
	return { type: "input_text", text: UNDECODABLE_STB_IMAGE_OMISSION_TEXT };
}

function hasWebPMagic(data: string): boolean {
	const header = Buffer.from(data.slice(0, 16), "base64");
	return (
		header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
	);
}

function isWebPImage(image: ImageContent): boolean {
	if (typeof image.data !== "string") return false;
	const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : undefined;
	return mimeType === "image/webp" || hasWebPMagic(image.data);
}

function imageFromBase64DataUrl(imageUrl: unknown): ImageContent | undefined {
	if (typeof imageUrl !== "string" || !imageUrl.toLowerCase().startsWith("data:")) return undefined;
	const separator = ";base64,";
	const separatorIndex = imageUrl.toLowerCase().indexOf(separator);
	if (separatorIndex < 5) return undefined;
	const mimeType = imageUrl.slice(5, separatorIndex);
	if (!mimeType.toLowerCase().startsWith("image/")) return undefined;
	return { type: "image", mimeType, data: imageUrl.slice(separatorIndex + separator.length) };
}

function modelBoundaryImageCacheKey(image: ImageContent, resize: ImageResizeOptions | undefined): string {
	const resizeKey = JSON.stringify([
		resize?.maxWidth,
		resize?.maxHeight,
		resize?.minDimension,
		resize?.maxBytes,
		resize?.jpegQuality,
	]);
	return `${resizeKey}:${image.mimeType}:${image.data.length}:${image.data.slice(0, 32)}:${image.data.slice(-32)}:${String(Bun.hash(image.data))}`;
}

async function memoizedStbImageNormalization(
	image: ImageContent,
	resize: ImageResizeOptions | undefined,
): Promise<ImageContent | null> {
	const key = modelBoundaryImageCacheKey(image, resize);
	const cached = modelBoundaryImageCache.get(key);
	if (cached !== undefined) return cached ? { ...image, ...cached } : null;

	let pending = modelBoundaryImageNormalizations.get(key);
	if (!pending) {
		const lease = reserveImageInput(Buffer.byteLength(image.data, "base64"));
		pending = resizeImage(image, { ...resize, excludeWebP: true })
			.then(resized => {
				if (resized.mimeType === "image/webp" || hasWebPMagic(resized.data)) {
					throw new Error("Image normalization retained WebP for an STB-backed model");
				}
				return { data: resized.data, mimeType: resized.mimeType };
			})
			.catch(error => {
				if (error instanceof ImageResourceLimitError) throw error;
				logger.warn("Dropping undecodable WebP for an STB-backed model", { error: String(error) });
				return null;
			})
			.then(payload => {
				modelBoundaryImageCache.set(key, payload);
				return payload;
			})
			.finally(() => {
				modelBoundaryImageNormalizations.delete(key);
				lease.release();
			});
		modelBoundaryImageNormalizations.set(key, pending);
	}
	const normalized = await pending;
	return normalized ? { ...image, ...normalized } : null;
}

async function normalizeNativeResponsesImagePart(part: unknown): Promise<unknown> {
	if (!isRecord(part) || part.type !== "input_image") return part;
	const image = imageFromBase64DataUrl(part.image_url);
	if (!image || !isWebPImage(image)) return part;
	const normalized = await memoizedStbImageNormalization(image, undefined);
	if (!normalized) return createNativeUndecodableStbImageOmission();
	return { ...part, image_url: `data:${normalized.mimeType};base64,${normalized.data}` };
}

async function normalizeNativeResponsesItem(item: Record<string, unknown>): Promise<Record<string, unknown>> {
	const normalizedItem = await normalizeNativeResponsesImagePart(item);
	if (normalizedItem !== item) return normalizedItem as Record<string, unknown>;
	if (!Array.isArray(item.content)) return item;

	let content: unknown[] | undefined;
	for (let index = 0; index < item.content.length; index++) {
		const part = item.content[index];
		const normalizedPart = await normalizeNativeResponsesImagePart(part);
		if (normalizedPart !== part) content ??= item.content.slice(0, index);
		content?.push(normalizedPart);
	}
	return content ? { ...item, content } : item;
}

async function normalizeNativeResponsesHistoryPayload(
	payload: ProviderPayload | undefined,
): Promise<ProviderPayload | undefined> {
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return payload;
	let items: Array<Record<string, unknown>> | undefined;
	for (let index = 0; index < payload.items.length; index++) {
		const item = payload.items[index]!;
		const normalizedItem = await normalizeNativeResponsesItem(item);
		if (normalizedItem !== item) items ??= payload.items.slice(0, index);
		items?.push(normalizedItem);
	}
	return items ? { ...payload, items } : payload;
}

export function modelLacksWebpSupport(
	model: Pick<Model, "provider" | "api" | "imageInputDecoder"> | undefined,
): boolean {
	if (!model) return false;
	return (
		model.imageInputDecoder === "stb" ||
		model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
	);
}

export function webpExclusionForModel(model: Pick<Model, "provider" | "api"> | undefined): true | undefined {
	return modelLacksWebpSupport(model) ? true : undefined;
}

interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;

	excludeWebP?: boolean;
}

interface LoadImageAttachmentInputOptions {
	image: ImageContent;
	label: string;
	uri: string;
	autoResize: boolean;
	maxBytes?: number;

	excludeWebP?: boolean;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export class ImageDecodeError extends Error {
	readonly source: string;

	constructor(source: string) {
		super(`Image could not be decoded: ${source} is corrupt or truncated.`);
		this.name = "ImageDecodeError";
		this.source = source;
	}
}

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * Decodes the image header so corrupt payloads are rejected here instead of being forwarded to
 * a provider as undecodable base64. Returns the intrinsic dimensions for callers that show them.
 */
export async function readDecodedImageDimensions(data: string | Uint8Array): Promise<ImageDimensions | undefined> {
	try {
		return await withImageDecode(data, async buffer => {
			const { width, height } = await new Bun.Image(buffer).metadata();
			if (!width || !height) return undefined;
			await decodeProbe(buffer);
			return { width, height };
		});
	} catch (error) {
		if (error instanceof ImageResourceLimitError) throw error;
		logger.debug("Image decode probe failed", { error: String(error) });
		return undefined;
	}
}

/**
 * Metadata reads only the header: a middle-elided PNG keeps its signature, header and trailer and still passes. A full
 * decode is the only check matching what vision backends accept; it terminates into a 1x1 raster so nothing full-size
 * is encoded.
 */
async function decodeProbe(buffer: Uint8Array): Promise<void> {
	await new Bun.Image(buffer).resize(1, 1).png().bytes();
}

/** Why an image cannot be decoded, or `null` when it decodes. Rethrows a `busy` resource error: no verdict yet. */
export async function imageDecodeFailureReason(image: ImageContent): Promise<string | null> {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return "invalid base64 image data";
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length === 0) return "empty image data";
	if (bytes.toString("base64").replace(/=+$/, "") !== image.data.replace(/=+$/, ""))
		return "invalid base64 image data";
	const detected = parseImageMetadata(bytes);
	const declared = image.mimeType.toLowerCase();
	if (detected && detected.mimeType !== (declared === "image/jpg" ? "image/jpeg" : declared)) {
		return `declared ${image.mimeType} but contains ${detected.mimeType}`;
	}
	try {
		await withImageDecode(bytes, buffer => decodeProbe(buffer));
		return null;
	} catch (error) {
		if (error instanceof ImageResourceLimitError && error.reason === "busy") throw error;
		return error instanceof Error ? error.message : String(error);
	}
}

export async function assertDecodableImage(data: string | Uint8Array, source: string): Promise<ImageDimensions> {
	const dimensions = await readDecodedImageDimensions(data);
	if (!dimensions) throw new ImageDecodeError(source);
	return dimensions;
}

export class UnsupportedImageConversionError extends Error {
	readonly mimeType: string;

	constructor(mimeType: string) {
		super(`Image conversion failed for unsupported model input type: ${mimeType}`);
		this.name = "UnsupportedImageConversionError";
		this.mimeType = mimeType;
	}
}

export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	return withImageDecode(image.data, async bytes => {
		const data = await new Bun.Image(bytes).png().toBase64();
		return { ...image, data, mimeType: "image/png" };
	});
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		return await convertImageToPng(image);
	} catch (error) {
		if (error instanceof ImageResourceLimitError) throw error;
		return null;
	}
}

interface NormalizeModelContextImagesOptions {
	model?: Model;
	resize?: ImageResizeOptions;
}

export async function normalizeModelContextImages(
	images: ImageContent[] | undefined,
	options?: NormalizeModelContextImagesOptions,
): Promise<ImageContent[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const excludesWebP = modelLacksWebpSupport(options?.model);
	const resize: ImageResizeOptions | undefined = excludesWebP
		? { ...options?.resize, excludeWebP: true }
		: options?.resize;
	const normalized: ImageContent[] = [];
	for (const image of images) {
		if (excludesWebP && isWebPImage(image)) {
			const converted = await memoizedStbImageNormalization(image, options?.resize);
			if (!converted) throw new UnsupportedImageConversionError(image.mimeType);
			normalized.push(converted);
			continue;
		}
		try {
			const resized = await resizeImage(image, resize);
			normalized.push({ ...image, data: resized.data, mimeType: resized.mimeType });
		} catch (error) {
			if (error instanceof ImageResourceLimitError) throw error;
			normalized.push(image);
		}
	}
	return normalized;
}

export async function normalizeModelContextMessages(messages: Message[], model: Model | undefined): Promise<Message[]> {
	if (!modelLacksWebpSupport(model)) return messages;
	let output: Message[] | undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]!;
		const hasNativePayload = message.role === "user" || message.role === "developer";
		const normalizedProviderPayload = hasNativePayload
			? await normalizeNativeResponsesHistoryPayload(message.providerPayload)
			: undefined;
		const providerPayloadChanged = hasNativePayload && normalizedProviderPayload !== message.providerPayload;
		let content: Array<(typeof message.content)[number]> | undefined;
		if (typeof message.content !== "string") {
			for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
				const part = message.content[partIndex]!;
				if (part.type !== "image" || !isWebPImage(part)) {
					content?.push(part);
					continue;
				}
				content ??= message.content.slice(0, partIndex);
				const normalized = await memoizedStbImageNormalization(part, undefined);
				content.push(normalized ?? createUndecodableStbImageOmission());
			}
		}
		if (!content && !providerPayloadChanged) continue;
		output ??= messages.slice();
		const normalizedMessage = { ...message, ...(content ? { content } : {}) } as Message;
		if (normalizedMessage.role === "user" || normalizedMessage.role === "developer") {
			if (providerPayloadChanged) {
				normalizedMessage.providerPayload = normalizedProviderPayload;
			} else if (content) {
				delete normalizedMessage.providerPayload;
			}
		}
		output[messageIndex] = normalizedMessage;
	}
	return output ?? messages;
}

export async function normalizeProviderContextImagesForModel(context: Context, model: Model): Promise<Context> {
	const messages = await normalizeModelContextMessages(context.messages, model);
	return messages === context.messages ? context : { ...context, messages };
}

/**
 * Resizing may legitimately fail (for example when no encoding gets under the size budget); in that
 * case the original bytes are kept. A decode failure is not recoverable and is reported instead.
 */
async function resizeImageOrKeepOriginal(
	image: ImageContent,
	options: ImageResizeOptions,
	source: string,
): Promise<ResizedImage | undefined> {
	try {
		const resized = await resizeImage(image, options);
		if (resized.decodeFailed) throw new ImageDecodeError(source);
		return resized;
	} catch (error) {
		if (error instanceof ImageDecodeError || error instanceof ImageResourceLimitError) throw error;
		logger.debug("Image resize failed; keeping the original bytes", { source, error: String(error) });
		return undefined;
	}
}

function formatImageFormat(sourceMimeType: string, sentMimeType: string): string {
	return sourceMimeType === sentMimeType ? sourceMimeType : `${sourceMimeType}, sent as ${sentMimeType}`;
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const file = Bun.file(resolvedPath);
	const stat = await file.stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const lease = reserveImageInput(stat.size);
	try {
		// A growing file cannot turn an admitted read into an unbounded allocation.
		const readLimit = Math.min(stat.size, maxBytes, MAX_IMAGE_INPUT_BYTES);
		const inputBuffer = new Uint8Array(await file.slice(0, readLimit + 1).arrayBuffer());
		if (inputBuffer.byteLength > maxBytes) {
			throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
		}

		if (inputBuffer.byteLength > stat.size) {
			throw new ImageResourceLimitError("oversized", "image file grew after admission; retry the read");
		}
		await assertDecodableImage(inputBuffer, resolvedPath);

		let outputData = Buffer.from(inputBuffer).toBase64();
		let outputMimeType = mimeType;
		let outputBytes = inputBuffer.byteLength;
		let dimensionNote: string | undefined;

		const shouldReencodeWebP = options.excludeWebP === true && mimeType === "image/webp";
		if (options.autoResize || shouldReencodeWebP) {
			const resized = await resizeImageOrKeepOriginal(
				{ type: "image", data: outputData, mimeType },
				{ excludeWebP: options.excludeWebP },
				resolvedPath,
			);
			if (resized) {
				outputData = resized.data;
				outputMimeType = resized.mimeType;
				outputBytes = resized.buffer.byteLength;
				dimensionNote = formatDimensionNote(resized);
			}
		}

		let textNote = `Read image file [${formatImageFormat(mimeType, outputMimeType)}]`;
		if (dimensionNote) {
			textNote += `\n${dimensionNote}`;
		}

		return {
			resolvedPath,
			mimeType: outputMimeType,
			data: outputData,
			textNote,
			dimensionNote,
			bytes: outputBytes,
		};
	} finally {
		lease.release();
	}
}

export async function loadImageAttachmentInput(
	options: LoadImageAttachmentInputOptions,
): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	if (!SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(options.image.mimeType)) {
		return null;
	}

	const inputBytes = Buffer.byteLength(options.image.data, "base64");
	if (inputBytes > maxBytes) {
		throw new ImageInputTooLargeError(inputBytes, maxBytes);
	}

	await assertDecodableImage(options.image.data, options.label);

	let outputData = options.image.data;
	let outputMimeType = options.image.mimeType;
	let outputBytes = inputBytes;
	let dimensionNote: string | undefined;

	const shouldReencodeWebP = options.excludeWebP === true && options.image.mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		const resized = await resizeImageOrKeepOriginal(
			options.image,
			{ excludeWebP: options.excludeWebP },
			options.label,
		);
		if (resized) {
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		}
	}

	let textNote = `Read image attachment ${options.label} [${formatImageFormat(options.image.mimeType, outputMimeType)}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath: options.uri,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}
