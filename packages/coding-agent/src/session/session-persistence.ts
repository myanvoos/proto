import { isAnthropicServerToolHistoryBlock } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { countNewlines, materializeString, stringifyJson } from "@oh-my-pi/pi-utils";
import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
} from "./blob-store";
import type { FileEntry } from "./session-entries";

const MAX_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";

const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";

/** Marker stored in JSONL for replay-critical payloads too large to inline safely. */
export const PERSISTED_REPLAY_BLOB_KEY = "__protoReplayBlob";

export interface PersistedReplayBlobRef {
	readonly [PERSISTED_REPLAY_BLOB_KEY]: string;
}

export function isPersistedReplayBlobRef(value: unknown): value is PersistedReplayBlobRef {
	return (
		typeof value === "object" &&
		value !== null &&
		PERSISTED_REPLAY_BLOB_KEY in value &&
		typeof (value as Record<string, unknown>)[PERSISTED_REPLAY_BLOB_KEY] === "string"
	);
}

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	let truncated = value.slice(0, maxLength);
	if (truncated.length > 0) {
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			truncated = truncated.slice(0, -1);
		}
	}
	return truncated;
}

/**
 * Read a property without tripping a throwing accessor. Tool `details` can keep
 * library objects whose non-enumerable getters throw (firecrawl-js `SearchData.data`),
 * and `in` plus a plain read reaches them while JSON never does.
 */
export function probeProperty(value: object, key: string): unknown {
	try {
		return key in value ? (value as Record<string, unknown>)[key] : undefined;
	} catch {
		return undefined;
	}
}

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	if (typeof value !== "object" || value === null) return false;
	return probeProperty(value, "type") === "image" && typeof probeProperty(value, "data") === "string";
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	if (typeof value !== "object" || value === null) return false;
	if (typeof probeProperty(value, "data") !== "string") return false;
	return isImageBlock(value) || isImageMimeType(probeProperty(value, "mimeType"));
}

function shouldExternalizeImagePayload(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isImageDataPayload(value)) return false;
	if (isBlobRef(value.data) || value.data.length < BLOB_EXTERNALIZE_THRESHOLD) return false;
	return (key === TEXT_CONTENT_KEY && isImageBlock(value)) || key === "images";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function externalizeReplaySubtree(obj: object, blobStore: BlobStore): PersistedReplayBlobRef {
	const encoded = JSON.stringify(obj);
	return { [PERSISTED_REPLAY_BLOB_KEY]: blobStore.putSync(Buffer.from(encoded, "utf8")).ref };
}

function preserveReplaySubtree(obj: object, blobStore: BlobStore): unknown {
	return JSON.stringify(obj).length > MAX_PERSIST_CHARS ? externalizeReplaySubtree(obj, blobStore) : obj;
}

function needsPersistenceTraversal(obj: unknown, key?: string): boolean {
	if (obj === null || obj === undefined) return false;
	if (typeof obj === "string") {
		return obj.length > MAX_PERSIST_CHARS || isBlobRef(obj) || (key === "image_url" && isImageDataUrl(obj));
	}
	if (typeof obj !== "object") return false;

	if (
		"type" in obj &&
		obj.type === "image_generation_call" &&
		"result" in obj &&
		typeof obj.result === "string" &&
		!isBlobRef(obj.result) &&
		obj.result.length >= BLOB_EXTERNALIZE_THRESHOLD
	) {
		return true;
	}
	if (shouldExternalizeImagePayload(obj, key)) return true;

	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			if (needsPersistenceTraversal(obj[i], key)) return true;
		}
		return false;
	}

	const record = obj as Record<string, unknown>;
	for (const childKey in record) {
		if (!Object.hasOwn(record, childKey)) continue;
		if (childKey === "jsonlEvents") return true;
		if (needsPersistenceTraversal(record[childKey], childKey)) return true;
	}
	return false;
}

interface ExternalizedImage {
	data: string;
	mimeType: string | undefined;
	ref: string;
}

const externalizedImageRefs = new WeakMap<BlobStore, WeakMap<object, ExternalizedImage>>();

function externalizeImagePayloadSync(blobStore: BlobStore, payload: object, data: string, mimeType?: string): string {
	let refs = externalizedImageRefs.get(blobStore);
	const cached = refs?.get(payload);
	if (cached?.data === data && cached.mimeType === mimeType) return cached.ref;
	const ref = externalizeImageDataSync(blobStore, data, mimeType);
	if (!refs) {
		refs = new WeakMap();
		externalizedImageRefs.set(blobStore, refs);
	}
	refs.set(payload, { data, mimeType, ref });
	return ref;
}

/** Failed writes leave unreferenced blobs collectible; retry must check that they still exist. */
export function forgetExternalizedImages(blobStore: BlobStore): void {
	externalizedImageRefs.delete(blobStore);
}

function truncateForPersistence(obj: unknown, blobStore: BlobStore, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (
		typeof obj === "object" &&
		"type" in obj &&
		obj.type === "image_generation_call" &&
		"result" in obj &&
		typeof obj.result === "string" &&
		!isBlobRef(obj.result) &&
		obj.result.length >= BLOB_EXTERNALIZE_THRESHOLD
	) {
		return { ...obj, result: externalizeImagePayloadSync(blobStore, obj, obj.result) };
	}
	if (shouldExternalizeImagePayload(obj, key)) {
		return { ...obj, data: externalizeImagePayloadSync(blobStore, obj, obj.data, obj.mimeType) };
	}

	if (typeof obj === "object" && "type" in obj && obj.type === "anthropicServerTool" && "block" in obj) {
		const block = obj.block;
		if (typeof block === "object" && block !== null && "type" in block && typeof block.type === "string") {
			const validationView = {
				type: block.type,
				...("name" in block ? { name: block.name } : {}),
				...("id" in block ? { id: block.id } : {}),
				...("tool_use_id" in block ? { tool_use_id: block.tool_use_id } : {}),
				...("content" in block ? { content: block.content } : {}),
			};
			if (isAnthropicServerToolHistoryBlock(validationView)) return preserveReplaySubtree(obj, blobStore);
		}
	}
	// Anthropic server-side compaction state is validated byte-for-byte on replay; persist it whole, both as
	// a `providerPayload` and under its preserveData slot (whose object carries no `type` marker).
	if (
		typeof obj === "object" &&
		(("type" in obj && (obj.type === "anthropicCompaction" || obj.type === "cursorHistory")) ||
			(key === "anthropicCompaction" && "content" in obj && typeof obj.content === "string"))
	) {
		return preserveReplaySubtree(obj, blobStore);
	}
	if (typeof obj === "object" && "type" in obj) {
		const signed =
			(obj.type === "thinking" && "thinkingSignature" in obj && isNonEmptyString(obj.thinkingSignature)) ||
			(obj.type === "text" && "textSignature" in obj && isNonEmptyString(obj.textSignature)) ||
			(obj.type === "toolCall" && "thoughtSignature" in obj && isNonEmptyString(obj.thoughtSignature));
		const redacted = obj.type === "redactedThinking" && "data" in obj && isNonEmptyString(obj.data);

		const encryptedReasoning =
			obj.type === "reasoning" && "encrypted_content" in obj && isNonEmptyString(obj.encrypted_content);
		if (signed || redacted || encryptedReasoning) return preserveReplaySubtree(obj, blobStore);
	}

	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		if (obj.length > MAX_PERSIST_CHARS) {
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
				return obj;
			}
			const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
			return materializeString(`${truncateString(obj, limit)}${TRUNCATION_NOTICE}`);
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			const newItem = truncateForPersistence(item, blobStore, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const [childKey, value] of Object.entries(obj)) {
			if (childKey === "jsonlEvents") {
				changed = true;
				continue;
			}
			const newValue = truncateForPersistence(value, blobStore, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		if (!changed) return obj;

		const contentEntry = entries.find(([childKey]) => childKey === "content");
		const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
		if (
			contentEntry &&
			typeof contentEntry[1] === "string" &&
			lineCountEntry &&
			typeof lineCountEntry[1] === "number"
		) {
			const lineCount = countNewlines(contentEntry[1]) + 1;
			const updatedEntries = entries.map(([childKey, value]) =>
				childKey === "lineCount" ? ([childKey, lineCount] as const) : ([childKey, value] as const),
			);
			return Object.fromEntries(updatedEntries);
		}
		return Object.fromEntries(entries);
	}

	return obj;
}

function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	// State codec payloads are durable computation, not lossy transcript previews.
	if (
		entry.type === "custom" &&
		(entry.customType === "declared-state" || entry.customType === "python-store") &&
		entry.data &&
		typeof entry.data === "object"
	)
		return { ...entry, data: preserveReplaySubtree(entry.data, blobStore) };
	const stripped = stripReplayedReasoningSignatures(entry);
	if (!needsPersistenceTraversal(stripped)) return stripped;
	try {
		return truncateForPersistence(stripped, blobStore) as FileEntry;
	} catch (error) {
		// The walk probes fields such as `data` and `type` with `in` and plain
		// reads, so it also reaches non-enumerable and inherited accessors that
		// the JSONL line never holds. Tool `details` can keep a library object
		// whose getter throws (firecrawl-js `SearchData.data`). Left unhandled,
		// that latches a disk failure, and every later rewrite of the session
		// meets the same entry, so nothing persists for the rest of the process.
		// Retry once on the plain JSON of the entry: it holds the fields the
		// line would serialize, and no accessors.
		let json: string | undefined;
		try {
			json = stringifyJson(stripped);
		} catch {
			throw error;
		}
		if (json === undefined) throw error;
		try {
			return truncateForPersistence(JSON.parse(json), blobStore) as FileEntry;
		} catch {
			// A cause the clone does not remove (blob I/O) fails again: keep the
			// first error so the logged cause stays stable.
			throw error;
		}
	}
}
