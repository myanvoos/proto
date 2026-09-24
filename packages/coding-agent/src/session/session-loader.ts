import { gunzipSync } from "node:zlib";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir, isEnoent, isEnotdir, logger, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import {
	type BlobReader,
	BlobStore,
	isBlobRef,
	parseBlobRef,
	resolveImageData,
	resolveImageDataUrl,
} from "./blob-store";
import { buildSessionContext } from "./session-context";
import type { FileEntry, RawFileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { isImageBlock, isImageDataPayload, isPersistedReplayBlobRef } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

// Native full-text JSONL parsing minimizes overhead for ordinary sessions. Larger files use
// bounded 512 KiB text batches: Bun.JSONL's string path is substantially faster than repeatedly
// parsing Uint8Array chunks, without retaining a second full-file copy.
const STREAM_LOAD_THRESHOLD_BYTES = 32 * 1024 * 1024;
const STREAM_PARSE_BATCH_BYTES = 512 * 1024;
const STREAM_GC_INTERVAL_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;
const BLOB_RESOLUTION_CONCURRENCY = 8;

interface VisitEntriesFromFileStreamOptions {
	shouldContinue?: () => boolean;

	maxRecords?: number;

	yieldEveryBytes?: number;

	yieldEveryEntries?: number;

	onMalformedRecord?: (kind: "complete" | "unterminated-final") => void;

	/** Rethrow a missing source instead of visiting nothing. */
	throwIfMissing?: boolean;

	/** Called with each stream chunk's byte length, so callers learn the exact snapshot size without re-stating. */
	onBytesConsumed?: (bytes: number) => void;
}

/** Controls how {@link loadSessionFile} treats its source. */
export interface LoadSessionOptions {
	preserveInvalidHeader?: boolean;
	/** Propagate ENOENT/ENOTDIR instead of treating the path as a new empty session. */
	throwIfMissing?: boolean;
}

export interface SessionArchiveRecord {
	id: string;
	beforeId: string | null;
	line: string;
}

export interface SessionArchive {
	version: 1;
	sessionId: string;
	sessionFile: string;
	records: SessionArchiveRecord[];
}

export interface SessionLoadResult {
	entries: FileEntry[];
	archivedEntryIds?: Set<string>;
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Malformed newline-terminated records, which are not safe to discard during resume. */
	malformedCompleteRecords: number;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
	/**
	 * Byte length of the snapshot actually parsed, or `null` when the path did not exist. Writers replay it as the
	 * freshness precondition of their next full rewrite.
	 */
	sourceSize?: number | null;
}

export function sessionArchivePath(sessionFile: string): string {
	return `${sessionFile}.archive.jsonl.gz`;
}

interface LoadedSessionArchive {
	archive: SessionArchive;
	entriesById: Map<string, FileEntry>;
}

async function loadSessionArchiveWithEntries(
	filePath: string,
	storage: SessionStorage,
	sessionId: string,
): Promise<LoadedSessionArchive | undefined> {
	const archivePath = sessionArchivePath(filePath);
	if (!(await storage.exists(archivePath))) return undefined;
	const encoded = (await storage.readText(archivePath)).trim();
	let archive: unknown;
	try {
		archive = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
	} catch (error) {
		throw new Error(`Session archive is corrupt: ${archivePath}`, { cause: error });
	}
	if (typeof archive !== "object" || archive === null) throw new Error(`Session archive is invalid: ${archivePath}`);
	const candidate = archive as Partial<SessionArchive>;
	if (
		candidate.version !== 1 ||
		candidate.sessionId !== sessionId ||
		typeof candidate.sessionFile !== "string" ||
		!Array.isArray(candidate.records)
	) {
		// A copied artifact directory may carry the source session archive alongside a fork.
		if (candidate.sessionId !== sessionId) return undefined;
		throw new Error(`Session archive is invalid: ${archivePath}`);
	}
	const recordIds = new Set<string>();
	const entriesById = new Map<string, FileEntry>();
	for (const record of candidate.records) {
		if (
			typeof record !== "object" ||
			record === null ||
			typeof record.id !== "string" ||
			!(record.beforeId === null || typeof record.beforeId === "string") ||
			typeof record.line !== "string"
		) {
			throw new Error(`Session archive is invalid: ${archivePath}`);
		}
		if (recordIds.has(record.id)) throw new Error(`Session archive has duplicate entry IDs: ${archivePath}`);
		const validatedRecord = record as SessionArchiveRecord;
		entriesById.set(record.id, parseArchivedEntry(validatedRecord));
		recordIds.add(record.id);
	}
	return { archive: candidate as SessionArchive, entriesById };
}

export async function loadSessionArchive(
	filePath: string,
	storage: SessionStorage,
	sessionId: string,
): Promise<SessionArchive | undefined> {
	return (await loadSessionArchiveWithEntries(filePath, storage, sessionId))?.archive;
}

function archiveDoesNotCollide(archive: SessionArchive, activeIds: ReadonlySet<string>): boolean {
	return archive.records.every(record => !activeIds.has(record.id));
}

function warnInvalidArchive(filePath: string, error: unknown): void {
	logger.warn("Ignoring invalid session archive", {
		file: sessionArchivePath(filePath),
		error: error instanceof Error ? error.message : String(error),
	});
}

function parseArchivedEntry(record: SessionArchiveRecord): FileEntry {
	let entry: unknown;
	try {
		entry = JSON.parse(record.line);
	} catch (error) {
		throw new Error(`Session archive entry ${record.id} is invalid`, { cause: error });
	}
	if (typeof entry !== "object" || entry === null || !("id" in entry) || entry.id !== record.id) {
		throw new Error(`Session archive entry ${record.id} is invalid`);
	}
	return entry as FileEntry;
}

function hydrateArchivedEntries(
	entries: FileEntry[],
	records: SessionArchiveRecord[],
	entriesById: ReadonlyMap<string, FileEntry>,
): {
	entries: FileEntry[];
	ids: Set<string>;
} {
	const byAnchor = new Map<string | null, SessionArchiveRecord[]>();
	for (const record of records) {
		const group = byAnchor.get(record.beforeId) ?? [];
		group.push(record);
		byAnchor.set(record.beforeId, group);
	}
	const ids = new Set(records.map(record => record.id));
	const activeIds = new Set(
		entries.flatMap(entry =>
			typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? [entry.id] : [],
		),
	);
	const result: FileEntry[] = [];
	const appendRecords = (anchor: string | null): void => {
		for (const record of byAnchor.get(anchor) ?? []) {
			if (activeIds.has(record.id)) continue;
			const entry = entriesById.get(record.id);
			if (!entry) throw new Error(`Session archive entry ${record.id} was not validated`);
			result.push(entry);
		}
		byAnchor.delete(anchor);
	};
	for (const entry of entries) {
		if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string") {
			appendRecords(entry.id);
			result.push(entry);
		} else result.push(entry);
	}
	appendRecords(null);
	if (byAnchor.size > 0) throw new Error("Session archive references an entry missing from the active transcript");
	return { entries: result, ids };
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	const lastNewline = body.lastIndexOf("\n");
	const completeRecords = lastNewline === -1 ? "" : body.slice(0, lastNewline + 1);
	const unterminatedFinalRecord = body.slice(lastNewline + 1);
	let malformedCompleteRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(completeRecords, {
		onMalformedRecord: () => {
			malformedCompleteRecords++;
		},
	}) as FileEntry[];
	let malformedFinalRecords = 0;
	entries.push(
		...(parseJsonlLenient<RawFileEntry>(unterminatedFinalRecord, {
			onMalformedRecord: () => {
				malformedFinalRecords++;
			},
		}) as FileEntry[]),
	);
	const malformedRecords = malformedCompleteRecords + malformedFinalRecords;
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		malformedCompleteRecords,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let titleSlot: SessionTitleUpdate | undefined;
	let sawFirstLine = false;
	let sawFirstEntry = false;
	let pending = "";
	let bufferedBytes = 0;
	let bytesSinceCollection = 0;
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	let recordsSeen = 0;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	let stopped = maxRecords === 0;
	let visitorThrew = false;
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const decoder = new TextDecoder();

	const shouldYieldToMacrotask = (): boolean =>
		(yieldEveryBytes > 0 && bytesSinceYield >= yieldEveryBytes) ||
		(yieldEveryEntries > 0 && entriesSinceYield >= yieldEveryEntries);

	const yieldToMacrotask = async (): Promise<void> => {
		bytesSinceYield = 0;
		entriesSinceYield = 0;
		await Bun.sleep(0);
	};

	const inspectFirstLine = (atEnd: boolean): void => {
		if (sawFirstLine) return;
		const newline = pending.indexOf("\n");
		if (newline === -1 && !atEnd) return;
		sawFirstLine = true;
		const end = newline === -1 ? pending.length : newline;
		const slot = parseTitleSlotLine(pending.slice(0, end).trim());
		if (!slot) return;
		titleSlot = titleUpdateFromSlot(slot);
		pending = newline === -1 ? "" : pending.slice(newline + 1);
	};

	const drain = async (atEnd = false): Promise<void> => {
		if (stopped || pending.length === 0) return;
		const newline = pending.lastIndexOf("\n");
		const hasUnterminatedFinal = atEnd && newline !== pending.length - 1;
		if (newline === -1 && !hasUnterminatedFinal) return;

		let input: string;
		if (hasUnterminatedFinal) {
			input = `${pending}\n`;
			pending = "";
		} else {
			input = pending.slice(0, newline + 1);
			pending = pending.slice(newline + 1);
		}
		bufferedBytes = 0;

		while (input.length > 0 && !stopped) {
			if (recordsSeen >= maxRecords) {
				stopped = true;
				break;
			}
			const { values, error, read, done } = Bun.JSONL.parseChunk(input);
			for (const value of values) {
				if (recordsSeen >= maxRecords || (options.shouldContinue && !options.shouldContinue())) {
					stopped = true;
					break;
				}
				const entry = value as FileEntry;
				if (!sawFirstEntry) {
					sawFirstEntry = true;
					applyTitleSlot(entry, titleSlot);
				}
				try {
					if (visit(entry) === false) {
						stopped = true;
						break;
					}
				} catch (error) {
					visitorThrew = true;
					throw error;
				}
				recordsSeen++;
				entriesSinceYield++;
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				if (shouldYieldToMacrotask()) await yieldToMacrotask();
			}
			if (stopped) break;
			if (error) {
				const nextNewline = input.indexOf("\n", read);
				if (nextNewline === -1) break;
				if (input.slice(read, nextNewline).trim().length > 0) {
					const kind =
						hasUnterminatedFinal && nextNewline === input.length - 1 ? "unterminated-final" : "complete";
					options.onMalformedRecord?.(kind);
				}
				recordsSeen++;
				input = input.slice(nextNewline + 1);
				continue;
			}
			if (read === 0 || done) break;
			input = input.slice(read);
		}
	};

	try {
		for await (const chunk of Bun.file(filePath).stream()) {
			if (stopped) break;
			options.onBytesConsumed?.(chunk.byteLength);
			bytesSinceYield += chunk.byteLength;
			bytesSinceCollection += chunk.byteLength;
			bufferedBytes += chunk.byteLength;
			pending += decoder.decode(chunk, { stream: true });
			inspectFirstLine(false);
			if (sawFirstLine && bufferedBytes >= STREAM_PARSE_BATCH_BYTES) await drain();
			if (bytesSinceCollection >= STREAM_GC_INTERVAL_BYTES) {
				Bun.gc(false);
				bytesSinceCollection = 0;
			}
			if (shouldYieldToMacrotask()) await yieldToMacrotask();
		}

		if (!stopped) {
			pending += decoder.decode();
			inspectFirstLine(true);
			await drain(true);
		}
	} catch (error) {
		if (visitorThrew) throw error;
		if (isEnoent(error) && !options.throwIfMissing) return undefined;
		throw error;
	}

	return titleSlot;
}

export async function loadEntriesFromFileStream(
	filePath: string,
	options?: Pick<VisitEntriesFromFileStreamOptions, "throwIfMissing">,
): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	let malformedCompleteRecords = 0;
	let bytesConsumed = 0;
	const titleSlot = await visitEntriesFromFileStream(
		filePath,
		entry => {
			entries.push(entry);
		},
		{
			onMalformedRecord: kind => {
				malformedRecords++;
				if (kind === "complete") malformedCompleteRecords++;
			},
			throwIfMissing: options?.throwIfMissing,
			onBytesConsumed: bytes => {
				bytesConsumed += bytes;
			},
		},
	);
	return {
		entries,
		titleSlot,
		malformedRecords,
		malformedCompleteRecords,
		sourceSize: bytesConsumed,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}

function shouldStreamEntries(storage: SessionStorage, size: number): boolean {
	return storage instanceof FileSessionStorage && size >= STREAM_LOAD_THRESHOLD_BYTES;
}

async function loadWithKnownSize(
	filePath: string,
	storage: SessionStorage,
	size: number,
	options: LoadSessionOptions,
): Promise<SessionLoadResult> {
	let loaded: SessionLoadResult;
	if (shouldStreamEntries(storage, size)) {
		loaded = await loadEntriesFromFileStream(filePath, { throwIfMissing: options.throwIfMissing });
	} else {
		const content = await storage.readText(filePath);
		loaded = { ...parseSessionContent(content), sourceSize: Buffer.byteLength(content, "utf8") };
	}
	if (loaded.invalidHeader && !options.preserveInvalidHeader) return { ...loaded, entries: [] };
	const header = loaded.entries[0];
	if (header?.type !== "session" || typeof header.id !== "string") return loaded;
	let archive: SessionArchive | undefined;
	let archiveEntriesById = new Map<string, FileEntry>();
	try {
		const loadedArchive = await loadSessionArchiveWithEntries(filePath, storage, header.id);
		archive = loadedArchive?.archive;
		archiveEntriesById = loadedArchive?.entriesById ?? archiveEntriesById;
		if (
			archive &&
			!archiveDoesNotCollide(
				archive,
				new Set(
					loaded.entries.flatMap(entry =>
						typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string"
							? [entry.id]
							: [],
					),
				),
			)
		) {
			throw new Error("Session archive entry ID collides with the active transcript");
		}
	} catch (error) {
		warnInvalidArchive(filePath, error);
		return loaded;
	}
	if (!archive || archive.records.length === 0) return loaded;
	try {
		const hydrated = hydrateArchivedEntries(loaded.entries, archive.records, archiveEntriesById);
		return { ...loaded, entries: hydrated.entries, archivedEntryIds: hydrated.ids };
	} catch (error) {
		warnInvalidArchive(filePath, error);
		return loaded;
	}
}

export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult> {
	try {
		return await loadWithKnownSize(filePath, storage, storage.statSync(filePath).size, options);
	} catch (err) {
		if (options.throwIfMissing && (isEnoent(err) || isEnotdir(err))) throw err;
		if (isEnoent(err)) {
			return {
				entries: [],
				titleSlot: undefined,
				malformedRecords: 0,
				malformedCompleteRecords: 0,
				invalidHeader: false,
				sourceSize: null,
			};
		}
		throw err;
	}
}

export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<FileEntry[]> {
	return (await loadSessionFile(filePath, storage)).entries;
}

export async function visitEntriesFromFile(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<void> {
	const size = storage.statSync(filePath).size;
	if (shouldStreamEntries(storage, size)) {
		let firstEntry: FileEntry | undefined;
		await visitEntriesFromFileStream(
			filePath,
			entry => {
				firstEntry = entry;
				return false;
			},
			{ maxRecords: 1 },
		);
		if (!isValidSessionHeader(firstEntry)) return;
		let archive: SessionArchive | undefined;
		let archiveEntriesById = new Map<string, FileEntry>();
		try {
			const loadedArchive = await loadSessionArchiveWithEntries(filePath, storage, firstEntry.id);
			archive = loadedArchive?.archive;
			archiveEntriesById = loadedArchive?.entriesById ?? archiveEntriesById;
		} catch (error) {
			warnInvalidArchive(filePath, error);
			archive = undefined;
		}
		if (archive?.records.length) {
			const activeIds = new Set<string>();
			// Active-file errors must propagate; only sidecar validation failures are ignored.
			await visitEntriesFromFileStream(filePath, entry => {
				if (typeof entry.id === "string") activeIds.add(entry.id);
			});
			try {
				if (!archiveDoesNotCollide(archive, activeIds)) {
					throw new Error("Session archive entry ID collides with the active transcript");
				}
				if (archive.records.some(record => record.beforeId !== null && !activeIds.has(record.beforeId))) {
					throw new Error("Session archive references an entry missing from the active transcript");
				}
			} catch (error) {
				warnInvalidArchive(filePath, error);
				archive = undefined;
			}
		}
		if (!archive || archive.records.length === 0) {
			let sawFirstEntry = false;
			await visitEntriesFromFileStream(filePath, entry => {
				if (!sawFirstEntry) {
					sawFirstEntry = true;
					if (!isValidSessionHeader(entry)) return false;
				}
				return visit(entry);
			});
			return;
		}
		const byAnchor = new Map<string | null, SessionArchiveRecord[]>();
		const byId = new Map(archive.records.map(record => [record.id, record]));
		for (const record of archive.records) {
			const group = byAnchor.get(record.beforeId) ?? [];
			group.push(record);
			byAnchor.set(record.beforeId, group);
		}
		const activeArchivedIds = new Set<string>();
		const activeIds = new Set<string>();
		const appendBefore = (anchor: string | null): boolean => {
			for (const record of byAnchor.get(anchor) ?? []) {
				if (activeArchivedIds.has(record.id)) continue;
				const archivedEntry = archiveEntriesById.get(record.id);
				if (!archivedEntry) throw new Error(`Session archive entry ${record.id} was not validated`);
				if (visit(archivedEntry) === false) return false;
			}
			byAnchor.delete(anchor);
			return true;
		};
		let sawFirstEntry = false;
		let stopped = false;
		await visitEntriesFromFileStream(filePath, entry => {
			if (!sawFirstEntry) {
				sawFirstEntry = true;
				if (!isValidSessionHeader(entry)) return false;
			}
			if (typeof entry.id === "string") {
				activeIds.add(entry.id);
				if (byId.has(entry.id)) activeArchivedIds.add(entry.id);
				if (!appendBefore(entry.id)) {
					stopped = true;
					return false;
				}
			}
			const keepGoing = visit(entry);
			if (keepGoing === false) stopped = true;
			return keepGoing;
		});
		if (!stopped && !appendBefore(null)) stopped = true;
		if (!stopped && [...byAnchor.keys()].some(anchor => anchor !== null && !activeIds.has(anchor))) {
			throw new Error("Session archive references an entry missing from the active transcript");
		}
		return;
	}

	for (const entry of (await loadWithKnownSize(filePath, storage, size, {})).entries) {
		if (visit(entry) === false) return;
	}
}

function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

interface BlobResolutionState {
	active: number;
	waiters: Array<() => void>;
	inFlight: Map<string, Promise<Buffer | null>>;
}

function createBlobResolutionState(): BlobResolutionState {
	return { active: 0, waiters: [], inFlight: new Map() };
}

async function acquireBlobResolutionSlot(state: BlobResolutionState): Promise<void> {
	if (state.active < BLOB_RESOLUTION_CONCURRENCY) {
		state.active++;
		return;
	}
	const deferred = Promise.withResolvers<void>();
	state.waiters.push(deferred.resolve);
	await deferred.promise;
}

function releaseBlobResolutionSlot(state: BlobResolutionState): void {
	const next = state.waiters.shift();
	if (next) {
		next();
	} else {
		state.active--;
	}
}

function createBoundedBlobReader(blobStore: BlobStore): BlobReader {
	const state = createBlobResolutionState();
	return hash => {
		const existing = state.inFlight.get(hash);
		if (existing) return existing;
		const pending = (async () => {
			await acquireBlobResolutionSlot(state);
			try {
				return await blobStore.get(hash);
			} finally {
				releaseBlobResolutionSlot(state);
			}
		})();
		state.inFlight.set(hash, pending);
		void pending.then(
			() => {
				if (state.inFlight.get(hash) === pending) state.inFlight.delete(hash);
			},
			() => {
				if (state.inFlight.get(hash) === pending) state.inFlight.delete(hash);
			},
		);
		return pending;
	};
}

async function resolvePersistedBlobRefs(
	value: unknown,
	blobStore: BlobStore,
	readBlob: BlobReader,
	key?: string,
): Promise<unknown> {
	if (isPersistedReplayBlobRef(value)) {
		const hash = parseBlobRef(value.__protoReplayBlob);
		if (!hash) return value;
		const buffer = await readBlob(hash);
		if (!buffer) {
			logger.warn("Blob not found for persisted replay payload", { hash });
			return value;
		}
		try {
			const parsed: unknown = JSON.parse(buffer.toString("utf8"));
			return await resolvePersistedBlobRefs(parsed, blobStore, readBlob, key);
		} catch (error) {
			logger.warn("Invalid persisted replay payload blob", {
				hash,
				error: error instanceof Error ? error.message : String(error),
			});
			return value;
		}
	}

	if (shouldResolveImagePayload(value, key)) {
		value.data = await resolveImageData(blobStore, value.data, readBlob);
		return value;
	}

	if (Array.isArray(value)) {
		const hydrated = await Promise.all(value.map(item => resolvePersistedBlobRefs(item, blobStore, readBlob, key)));
		for (let index = 0; index < hydrated.length; index++) value[index] = hydrated[index];
		return value;
	}

	if (typeof value !== "object" || value === null) return value;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		value.result = await resolveImageData(blobStore, value.result, readBlob);
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		value.image_url = await resolveImageDataUrl(blobStore, value.image_url, readBlob);
	}

	await Promise.all(
		Object.entries(value).map(async ([childKey, item]) => {
			const hydrated = await resolvePersistedBlobRefs(item, blobStore, readBlob, childKey);
			(value as Record<string, unknown>)[childKey] = hydrated;
		}),
	);
	return value;
}

function containsBlobRef(value: unknown, key?: string): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (isPersistedReplayBlobRef(value)) return true;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item, key)) return true;
		}
		return false;
	}

	if (shouldResolveImagePayload(value, key)) return true;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		return true;
	}
	if (hasImageUrl(value) && isBlobRef(value.image_url)) return true;

	for (const childKey of Object.keys(value)) {
		const child = (value as Record<string, unknown>)[childKey];
		if (typeof child === "object" && child !== null && containsBlobRef(child, childKey)) return true;
	}
	return false;
}

async function resolveBlobRefs(values: readonly unknown[], blobStore: BlobStore): Promise<void> {
	const readBlob = createBoundedBlobReader(blobStore);
	const pending: Promise<unknown>[] = [];
	for (const value of values) {
		if (!containsBlobRef(value)) continue;
		pending.push(resolvePersistedBlobRefs(value, blobStore, readBlob));
	}
	await Promise.all(pending);
}

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await resolveBlobRefs(
		entries.filter(entry => entry.type !== "session"),
		blobStore,
	);
}

export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	const { messages } = buildSessionContext(sessionEntries, undefined, undefined, {
		transcript: true,
		collapseCompactedHistory: true,
	});
	// Hydrate only what the transcript retains. A collapsed summary's remote-compaction replacement history exists
	// for provider replay alone — this transcript is never replayed and the renderer reads just the summary — so
	// dropping it keeps hydration off every image blob buried in that hidden history.
	const displayMessages = messages.map(message =>
		message.role === "compactionSummary" && message.providerPayload !== undefined
			? { ...message, providerPayload: undefined }
			: message,
	);
	await resolveBlobRefs(displayMessages, new BlobStore(getBlobsDir()));
	return displayMessages;
}
