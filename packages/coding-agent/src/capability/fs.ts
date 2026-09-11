import * as fs from "node:fs";
import * as path from "node:path";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";

const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const DIRENT_ENTRY_OVERHEAD_BYTES = 64;

function cacheValueBytes(value: string | null): number {
	return Math.max(1, value === null ? 1 : Buffer.byteLength(value, "utf8"));
}

function dirEntriesBytes(entries: fs.Dirent[]): number {
	let bytes = 0;
	for (const entry of entries) {
		bytes += DIRENT_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(entry.name, "utf8");
	}
	return Math.max(1, bytes);
}

const contentCache = new LRUCache<string, string | null>({
	max: MAX_CACHE_ENTRIES,
	maxSize: MAX_CACHE_BYTES,
	maxEntrySize: MAX_CACHE_BYTES,
	sizeCalculation: value => cacheValueBytes(value),
});

const dirCache = new LRUCache<string, fs.Dirent[]>({
	max: MAX_CACHE_ENTRIES,
	maxSize: MAX_CACHE_BYTES,
	maxEntrySize: MAX_CACHE_BYTES,
	sizeCalculation: entries => dirEntriesBytes(entries),
});

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	const cached = contentCache.get(abs);
	if (cached !== undefined) return cached;

	try {
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			contentCache.set(abs, null);
			return null;
		}
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		contentCache.set(abs, null);
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	const cached = dirCache.get(abs);
	if (cached !== undefined) return cached;

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export interface CacheStats {
	content: number;
	dir: number;
	contentBytes: number;
	dirBytes: number;
}

export function cacheStats(): CacheStats {
	return {
		content: contentCache.size,
		dir: dirCache.size,
		contentBytes: contentCache.calculatedSize,
		dirBytes: dirCache.calculatedSize,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
