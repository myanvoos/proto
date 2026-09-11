import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir, isEnoent, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import { BlobStore, isBlobRef, resolveImageData, resolveImageDataUrl } from "./blob-store";
import { buildSessionContext } from "./session-context";
import type { FileEntry, RawFileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { isImageBlock, isImageDataPayload } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

// Native full-text JSONL parsing is faster below this size; retain streaming for very large resumes.
const STREAM_LOAD_THRESHOLD_BYTES = 32 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;
const EMPTY_BUFFER = new Uint8Array(0);
const NEWLINE = new Uint8Array([0x0a]);

class GrowingBuffer {
	#space: Uint8Array | undefined;
	#length = 0;

	get length(): number {
		return this.#length;
	}

	get bytes(): Uint8Array {
		return this.#space?.subarray(0, this.#length) ?? EMPTY_BUFFER;
	}

	append(chunk: Uint8Array, exact = false): void {
		const n = chunk.length;
		if (n === 0) return;
		if (this.#length === 0) {
			this.#space = chunk;
			this.#length = n;
			return;
		}

		const offset = this.#length;
		const required = offset + n;
		const space = this.#space;
		if (!space || space.length < required) {
			const nextSize = exact || !space ? required : Math.max(required, space.length * 2);
			const next = Buffer.allocUnsafe(nextSize);
			if (space) next.set(space.subarray(0, offset));
			this.#space = next;
		}
		this.#space!.set(chunk, offset);
		this.#length = required;
	}

	consume(offset: number): void {
		if (offset <= 0) return;
		if (offset >= this.#length) {
			this.clear();
			return;
		}
		const space = this.#space!;
		space.copyWithin(0, offset, this.#length);
		this.#length -= offset;
	}

	clear(): void {
		this.#space = undefined;
		this.#length = 0;
	}
}

interface VisitEntriesFromFileStreamOptions {
	shouldContinue?: () => boolean;

	maxRecords?: number;

	yieldEveryBytes?: number;

	yieldEveryEntries?: number;

	onMalformedRecord?: () => void;
}

export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
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
	let malformedRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
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
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	let recordsSeen = 0;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	let stopped = false;
	let visitorThrew = false;
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);

	const buffer = new GrowingBuffer();
	const decoder = new TextDecoder();

	const yieldToMacrotask = async (): Promise<void> => {
		if (yieldEveryBytes === 0 && yieldEveryEntries === 0) return;
		const bytesReady = yieldEveryBytes === 0 || bytesSinceYield < yieldEveryBytes;
		const entriesReady = yieldEveryEntries === 0 || entriesSinceYield < yieldEveryEntries;
		if (bytesReady && entriesReady) {
			return;
		}
		bytesSinceYield = 0;
		entriesSinceYield = 0;
		await Bun.sleep(0);
	};

	const drain = async (): Promise<void> => {
		while (buffer.length > 0 && !stopped) {
			if (recordsSeen >= maxRecords) {
				stopped = true;
				break;
			}
			const bytes = buffer.bytes;
			const { values, error, read, done } = Bun.JSONL.parseChunk(bytes);
			for (const value of values) {
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				if (options.shouldContinue && !options.shouldContinue()) {
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
					recordsSeen++;
					entriesSinceYield++;
					if (recordsSeen >= maxRecords) {
						stopped = true;
						break;
					}
				} catch (err) {
					visitorThrew = true;
					throw err;
				}
				await yieldToMacrotask();
			}
			if (stopped) break;
			if (error) {
				const nextNewline = bytes.indexOf(0x0a, read);
				if (nextNewline === -1) break;
				let nonWhitespace = false;
				for (let index = read; index < nextNewline; index++) {
					const byte = bytes[index];
					if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
						nonWhitespace = true;
						break;
					}
				}
				if (nonWhitespace) options.onMalformedRecord?.();
				recordsSeen++;
				buffer.consume(nextNewline + 1);
				if (recordsSeen >= maxRecords) {
					stopped = true;
					break;
				}
				continue;
			}
			if (read === 0) break;
			buffer.consume(read);
			if (done) {
				buffer.clear();
				break;
			}
		}
	};

	try {
		for await (const chunk of Bun.file(filePath).stream()) {
			if (stopped) break;
			bytesSinceYield += chunk.byteLength;
			buffer.append(chunk);

			if (!sawFirstLine) {
				const newline = buffer.bytes.indexOf(0x0a);
				if (newline !== -1) {
					sawFirstLine = true;
					const firstLine = decoder.decode(buffer.bytes.subarray(0, newline)).trim();
					if (firstLine) {
						const slot = parseTitleSlotLine(firstLine);
						if (slot) {
							titleSlot = titleUpdateFromSlot(slot);
							buffer.consume(newline + 1);
						}
					}
				}
			}
			await drain();
			await yieldToMacrotask();
		}

		if (!stopped && buffer.length > 0 && buffer.bytes[buffer.length - 1] !== 0x0a) {
			buffer.append(NEWLINE, true);
			await drain();
		}
	} catch (err) {
		if (visitorThrew) throw err;
		if (isEnoent(err)) return undefined;
		throw err;
	}

	return titleSlot;
}

export async function loadEntriesFromFileStream(filePath: string): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	const titleSlot = await visitEntriesFromFileStream(
		filePath,
		entry => {
			entries.push(entry);
		},
		{
			onMalformedRecord: () => {
				malformedRecords++;
			},
		},
	);
	return {
		entries,
		titleSlot,
		malformedRecords,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}

function shouldStreamEntries(storage: SessionStorage, size: number): boolean {
	return storage instanceof FileSessionStorage && size >= STREAM_LOAD_THRESHOLD_BYTES;
}

async function loadWithKnownSize(filePath: string, storage: SessionStorage, size: number): Promise<SessionLoadResult> {
	const loaded = shouldStreamEntries(storage, size)
		? await loadEntriesFromFileStream(filePath)
		: parseSessionContent(await storage.readText(filePath));
	return loaded.invalidHeader ? { ...loaded, entries: [] } : loaded;
}

export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionLoadResult> {
	try {
		return await loadWithKnownSize(filePath, storage, storage.statSync(filePath).size);
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined, malformedRecords: 0, invalidHeader: false };
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

	for (const entry of (await loadWithKnownSize(filePath, storage, size)).entries) {
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

async function resolvePersistedBlobRefs(value: unknown, blobStore: BlobStore, key?: string): Promise<void> {
	if (shouldResolveImagePayload(value, key)) {
		value.data = await resolveImageData(blobStore, value.data);
		return;
	}

	if (Array.isArray(value)) {
		await Promise.all(value.map(item => resolvePersistedBlobRefs(item, blobStore, key)));
		return;
	}

	if (typeof value !== "object" || value === null) return;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		value.result = await resolveImageData(blobStore, value.result);
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		value.image_url = await resolveImageDataUrl(blobStore, value.image_url);
	}

	await Promise.all(
		Object.entries(value).map(([childKey, item]) => resolvePersistedBlobRefs(item, blobStore, childKey)),
	);
}

function containsBlobRef(value: unknown, key?: string): boolean {
	if (typeof value !== "object" || value === null) return false;
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

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	const pending: Promise<void>[] = [];

	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (!containsBlobRef(entry)) continue;
		pending.push(resolvePersistedBlobRefs(entry, blobStore));
	}
	await Promise.all(pending);
}

export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries, undefined, undefined, {
		transcript: true,
		collapseCompactedHistory: true,
	}).messages;
}
