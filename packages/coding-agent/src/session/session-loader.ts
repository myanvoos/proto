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

// Native full-text JSONL parsing minimizes overhead for ordinary sessions. Larger files use
// bounded 512 KiB text batches: Bun.JSONL's string path is substantially faster than repeatedly
// parsing Uint8Array chunks, without retaining a second full-file copy.
const STREAM_LOAD_THRESHOLD_BYTES = 32 * 1024 * 1024;
const STREAM_PARSE_BATCH_BYTES = 512 * 1024;
const STREAM_GC_INTERVAL_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;

interface VisitEntriesFromFileStreamOptions {
	shouldContinue?: () => boolean;

	maxRecords?: number;

	yieldEveryBytes?: number;

	yieldEveryEntries?: number;

	onMalformedRecord?: (kind: "complete" | "unterminated-final") => void;
}

export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Malformed newline-terminated records, which are not safe to discard during resume. */
	malformedCompleteRecords: number;
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
		if (isEnoent(error)) return undefined;
		throw error;
	}

	return titleSlot;
}

export async function loadEntriesFromFileStream(filePath: string): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	let malformedCompleteRecords = 0;
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
		},
	);
	return {
		entries,
		titleSlot,
		malformedRecords,
		malformedCompleteRecords,
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
	preserveInvalidHeader: boolean,
): Promise<SessionLoadResult> {
	const loaded = shouldStreamEntries(storage, size)
		? await loadEntriesFromFileStream(filePath)
		: parseSessionContent(await storage.readText(filePath));
	return loaded.invalidHeader && !preserveInvalidHeader ? { ...loaded, entries: [] } : loaded;
}

export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options?: { preserveInvalidHeader?: boolean },
): Promise<SessionLoadResult> {
	try {
		return await loadWithKnownSize(
			filePath,
			storage,
			storage.statSync(filePath).size,
			options?.preserveInvalidHeader === true,
		);
	} catch (err) {
		if (isEnoent(err)) {
			return {
				entries: [],
				titleSlot: undefined,
				malformedRecords: 0,
				malformedCompleteRecords: 0,
				invalidHeader: false,
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

	for (const entry of (await loadWithKnownSize(filePath, storage, size, false)).entries) {
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
