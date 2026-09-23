import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { formatAge, formatBytes, isProbablyBinary, readImageMetadata, truncateHeadBytes } from "@oh-my-pi/pi-utils";
import type { FileMentionMessage } from "../session/messages";
import { DEFAULT_MAX_BYTES, formatHeadTruncationNotice, truncateHead } from "../session/streaming-output";
import { resolveReadPath } from "../tools/path-utils";
import { readDecodedImageDimensions } from "./image-loading";
import { formatDimensionNote, resizeImage } from "./image-resize";

const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const DEFAULT_DIR_LIMIT = 500;

const MAX_AUTO_READ_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_AUTO_READ_IMAGE_BYTES = 25 * 1024 * 1024;

function isMentionBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	return MENTION_BOUNDARY_REGEX.test(text[index - 1]);
}

function sanitizeMentionPath(rawPath: string): string | null {
	let cleaned = rawPath.trim();
	cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.trim();
	return cleaned.length > 0 ? cleaned : null;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await Bun.file(filePath).stat();
		return true;
	} catch {
		return false;
	}
}

async function resolveMentionPath(filePath: string, cwd: string): Promise<string | null> {
	const absolutePath = resolveReadPath(filePath, cwd);
	return (await pathExists(absolutePath)) ? filePath : null;
}

function buildTextOutput(textContent: string): { output: string; lineCount: number } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const truncation = truncateHead(textContent);

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);
		let outputText = snippet.text;

		if (outputText.length > 0) {
			outputText += `\n\n[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				DEFAULT_MAX_BYTES,
			)} limit. Showing first ${formatBytes(snippet.bytes)} of the line.]`;
		} else {
			outputText = `[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				DEFAULT_MAX_BYTES,
			)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		return { output: outputText, lineCount: totalFileLines };
	}

	let outputText = truncation.content;

	if (truncation.truncated) {
		outputText += formatHeadTruncationNotice(truncation, { startLine: 1, totalFileLines });
	}

	return { output: outputText, lineCount: totalFileLines };
}

interface RankedDirectoryEntry {
	entry: string;
	sortKey: string;
	scanIndex: number;
}

function compareDirectoryEntries(a: RankedDirectoryEntry, b: RankedDirectoryEntry): number {
	const keyComparison = a.sortKey.localeCompare(b.sortKey);
	return keyComparison === 0 ? a.scanIndex - b.scanIndex : keyComparison;
}

function siftUpMaxHeap(heap: RankedDirectoryEntry[], startIndex: number): void {
	let index = startIndex;
	while (index > 0) {
		const parentIndex = Math.floor((index - 1) / 2);
		const parent = heap[parentIndex];
		const current = heap[index];
		if (!parent || !current || compareDirectoryEntries(parent, current) >= 0) return;
		heap[parentIndex] = current;
		heap[index] = parent;
		index = parentIndex;
	}
}

function siftDownMaxHeap(heap: RankedDirectoryEntry[]): void {
	let index = 0;
	while (true) {
		const leftIndex = index * 2 + 1;
		if (leftIndex >= heap.length) return;

		const rightIndex = leftIndex + 1;
		let largerChildIndex = leftIndex;
		if (rightIndex < heap.length && compareDirectoryEntries(heap[rightIndex]!, heap[leftIndex]!) > 0) {
			largerChildIndex = rightIndex;
		}

		const current = heap[index];
		const largerChild = heap[largerChildIndex];
		if (!current || !largerChild || compareDirectoryEntries(current, largerChild) >= 0) return;
		heap[index] = largerChild;
		heap[largerChildIndex] = current;
		index = largerChildIndex;
	}
}

async function buildDirectoryListing(absolutePath: string): Promise<{ output: string; lineCount: number }> {
	const topEntries: RankedDirectoryEntry[] = [];
	let scannedEntryCount = 0;
	try {
		for await (const entry of new Bun.Glob("*").scan({ cwd: absolutePath, dot: true, onlyFiles: false })) {
			const candidate: RankedDirectoryEntry = {
				entry,
				sortKey: entry.toLowerCase(),
				scanIndex: scannedEntryCount++,
			};
			if (topEntries.length < DEFAULT_DIR_LIMIT) {
				topEntries.push(candidate);
				siftUpMaxHeap(topEntries, topEntries.length - 1);
			} else if (compareDirectoryEntries(candidate, topEntries[0]!) < 0) {
				topEntries[0] = candidate;
				siftDownMaxHeap(topEntries);
			}
		}
	} catch {
		return { output: "(empty directory)", lineCount: 1 };
	}

	const entries = topEntries.sort(compareDirectoryEntries).map(({ entry }) => entry);
	const results: string[] = [];
	const entryLimitReached = scannedEntryCount > DEFAULT_DIR_LIMIT;

	for (const entry of entries) {
		const fullPath = path.join(absolutePath, entry);
		let suffix = "";
		let age = "";

		try {
			const stat = await Bun.file(fullPath).stat();
			if (stat.isDirectory()) {
				suffix = "/";
			}
			const ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
			age = formatAge(ageSeconds);
		} catch {
			continue;
		}

		const line = age ? `${entry}${suffix} (${age})` : `${entry}${suffix}`;
		results.push(line);
	}

	if (results.length === 0) {
		return { output: "(empty directory)", lineCount: 1 };
	}

	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;

	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${DEFAULT_DIR_LIMIT} entries limit reached. Use limit=${DEFAULT_DIR_LIMIT * 2} for more`);
	}
	if (truncation.truncated) {
		notices.push(`${formatBytes(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}

	return { output, lineCount: output.split("\n").length };
}

export function extractFileMentions(text: string): string[] {
	const matches = [...text.matchAll(FILE_MENTION_REGEX)];
	const mentions: string[] = [];

	for (const match of matches) {
		const index = match.index ?? 0;
		if (!isMentionBoundary(text, index)) continue;

		const rawPath = match[1] ?? match[2] ?? match[3];
		if (!rawPath) continue;

		const cleaned = match[1] !== undefined || match[2] !== undefined ? rawPath.trim() : sanitizeMentionPath(rawPath);
		if (!cleaned) continue;

		mentions.push(cleaned);
	}

	return [...new Set(mentions)];
}

export async function generateFileMentionMessages(
	filePaths: string[],
	cwd: string,
	options?: { autoResizeImages?: boolean },
): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const autoResizeImages = options?.autoResizeImages ?? true;

	const files: FileMentionMessage["files"] = [];

	for (const filePath of filePaths) {
		const resolvedPath = await resolveMentionPath(filePath, cwd);
		if (!resolvedPath) {
			continue;
		}
		const absolutePath = resolveReadPath(resolvedPath, cwd);
		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) {
				const { output, lineCount } = await buildDirectoryListing(absolutePath);
				files.push({ path: resolvedPath, content: output, lineCount });
				continue;
			}

			const imageMetadata = await readImageMetadata(absolutePath);
			const mimeType = imageMetadata?.mimeType;
			if (mimeType) {
				if (stat.size > MAX_AUTO_READ_IMAGE_BYTES) {
					files.push({
						path: resolvedPath,
						content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
						byteSize: stat.size,
						skippedReason: "tooLarge",
					});
					continue;
				}
				const buffer = await fs.readFile(absolutePath);
				if (buffer.length === 0) {
					continue;
				}

				const base64Content = buffer.toBase64();
				// An undecodable image is reported instead of being attached: the provider cannot use it
				// and the user would otherwise see an empty preview.
				if (!(await readDecodedImageDimensions(buffer))) {
					files.push({
						path: resolvedPath,
						content: "(skipped auto-read: image is corrupt or truncated)",
						byteSize: stat.size,
						skippedReason: "undecodableImage",
					});
					continue;
				}
				let image: ImageContent = { type: "image", mimeType, data: base64Content };
				let dimensionNote: string | undefined;

				if (autoResizeImages) {
					try {
						const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
						dimensionNote = formatDimensionNote(resized);
						image = {
							type: "image",
							mimeType: resized.mimeType,
							data: resized.data,
						};
					} catch {
						image = { type: "image", mimeType, data: base64Content };
					}
				}

				files.push({ path: resolvedPath, content: dimensionNote ?? "", image });
				continue;
			}

			if (stat.size > MAX_AUTO_READ_TEXT_BYTES) {
				files.push({
					path: resolvedPath,
					content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "tooLarge",
				});
				continue;
			}
			if (await isProbablyBinary(absolutePath)) {
				files.push({
					path: resolvedPath,
					content: `(skipped auto-read: binary file, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "binary",
				});
				continue;
			}

			const content = await Bun.file(absolutePath).text();
			const { output, lineCount } = buildTextOutput(content);
			files.push({ path: resolvedPath, content: output, lineCount });
		} catch {}
	}

	if (files.length === 0) return [];

	const message: FileMentionMessage = {
		role: "fileMention",
		files,
		timestamp: Date.now(),
	};

	return [message];
}
