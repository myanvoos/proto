import * as fs from "node:fs/promises";
import type {
	Context,
	ImageContent,
	Message,
	Model,
	OpenAIResponsesHistoryPayload,
	TextContent,
} from "@oh-my-pi/pi-ai";
import { formatBytes, isRecord, logger, readImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveReadPath } from "../tools/path-utils";
import type { ImageResizeOptions } from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
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

function loadImageResize() {
	return import("./image-resize");
}

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
		pending = loadImageResize()
			.then(({ resizeImage }) => resizeImage(image, { ...resize, excludeWebP: true }))
			.then(resized => {
				if (resized.mimeType === "image/webp" || hasWebPMagic(resized.data)) {
					throw new Error("Image normalization retained WebP for an STB-backed model");
				}
				return { data: resized.data, mimeType: resized.mimeType };
			})
			.catch(error => {
				logger.warn("Dropping undecodable WebP for an STB-backed model", { error: String(error) });
				return null;
			})
			.then(payload => {
				modelBoundaryImageCache.set(key, payload);
				return payload;
			})
			.finally(() => modelBoundaryImageNormalizations.delete(key));
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
	payload: OpenAIResponsesHistoryPayload | undefined,
): Promise<OpenAIResponsesHistoryPayload | undefined> {
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

export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		return await convertImageToPng(image);
	} catch {
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
	const { resizeImage } = await loadImageResize();
	for (const image of images) {
		try {
			if (excludesWebP && isWebPImage(image)) {
				const converted = await memoizedStbImageNormalization(image, options?.resize);

				normalized.push(converted ?? image);
				continue;
			}
			const resized = await resizeImage(image, resize);
			normalized.push({ ...image, data: resized.data, mimeType: resized.mimeType });
		} catch {
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

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	let outputData = Buffer.from(inputBuffer).toBase64();
	let outputMimeType = mimeType;
	let outputBytes = inputBuffer.byteLength;
	let dimensionNote: string | undefined;
	const { formatDimensionNote, resizeImage } = await loadImageResize();

	const shouldReencodeWebP = options.excludeWebP === true && mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(
				{ type: "image", data: outputData, mimeType },
				{ excludeWebP: options.excludeWebP },
			);
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {}
	}

	let textNote = `Read image file [${outputMimeType}]`;
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

	let outputData = options.image.data;
	let outputMimeType = options.image.mimeType;
	let outputBytes = inputBytes;
	let dimensionNote: string | undefined;
	const { formatDimensionNote, resizeImage } = await loadImageResize();

	const shouldReencodeWebP = options.excludeWebP === true && options.image.mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(options.image, { excludeWebP: options.excludeWebP });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {}
	}

	let textNote = `Read image attachment ${options.label} [${outputMimeType}]`;
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
