import * as fs from "node:fs/promises";
import {
	formatBytes,
	readMediaMetadata,
	SUPPORTED_AUDIO_MIME_TYPES,
	SUPPORTED_IMAGE_MIME_TYPES,
	SUPPORTED_VIDEO_MIME_TYPES,
} from "@oh-my-pi/pi-utils";
import { resolveReadPath } from "../tools/path-utils";

export const MAX_MEDIA_INPUT_BYTES = 20 * 1024 * 1024;

export class MediaInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Media file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "MediaInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export type MediaKind = "image" | "audio" | "video";

export interface LoadedMediaFileInput {
	resolvedPath: string;
	kind: "audio" | "video";
	mimeType: string;
	data: string;
	bytes: number;
}

export function supportedMediaFormats(): string {
	return [
		`image: ${[...SUPPORTED_IMAGE_MIME_TYPES].map(mime => mime.slice("image/".length).toUpperCase()).join(", ")}`,
		`audio: ${[...SUPPORTED_AUDIO_MIME_TYPES].map(mime => mime.slice("audio/".length).toUpperCase()).join(", ")}`,
		`video: ${[...SUPPORTED_VIDEO_MIME_TYPES].map(mime => mime.slice("video/".length).toUpperCase()).join(", ")}`,
	].join("; ");
}

export async function loadMediaFileInput(options: {
	path: string;
	cwd: string;
	maxBytes?: number;
}): Promise<LoadedMediaFileInput | null> {
	const maxBytes = options.maxBytes ?? MAX_MEDIA_INPUT_BYTES;
	const resolvedPath = resolveReadPath(options.path, options.cwd);
	const metadata = await readMediaMetadata(resolvedPath);
	if (!metadata) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new MediaInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new MediaInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	return {
		resolvedPath,
		kind: metadata.kind,
		mimeType: metadata.mimeType,
		data: Buffer.from(inputBuffer).toBase64(),
		bytes: inputBuffer.byteLength,
	};
}
