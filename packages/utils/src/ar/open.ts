import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatBytes } from "../format";
import { UTF8_DECODER } from "./bytes";
import { ArchiveError } from "./error";
import { type ArchiveLimits, assertInMemorySize, DEFAULT_ARCHIVE_LIMITS } from "./limits";
import { normalizeArchiveLookupPath } from "./paths";
import { ArchiveReader } from "./reader";
import { ARCHIVE_EXTENSION_ALTERNATION, archiveFormatFromPath, formatReaderFor } from "./registry";
import { type ByteSource, fileByteSource, memoryByteSource } from "./source";
import type {
	ArchiveDirectoryEntry,
	ArchiveFormat,
	ArchiveMemberContent,
	ArchivePathCandidate,
	ArchiveSource,
	FormatReadOptions,
} from "./types";

const ENCODER = new TextEncoder();

export interface OpenArchiveOptions {
	limits?: Partial<ArchiveLimits>;
}

interface ResolvedArchiveSource {
	source: ByteSource;
	format: ArchiveFormat;
	archivePath?: string;
}

function resolveSource(input: ArchiveSource): ResolvedArchiveSource {
	if (typeof input !== "string") {
		if ("bytes" in input) {
			return { source: memoryByteSource(input.bytes), format: input.format };
		}
		if ("source" in input) {
			return { source: input.source, format: input.format, archivePath: input.path };
		}
		const format = input.format;
		return { source: fileByteSource(input.path), format, archivePath: input.path };
	}

	const format = archiveFormatFromPath(input);
	if (!format) {
		throw new ArchiveError(`Unsupported archive format: ${input}`);
	}
	return { source: fileByteSource(input), format, archivePath: input };
}

export async function openArchive(input: ArchiveSource, options: OpenArchiveOptions = {}): Promise<ArchiveReader> {
	const { source, format, archivePath } = resolveSource(input);
	const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
	const readOptions: FormatReadOptions = { limits, archivePath };
	const entries = await formatReaderFor(format)(source, readOptions);
	return new ArchiveReader(format, entries, limits);
}

export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = new RegExp(`\\.(?:${ARCHIVE_EXTENSION_ALTERNATION})(?=(?::|$))`, "gi");
	const seen = new Set<string>();
	const candidates: ArchivePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = pattern.exec(normalized);
		if (match === null) {
			break;
		}
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}

	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

export function formatArchiveEntryLines(entries: readonly ArchiveDirectoryEntry[]): string[] {
	return entries.map(entry => {
		if (entry.isDirectory) return `${entry.name}/`;

		const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
		return `${entry.name}${sizeSuffix}`;
	});
}

export async function listArchiveRoot(
	bytes: Uint8Array,
	format: ArchiveFormat,
	opts: { limit?: number } = {},
): Promise<string> {
	const archive = await openArchive({ bytes, format });
	const entries = archive.listDirectory("");
	const limitedEntries = opts.limit !== undefined && opts.limit > 0 ? entries.slice(0, opts.limit) : entries;
	const lines = formatArchiveEntryLines(limitedEntries);
	return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
}

export async function readArchiveEntries(
	input: ArchiveSource,
	options: OpenArchiveOptions = {},
): Promise<Map<string, Uint8Array>> {
	const archive = await openArchive(input, options);
	const entries = new Map<string, Uint8Array>();
	let total = 0;
	for (const entry of archive.indexEntries()) {
		if (entry.isDirectory) continue;

		const file = await archive.readFile(entry.path);
		entries.set(entry.path, file.bytes);
		total += file.bytes.byteLength;
		assertInMemorySize(total, archive.limits);
	}
	return entries;
}

export async function memberContentToBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
	if (typeof content === "string") return ENCODER.encode(content);
	if (content instanceof Uint8Array) return content;
	return new Uint8Array(await content.arrayBuffer());
}

export function archiveEntryText(entries: ReadonlyMap<string, Uint8Array>, entryPath: string): string | undefined {
	const bytes = entries.get(entryPath);
	return bytes ? UTF8_DECODER.decode(bytes) : undefined;
}

export async function extractArchive(
	input: ArchiveSource,
	destDir: string,
	options: OpenArchiveOptions = {},
): Promise<number> {
	const archive = await openArchive(input, options);
	const extractRoot = path.resolve(destDir);
	await fs.mkdir(extractRoot, { recursive: true });
	let count = 0;

	const files: { path: string; mode?: number }[] = [];
	const links: { path: string; target: string }[] = [];
	for (const entry of archive.indexEntries()) {
		const outputPath = path.resolve(extractRoot, entry.path);
		if (outputPath !== extractRoot && !outputPath.startsWith(extractRoot + path.sep)) {
			throw new ArchiveError(`Archive entry escapes extraction dir: ${entry.path}`);
		}
		if (entry.isDirectory) {
			if (entry.storage?.type !== "link") {
				await fs.mkdir(outputPath, { recursive: true });
				count++;
			}
			continue;
		}
		if (entry.storage?.type === "link") {
			links.push({ path: entry.path, target: entry.storage.targetPath });
			continue;
		}
		files.push({ path: entry.path, mode: entry.mode });
	}

	for (const file of files) {
		const extracted = await archive.readFile(file.path);
		const outputPath = path.resolve(extractRoot, file.path);
		await Bun.write(outputPath, extracted.bytes);
		const permissions = (file.mode ?? 0) & 0o777;
		if (permissions) await fs.chmod(outputPath, permissions);
		count++;
	}

	for (const link of links) {
		const outputPath = path.resolve(extractRoot, link.path);

		const normalizedTarget = normalizeArchiveLookupPath(link.target);
		if (normalizedTarget === undefined) {
			throw new ArchiveError(`Archive symlink escapes extraction dir: ${link.path} -> ${link.target}`);
		}
		const resolvedTarget = path.resolve(extractRoot, normalizedTarget);
		if (resolvedTarget !== extractRoot && !resolvedTarget.startsWith(extractRoot + path.sep)) {
			throw new ArchiveError(`Archive symlink escapes extraction dir: ${link.path} -> ${link.target}`);
		}
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.symlink(path.relative(path.dirname(outputPath), resolvedTarget) || ".", outputPath);
		count++;
	}

	return count;
}
