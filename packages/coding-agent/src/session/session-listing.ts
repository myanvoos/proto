import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { forEachJsonlRecord, getSessionsDir, logger, parseJsonlLenient, toError } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { lookupSessionScan, lookupSessionTitle, recordSessionScan, recordSessionTitle } from "./session-index";
import { readSessionLiveState } from "./session-liveness";
import { computeDefaultSessionDir } from "./session-paths";
import { FileSessionStorage, type SessionStorage, type SessionStorageStat } from "./session-storage";

export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

export interface SessionInfo {
	path: string;
	id: string;

	cwd: string;
	title?: string;

	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/** Persisted assistant turns; zero means the agent never replied (0-turn session). */
	assistantTurns?: number;

	size: number;
	firstMessage: string;
	allMessagesText: string;

	status?: SessionStatus;

	liveOpen?: boolean;

	liveStreaming?: boolean;
}

interface ResolvedSessionMatch {
	session: SessionInfo;
	scope: "local" | "global";
}

export interface RecentSessionInfo {
	path: string;
	name: string;
	timeAgo: string;
}

const SESSION_LIST_PREFIX_BYTES = 4096;

const SESSION_LIST_SUFFIX_BYTES = 32_768;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;

const SESSION_SCAN_CACHE_MAX = 4096;

// Search text is a bounded prefix of the transcript. Unbounded accumulation retained a full copy
// of every transcript in memory (and in every persisted scan row); the history database's content
// search already covers matches that live deeper than this prefix.
const SESSION_SEARCH_TEXT_MAX_CHARS = 16_384;

const SESSION_SCAN_BOUNDARY_BYTES = 512;

interface SessionScanAccumulator {
	messageCount: number;
	assistantTurns: number;
	firstMessage: string;
	searchText: string;
	hasMessageText: boolean;
	shortSummary: string | undefined;
}

interface SessionScanResumeState {
	scannedBytes: number;
	prefixHash: string;
	boundaryHash: string;
	header: SessionListHeader;
	acc: SessionScanAccumulator;
}

interface SessionScanCacheEntry {
	mtimeMs: number;
	size: number;
	info: SessionInfo | undefined;
	resume?: SessionScanResumeState;
}

type SessionScanCache = LRUCache<string, SessionScanCacheEntry>;

const fileSessionScanCache: SessionScanCache = new LRUCache({ max: SESSION_SCAN_CACHE_MAX });

const kScanCache = Symbol("session-listing.scanCache");

interface StorageWithScanCache extends SessionStorage {
	[kScanCache]?: SessionScanCache;
}

function getSessionScanCache(storage: SessionStorage): SessionScanCache {
	if (storage instanceof FileSessionStorage) return fileSessionScanCache;
	const holder = storage as StorageWithScanCache;
	if (!holder[kScanCache]) holder[kScanCache] = new LRUCache({ max: SESSION_SCAN_CACHE_MAX });
	return holder[kScanCache];
}

function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function formatTimeAgo(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

function sessionDisplayName(info: SessionInfo): string {
	const title = sanitizeSessionName(info.title);
	if (title) return title;
	const first =
		info.firstMessage && info.firstMessage !== "(no messages)" ? sanitizeSessionName(info.firstMessage) : undefined;
	if (first) return first;
	const created = info.created.getTime();
	const ts = Number.isFinite(created) ? created : info.modified.getTime();
	const date = new Date(ts);
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `Untitled · ${time}`;
}

function extractTextFromContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const text: string[] = [];
	for (const block of content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join(" ");
}

function deriveSessionStatus(suffix: string): SessionStatus {
	if (!suffix) return "unknown";
	const lines = suffix.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];

		if (line.charCodeAt(0) !== 123) continue;
		let entry: { type?: string; message?: TailMessage };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message) {
			return statusFromTailMessage(entry.message);
		}
	}
	return "unknown";
}

export async function readLastAssistantText(sessionPath: string): Promise<string | undefined> {
	let suffix: string;
	try {
		const file = Bun.file(sessionPath);
		const size = file.size;
		const slice = await file.slice(Math.max(0, size - SESSION_LIST_SUFFIX_BYTES)).text();
		suffix = slice;
	} catch {
		return undefined;
	}
	const lines = suffix.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.charCodeAt(0) !== 123) continue;
		let entry: { type?: string; message?: TailMessage };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
		const text = extractTextFromContent((entry.message.content ?? []) as Message["content"]);
		if (text.trim().length === 0) continue;
		return text;
	}
	return undefined;
}

interface TailMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

function isToolCallBlock(block: unknown): boolean {
	return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall";
}

function statusFromTailMessage(message: TailMessage): SessionStatus {
	switch (message.role) {
		case "assistant": {
			switch (message.stopReason) {
				case "error":
					return "error";
				case "aborted":
					return "aborted";
				case "length":
					return "interrupted";
			}

			const content = message.content;
			if (Array.isArray(content) && content.some(isToolCallBlock)) return "interrupted";
			return "complete";
		}
		case "toolResult":
			return "interrupted";
		case "user":
			return "pending";
		default:
			return "unknown";
	}
}

function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;

	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;

	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;

	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) {
			return decodeJsonStringFragment(source.slice(valueStart, i));
		}
	}

	return decodeJsonStringFragment(source.slice(valueStart));
}

function extractFirstDisplayMessage(content: string): string | undefined {
	let fallback: string | undefined;
	let index = content.indexOf('"role"');

	while (index !== -1) {
		const role = extractStringProperty(content, "role", index);
		const text = extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
		if (text) {
			if (role === "user") return text;
			if (!fallback && (role === "developer" || role === "assistant")) fallback = text;
		}
		index = content.indexOf('"role"', index + 6);
	}

	return fallback;
}

interface SessionListHeader {
	type: "session";
	id: string;
	cwd?: string;
	title?: string;
	parentSession?: string;
	timestamp?: string;
}

function normalizeTitleOverride(title: string | undefined): string | null | undefined {
	if (title === undefined) return undefined;
	return title.trim() ? title : null;
}

function sessionListHeaderFromRecord(
	record: Record<string, unknown> | undefined,
	titleOverride?: string | null,
): SessionListHeader | undefined {
	if (record?.type !== "session" || typeof record.id !== "string") return undefined;
	return {
		type: "session",
		id: record.id,
		cwd: typeof record.cwd === "string" ? record.cwd : undefined,
		title:
			titleOverride === null
				? undefined
				: (titleOverride ?? (typeof record.title === "string" ? record.title : undefined)),
		parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
	};
}

function parseSessionListHeaderLine(line: string, titleOverride?: string | null): SessionListHeader | undefined {
	if (extractStringProperty(line, "type") !== "session") return undefined;
	const id = extractStringProperty(line, "id");
	if (!id) return undefined;
	return {
		type: "session",
		id,
		cwd: extractStringProperty(line, "cwd"),
		title: titleOverride === null ? undefined : (titleOverride ?? extractStringProperty(line, "title")),
		parentSession: extractStringProperty(line, "parentSession"),
		timestamp: extractStringProperty(line, "timestamp"),
	};
}

function parseSessionListHeader(
	content: string,
	entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
	const firstEntry = entries[0];
	const parsedSlotTitle = normalizeTitleOverride(
		firstEntry?.type === "title" && typeof firstEntry.title === "string" ? firstEntry.title : undefined,
	);
	const parsedHeader = sessionListHeaderFromRecord(entries[firstEntry?.type === "title" ? 1 : 0], parsedSlotTitle);
	if (parsedHeader) return parsedHeader;

	let slotTitle: string | null | undefined;
	let firstNonEmpty = true;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (firstNonEmpty && extractStringProperty(line, "type") === "title") {
			slotTitle = normalizeTitleOverride(extractStringProperty(line, "title"));
			firstNonEmpty = false;
			continue;
		}
		return parseSessionListHeaderLine(line, slotTitle);
	}
	return undefined;
}

function getSessionListWorkerCount(fileCount: number): number {
	if (fileCount <= SESSION_LIST_PARALLEL_THRESHOLD) return 1;
	return Math.min(
		SESSION_LIST_MAX_WORKERS,
		os.availableParallelism(),
		Math.ceil(fileCount / SESSION_LIST_PARALLEL_THRESHOLD),
	);
}

function attachSessionLiveState(info: SessionInfo, storage: SessionStorage): SessionInfo {
	if (!(storage instanceof FileSessionStorage)) return info;
	const live = readSessionLiveState(info.path);
	info.liveOpen = live.fresh;
	info.liveStreaming = live.fresh && live.streaming;
	return info;
}

function foldSessionEntry(acc: SessionScanAccumulator, raw: Record<string, unknown>): void {
	const entry = raw as { type?: string; message?: Message; shortSummary?: string };
	if (entry.type === "compaction" && typeof entry.shortSummary === "string") {
		acc.shortSummary = entry.shortSummary;
	}
	if (entry.type !== "message" || !entry.message) return;
	acc.messageCount++;
	if (entry.message.role === "assistant") acc.assistantTurns++;
	if (entry.message.role !== "user" && entry.message.role !== "assistant") return;
	const textContent = extractTextFromContent(entry.message.content);
	if (!textContent) return;
	if (acc.searchText.length < SESSION_SEARCH_TEXT_MAX_CHARS) {
		acc.searchText = (acc.hasMessageText ? `${acc.searchText} ${textContent}` : textContent).slice(
			0,
			SESSION_SEARCH_TEXT_MAX_CHARS,
		);
		acc.hasMessageText = true;
	}
	if (!acc.firstMessage && entry.message.role === "user") {
		acc.firstMessage = textContent.slice(0, SESSION_SEARCH_TEXT_MAX_CHARS);
	}
}

function foldSessionJsonl(acc: SessionScanAccumulator, chunk: string): number {
	const lastBreak = chunk.lastIndexOf("\n");
	if (lastBreak === -1) return 0;
	const complete = chunk.slice(0, lastBreak + 1);
	for (const entry of parseJsonlLenient<Record<string, unknown>>(complete)) foldSessionEntry(acc, entry);
	return Buffer.byteLength(complete, "utf8");
}

async function boundaryFingerprint(file: string, storage: SessionStorage, scannedBytes: number): Promise<string> {
	if (scannedBytes <= 0) return "";
	const start = Math.max(0, scannedBytes - SESSION_SCAN_BOUNDARY_BYTES);
	return Bun.hash(await storage.readTextRange(file, start, scannedBytes)).toString();
}

function loadPersistedResume(file: string): SessionScanResumeState | undefined {
	const row = lookupSessionScan(file);
	if (!row) return undefined;
	try {
		return JSON.parse(row.payload) as SessionScanResumeState;
	} catch {
		return undefined;
	}
}

async function resumableScanState(
	cached: SessionScanResumeState | undefined,
	file: string,
	storage: SessionStorage,
	size: number,
	prefixHash: string,
): Promise<SessionScanResumeState | undefined> {
	if (!cached || cached.prefixHash !== prefixHash || size < cached.scannedBytes) return undefined;
	// Resume states persisted before assistant turns were counted cannot answer 0-turn elision.
	if (typeof cached.acc.assistantTurns !== "number") return undefined;
	const boundaryHash = await boundaryFingerprint(file, storage, cached.scannedBytes);
	return boundaryHash === cached.boundaryHash ? cached : undefined;
}

async function scanSessionFile(file: string, storage: SessionStorage): Promise<SessionInfo | undefined> {
	let stat: SessionStorageStat;
	try {
		stat = storage.statSync(file);
	} catch {
		return undefined;
	}
	const cache = getSessionScanCache(storage);

	// One cache entry per file, not one per caller shape. `withStatus` only decides whether a bounded tail
	// read is turned into a status string; everything expensive — the full read, the JSONL fold, the
	// boundary fingerprint — is identical. Keying them apart made findMostRecentSession (withStatus=false)
	// and listSessions (withStatus=true) each pay the full cold scan for the same file in one process.
	const cacheKey = file;
	const cached = cache.get(cacheKey);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.info ? attachSessionLiveState({ ...cached.info }, storage) : undefined;
	}
	try {
		const [prefix, suffix] = await storage.readTextSlices(file, SESSION_LIST_PREFIX_BYTES, SESSION_LIST_SUFFIX_BYTES);
		const { size, mtime } = stat;
		const prefixHash = Bun.hash(prefix).toString();
		const resumeCandidate = cached?.resume ?? loadPersistedResume(file);
		const resume = await resumableScanState(resumeCandidate, file, storage, size, prefixHash);
		let scannedDelta = false;

		let header: SessionListHeader;
		let acc: SessionScanAccumulator;
		let scannedBytes: number;

		if (resume) {
			header = resume.header;
			acc = { ...resume.acc };
			scannedBytes = resume.scannedBytes;
			if (size > scannedBytes) {
				scannedBytes += foldSessionJsonl(acc, await storage.readTextRange(file, scannedBytes, size));
				scannedDelta = true;
			}
		} else {
			const content = size <= SESSION_LIST_PREFIX_BYTES ? prefix : await storage.readText(file);
			acc = {
				messageCount: 0,
				assistantTurns: 0,
				firstMessage: "",
				searchText: "",
				hasMessageText: false,
				shortSummary: undefined,
			};
			// Fold records as they parse instead of materializing the whole transcript; only the
			// first two records are retained for header detection. `foldSessionEntry` ignores
			// session/title records, so folding the header candidates too is a no-op.
			const headerProbe: Record<string, unknown>[] = [];
			forEachJsonlRecord<Record<string, unknown>>(content, raw => {
				if (headerProbe.length < 2) headerProbe.push(raw);
				foldSessionEntry(acc, raw);
			});
			const parsedHeader = parseSessionListHeader(content, headerProbe);
			if (!parsedHeader) {
				cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, info: undefined });
				return undefined;
			}
			header = parsedHeader;
			const lastBreak = content.lastIndexOf("\n");
			scannedBytes = lastBreak === -1 ? 0 : Buffer.byteLength(content.slice(0, lastBreak + 1), "utf8");
			acc.firstMessage ||= extractFirstDisplayMessage(content) ?? "";
		}

		const info: SessionInfo = {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? acc.shortSummary,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp ?? ""),
			modified: mtime,
			messageCount: acc.messageCount,
			assistantTurns: acc.assistantTurns,
			size,
			firstMessage: acc.firstMessage || "(no messages)",
			allMessagesText: acc.hasMessageText ? acc.searchText : acc.firstMessage,
			status: deriveSessionStatus(suffix),
		};

		const nextResume: SessionScanResumeState = {
			scannedBytes,
			prefixHash,
			boundaryHash: await boundaryFingerprint(file, storage, scannedBytes),
			header,
			acc: { ...acc },
		};
		cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, info: { ...info }, resume: nextResume });
		if (!resume || scannedDelta) {
			recordSessionScan(file, stat.size, stat.mtimeMs, JSON.stringify(nextResume));
		}
		return attachSessionLiveState(info, storage);
	} catch {
		return undefined;
	}
}

async function collectSessionsFromFileStride(
	files: string[],
	storage: SessionStorage,
	startIndex: number,
	stride: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];

	for (let i = startIndex; i < files.length; i += stride) {
		const session = await scanSessionFile(files[i], storage);
		if (session) sessions.push(session);
	}

	return sessions;
}

async function collectSessionsFromFiles(files: string[], storage: SessionStorage): Promise<SessionInfo[]> {
	const workerCount = getSessionListWorkerCount(files.length);
	const sessions =
		workerCount === 1
			? await collectSessionsFromFileStride(files, storage, 0, 1)
			: (
					await Promise.all(
						Array.from({ length: workerCount }, (_, workerIndex) =>
							collectSessionsFromFileStride(files, storage, workerIndex, workerCount),
						),
					)
				).flat();

	// Parallel strides finish in any order; tie-break equal mtimes so the listing is deterministic.
	sessions.sort(
		(a, b) =>
			b.modified.getTime() - a.modified.getTime() ||
			b.created.getTime() - a.created.getTime() ||
			b.path.localeCompare(a.path),
	);
	return sessions;
}

export async function recoverOrphanedBackups(sessionDir: string, storage: SessionStorage): Promise<void> {
	let backups: string[];
	try {
		backups = storage.listFilesSync(sessionDir, "*.bak");
	} catch {
		return;
	}
	if (backups.length === 0) return;

	const candidates = new Map<string, { backup: string; mtimeMs: number }>();
	for (const backup of backups) {
		const name = path.basename(backup);

		if (!name.endsWith(".bak")) continue;
		const trimmed = name.slice(0, -".bak".length);
		const dotIdx = trimmed.lastIndexOf(".");
		if (dotIdx <= 0) continue;
		const primaryName = trimmed.slice(0, dotIdx);
		if (!primaryName.endsWith(".jsonl")) continue;
		const primaryPath = path.join(sessionDir, primaryName);
		let mtimeMs = 0;
		try {
			mtimeMs = storage.statSync(backup).mtimeMs;
		} catch {
			continue;
		}
		const existing = candidates.get(primaryPath);
		if (!existing || mtimeMs > existing.mtimeMs) {
			candidates.set(primaryPath, { backup, mtimeMs });
		}
	}
	for (const [primaryPath, { backup }] of candidates) {
		if (storage.existsSync(primaryPath)) continue;
		try {
			await storage.rename(backup, primaryPath);
			logger.warn("Recovered orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
			});
		} catch (err) {
			logger.warn("Failed to recover orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
				error: toError(err).message,
			});
		}
	}
}

async function scanSessionDir(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	try {
		await recoverOrphanedBackups(sessionDir, storage);
		const files = storage.listFilesSync(sessionDir, "*.jsonl");
		return await collectSessionsFromFiles(files, storage);
	} catch {
		return [];
	}
}

async function scanSessionDirReadOnly(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	try {
		const files = storage.listFilesSync(sessionDir, "*.jsonl");
		return await collectSessionsFromFiles(files, storage);
	} catch {
		return [];
	}
}

export function listSessions(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDir(sessionDir, storage);
}

export function listSessionsReadOnly(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDirReadOnly(sessionDir, storage);
}

export async function listAllSessions(
	storage: SessionStorage = new FileSessionStorage(),
	sessionsRoot: string = getSessionsDir(),
): Promise<SessionInfo[]> {
	try {
		const files = await Array.fromAsync(new Bun.Glob("*/*.jsonl").scan(sessionsRoot), name =>
			path.join(sessionsRoot, name),
		);
		return await collectSessionsFromFiles(files, storage);
	} catch {
		return [];
	}
}

export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await scanSessionDir(sessionDir, storage);
	return sessions[0]?.path ?? null;
}

/**
 * True when a scanned session is a 0-turn stub with no display name: the tail shows no
 * assistant activity, no assistant record was persisted, and neither a title nor a first
 * prompt is worth showing. Covers header-only records (`newSession()` boundaries,
 * `ensureOnDisk()` stubs, drafts). A title or first prompt is user intent worth resuming,
 * so named 0-turn sessions stay discoverable. The pickers and `--continue` skip these;
 * every other consumer (GC, ACP, `resolveResumableSession`) keeps the unfiltered scan.
 */
export function isEmptySession(session: SessionInfo): boolean {
	if (session.status !== undefined && session.status !== "pending" && session.status !== "unknown") return false;
	if ((session.assistantTurns ?? 1) > 0) return false;
	if (sanitizeSessionName(session.title)) return false;
	if (sanitizeSessionName(session.firstMessage === "(no messages)" ? undefined : session.firstMessage)) return false;
	return true;
}

/** Picker-facing view of a session list: 0-turn empties dropped. */
export function filterSessionsForPicker(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.filter(session => !isEmptySession(session));
}

/** Most recent session with resumable content, skipping 0-turn empties. */
export async function findMostRecentNonEmptySession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await scanSessionDir(sessionDir, storage);
	return sessions.find(session => !isEmptySession(session))?.path ?? null;
}

function sessionIdFromSessionPath(file: string): string | undefined {
	const base = path.basename(file);
	if (!base.endsWith(".jsonl")) return undefined;
	const sep = base.lastIndexOf("_");
	if (sep <= 0) return undefined;
	return base.slice(sep + 1, -".jsonl".length) || undefined;
}

export async function getRecentSessions(
	sessionDir: string,
	limit = 4,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<RecentSessionInfo[]> {
	let files: string[];
	try {
		files = storage.listFilesSync(sessionDir, "*.jsonl");
	} catch {
		return [];
	}
	const byMtime: Array<{ file: string; stat: SessionStorageStat }> = [];
	for (const file of files) {
		try {
			byMtime.push({ file, stat: storage.statSync(file) });
		} catch {}
	}
	byMtime.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

	const useIndex = storage instanceof FileSessionStorage;
	const recent: RecentSessionInfo[] = [];
	for (const { file, stat } of byMtime) {
		if (recent.length >= limit) break;
		const id = useIndex ? sessionIdFromSessionPath(file) : undefined;
		const indexed = id ? lookupSessionTitle(id) : undefined;
		if (indexed) {
			recent.push({ path: file, name: indexed, timeAgo: formatTimeAgo(stat.mtime) });
			continue;
		}
		const info = await scanSessionFile(file, storage);
		if (!info || isEmptySession(info)) continue;
		const title = sanitizeSessionName(info.title);
		if (useIndex && title && info.id) recordSessionTitle(info.id, title);
		recent.push({ path: file, name: sessionDisplayName(info), timeAgo: formatTimeAgo(info.modified) });
	}
	return recent;
}

function sessionMatchesResumeArg(session: SessionInfo, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	const normalizedId = session.id.toLowerCase();
	if (normalizedId.startsWith(normalizedArg)) {
		return true;
	}

	const fileName = path.basename(session.path, ".jsonl").toLowerCase();
	if (fileName.startsWith(normalizedArg)) {
		return true;
	}

	const separator = fileName.lastIndexOf("_");
	if (separator < 0) {
		return false;
	}

	const fileSessionId = fileName.slice(separator + 1);
	return fileSessionId.startsWith(normalizedArg);
}

interface ResolveResumableSessionOptions {
	allowGlobalFallback?: boolean;
}

function isSessionStorage(value: SessionStorage | ResolveResumableSessionOptions): value is SessionStorage {
	return "listFilesSync" in value;
}

export async function resolveResumableSession(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	storageOrOptions: SessionStorage | ResolveResumableSessionOptions = new FileSessionStorage(),
	options: ResolveResumableSessionOptions = {},
): Promise<ResolvedSessionMatch | undefined> {
	const storage = isSessionStorage(storageOrOptions) ? storageOrOptions : new FileSessionStorage();
	const resolvedOptions = isSessionStorage(storageOrOptions) ? options : storageOrOptions;
	const localSessionDir = sessionDir ?? computeDefaultSessionDir(cwd, storage);
	const localSessions = await listSessions(localSessionDir, storage);
	const localMatch = localSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (localMatch) {
		return { session: localMatch, scope: "local" };
	}

	if (sessionDir && resolvedOptions.allowGlobalFallback !== true) {
		return undefined;
	}

	const globalSessions = await listAllSessions(storage);
	const globalMatch = globalSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (!globalMatch) {
		return undefined;
	}

	return { session: globalMatch, scope: "global" };
}
