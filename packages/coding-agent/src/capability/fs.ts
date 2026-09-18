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

const contentInFlight = new Map<string, Promise<string | null>>();
const dirInFlight = new Map<string, Promise<fs.Dirent[]>>();

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	const cached = contentCache.get(abs);
	if (cached !== undefined) return cached;

	const existing = contentInFlight.get(abs);
	if (existing) return await existing;

	const pending = (async (): Promise<string | null> => {
		try {
			const stats = await fs.promises.stat(abs);
			if (!stats.isFile()) return null;
			return await Bun.file(abs).text();
		} catch {
			return null;
		}
	})();
	contentInFlight.set(abs, pending);

	try {
		const content = await pending;
		if (contentInFlight.get(abs) === pending) contentCache.set(abs, content);
		return content;
	} finally {
		if (contentInFlight.get(abs) === pending) contentInFlight.delete(abs);
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	const cached = dirCache.get(abs);
	if (cached !== undefined) return cached;

	const existing = dirInFlight.get(abs);
	if (existing) return await existing;

	const pending = fs.promises.readdir(abs, { withFileTypes: true }).catch((): fs.Dirent[] => []);
	dirInFlight.set(abs, pending);

	try {
		const entries = await pending;
		if (dirInFlight.get(abs) === pending) dirCache.set(abs, entries);
		return entries;
	} finally {
		if (dirInFlight.get(abs) === pending) dirInFlight.delete(abs);
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
	contentInFlight.clear();
	dirInFlight.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	contentInFlight.delete(abs);
	dirInFlight.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
		dirInFlight.delete(parent);
	}
}
