import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger, peekFileEnds, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { type FileLockHandle, tryAcquireFileLockSync } from "@oh-my-pi/pi-utils/file-lock";
import { overlayTitleSlotContent, type SessionTitleUpdate } from "./session-title-slot";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
}

export interface SessionStorageWriter {
	append(line: string): Promise<void>;

	appendSync?(line: string): void;

	flush(): Promise<void>;

	flushSync?(): void;

	isOpen(): boolean;
	close(): Promise<void>;
	getError(): Error | undefined;
}

/** Optimistic precondition for replacing a session file. */
export interface SessionStorageWriteOptions {
	/** Byte length the writer last loaded or durably wrote, or `null` when the target must not exist. */
	expectedSize?: number | null;
}

/** The session changed after a writer loaded it, so replacing it would discard another writer's durable entries. */
export class SessionWriteConflictError extends Error {
	readonly path: string;
	readonly expectedSize: number | null;
	readonly actualSize: number | null;

	constructor(path: string, expectedSize: number | null, actualSize: number | null) {
		const expected = expectedSize === null ? "missing" : `${expectedSize} bytes`;
		const actual = actualSize === null ? "missing" : `${actualSize} bytes`;
		super(`Session file changed before rewrite: ${path} (expected ${expected}, found ${actual}).`);
		this.name = "SessionWriteConflictError";
		this.path = path;
		this.expectedSize = expectedSize;
		this.actualSize = actualSize;
	}
}

/**
 * Guards applied by {@link SessionStorage.writeTextAtomic}. The backend checks `expectedSize` and calls
 * `commitGuard()` synchronously immediately before publishing; a failed precondition leaves the target untouched.
 */
export interface WriteTextAtomicOptions extends SessionStorageWriteOptions {
	commitGuard?: () => boolean;
	durable?: boolean;
}

export class SessionStorageLockError extends Error {
	constructor(path: string) {
		super(`Session file already has an active writer: ${path}`);
		this.name = "SessionStorageLockError";
	}
}

export interface SessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void;

	updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void>;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	readTextRange(path: string, start: number, end: number): Promise<string>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;

	drain(): Promise<void>;
}

interface FileWriterResources {
	fd: number;
	lock: FileLockHandle;
}

const writerRegistry = new FinalizationRegistry<FileWriterResources>(({ fd, lock }) => {
	try {
		fs.closeSync(fd);
	} catch {}
	try {
		lock.release();
	} catch {}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	#lock: FileLockHandle;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";

		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const lock = tryAcquireFileLockSync(fpath);
		if (!lock) throw new SessionStorageLockError(fpath);

		let fd: number;
		try {
			fd = fs.openSync(fpath, flags === "w" ? "w" : "a");
		} catch (error) {
			lock.release();
			throw error;
		}
		this.#fd = fd;
		this.#lock = lock;

		writerRegistry.register(this, { fd, lock }, this);
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	#writeNow(line: string): void {
		const originalSize = fs.fstatSync(this.#fd).size;
		const buf = Buffer.from(line, "utf-8");
		let offset = 0;
		try {
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (writeError) {
			try {
				fs.ftruncateSync(this.#fd, originalSize);
			} catch (rollbackError) {
				throw new AggregateError(
					[toError(writeError), toError(rollbackError)],
					"Session append failed and its partial bytes could not be rolled back",
				);
			}
			throw writeError;
		}
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;

		try {
			this.#writeNow(line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async append(line: string): Promise<void> {
		this.appendSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	flushSync(): void {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;

		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {}
		this.#lock.release();
		if (this.#error) throw this.#error;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

export class FileSessionStorage implements SessionStorage {
	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	writeTextSync(fpath: string, content: string, options?: SessionStorageWriteOptions): void {
		const lock = tryAcquireFileLockSync(fpath);
		if (!lock) throw new SessionStorageLockError(fpath);
		try {
			this.#writeTextSyncLocked(fpath, content, options?.expectedSize);
		} finally {
			lock.release();
		}
	}

	/** Runs under the file lock every appender and publisher takes, so the check cannot race another writer. */
	#assertExpectedSize(fpath: string, expectedSize: number | null | undefined): void {
		if (expectedSize === undefined) return;
		let actualSize: number | null;
		try {
			actualSize = fs.statSync(fpath).size;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			actualSize = null;
		}
		if (actualSize !== expectedSize) throw new SessionWriteConflictError(fpath, expectedSize, actualSize);
	}

	#writeTextSyncLocked(fpath: string, content: string, expectedSize?: number | null): void {
		const dir = path.dirname(fpath);
		this.ensureDirSync(dir);
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		try {
			fs.writeFileSync(tempPath, content);
			this.#assertExpectedSize(fpath, expectedSize);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
		try {
			this.renameSync(tempPath, fpath);
		} catch (err) {
			if (!hasFsCode(err, "EPERM")) {
				this.#discardTemp(tempPath, fpath);
				throw toError(err);
			}
			try {
				this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err);
			} catch (fallbackErr) {
				this.#discardTemp(tempPath, fpath);
				throw fallbackErr;
			}
		}
	}

	async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		const lock = tryAcquireFileLockSync(fpath);
		if (!lock) throw new SessionStorageLockError(fpath);
		try {
			const content = await this.readText(fpath);
			await this.#writeTextAtomicLocked(fpath, overlayTitleSlotContent(content, update), { durable: true });
		} finally {
			lock.release();
		}
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, mtime: stats.mtime };
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return peekFileEnds(path, prefixBytes, suffixBytes, (head, tail) => [
			utf8Decoder.decode(head),
			utf8Decoder.decode(tail),
		]);
	}

	readTextRange(path: string, start: number, end: number): Promise<string> {
		return Bun.file(path).slice(start, end).text();
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const lock = tryAcquireFileLockSync(fpath);
		if (!lock) throw new SessionStorageLockError(fpath);
		try {
			await this.#writeTextAtomicLocked(fpath, content, options);
		} finally {
			lock.release();
		}
	}

	async #writeTextAtomicLocked(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const dir = path.resolve(fpath, "..");
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			if (options?.durable) {
				const handle = await fs.promises.open(tempPath, "w");
				try {
					await handle.writeFile(content);
					await handle.sync();
				} finally {
					await handle.close();
				}
			} else {
				await fs.promises.writeFile(tempPath, content);
			}
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}

		if (options?.commitGuard && !options.commitGuard()) {
			this.#discardTemp(tempPath, fpath);
			return;
		}
		try {
			this.#assertExpectedSize(fpath, options?.expectedSize);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw err;
		}
		try {
			this.renameSync(tempPath, fpath);
		} catch (err) {
			if (!hasFsCode(err, "EPERM")) {
				this.#discardTemp(tempPath, fpath);
				throw toError(err);
			}
			try {
				this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err, options?.commitGuard);
			} catch (fallbackErr) {
				this.#discardTemp(tempPath, fpath);
				throw fallbackErr;
			}
		}
		if (options?.durable) this.#syncDirectory(dir);
	}

	#syncDirectory(dir: string): void {
		if (process.platform === "win32") return;
		const fd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}

	renameSync(source: string, target: string): void {
		fs.renameSync(source, target);
	}

	#discardTemp(tempPath: string, targetPath: string): void {
		try {
			fs.unlinkSync(tempPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite temp file", {
					sessionFile: targetPath,
					tempPath,
					error: toError(err).message,
				});
			}
		}
	}

	#replaceSessionFileAfterEpermSync(
		tempPath: string,
		targetPath: string,
		renameError: unknown,
		commitGuard?: () => boolean,
	): void {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, `${path.basename(targetPath)}.${Snowflake.next()}.bak`);
		try {
			this.renameSync(targetPath, backupPath);
		} catch (moveAsideError) {
			if (isEnoent(moveAsideError)) {
				if (commitGuard && !commitGuard()) {
					this.#discardTemp(tempPath, targetPath);
					return;
				}
				this.renameSync(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}
		if (commitGuard && !commitGuard()) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (restoreErr) {
				logger.warn("Failed to restore backup after commitGuard rejection", {
					sessionFile: targetPath,
					backupPath,
					error: toError(restoreErr).message,
				});
			}
			this.#discardTemp(tempPath, targetPath);
			return;
		}
		try {
			this.renameSync(tempPath, targetPath);
		} catch (replaceError) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${rollbackError.message})`,
					{ cause: toError(renameError) },
				);
			}
			throw toError(replaceError);
		}
		try {
			fs.unlinkSync(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new FileSessionStorageWriter(path, options);
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		await this.unlink(sessionPath);

		const artifactsDir = sessionPath.slice(0, -6);

		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}

		// EPERM-rewrite leftovers (`<name>.jsonl.<snowflake>.bak`) would otherwise be
		// recovered by the next listing and resurrect the deleted session. Best-effort:
		// a locked backup warns instead of failing the delete the user asked for.
		const base = path.basename(sessionPath);
		for (const bak of this.listFilesSync(path.dirname(sessionPath), "*.bak")) {
			if (!path.basename(bak).startsWith(`${base}.`)) continue;
			try {
				await fsp.unlink(bak);
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("Failed to remove stale session backup during delete", {
						path: bak,
						error: toError(err).message,
					});
				}
			}
		}
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			this.#storage.appendSync(this.#path, line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async append(line: string): Promise<void> {
		this.appendSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	flushSync(): void {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

interface MemoryFileEntry {
	chunks: string[];
	cumulativeBytes: number[];
	size: number;
	mtimeMs: number;
}

function createMemoryFileEntry(content: string, mtimeMs: number): MemoryFileEntry {
	const size = Buffer.byteLength(content, "utf-8");
	return {
		chunks: size === 0 ? [] : [content],
		cumulativeBytes: size === 0 ? [] : [size],
		size,
		mtimeMs,
	};
}

function appendMemoryChunk(entry: MemoryFileEntry, chunk: string): void {
	const chunkSize = Buffer.byteLength(chunk, "utf-8");
	if (chunkSize === 0) return;
	entry.size += chunkSize;
	entry.chunks.push(chunk);
	entry.cumulativeBytes.push(entry.size);
}

function normalizeByteLimit(maxBytes: number, size: number): number {
	if (!(maxBytes > 0) || size === 0) return 0;
	return Math.min(Math.trunc(maxBytes), size);
}

function lowerBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function upperBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function joinChunkRange(chunks: readonly string[], start: number, end: number): string {
	const count = end - start;
	if (count <= 0) return "";
	if (count === 1) return chunks[start] ?? "";

	let content = "";
	for (let i = start; i < end; i++) {
		content += chunks[i];
	}
	return content;
}

function decodeChunkByteRange(chunk: string, startByte: number, endByte: number, chunkSize: number): string {
	if (startByte >= endByte) return "";
	if (startByte === 0 && endByte === chunkSize) return chunk;
	if (chunk.length === chunkSize) return chunk.slice(startByte, endByte);
	const bytes = Buffer.from(chunk, "utf-8");
	return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

function materializeMemoryEntry(entry: MemoryFileEntry): string {
	const { chunks } = entry;
	if (chunks.length === 0) return "";
	if (chunks.length === 1) return chunks[0];

	const content = chunks.join("");
	entry.chunks = [content];
	entry.cumulativeBytes = [entry.size];
	return content;
}

function sliceChunksHead(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const boundaryIndex = lowerBound(entry.cumulativeBytes, limit);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	if (chunkEnd === limit) return joinChunkRange(entry.chunks, 0, boundaryIndex + 1);

	const chunk = entry.chunks[boundaryIndex];
	const chunkPrefix = decodeChunkByteRange(chunk, 0, limit - chunkStart, chunkEnd - chunkStart);
	return joinChunkRange(entry.chunks, 0, boundaryIndex) + chunkPrefix;
}

function sliceChunksTail(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const startByte = entry.size - limit;
	const boundaryIndex = upperBound(entry.cumulativeBytes, startByte);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	const chunkOffset = startByte - chunkStart;
	if (chunkOffset === 0) return joinChunkRange(entry.chunks, boundaryIndex, entry.chunks.length);

	const chunk = entry.chunks[boundaryIndex];
	const chunkSuffix = decodeChunkByteRange(chunk, chunkOffset, chunkEnd - chunkStart, chunkEnd - chunkStart);
	return chunkSuffix + joinChunkRange(entry.chunks, boundaryIndex + 1, entry.chunks.length);
}

export class MemorySessionStorage implements SessionStorage {
	#files = new Map<string, MemoryFileEntry>();

	#requireEntry(path: string): MemoryFileEntry {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry;
	}

	ensureDirSync(_dir: string): void {}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		const actualSize = this.#files.get(path)?.size ?? null;
		if (options?.expectedSize !== undefined && actualSize !== options.expectedSize) {
			throw new SessionWriteConflictError(path, options.expectedSize, actualSize);
		}
		this.#files.set(path, createMemoryFileEntry(content, Date.now()));
	}

	async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		const entry = this.#requireEntry(path);
		this.#files.set(
			path,
			createMemoryFileEntry(overlayTitleSlotContent(materializeMemoryEntry(entry), update), Date.now()),
		);
	}

	appendSync(path: string, chunk: string): void {
		const mtimeMs = Date.now();
		let entry = this.#files.get(path);
		if (!entry) {
			entry = createMemoryFileEntry("", mtimeMs);
			this.#files.set(path, entry);
		}
		appendMemoryChunk(entry, chunk);
		entry.mtimeMs = mtimeMs;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#requireEntry(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.#files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesPattern(name, pattern)) continue;
			files.push(path);
		}
		return files;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(materializeMemoryEntry(entry));
	}

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve([sliceChunksHead(entry, prefixBytes), sliceChunksTail(entry, suffixBytes)]);
	}

	readTextRange(path: string, start: number, end: number): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		const bytes = Buffer.from(materializeMemoryEntry(entry), "utf8");
		return Promise.resolve(bytes.subarray(start, end).toString("utf8"));
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (options?.commitGuard && !options.commitGuard()) return Promise.resolve();
		try {
			this.writeTextSync(path, content, { expectedSize: options?.expectedSize });
		} catch (err) {
			return Promise.reject(err);
		}
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}
	deleteSessionWithArtifacts(_sessionPath: string): Promise<void> {
		return Promise.resolve();
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
