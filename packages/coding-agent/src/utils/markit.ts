import * as path from "node:path";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ConversionResult, Markit, StreamInfo } from "../markit";
import { ToolAbortError } from "../tools/tool-errors";
import {
	type MarkitConversionCacheStatus,
	markitConversionCacheKey,
	readMarkitConversionCache,
	writeMarkitConversionCache,
} from "./markit-cache";

export const CONVERTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".epub"]);

interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
	cache?: MarkitConversionCacheStatus;
}

interface MarkitFileConversionOptions {
	imageDir?: string;
}

let markit: () => Markit | Promise<Markit> = async () => {
	const promise = import("../markit").then(({ Markit }) => {
		const instance = new Markit();
		markit = () => instance;
		return instance;
	});
	markit = () => promise;
	return promise;
};

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	if (!trimmed) return ".bin";
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.trim();
	}
	return "Conversion failed";
}

async function runMarkitConversion<T>(task: (markit: Markit) => Promise<T>, signal?: AbortSignal): Promise<T> {
	try {
		const instance = await markit();
		return signal ? await untilAborted(signal, () => task(instance)) : await task(instance);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) {
		return { content: markdown, ok: true };
	}

	return { content: "", ok: false, error: "Conversion produced no output" };
}

function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ToolAbortError();
}

async function runCachedBufferConversion(
	bytes: Uint8Array,
	streamInfo: StreamInfo,
	signal?: AbortSignal,
	cacheEnabled = true,
): Promise<MarkitConversionResult> {
	const cacheKey = cacheEnabled
		? markitConversionCacheKey(bytes, streamInfo.extension ?? streamInfo.mimetype ?? ".bin")
		: undefined;

	if (cacheKey) {
		throwIfAborted(signal);
		const cached = await readMarkitConversionCache(cacheKey);
		throwIfAborted(signal);
		if (cached.status === "hit") {
			return { content: cached.content, ok: true, cache: "hit" };
		}
	}

	throwIfAborted(signal);
	let result: ConversionResult;
	try {
		result = await runMarkitConversion(markit => markit.convert(toBuffer(bytes), streamInfo), signal);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return { content: "", ok: false, error: normalizeError(error), cache: cacheEnabled ? "miss" : "skipped" };
	}

	const finalized = finalizeConversion(result.markdown);
	if (finalized.ok && cacheKey) {
		await writeMarkitConversionCache(cacheKey, finalized.content);
	}
	return { ...finalized, cache: cacheEnabled ? "miss" : "skipped" };
}

export async function convertFileWithMarkit(
	filePath: string,
	signal?: AbortSignal,
	options?: MarkitFileConversionOptions,
): Promise<MarkitConversionResult> {
	if (options?.imageDir) {
		try {
			const result = await runMarkitConversion(
				markit => markit.convertFile(filePath, { imageDir: options.imageDir }),
				signal,
			);
			return { ...finalizeConversion(result.markdown), cache: "skipped" };
		} catch (error) {
			if (error instanceof ToolAbortError) {
				throw error;
			}
			return { content: "", ok: false, error: normalizeError(error), cache: "skipped" };
		}
	}

	throwIfAborted(signal);
	let bytes: Uint8Array;
	try {
		bytes = await untilAborted(signal, () => Bun.file(filePath).bytes());
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
		return { content: "", ok: false, error: normalizeError(error), cache: "miss" };
	}
	const streamInfo: StreamInfo = {
		localPath: filePath,
		extension: path.extname(filePath).toLowerCase(),
		filename: path.basename(filePath),
	};
	return runCachedBufferConversion(bytes, streamInfo, signal, true);
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
	options?: { useCache?: boolean },
): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	const streamInfo: StreamInfo = {
		extension: normalizedExtension,
		filename: `input${normalizedExtension}`,
	};
	return runCachedBufferConversion(buffer, streamInfo, signal, options?.useCache ?? true);
}
