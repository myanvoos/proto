import { LRUCache } from "../lru";
import { ArchiveError } from "./error";

export interface ByteSource {
	readonly size: number;
	read(start: number, end: number): Promise<Uint8Array>;
}

export function assertValidRange(start: number, end: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new ArchiveError("Invalid archive range");
	}
}

export function readMemoryRange(buffer: Uint8Array, start: number, end: number): Uint8Array {
	assertValidRange(start, end);
	if (end > buffer.byteLength) {
		throw new ArchiveError("Invalid archive: truncated data");
	}
	return buffer.subarray(start, end);
}

export function memoryByteSource(buffer: Uint8Array): ByteSource {
	return {
		size: buffer.byteLength,
		async read(start, end) {
			return readMemoryRange(buffer, start, end);
		},
	};
}

export function fileByteSource(filePath: string): ByteSource {
	const file = Bun.file(filePath);
	const size = file.size;
	if (!Number.isSafeInteger(size)) {
		throw new ArchiveError("Archive is too large to read safely");
	}
	return {
		size,
		async read(start, end) {
			assertValidRange(start, end);
			const bytes = await file.slice(start, end).bytes();
			if (bytes.byteLength !== end - start) {
				throw new ArchiveError("Invalid archive: truncated data");
			}
			return bytes;
		},
	};
}

export async function readAllBytes(source: ByteSource): Promise<Uint8Array> {
	return source.read(0, source.size);
}

export interface HttpByteSourceOptions {
	headers?: Record<string, string>;

	fetch?: typeof fetch;

	maxFallbackBytes?: number;
}

const HTTP_FALLBACK_CAP = 256 * 1024 * 1024;

export async function httpByteSource(url: string | URL, options: HttpByteSourceOptions = {}): Promise<ByteSource> {
	const doFetch = options.fetch ?? fetch;
	const headers = { ...options.headers, range: "bytes=0-0" };
	const probe = await doFetch(url, { headers });
	if (probe.status === 200) {
		const cap = options.maxFallbackBytes ?? HTTP_FALLBACK_CAP;
		const declared = Number(probe.headers.get("content-length") ?? 0);
		if (declared > cap) {
			throw new ArchiveError(
				`Remote archive is too large to buffer without range support (${declared} > ${cap} bytes)`,
			);
		}
		const bytes = new Uint8Array(await probe.arrayBuffer());
		if (bytes.byteLength > cap) {
			throw new ArchiveError(`Remote archive is too large to buffer without range support (> ${cap} bytes)`);
		}
		return memoryByteSource(bytes);
	}
	if (probe.status !== 206) {
		await probe.body?.cancel();
		throw new ArchiveError(`Remote archive request failed (HTTP ${probe.status})`);
	}
	await probe.body?.cancel();

	const contentRange = probe.headers.get("content-range");
	const total = contentRange ? Number(/\/(\d+)$/.exec(contentRange)?.[1]) : Number.NaN;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new ArchiveError("Remote archive did not report a valid size in Content-Range");
	}
	return {
		size: total,
		async read(start, end) {
			assertValidRange(start, end);
			if (start === end) return new Uint8Array(0);
			const response = await doFetch(url, {
				headers: { ...options.headers, range: `bytes=${start}-${end - 1}` },
			});
			if (response.status !== 206) {
				await response.body?.cancel();
				throw new ArchiveError(`Remote archive range request failed (HTTP ${response.status})`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength !== end - start) {
				throw new ArchiveError("Invalid archive: truncated data");
			}
			return bytes;
		},
	};
}

export interface CachingByteSourceOptions {
	blockSize?: number;

	maxBlocks?: number;
}

export function cachingByteSource(source: ByteSource, options: CachingByteSourceOptions = {}): ByteSource {
	const blockSize = options.blockSize ?? 256 * 1024;
	const blocks = new LRUCache<number, Promise<Uint8Array>>({ max: options.maxBlocks ?? 64 });
	const readBlock = (index: number): Promise<Uint8Array> => {
		const cached = blocks.get(index);
		if (cached) return cached;
		const start = index * blockSize;
		const pending = source.read(start, Math.min(start + blockSize, source.size));
		blocks.set(index, pending);
		pending.catch(() => blocks.delete(index));
		return pending;
	};
	return {
		size: source.size,
		async read(start, end) {
			assertValidRange(start, end);
			if (end > source.size) {
				throw new ArchiveError("Invalid archive: truncated data");
			}
			if (start === end) return new Uint8Array(0);
			const firstBlock = Math.floor(start / blockSize);
			const lastBlock = Math.floor((end - 1) / blockSize);
			if (lastBlock - firstBlock > 1) return source.read(start, end);
			const out = new Uint8Array(end - start);
			for (let index = firstBlock; index <= lastBlock; index++) {
				const block = await readBlock(index);
				const blockStart = index * blockSize;
				const from = Math.max(start, blockStart);
				const to = Math.min(end, blockStart + block.byteLength);
				if (to < Math.min(end, blockStart + blockSize)) {
					throw new ArchiveError("Invalid archive: truncated data");
				}
				out.set(block.subarray(from - blockStart, to - blockStart), from - start);
			}
			return out;
		},
	};
}
