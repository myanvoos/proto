import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getProjectDir, isEnoent, readImageMetadata } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { resolveReadPath } from "../tools/path-utils";
import { formatBytes } from "../tools/render-utils";
import { ImageDecodeError, loadImageInput } from "../utils/image-loading";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-resources";
import { CONVERTIBLE_EXTENSIONS, convertFileWithMarkit } from "../utils/markit";

const MAX_CLI_TEXT_BYTES = 5 * 1024 * 1024;

interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

interface ProcessFileOptions {
	autoResizeImages?: boolean;
}

export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const absolutePath = path.resolve(resolveReadPath(fileArg, getProjectDir()));

		const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
		if (!stat) {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const maxBytes = mimeType ? MAX_IMAGE_INPUT_BYTES : MAX_CLI_TEXT_BYTES;
		if (stat.size > maxBytes) {
			console.error(
				chalk.yellow(`Warning: Skipping file contents (too large: ${formatBytes(stat.size)}): ${absolutePath}`),
			);
			text += `<file name="${absolutePath}">(skipped: too large, ${formatBytes(stat.size)})</file>\n`;
			continue;
		}

		if (mimeType) {
			try {
				const loaded = await loadImageInput({
					path: absolutePath,
					cwd: getProjectDir(),
					resolvedPath: absolutePath,
					detectedMimeType: mimeType,
					autoResize: autoResizeImages,
				});
				if (loaded) {
					images.push({ type: "image", mimeType: loaded.mimeType, data: loaded.data });
					text += `<file name="${absolutePath}">${loaded.dimensionNote ?? ""}</file>\n`;
				}
			} catch (error) {
				if (error instanceof ImageDecodeError) {
					console.error(chalk.red(`Error: Image is corrupt or truncated: ${absolutePath}`));
					process.exit(1);
				}
				if (isEnoent(error)) {
					console.error(chalk.red(`Error: File not found: ${absolutePath}`));
					process.exit(1);
				}
				throw error;
			}
			continue;
		}

		let buffer: Uint8Array;
		try {
			buffer = await Bun.file(absolutePath).bytes();
		} catch (err) {
			if (isEnoent(err)) {
				console.error(chalk.red(`Error: File not found: ${absolutePath}`));
				process.exit(1);
			}
			throw err;
		}
		if (buffer.length === 0) {
			continue;
		}

		if (CONVERTIBLE_EXTENSIONS.has(ext)) {
			const result = await convertFileWithMarkit(absolutePath);
			if (result.ok) {
				text += `<file name="${absolutePath}">\n${result.content}\n</file>\n`;
			} else {
				text += `<file name="${absolutePath}">[Cannot read ${ext} file: ${result.error || "conversion failed"}]</file>\n`;
			}
		} else {
			try {
				const content = new TextDecoder().decode(buffer);
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
