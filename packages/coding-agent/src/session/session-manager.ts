import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deserialize, serialize } from "node:v8";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ServiceTierByFamily,
	TextContent,
	Usage,
} from "@oh-my-pi/pi-ai";
import {
	directoryExists,
	directoryIsEnterable,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	hasFsCode,
	isEexist,
	isEnoent,
	isEnotdir,
	isFsError,
	logger,
	moveFileAcrossDevices,
	pathIsWithin,
	stringifyJson,
	toError,
} from "@oh-my-pi/pi-utils";
import type { StructuredSubagentSchemaMode } from "../task/types";
import { ArtifactManager } from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore, sweepUnreferencedBlobs } from "./blob-store";
import type { CompactionMethod } from "./compaction-methods";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import { type BuildSessionContextOptions, buildSessionContext, type SessionContext } from "./session-context";
import {
	type BranchSummaryEntry,
	buildSubagentUsageEntryData,
	type CompactionEntry,
	type CredentialPinEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	emptyUsageStatistics,
	type FileEntry,
	type LabelEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	parseSubagentUsageEntry,
	type ResetBoundaryEntry,
	type ServiceTierChangeEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	SUBAGENT_USAGE_CUSTOM_TYPE,
	type SubagentUsageEntryData,
	type SubagentUsageTotals,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { recordSessionTitle } from "./session-index";
import {
	filterSessionsForPicker,
	findMostRecentNonEmptySession,
	isEmptySession,
	listAllSessions,
	listSessions,
	type SessionInfo,
} from "./session-listing";
import { claimSessionOwnership, liveSessionOwnerPid } from "./session-liveness";
import {
	loadSessionArchive,
	loadSessionFile,
	resolveBlobRefsInEntries,
	type SessionArchive,
	type SessionLoadResult,
	sessionArchivePath,
	visitEntriesFromFile,
} from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	hasPositiveMovedProjectEvidence,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	type SessionDirectoryError,
	sessionDirectoryError,
	writeTerminalBreadcrumb,
} from "./session-paths";
import { prepareEntryForPersistence } from "./session-persistence";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	SessionStorageLockError,
	type SessionStorageWriter,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	normalizeWorkspaceDirectory,
} from "./session-workspace";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;
const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";
const DISCARDED_ENTRY_BRANCH_MARKER = "discarded-entry-branch";
/** A record loaded from a hand-edited file may carry no id at all; never print "undefined". */
function describeEntryId(id: unknown): string {
	return typeof id === "string" && id.length > 0 ? `"${id}"` : "with no id";
}

const RAW_ENTRY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const RAW_ENTRY_CACHE_MAX_COUNT = 64;

interface CachedRawEntry {
	entry: SessionEntry;
	bytes: number;
}

interface RawEntryFile {
	name: string;
	bytes: number;
}

function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH);
}

export async function copySessionArtifacts(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
	const sourceArtifactsDir = artifactsDirectoryFor(sourceSessionFile);
	const destinationArtifactsDir = artifactsDirectoryFor(destinationSessionFile);
	if (!sourceArtifactsDir || !destinationArtifactsDir) return;
	if (path.resolve(sourceArtifactsDir) === path.resolve(destinationArtifactsDir)) return;

	try {
		const sourceStat = await fs.promises.stat(sourceArtifactsDir);
		if (sourceStat.isDirectory()) {
			await fs.promises.cp(sourceArtifactsDir, destinationArtifactsDir, { recursive: true });
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to copy artifacts during fork", {
				sourceArtifactsDir,
				destinationArtifactsDir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** The numeric id an artifact file name (`<id>.<tool>.log`) carries, if any. */
function artifactIdOf(name: string): string | undefined {
	return /^(\d+)\./.exec(name)?.[1];
}

/**
 * Move one directory entry without replacing anything that appeared at `to` since the caller
 * listed the destination. `link(2)` refuses an existing target where `rename(2)` would silently
 * overwrite it; where hard links are unavailable an exclusive copy keeps the same guarantee. A
 * directory rename only ever replaces an empty directory, which is harmless.
 */
async function moveEntryWithoutReplacing(from: string, to: string, isDirectory: boolean): Promise<void> {
	if (isDirectory) {
		await fs.promises.rename(from, to);
		return;
	}
	try {
		await fs.promises.link(from, to);
	} catch (err) {
		if (isEexist(err)) throw err;
		await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
	}
	try {
		await fs.promises.unlink(from);
	} catch (err) {
		// The entry has landed; a second copy left behind is not a failed move.
		if (!isEnoent(err)) logger.debug("Artifact placed but its source copy could not be removed", { from, to });
	}
}

/** What `destination` currently holds: entries by name, and the artifact ids already in use. */
async function destinationOccupancy(
	destination: string,
): Promise<{ occupants: Map<string, fs.Dirent>; takenIds: Set<string> }> {
	const present = await fs.promises.readdir(destination, { withFileTypes: true });
	const occupants = new Map(present.map(entry => [entry.name, entry]));
	const takenIds = new Set<string>();
	for (const entry of present) {
		const id = artifactIdOf(entry.name);
		if (id !== undefined) takenIds.add(id);
	}
	return { occupants, takenIds };
}

/**
 * Move `source`'s entries into `destination`, recursing into directories present on both sides,
 * then remove `source` once empty. Nothing at the destination is replaced: an entry whose name —
 * or, for `<id>.<tool>.log` artifacts, whose id — is taken stays at the source, as does one whose
 * move fails. Once moving has begun this never throws, so the caller is never left with a session
 * file rolled back away from artifacts that already moved. Returns the stranded entries.
 */
async function mergeDirectoryInto(
	source: string,
	destination: string,
	stranded: string[] = [],
	prefix = "",
): Promise<string[]> {
	let { occupants, takenIds } = await destinationOccupancy(destination);
	const strandedBefore = stranded.length;
	for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		const label = prefix + entry.name;
		const id = artifactIdOf(entry.name);
		try {
			// A writer can publish another `<id>.*` file while earlier entries move, and a different
			// name slips past link(2)'s EEXIST; re-list right before an id-bearing move.
			if (id !== undefined) ({ occupants, takenIds } = await destinationOccupancy(destination));
			const occupant = occupants.get(entry.name);
			if (occupant === undefined && (id === undefined || !takenIds.has(id))) {
				if (entry.isDirectory()) {
					try {
						await moveEntryWithoutReplacing(from, to, true);
					} catch (err) {
						if (!hasFsCode(err, "EXDEV")) throw err;
						await fs.promises.mkdir(to);
						await mergeDirectoryInto(from, to, stranded, `${label}/`);
					}
				} else {
					await moveEntryWithoutReplacing(from, to, false);
				}
			} else if (occupant?.isDirectory() && entry.isDirectory()) {
				await mergeDirectoryInto(from, to, stranded, `${label}/`);
			} else {
				stranded.push(`${label} (${occupant === undefined ? "id" : "name"} taken)`);
			}
		} catch (err) {
			// ENOENT: the entry vanished under us (a writer's temp file); nothing to move.
			if (!isEnoent(err)) stranded.push(`${label} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	try {
		await fs.promises.rmdir(source);
	} catch (err) {
		// Still occupied by a recorded collision, by an entry a writer landed mid-merge, or held open.
		if (!isEnoent(err) && (stranded.length === strandedBefore || !hasFsCode(err, "ENOTEMPTY"))) {
			stranded.push(`${prefix || "."} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	return stranded;
}

/**
 * Relocate a session's artifacts directory for {@link SessionManager.moveTo}.
 *
 * The destination may already exist: a session moving back into a bucket it lived in before finds
 * its own directory there whenever a writer that captured the old path (subagents sharing the
 * parent's ArtifactManager, eval subprocesses inheriting the artifacts env) kept writing after the
 * move away. Renaming onto an existing directory fails with a platform-specific code (ENOTEMPTY,
 * EEXIST, EPERM on Windows), so the fallback is decided by what is there: an existing real directory
 * is merged into, and a cross-device destination is created and merged into. Symlinks on either side
 * are never merged through.
 */
async function relocateArtifactsDirectory(source: string, destination: string): Promise<"renamed" | "merged"> {
	try {
		await fs.promises.rename(source, destination);
		return "renamed";
	} catch (err) {
		const [occupant, origin] = await Promise.all([
			fs.promises.lstat(destination).catch((statErr: unknown) => {
				if (isEnoent(statErr)) return null;
				throw err;
			}),
			fs.promises.lstat(source),
		]);
		if (occupant === null && origin.isDirectory() && hasFsCode(err, "EXDEV")) {
			await fs.promises.mkdir(destination);
		} else if (occupant === null || !occupant.isDirectory() || !origin.isDirectory()) {
			throw err;
		}
	}
	const stranded = await mergeDirectoryInto(source, destination);
	if (stranded.length > 0) {
		logger.warn("Merged session artifacts into an existing directory; some entries left at source", {
			source,
			destination,
			stranded,
		});
	} else {
		logger.info("Merged session artifacts into an existing directory", { source, destination });
	}
	return "merged";
}

function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);

	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = `${path.dirname(current)}.jsonl`;
		if (!fs.existsSync(parentSessionFile)) return current;
		current = parentSessionFile;
	}
	return current;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return message.role === "assistant" ? message.usage : undefined;
}

function addSubagentUsage(target: UsageStatistics, entry: SubagentUsageEntryData, agents: Set<string>): void {
	const subagent = target.subagent;
	subagent.input += entry.input;
	subagent.output += entry.output;
	subagent.cacheRead += entry.cacheRead;
	subagent.cacheWrite += entry.cacheWrite;
	subagent.totalTokens += entry.totalTokens;
	subagent.premiumRequests += entry.premiumRequests;
	subagent.cost += entry.cost;
	subagent.runs += 1;
	agents.add(entry.agentId);
	subagent.agents = agents.size;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "credential_pin":
			return true;
		default:
			return false;
	}
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#children = new Map<string | null, SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#leafPath: SessionEntry[] | undefined;
	#usage = emptyUsageStatistics();
	#subagentIds = new Set<string>();

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#leafPath = undefined;
		this.#usage = emptyUsageStatistics();
		this.#subagentIds.clear();
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
	}

	insert(entry: SessionEntry): void {
		this.#entriesById.set(entry.id, entry);
		if (this.#leafPath && entry.parentId === this.#leaf) this.#leafPath.push(entry);
		else this.#leafPath = undefined;
		this.#leaf = entry.id;

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		addUsage(this.#usage, entryUsage(entry));
		if (entry.type === "custom" && entry.customType === SUBAGENT_USAGE_CUSTOM_TYPE) {
			const subagentUsage = parseSubagentUsageEntry(entry.data);
			if (subagentUsage) addSubagentUsage(this.#usage, subagentUsage, this.#subagentIds);
		}
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		if (this.#leaf === id) return;
		this.#leaf = id;
		this.#leafPath = undefined;
	}

	childrenOf(parentId: string): SessionEntry[] {
		return [...(this.#children.get(parentId) ?? [])];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage, subagent: { ...this.#usage.subagent } };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		if (id === this.#leaf && this.#leafPath) return [...this.#leafPath];

		const branch: SessionEntry[] = [];
		const seen = new Set<string>();
		let cursor = id ? this.#entriesById.get(id) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		if (id === this.#leaf) this.#leafPath = [...branch];
		return branch;
	}

	pathToView(id: string | null | undefined = this.#leaf): readonly SessionEntry[] {
		if (id !== this.#leaf) return this.pathTo(id);
		if (!this.#leafPath) this.pathTo(id);
		return this.#leafPath ?? [];
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getRecordedCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getCustomEntryDataForMetadata"
	| "getTree"
	| "getUsageStatistics"
	| "getSubagentUsage"
	| "putBlob"
	| "putBlobSync"
>;

export interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	sessionFile: string | undefined;
	expectedDiskSize: number | null;
	titleUpdatedAt: string;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	draftOnlySessionCleanupArmed: boolean;
	fallbackRuntimeOnly: boolean;
	header: SessionHeader;
	entries: SessionEntry[];
	archivedEntryIds: string[];
	rawEntryFiles: Array<readonly [string, RawEntryFile]>;
	rawEntryDirectory: string | undefined;
	rawEntryDirectoryContents: Array<readonly [string, Uint8Array]>;
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

interface AtomicEntryBatch {
	collecting: boolean;
	entryIds: Set<string>;
	deferredNotifications: SessionEntry[];
	preBatchLeafId: string | null;
	externalLeafChanged: boolean;
	externalLeafId: string | null;
}

const BLOB_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastBlobSweepAt = 0;

export class SessionPersistenceIndeterminateError extends AggregateError {
	readonly operationError: Error;
	readonly recoveryErrors: readonly Error[];

	constructor(operationError: Error, recoveryErrors: readonly Error[]) {
		super(
			[operationError, ...recoveryErrors],
			`Session persistence is indeterminate after "${operationError.message}" and authoritative repair failed.`,
		);
		this.name = "SessionPersistenceIndeterminateError";
		this.operationError = operationError;
		this.recoveryErrors = [...recoveryErrors];
	}
}

/**
 * Thrown by {@link SessionManager.forkFrom} when the fork source is missing. The CLI maps it to a session-resolution
 * failure at its own boundary.
 */
export class ForkSourceNotFoundError extends Error {
	constructor(sourcePath: string) {
		super(`Session "${sourcePath}" not found.`);
		this.name = "ForkSourceNotFoundError";
	}
}

export class SessionManager {
	#cwd: string;

	#additionalDirectories: string[] = [];
	/**
	 * The runtime cwd diverges from the transcript's recorded project (resume into a denied/deleted cwd): workspace
	 * edits stay runtime-only and the next new/fork re-anchors the bucket to the runtime cwd.
	 */
	#fallbackRuntimeOnly = false;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;

	#sessionId = "";
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#titleRevision = 0;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entries: SessionEntry[] = [];
	#archivedEntryIds = new Set<string>();
	#index = new SessionEntryIndex();
	#rawEntryFiles = new Map<string, RawEntryFile>();
	#rawEntryDirectory: string | undefined;
	#rawEntryCache = new Map<string, CachedRawEntry>();
	#rawEntryCacheBytes = 0;

	#fileIsCurrent = false;

	#rewriteRequired = false;
	/**
	 * Byte length this manager last loaded or durably wrote (`null`: the path was absent). Every full rewrite replays it
	 * as a freshness precondition, so a stale in-memory view cannot erase turns another writer appended.
	 */
	#expectedDiskSize: number | null = null;

	#forceFileCreation = false;

	#draftOnlySessionCleanupArmed = false;

	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	#writer: SessionStorageWriter | undefined;

	#released = false;

	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	#lockContentionReported = false;

	#atomicPersistenceTail: Promise<void> = Promise.resolve();

	#pendingDurabilityNotifications: SessionEntry[] = [];

	#diskEpoch = 0;

	#atomicRewriteFenceEpoch: number | null = null;

	#atomicRewriteDirty = false;

	#sessionFileRelocating: { source: string; dest: string; copying?: boolean } | null = null;

	#atomicEntryBatch: AtomicEntryBatch | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;

	#breadcrumbFresh = false;
	#persistenceUnavailable: SessionDirectoryError | undefined;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#persistenceErrorCallbacks = new Set<(error: Error) => void>();
	#historyDegradedCallbacks = new Set<(message: string) => void>();
	#historyDegradedReported = false;

	private constructor(cwd: string, sessionDir: string, persist: boolean, storage: SessionStorage) {
		this.#cwd = cwd;
		this.#sessionDir = sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		this.#blobs = new BlobStore(getBlobsDir());

		if (persist && sessionDir) {
			try {
				this.#storage.ensureDirSync(sessionDir);
			} catch (error) {
				throw sessionDirectoryError(sessionDir, error);
			}
		}
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
		if (!this.#persist) return;
		this.#breadcrumbFresh = fresh;
		if (!this.#suppressBreadcrumb) writeTerminalBreadcrumb(cwd, sessionFile, fresh);
	}

	#materializeBreadcrumb(): void {
		if (!this.#breadcrumbFresh || !this.#sessionFile) return;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, false);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		// Lock contention is retryable, so it never latches a permanent disk failure —
		// but it must never be silent either: another live process holding the file
		// would otherwise drop every entry without a trace.
		if (error instanceof SessionStorageLockError) {
			this.#noteLockContention(error);
			return error;
		}
		if (!this.#diskFailure) this.#diskFailure = error;

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
			for (const callback of this.#persistenceErrorCallbacks) {
				try {
					callback(error);
				} catch (callbackError) {
					logger.warn("Session persistence error observer failed", {
						error: toError(callbackError).message,
					});
				}
			}
		}

		return this.#diskFailure;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return;
				if (this.#diskFailure && !options.ignorePriorError) throw this.#diskFailure;
				await work();
			});

		const reported = scheduled.catch(err => {
			throw this.#noteDiskFailure(err);
		});
		this.#diskTail = reported.catch(() => undefined);
		return reported;
	}

	async #withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#atomicPersistenceTail;
		const turn = Promise.withResolvers<void>();
		this.#atomicPersistenceTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignorePriorError: true, ignoreEpoch: true },
			);
		} finally {
			this.#writer = undefined;
			this.#diskTail = Promise.resolve();
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		if (writer) void writer.close().catch(() => undefined);
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		await writer.close();
	}

	#latchIndeterminate(operationError: Error, recoveryErrors: readonly Error[]): SessionPersistenceIndeterminateError {
		const error = new SessionPersistenceIndeterminateError(operationError, recoveryErrors);
		this.#diskFailure = error;
		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence became indeterminate.", {
				sessionFile: this.#sessionFile,
				error: error.message,
			});
		}
		return error;
	}

	#notifyDurableEntries(entries: readonly SessionEntry[] = []): void {
		const notifications = [...this.#pendingDurabilityNotifications, ...entries];
		this.#pendingDurabilityNotifications = [];
		const seen = new Set<string>();
		for (const entry of notifications) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			this.#notifyEntryAppended(entry);
		}
	}

	async #authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		if (this.#released) {
			logger.warn("Skipped authoritative session repair after terminal release", {
				error: String(operationError),
			});
			return;
		}
		if (!this.#persist || !this.#sessionFile) return;
		const previousDiskTail = this.#diskTail;
		const writer = this.#writer;
		this.#diskEpoch++;
		const epoch = this.#diskEpoch;
		this.#writer = undefined;
		this.#diskTail = Promise.resolve();
		this.#forceFileCreation = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#atomicRewriteFenceEpoch = epoch;
		if (!this.#diskFailure) this.#diskFailure = operationError;
		try {
			await previousDiskTail.catch(() => undefined);
			let closeError: Error | undefined;
			if (writer) {
				try {
					await writer.close();
				} catch (error) {
					closeError = toError(error);
				}
			}
			let drainError: Error | undefined;
			try {
				await this.#storage.drain();
			} catch (error) {
				drainError = toError(error);
			}
			if (writer?.isOpen()) {
				throw this.#latchIndeterminate(operationError, [
					closeError ?? new Error("Failed to close session writer before authoritative repair."),
					...(drainError ? [drainError] : []),
				]);
			}

			do {
				this.#atomicRewriteDirty = false;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Session file disappeared during authoritative repair."),
					]);
				}
				const body = this.#fileBody();
				try {
					await this.#storage.writeTextAtomic(sessionFile, body, {
						expectedSize: this.#expectedDiskSize,
						commitGuard: () => !this.#released && this.#diskEpoch === epoch,
					});
				} catch (error) {
					const recoveryErrors = [toError(error)];
					try {
						await this.#storage.drain();
					} catch (drainFailure) {
						recoveryErrors.push(toError(drainFailure));
					}
					let actual: string;
					try {
						actual = await this.#storage.readText(sessionFile);
					} catch (readFailure) {
						recoveryErrors.push(toError(readFailure));
						throw this.#latchIndeterminate(operationError, recoveryErrors);
					}
					if (actual !== body) {
						recoveryErrors.push(new Error("Authoritative session repair did not match durable storage."));
						throw this.#latchIndeterminate(operationError, recoveryErrors);
					}
				}
				this.#recordFullRewrite(body);
				if (this.#diskEpoch !== epoch) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Authoritative session repair was superseded before verification."),
					]);
				}
			} while (this.#atomicRewriteDirty);

			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
			this.#clearDiskError();
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) throw error;
			throw this.#latchIndeterminate(operationError, [toError(error)]);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		if (this.#writer?.isOpen()) return this.#writer;

		this.#writer = this.#storage.openWriter(this.#sessionFile, {
			flags: "a",
			onError: err => this.#noteDiskFailure(err),
		});
		return this.#writer;
	}

	#rawEntryDirectoryPath(): string {
		this.#rawEntryDirectory ??= path.join(os.tmpdir(), `proto-session-history-${Bun.randomUUIDv7()}`);
		return this.#rawEntryDirectory;
	}

	#ensureRawEntryDirectory(): string {
		const directory = this.#rawEntryDirectoryPath();
		fs.mkdirSync(directory, { recursive: true });
		return directory;
	}

	#retentionBlobStore(): BlobStore {
		if (this.#persist) return this.#blobs;
		return new BlobStore(path.join(this.#rawEntryDirectoryPath(), "blobs"));
	}

	#clearRawEntryRetention(): void {
		this.#rawEntryFiles.clear();
		this.#rawEntryCache.clear();
		this.#rawEntryCacheBytes = 0;
	}

	#disposeRawEntryDirectory(): void {
		const directory = this.#rawEntryDirectory;
		this.#rawEntryDirectory = undefined;
		if (!directory) return;
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch (error) {
			logger.warn("Failed to remove lazy session history directory", {
				directory,
				error: toError(error).message,
			});
		}
	}

	#cacheRawEntry(entry: SessionEntry, bytes: number): void {
		const existing = this.#rawEntryCache.get(entry.id);
		if (existing) {
			this.#rawEntryCache.delete(entry.id);
			this.#rawEntryCacheBytes -= existing.bytes;
		}
		if (bytes > RAW_ENTRY_CACHE_MAX_BYTES) return;

		this.#rawEntryCache.set(entry.id, { entry, bytes });
		this.#rawEntryCacheBytes += bytes;
		while (
			this.#rawEntryCache.size > RAW_ENTRY_CACHE_MAX_COUNT ||
			this.#rawEntryCacheBytes > RAW_ENTRY_CACHE_MAX_BYTES
		) {
			const oldestId = this.#rawEntryCache.keys().next().value;
			if (oldestId === undefined) break;
			const oldest = this.#rawEntryCache.get(oldestId);
			this.#rawEntryCache.delete(oldestId);
			if (oldest) this.#rawEntryCacheBytes -= oldest.bytes;
		}
	}

	#retainEntry(entry: SessionEntry): SessionEntry {
		const retained = prepareEntryForPersistence(entry, this.#retentionBlobStore()) as SessionEntry;
		if (retained === entry) return retained;
		// Spill files are keyed by entry id. A record loaded from a hand-edited session file may
		// have none: keeping it whole in memory is cheaper than a key two such records would share.
		if (typeof entry.id !== "string" || entry.id.length === 0) return entry;

		const serialized = serialize(entry);
		const compressed = gzipSync(serialized, { level: 1 });
		const name = `${new Bun.SHA256().update(compressed).digest("hex")}.entry.gz`;
		const file = path.join(this.#ensureRawEntryDirectory(), name);
		if (!fs.existsSync(file)) fs.writeFileSync(file, compressed);
		this.#rawEntryFiles.set(entry.id, { name, bytes: serialized.byteLength });
		this.#cacheRawEntry(deserialize(serialized) as SessionEntry, serialized.byteLength);
		return retained;
	}

	/**
	 * Oversized entries live in a per-process temp file that the session file on disk does not
	 * need: it already holds the truncated copy. Losing that cache — a temp cleaner, a corrupt
	 * file, a released directory — therefore costs fidelity for one entry, never the session.
	 * Forget the mapping, say so once, and carry on with the retained copy.
	 */
	#degradeRawEntry(entry: SessionEntry, file: string | undefined, problem: string, cause?: unknown): SessionEntry {
		const cached = this.#rawEntryCache.get(entry.id);
		if (cached) {
			this.#rawEntryCache.delete(entry.id);
			this.#rawEntryCacheBytes -= cached.bytes;
		}
		this.#rawEntryFiles.delete(entry.id);

		const sessionFile = this.#sessionFile;
		const where = sessionFile ? ` of session "${sessionFile}"` : "";
		const located = file ? ` (${file})` : "";
		const message =
			`Cannot read back oversized ${entry.type} entry ${describeEntryId(entry.id)}${where}: ${problem}${located}. ` +
			"The session file was not modified and the session keeps running; that entry is now shown in its " +
			"truncated form. Full copies of oversized entries live in the system temp directory as " +
			"proto-session-history-* for the lifetime of the process: exclude that pattern from temp cleanup to " +
			"keep them.";
		logger.warn("Oversized session entry cache lost; using the truncated copy", {
			entryId: entry.id,
			file,
			problem,
			error: cause === undefined ? undefined : toError(cause).message,
		});
		if (!this.#historyDegradedReported) {
			this.#historyDegradedReported = true;
			for (const callback of this.#historyDegradedCallbacks) {
				try {
					callback(message);
				} catch (callbackError) {
					logger.warn("Session history degradation observer failed", { error: toError(callbackError).message });
				}
			}
		}
		return entry;
	}

	#materializeEntry(entry: SessionEntry, cache = true): SessionEntry {
		const rawFile = this.#rawEntryFiles.get(entry.id);
		if (!rawFile) return entry;

		const cached = this.#rawEntryCache.get(entry.id);
		if (cached) {
			if (cache) {
				this.#rawEntryCache.delete(entry.id);
				this.#rawEntryCache.set(entry.id, cached);
			}
			return cached.entry;
		}

		const directory = this.#rawEntryDirectory;
		if (!directory) return this.#degradeRawEntry(entry, undefined, "its temporary copy was already released");
		const file = path.join(directory, rawFile.name);
		let compressed: Buffer;
		try {
			compressed = fs.readFileSync(file);
		} catch (error) {
			return this.#degradeRawEntry(entry, file, "its temporary copy is gone", error);
		}
		let parsed: unknown;
		try {
			parsed = deserialize(gunzipSync(compressed));
		} catch (error) {
			return this.#degradeRawEntry(entry, file, "its temporary copy is corrupt", error);
		}
		if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) {
			return this.#degradeRawEntry(entry, file, "its temporary copy holds no session entry");
		}
		if (parsed.id !== entry.id) {
			return this.#degradeRawEntry(
				entry,
				file,
				`its temporary copy holds a different entry (${describeEntryId(parsed.id)})`,
			);
		}
		const materialized = parsed as SessionEntry;
		if (cache) this.#cacheRawEntry(materialized, rawFile.bytes);
		return materialized;
	}

	#materializeEntries(entries: readonly SessionEntry[]): SessionEntry[] {
		if (this.#rawEntryFiles.size === 0) return [...entries];
		const materialized = entries.map(entry => this.#materializeEntry(entry, false));
		this.#rawEntryCache.clear();
		this.#rawEntryCacheBytes = 0;

		const candidates: SessionEntry[] = [];
		let candidateBytes = 0;
		for (let index = materialized.length - 1; index >= 0; index--) {
			const entry = materialized[index];
			const rawFile = this.#rawEntryFiles.get(entry.id);
			if (!rawFile || rawFile.bytes > RAW_ENTRY_CACHE_MAX_BYTES) continue;
			if (
				candidates.length >= RAW_ENTRY_CACHE_MAX_COUNT ||
				candidateBytes + rawFile.bytes > RAW_ENTRY_CACHE_MAX_BYTES
			) {
				break;
			}
			candidates.push(entry);
			candidateBytes += rawFile.bytes;
		}
		for (let index = candidates.length - 1; index >= 0; index--) {
			const entry = candidates[index];
			this.#cacheRawEntry(entry, this.#rawEntryFiles.get(entry.id)!.bytes);
		}
		return materialized;
	}

	#replaceEntries(entries: readonly SessionEntry[]): void {
		this.#disposeRawEntryDirectory();
		this.#clearRawEntryRetention();
		this.#entries = entries.map(entry => this.#retainEntry(entry));
		this.#index.rebuild(this.#entries);
	}

	#restoreRetainedEntries(
		entries: readonly SessionEntry[],
		rawEntryFiles: Iterable<readonly [string, RawEntryFile]>,
		directoryContents: readonly (readonly [string, Uint8Array])[],
	): void {
		this.#disposeRawEntryDirectory();
		this.#clearRawEntryRetention();
		this.#entries = [...entries];
		if (directoryContents.length > 0) {
			const targetDirectory = this.#ensureRawEntryDirectory();
			for (const [relativePath, bytes] of directoryContents) {
				const target = path.join(targetDirectory, relativePath);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, bytes);
			}
		}
		for (const [id, file] of rawEntryFiles) this.#rawEntryFiles.set(id, { ...file });
		this.#index.rebuild(this.#entries);
	}

	#lineFor(entry: FileEntry): string {
		return `${stringifyJson(prepareEntryForPersistence(entry, this.#blobs)) ?? "null"}\n`;
	}

	#titleSlotLine(): string {
		return serializeTitleSlot({
			title: this.#sessionName,
			source: this.#titleSource,
			updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
		});
	}

	#recordDurableAppend(line: string): void {
		this.#expectedDiskSize = (this.#expectedDiskSize ?? 0) + Buffer.byteLength(line, "utf8");
	}

	#recordFullRewrite(body: string): void {
		this.#expectedDiskSize = Buffer.byteLength(body, "utf8");
	}

	#fileBody(): string {
		let body = this.#titleSlotLine();
		body += this.#lineFor(this.#header);
		for (const entry of this.#entries) {
			if (!this.#archivedEntryIds.has(entry.id)) body += this.#lineFor(entry);
		}
		return body;
	}

	#noteLockContention(error: SessionStorageLockError): void {
		if (this.#lockContentionReported) return;
		this.#lockContentionReported = true;
		const ownerPid = this.#sessionFile ? liveSessionOwnerPid(this.#sessionFile) : undefined;
		logger.warn("Session file is locked by another process; entries stay in memory until it is released.", {
			sessionFile: this.#sessionFile,
			ownerPid,
		});
		const reported = new Error(
			ownerPid === undefined
				? `session file is locked by another process: ${error.message}`
				: `session file is locked by another proto process (pid ${ownerPid})`,
			{ cause: error },
		);
		for (const callback of this.#persistenceErrorCallbacks) {
			try {
				callback(reported);
			} catch (callbackError) {
				logger.warn("Session persistence error observer failed", { error: toError(callbackError).message });
			}
		}
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	#liveRelocationWritePath(): string | null {
		const relocating = this.#sessionFileRelocating;
		if (!relocating) return null;
		// A cross-device copy keeps the source authoritative until the copy is published.
		if (relocating.copying && this.#storage.existsSync(relocating.source)) return relocating.source;
		if (this.#storage.existsSync(relocating.dest)) return relocating.dest;
		if (this.#storage.existsSync(relocating.source)) return relocating.source;

		return relocating.dest;
	}

	#rewriteSynchronously(): void {
		if (this.#released) return;
		if (!this.#persist || !this.#shouldHaveSessionFile()) return;
		const targetPath = this.#liveRelocationWritePath() ?? this.#sessionFile;
		if (!targetPath) return;

		try {
			const body = this.#fileBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			this.#storage.writeTextSync(targetPath, body, { expectedSize: this.#expectedDiskSize });
			this.#recordFullRewrite(body);
			this.#clearDiskError();

			if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
				this.#fileIsCurrent = true;
				this.#materializeBreadcrumb();
				this.#rewriteRequired = false;
				this.#hasTitleSlot = true;
			} else {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#hasTitleSlot = true;
			}
		} catch (err) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#noteDiskFailure(err);
		}
	}

	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#released) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch)) {
					this.#lockContentionReported = false;
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	async #runFencedAtomicRewrite(epoch: number): Promise<boolean> {
		if (this.#released) return false;
		this.#atomicRewriteFenceEpoch = epoch;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return false;
				if (this.#diskEpoch !== epoch) return false;
				const body = this.#fileBody();
				try {
					await this.#storage.writeTextAtomic(sessionFile, body, {
						expectedSize: this.#expectedDiskSize,
						commitGuard: () => !this.#released && this.#diskEpoch === epoch,
					});
				} catch (error) {
					try {
						if ((await this.#storage.readText(sessionFile)) === body) this.#recordFullRewrite(body);
					} catch {
						// Preserve the publish error when durable state cannot be read back.
					}
					throw error;
				}
				if (this.#diskEpoch !== epoch) return false;
				this.#recordFullRewrite(body);
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (this.#released || !this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		if (this.#diskFailure) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
		}

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#atomicRewriteDirty = true;
			this.#rewriteSynchronously();
			return;
		}

		if (!this.#fileIsCurrent || this.#rewriteRequired) {
			this.#rewriteSynchronously();
			return;
		}

		try {
			const writer = this.#appendWriter();
			const line = this.#lineFor(entry);
			if (writer.appendSync) {
				writer.appendSync(line);
				this.#recordDurableAppend(line);
			} else {
				void writer
					.append(line)
					.then(() => this.#recordDurableAppend(line))
					.catch(err => {
						this.#fileIsCurrent = false;
						this.#rewriteRequired = true;
						this.#noteDiskFailure(err);
					});
			}
		} catch (err) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#noteDiskFailure(err);
		}
	}

	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#rewriteSynchronously();
			if (this.#diskFailure) throw this.#diskFailure;
			return;
		}

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}

		if (
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			!this.#hasTitleSlot ||
			!this.#storage.existsSync(this.#sessionFile)
		) {
			await this.#rewriteAtomically();
			return;
		}

		const epoch = this.#diskEpoch;
		const line = this.#lineFor(entry);
		await this.#scheduleDiskWork(
			async () => {
				if (this.#released) return;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				try {
					await this.#appendWriter().append(line);
					this.#recordDurableAppend(line);
					await this.#closeWriterHandle();
					await this.#storage.updateSessionTitle(sessionFile, update);
					if (this.#diskEpoch === epoch) this.#fileIsCurrent = true;
				} catch (error) {
					if (error instanceof SessionStorageLockError) {
						this.#fileIsCurrent = false;
						this.#rewriteRequired = true;
						throw error;
					}
					if (!(await this.#runFencedAtomicRewrite(epoch))) return;
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch },
		);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("entry hook failed", { error: String(err) });
			}
		}
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#expectedDiskSize = null;
		this.#reconcileSessionDirForFallback();
		this.#sessionId = mintSessionId();
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
		};
		const workspace = normalizeSessionWorkspace({
			cwd: this.#cwd,
			directories: options?.additionalDirectories ?? [],
		});
		this.#additionalDirectories = additionalWorkspaceDirectories(workspace);
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = [...this.#additionalDirectories];
		}
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#archivedEntryIds.clear();
		this.#index.clear();
		this.#disposeRawEntryDirectory();
		this.#clearRawEntryRetention();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, true);
		} else {
			this.#sessionFile = undefined;
		}

		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[]): void {
		this.#header = header;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = header.timestamp;
		this.#replaceEntries(entries);
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string } {
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
		};
	}

	#setLeaf(id: string | null): void {
		this.#index.setLeaf(id);
		const batch = this.#atomicEntryBatch;
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = id;
		}
	}

	#recordEntry(entry: SessionEntry): void {
		if (this.#released) {
			logger.warn("Dropped session entry appended after terminal release", { type: entry.type });
			return;
		}
		this.#archivedEntryIds.delete(entry.id);
		const retained = this.#retainEntry(entry);
		this.#entries.push(retained);
		this.#index.insert(retained);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = entry.id;
		}
		this.#appendToSessionFile(retained);
		if (batch) batch.deferredNotifications.push(entry);
		else this.#notifyEntryAppended(entry);
	}

	#rollbackAtomicEntryBatch(batch: AtomicEntryBatch): void {
		const retainedAncestor = (id: string | null): string | null => {
			const seen = new Set<string>();
			while (id && batch.entryIds.has(id) && !seen.has(id)) {
				seen.add(id);
				id = this.#index.get(id)?.parentId ?? null;
			}
			return id;
		};
		const retained = this.#materializeEntries(this.#entries.filter(entry => !batch.entryIds.has(entry.id)));
		for (const entry of retained) entry.parentId = retainedAncestor(entry.parentId);
		const restoredLeaf = retainedAncestor(batch.externalLeafChanged ? batch.externalLeafId : batch.preBatchLeafId);
		this.#replaceEntries(retained);
		this.#index.setLeaf(restoredLeaf && this.#index.has(restoredLeaf) ? restoredLeaf : null);
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsSync(markerPath);
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#artifactManagerForSession(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		this.#artifactManager = new ArtifactManager(sessionFile.slice(0, -JSONL_SUFFIX_LENGTH));
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of [...this.#sessionNameChangedCallbacks]) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	async sweepBlobs(): Promise<void> {
		if (!this.#persist || Date.now() - lastBlobSweepAt < BLOB_SWEEP_INTERVAL_MS) return;
		lastBlobSweepAt = Date.now();
		await sweepUnreferencedBlobs(this.#blobs.dir, getSessionsDir());
	}

	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	#captureRawEntryDirectoryContents(): Array<readonly [string, Uint8Array]> {
		const directory = this.#rawEntryDirectory;
		if (!directory || !fs.existsSync(directory)) return [];
		const contents: Array<readonly [string, Uint8Array]> = [];
		const visit = (current: string, relative = ""): void => {
			for (const item of fs.readdirSync(current, { withFileTypes: true })) {
				const childRelative = path.join(relative, item.name);
				const child = path.join(current, item.name);
				if (item.isDirectory()) visit(child, childRelative);
				else if (item.isFile()) contents.push([childRelative, fs.readFileSync(child)]);
			}
		};
		visit(directory);
		return contents;
	}

	captureState(): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			expectedDiskSize: this.#expectedDiskSize,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			fallbackRuntimeOnly: this.#fallbackRuntimeOnly,
			// Cloned, unlike entries: moveTo mutates the header in place (cwd, additionalDirectories), so a captured
			// reference would let a rollback observe the move it is undoing.
			header: structuredClone(this.#header),
			entries: [...this.#entries],
			archivedEntryIds: [...this.#archivedEntryIds],
			rawEntryFiles: [...this.#rawEntryFiles].map(([id, file]) => [id, { ...file }]),
			rawEntryDirectory: this.#rawEntryDirectory,
			rawEntryDirectoryContents: this.#captureRawEntryDirectoryContents(),
		};
	}

	cloneCurrentSession(options?: { persist?: boolean }): SessionManager {
		const persist = options?.persist ?? this.#persist;
		const clone = new SessionManager(this.#cwd, this.#sessionDir, persist, this.#storage);
		clone.#suppressBreadcrumb = true;
		clone.restoreState(this.captureState());
		if (persist !== this.#persist) clone.#replaceEntries(this.getEntries());
		if (!persist) {
			clone.#sessionFile = undefined;
			clone.#expectedDiskSize = null;
			clone.#fileIsCurrent = false;
			clone.#rewriteRequired = false;
			clone.#forceFileCreation = false;
		}
		return clone;
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#expectedDiskSize = snapshot.expectedDiskSize;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#fallbackRuntimeOnly = snapshot.fallbackRuntimeOnly;
		this.#header = snapshot.header;
		this.#sessionId = snapshot.header.id;
		this.#restoreRetainedEntries(snapshot.entries, snapshot.rawEntryFiles, snapshot.rawEntryDirectoryContents);
		this.#archivedEntryIds = new Set(snapshot.archivedEntryIds ?? []);
		this.#additionalDirectories = snapshot.header.additionalDirectories ?? [];
		this.#sessionName = snapshot.sessionName;
		this.#titleSource = snapshot.titleSource;
		this.#titleUpdatedAt = snapshot.titleUpdatedAt;
		this.#hasTitleSlot = snapshot.hasTitleSlot;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Undo a {@link moveTo} from a {@link captureState} snapshot: relocate the transcript and artifacts back into the
	 * captured bucket, then restore the captured metadata (cwd, header, workspace roots) and persist it so a fresh open
	 * sees the pre-move header. Bypasses AgentSession so rollback never re-enters forward-move hooks. When the
	 * relocation back fails the manager stays on the moved file (restoring would split the transcript) and the error
	 * names where it actually lives.
	 */
	async rollbackMove(snapshot: SessionManagerStateSnapshot): Promise<void> {
		try {
			const targetSessionDir = snapshot.sessionFile ? path.dirname(snapshot.sessionFile) : snapshot.sessionDir;
			await this.moveTo(snapshot.cwd, targetSessionDir);
		} catch (error) {
			throw new Error(
				`could not relocate the session back to ${snapshot.sessionDir} (${error instanceof Error ? error.message : String(error)}); the session file remains at ${this.getSessionFile()}`,
			);
		}
		// The inverse moveTo already rewrote the restored file; restoreState would reset the freshness token to the
		// pre-move size, and the final rewrite would then reject an otherwise successful rollback.
		const relocatedDiskSize = this.#expectedDiskSize;
		this.restoreState(snapshot);
		if (this.#persist && this.#sessionFile) {
			this.#expectedDiskSize = relocatedDiskSize;
			this.#forceFileCreation = true;
			this.#rewriteRequired = true;
			await this.#rewriteAtomically();
		}
	}

	async setSessionFile(sessionFile: string): Promise<void> {
		await this.#setSessionFile(sessionFile);
	}

	async #setSessionFile(
		sessionFile: string,
		loadedSession?: SessionLoadResult,
		newSessionOptions?: NewSessionOptions,
		failIfEmpty = false,
	): Promise<void> {
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;

		const resolvedSessionFile = path.resolve(sessionFile);
		// Nonpersistent sessions may import a selected disk transcript without
		// changing their write backend or acquiring the source's persistence target.
		const readStorage =
			!this.#persist &&
			this.#storage instanceof MemorySessionStorage &&
			!this.#storage.existsSync(resolvedSessionFile)
				? new FileSessionStorage()
				: this.#storage;
		const loaded = loadedSession ?? (await loadSessionFile(resolvedSessionFile, readStorage));
		const sourceSize =
			loaded.sourceSize !== undefined
				? loaded.sourceSize
				: readStorage.existsSync(resolvedSessionFile)
					? readStorage.statSync(resolvedSessionFile).size
					: null;
		if (loaded.invalidHeader) {
			throw new Error(
				`Cannot resume session "${resolvedSessionFile}": the session header is missing or malformed. The file was not modified.`,
			);
		}
		if (loaded.malformedCompleteRecords > 0) {
			throw new Error(
				`Cannot resume session "${resolvedSessionFile}": found ${loaded.malformedCompleteRecords} malformed complete record(s). The file was not modified.`,
			);
		}
		// Fail-closed callers (revive) must not mint a fresh session over a transcript that is gone or empty.
		if (failIfEmpty && loaded.entries.length === 0) {
			throw new Error(
				`Cannot resume session "${resolvedSessionFile}": the session file holds no entries. The file was not modified.`,
			);
		}

		this.#sessionFile = this.#persist ? resolvedSessionFile : undefined;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const { entries: fileEntries, titleSlot } = loaded;
		this.#archivedEntryIds = new Set(loaded.archivedEntryIds ?? []);
		if (fileEntries.length === 0) {
			this.#resetToNewSession(newSessionOptions, resolvedSessionFile);
			this.#expectedDiskSize = sourceSize;
			this.#forceFileCreation = this.#persist;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = this.#persist;
			return;
		}

		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);

		const header = fileEntries[0] as SessionHeader;

		// Adopt the loaded session's project only when it can be entered: a deleted or permission-denied directory
		// (macOS TCC) would leave callers without a cwd-change callback (extension UI, RPC) tracking a directory the
		// process cannot enter. Otherwise keep the runtime cwd and mark the fallback.
		const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryIsEnterable(headerCwd))) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#fallbackRuntimeOnly = false;
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		} else {
			this.#fallbackRuntimeOnly = headerCwd !== undefined && headerCwd !== path.resolve(this.#cwd);
		}

		this.#applyEntries(header, fileEntries.slice(1) as SessionEntry[]);
		this.#expectedDiskSize = sourceSize;
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = this.#persist;
		this.#rewriteRequired = this.#persist && (migrated || loaded.malformedRecords > 0);
		this.#forceFileCreation = this.#persist;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.sanitizeLoadedOpenAIResponsesReplayMetadata() && this.#persist) this.#rewriteRequired = true;
	}

	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#drainAndCloseWriter();
		return this.#resetToNewSession(options);
	}

	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const archivePath = sessionArchivePath(sessionPath);
		if (await this.#storage.exists(archivePath)) await this.#storage.unlink(archivePath);
	}

	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		const oldSessionFile = this.#sessionFile;
		const parentSessionId = this.#sessionId;
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#reconcileSessionDirForFallback();

		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#sessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		this.#archivedEntryIds.clear();
		this.#expectedDiskSize = null;
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
			parentSession: parentSessionId,
			providerPromptCacheKey: this.#header.providerPromptCacheKey ?? parentSessionId,
		};
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#draftOnlySessionCleanupArmed = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		await this.#rewriteAtomically();
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));
		// A fallback session's transcript still sits in its recorded project's bucket, so a same-cwd move must still
		// relocate it.
		const expectedSessionFile = this.#sessionFile
			? path.join(nextSessionDir, path.basename(this.#sessionFile))
			: undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			!this.#fallbackRuntimeOnly &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir)) &&
			(!expectedSessionFile || path.resolve(this.#sessionFile!) === path.resolve(expectedSessionFile))
		) {
			return;
		}

		let sessionFileExisted = false;

		if (this.#persist && this.#sessionFile) {
			const source = this.#sessionFile;
			const dest = path.join(nextSessionDir, path.basename(source));
			this.#sessionFileRelocating = { source, dest };
		}

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				await this.#drainAndCloseWriter();
				this.#clearDiskError();

				const oldSessionFile = this.#sessionFile;
				const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile);
				const newArtifactsDir = artifactsDirectoryFor(newSessionFile);
				const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
				const artifactPathChanged =
					oldArtifactsDir !== null &&
					newArtifactsDir !== null &&
					path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
				sessionFileExisted = this.#storage.existsSync(oldSessionFile);

				let sessionMoved = false;
				let archiveMoved = false;
				let artifactsRenamed = false;

				try {
					if (sessionFileExisted && sessionPathChanged) {
						try {
							await fs.promises.rename(oldSessionFile, newSessionFile);
						} catch (error) {
							if (!hasFsCode(error, "EXDEV")) throw error;
							if (this.#sessionFileRelocating) this.#sessionFileRelocating.copying = true;
							await moveFileAcrossDevices(oldSessionFile, newSessionFile);
						}
						sessionMoved = true;
					}
					const oldArchivePath = sessionArchivePath(oldSessionFile);
					const newArchivePath = sessionArchivePath(newSessionFile);
					if (sessionPathChanged && (await this.#storage.exists(oldArchivePath))) {
						try {
							await fs.promises.rename(oldArchivePath, newArchivePath);
						} catch (error) {
							if (!hasFsCode(error, "EXDEV")) throw error;
							await moveFileAcrossDevices(oldArchivePath, newArchivePath);
						}
						archiveMoved = true;
					}

					if (artifactPathChanged) {
						let artifactStat: fs.Stats | null = null;
						try {
							artifactStat = await fs.promises.stat(oldArtifactsDir);
						} catch (err) {
							if (!isEnoent(err)) throw err;
						}
						if (artifactStat?.isDirectory()) {
							// Only a whole-directory rename can be undone by renaming back; a merge
							// leaves the rollback below to the session file alone.
							artifactsRenamed =
								(await relocateArtifactsDirectory(oldArtifactsDir, newArtifactsDir)) === "renamed";
						}
					}
				} catch (err) {
					if (archiveMoved) {
						try {
							await fs.promises.rename(sessionArchivePath(newSessionFile), sessionArchivePath(oldSessionFile));
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move session archive and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}
					if (artifactsRenamed && oldArtifactsDir && newArtifactsDir) {
						try {
							await fs.promises.rename(newArtifactsDir, oldArtifactsDir);
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move artifacts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					if (sessionMoved) {
						try {
							try {
								await fs.promises.rename(newSessionFile, oldSessionFile);
							} catch (error) {
								if (!hasFsCode(error, "EXDEV")) throw error;
								await moveFileAcrossDevices(newSessionFile, oldSessionFile);
							}
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move session file and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					throw err;
				}

				if (sessionFileExisted && sessionPathChanged) {
					this.#header.previousSessionFiles = [
						...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(oldSessionFile)]),
					];
				}

				this.#sessionFile = newSessionFile;
				// A rename carried this manager's tracked bytes to the new path; without one the destination holds no
				// bytes this manager wrote, so a recreate-from-memory publishes against an absent file.
				if (sessionPathChanged && !sessionMoved) this.#expectedDiskSize = null;
				this.#artifactManager = null;
				this.#artifactManagerSessionFile = null;

				this.#sessionFileRelocating = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;
			// Cleared only once the relocation landed, so a failed move retries on the next attempt.
			this.#fallbackRuntimeOnly = false;

			if (this.#additionalDirectories.length === 0) {
				this.#header.additionalDirectories = undefined;
			} else {
				this.#additionalDirectories = this.#additionalDirectories.filter(d => d !== resolvedCwd);
				this.#header.additionalDirectories =
					this.#additionalDirectories.length > 0 ? this.#additionalDirectories : undefined;
			}

			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}

			if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		} finally {
			this.#sessionFileRelocating = null;
		}
	}

	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically();
	}

	async persistCopy(
		options?: { sessionDir?: string; suppressBreadcrumb?: boolean },
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const sessionDir = options?.sessionDir ?? SessionManager.getDefaultSessionDir(this.#cwd, undefined, storage);
		const manager = new SessionManager(this.#cwd, sessionDir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#resetToNewSession();
		manager.#sessionName = this.#sessionName;
		manager.#titleSource = this.#titleSource;
		manager.#titleUpdatedAt = this.#titleUpdatedAt;
		manager.#header.title = this.#sessionName;
		manager.#header.titleSource = this.#titleSource;
		manager.#additionalDirectories = [...this.#additionalDirectories];
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? [...manager.#additionalDirectories] : undefined;
		manager.#replaceEntries(this.getEntries());
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		return manager;
	}

	appendEntriesAtomically<T>(append: () => T): Promise<T> {
		return this.#withAtomicPersistenceLock(() => this.#appendEntriesAtomicallyLocked(append));
	}

	async #appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		if (!this.#persist || !this.#sessionFile) return append();
		if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
		try {
			await this.ensureOnDisk();
			await this.flush();
		} catch (error) {
			const operationError = toError(error);
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
			throw error;
		}

		const batch: AtomicEntryBatch = {
			collecting: true,
			entryIds: new Set(),
			deferredNotifications: [],
			preBatchLeafId: this.#index.leafId(),
			externalLeafChanged: false,
			externalLeafId: null,
		};
		this.#atomicEntryBatch = batch;
		let result!: T;
		try {
			try {
				result = append();
			} finally {
				batch.collecting = false;
			}
			await this.#rewriteAtomically();
			if (!this.#fileIsCurrent || this.#rewriteRequired) {
				throw new Error("Atomic session batch was superseded before commit.");
			}
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(batch.deferredNotifications);
			return result;
		} catch (error) {
			batch.collecting = false;
			const operationError = toError(error);
			this.#rollbackAtomicEntryBatch(batch);
			try {
				await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			} catch (repairError) {
				const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
				this.#pendingDurabilityNotifications.push(...retainedNotifications);
				this.#atomicEntryBatch = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (repairError instanceof SessionPersistenceIndeterminateError) throw repairError;
				throw this.#latchIndeterminate(operationError, [toError(repairError)]);
			}
			const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(retainedNotifications);
			throw error;
		}
	}

	recoverPersistenceFromCurrentState(): Promise<void> {
		return this.#withAtomicPersistenceLock(async () => {
			if (!this.#persist || !this.#sessionFile) return;
			if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
			const operationError =
				this.#diskFailure ?? new Error("Authoritative session persistence recovery was requested.");
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
		});
	}

	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});

		// Backends (indexed Redis/SQL) surface fire-and-forget publish failures only from drain(); route it through the
		// disk queue so such a failure latches and reaches persistence-error observers.
		await this.#scheduleDiskWork(async () => {
			await this.#storage.drain();
		});
		if (this.#diskFailure) throw this.#diskFailure;
	}

	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) throw new Error("Cannot synchronously flush during an atomic session batch.");
		if (this.#diskFailure) throw this.#diskFailure;
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			this.#writer?.flushSync?.();
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsSync(draftPath)) return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		// The in-memory view can be stale (another writer may have appended since this manager last
		// read the file), so decide on the file about to be destroyed: keep it unless it is still
		// well-formed draft-only metadata.
		const onDisk = await loadSessionFile(sessionFile, this.#storage, { preserveInvalidHeader: true });
		if (
			onDisk.invalidHeader ||
			onDisk.malformedRecords > 0 ||
			!(onDisk.entries.slice(1) as SessionEntry[]).every(isDraftOnlyMetadataEntry)
		) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionFile);
			const archivePath = sessionArchivePath(sessionFile);
			if (await this.#storage.exists(archivePath)) await this.#storage.unlink(archivePath);
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	async close(): Promise<void> {
		try {
			if (!this.#persist) return;
			await this.#scheduleDiskWork(async () => {
				const hadWriter = this.#writer !== undefined;
				await this.#closeWriterHandle();
				if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
					this.#fileIsCurrent = true;
			});
			await this.#dropIfEmptyAndNoDraft();

			await this.#scheduleDiskWork(async () => {
				await this.#storage.drain();
			});
			if (this.#diskFailure) throw this.#diskFailure;
		} finally {
			this.releaseRetainedEntries();
		}
	}

	seal(): void {
		if (this.#released) return;
		this.#released = true;
		this.#diskEpoch++;
	}

	releaseRetainedEntries(): void {
		this.seal();
		this.#entries = [];
		this.#index.clear();
		this.#clearRawEntryRetention();
		this.#disposeRawEntryDirectory();
		this.#closeWriterEventually();
	}

	getCwd(): string {
		return this.#cwd;
	}

	/** The header's recorded project cwd; differs from {@link getCwd} while a resume fallback keeps the launch cwd. */
	getRecordedCwd(): string | undefined {
		return this.#header?.cwd;
	}

	/** Track `newCwd` as the runtime cwd without relocating the transcript; it stays in its recorded bucket. */
	setCwdWithoutRelocation(newCwd: string): void {
		const resolvedCwd = path.resolve(newCwd);
		this.#fallbackRuntimeOnly = true;
		if (resolvedCwd === path.resolve(this.#cwd)) return;
		this.#cwd = resolvedCwd;
		if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
	}

	/** Re-adopt the header's recorded cwd and the transcript's own bucket, ending a runtime-only fallback. */
	adoptRecordedCwd(): void {
		const recordedCwd = this.#header.cwd;
		if (!recordedCwd) return;
		this.#cwd = path.resolve(recordedCwd);
		if (this.#sessionFile) this.#sessionDir = path.dirname(this.#sessionFile);
		this.#fallbackRuntimeOnly = false;
		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Re-anchor the session bucket to the runtime cwd once a fallback session starts a new transcript. Only a real
	 * relocation or new transcript may recompute the bucket; workspace edits must not clear the fallback early.
	 */
	#reconcileSessionDirForFallback(): void {
		if (!this.#fallbackRuntimeOnly) return;
		this.#sessionDir = computeDefaultSessionDir(this.#cwd, this.#storage);
		this.#fallbackRuntimeOnly = false;
	}

	getAdditionalDirectories(): string[] {
		return [...this.#additionalDirectories];
	}

	async #persistWorkspaceDirectoriesChange(): Promise<void> {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	async addWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		if (resolved === path.resolve(this.#cwd)) {
			throw new Error("The current working directory is already the primary workspace root.");
		}
		if (this.#additionalDirectories.includes(resolved)) return null;
		this.#additionalDirectories = [...this.#additionalDirectories, resolved];
		// A fallback transcript still sits in its recorded bucket: keep workspace edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) return resolved;
		this.#header.additionalDirectories = this.#additionalDirectories;
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	async removeWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		const idx = this.#additionalDirectories.findIndex(p => path.resolve(p) === resolved);
		if (idx === -1) return null;
		this.#additionalDirectories = this.#additionalDirectories.filter((_, i) => i !== idx);
		if (this.#fallbackRuntimeOnly) return resolved;
		if (this.#additionalDirectories.length === 0) {
			this.#header.additionalDirectories = undefined;
		} else {
			this.#header.additionalDirectories = this.#additionalDirectories;
		}
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	async setAdditionalDirectories(directories: string[]): Promise<void> {
		const workspace = normalizeSessionWorkspace({ cwd: this.#cwd, directories });
		const next = additionalWorkspaceDirectories(workspace);
		if (this.#fallbackRuntimeOnly) {
			this.#additionalDirectories = next;
			return;
		}
		if (
			next.length === this.#additionalDirectories.length &&
			next.every((d, i) => d === this.#additionalDirectories[i])
		) {
			return;
		}
		this.#additionalDirectories = next;
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = this.#additionalDirectories;
		} else {
			this.#header.additionalDirectories = undefined;
		}
		await this.#persistWorkspaceDirectoriesChange();
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	getSubagentUsage(): SubagentUsageTotals {
		return this.#index.usageSnapshot().subagent;
	}

	/**
	 * Attributes one settled subagent run to this session. The run is appended as a session entry so
	 * the rollup survives a reload: the owning session is the only place the spend can be summed,
	 * because subagents write their own transcripts.
	 */
	recordSubagentUsage(args: { agentId: string; agent?: string; label?: string; turn?: number; usage: Usage }): void {
		this.appendCustomEntry(SUBAGENT_USAGE_CUSTOM_TYPE, buildSubagentUsageEntryData(args));
	}

	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	isSessionOnDisk(): boolean {
		return !!this.#sessionFile && this.#storage.existsSync(this.#sessionFile);
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		const sessionFile = this.#sessionFile;
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			!this.#storage.existsSync(sessionFile) &&
			this.#entries.every(isDraftOnlyMetadataEntry);

		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	/** Changes synchronously on every accepted rename, including reassertions of the same title. */
	get titleRevision(): number {
		return this.#titleRevision;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	/** The per-process directory holding full copies of oversized entries, once one has been written. */
	getRawEntryDirectory(): string | undefined {
		return this.#rawEntryDirectory;
	}

	/** Fires once per session when an oversized entry's cached copy was lost and the truncated copy is used. */
	onHistoryDegraded(cb: (message: string) => void): () => void {
		this.#historyDegradedCallbacks.add(cb);
		return () => {
			this.#historyDegradedCallbacks.delete(cb);
		};
	}

	onPersistenceError(cb: (error: Error) => void): () => void {
		this.#persistenceErrorCallbacks.add(cb);
		return () => {
			this.#persistenceErrorCallbacks.delete(cb);
		};
	}

	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#released) return false;
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		this.#titleRevision++;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		const retained = this.#retainEntry(entry);
		this.#entries.push(retained);
		this.#index.insert(retained);
		this.#notifyEntryAppended(entry);
		await this.#persistTitleChangeEntry(retained as TitleChangeEntry, { title, source, updatedAt: timestamp });

		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordSessionTitle(this.#sessionId, title);
		}

		this.#notifySessionNameListeners();
		return true;
	}

	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendMessageToBranch(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
		parentId: string | null,
	): string {
		if (parentId !== null && !this.#index.has(parentId)) throw new Error(`Entry ${parentId} not found`);
		const activeLeafId = this.#index.leafId();
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.#index),
			parentId,
			timestamp: nowIso(),
			message,
		};
		this.#recordEntry(entry);
		this.#index.setLeaf(activeLeafId);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModelChange(model: string, role?: string, resolvedModelIsFallback = false): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			...this.#freshEntryFields(),
			model,
			role,
			resolvedModelIsFallback,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		agent?: string;
		modelRole?: string;
		modelOverride?: string;
		resolvedModel?: string;
		readOnly?: boolean;
		outputSchema?: unknown;
		outputSchemaMode?: StructuredSubagentSchemaMode;
		restrictToolNames?: boolean;
		spawns?: string;
		readSummarize?: boolean;
		advisor?: string;
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		options: {
			details?: T;
			fromExtension?: boolean;
			preserveData?: Record<string, unknown>;
			method?: CompactionMethod;
			providerReplayThroughEntryId?: string;
			tokensAfter?: number;
		} = {},
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			tokensAfter: options.tokensAfter,
			method: options.method,
			providerReplayThroughEntryId: options.providerReplayThroughEntryId,
			details: options.details,
			fromExtension: options.fromExtension,
			preserveData: options.preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Archive compacted message rows while keeping them hydrated for branch, rewind, and export APIs. */
	async archiveCompactedHistory(firstKeptEntryId: string): Promise<void> {
		if (!this.#persist || !this.#sessionFile || this.#released) return;
		await this.#withAtomicPersistenceLock(async () => {
			const epoch = this.#diskEpoch;
			await this.#scheduleDiskWork(
				async () => {
					const sessionFile = this.#sessionFile;
					if (!sessionFile || this.#released || this.#diskEpoch !== epoch) return;
					await this.#closeWriterHandle();
					const activeText = await this.#storage.readText(sessionFile);
					const actualSize = Buffer.byteLength(activeText, "utf8");
					if (this.#expectedDiskSize !== null && actualSize !== this.#expectedDiskSize) {
						throw new Error(`Session file changed before transcript archival: ${sessionFile}`);
					}
					const keptIndex = this.#entries.findIndex(entry => entry.id === firstKeptEntryId);
					if (keptIndex < 0) throw new Error(`Compaction boundary ${firstKeptEntryId} is not in the session`);
					const eligible = new Set(
						this.#entries
							.slice(0, keptIndex)
							.filter(entry => entry.type === "message")
							.map(entry => entry.id),
					);
					for (const id of this.#archivedEntryIds) eligible.delete(id);
					if (eligible.size === 0) return;
					const rows = activeText.split("\n");
					const parsedRows = rows.map(line => {
						try {
							const parsed: unknown = JSON.parse(line);
							return typeof parsed === "object" &&
								parsed !== null &&
								"id" in parsed &&
								typeof parsed.id === "string"
								? parsed.id
								: undefined;
						} catch {
							return undefined;
						}
					});
					const toArchive = parsedRows.flatMap((id, index) =>
						id !== undefined && eligible.has(id) ? [{ id, index, line: rows[index]! }] : [],
					);
					if (toArchive.length === 0) return;
					const archivePath = sessionArchivePath(sessionFile);
					const existing = await loadSessionArchive(sessionFile, this.#storage, this.#header.id);
					const archivedIds = new Set(existing?.records.map(record => record.id) ?? []);
					const records = [...(existing?.records ?? [])];
					const replacementAnchors = new Map<string, string | null>();
					for (const item of toArchive) {
						if (archivedIds.has(item.id)) continue;
						const beforeId =
							parsedRows.slice(item.index + 1).find(nextId => nextId !== undefined && !eligible.has(nextId)) ??
							null;
						replacementAnchors.set(item.id, beforeId);
						records.push({ id: item.id, beforeId, line: item.line });
						archivedIds.add(item.id);
					}
					for (const record of records) {
						while (record.beforeId !== null && replacementAnchors.has(record.beforeId)) {
							record.beforeId = replacementAnchors.get(record.beforeId) ?? null;
						}
					}
					if (records.length === (existing?.records.length ?? 0)) return;
					const archive: SessionArchive = {
						version: 1,
						sessionId: this.#header.id,
						sessionFile,
						records,
					};
					const encoded = gzipSync(Buffer.from(JSON.stringify(archive), "utf8")).toString("base64");
					const archiveSize = (await this.#storage.exists(archivePath))
						? this.#storage.statSync(archivePath).size
						: null;
					await this.#storage.writeTextAtomic(archivePath, encoded, { expectedSize: archiveSize, durable: true });
					for (const record of records) this.#archivedEntryIds.add(record.id);
					if (!(await this.#runFencedAtomicRewrite(epoch))) return;
					this.#lockContentionReported = false;
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				},
				{ epoch },
			);
		});
	}

	appendResetBoundary(): string {
		const entry: ResetBoundaryEntry = { type: "reset_boundary", ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	async rewriteEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically();
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
		timestamp?: number,
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const fresh = this.#freshEntryFields();
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,

			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...fresh,
			// Prefer the initiating message's own time: the emission time would shift a rebuilt
			// message past provider preparation and hook time.
			timestamp:
				timestamp !== undefined && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fresh.timestamp,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	appendCredentialPin(provider: string, hash: string): string {
		const entry: CredentialPinEntry = {
			type: "credential_pin",
			...this.#freshEntryFields(),
			provider,
			hash,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	getCredentialPins(): Map<string, { hash: string; lastUsedAt: number }> {
		const pins = new Map<string, { hash: string; lastUsedAt: number }>();
		for (const entry of this.getBranch()) {
			if (entry.type === "credential_pin") {
				pins.set(entry.provider, { hash: entry.hash, lastUsedAt: new Date(entry.timestamp).getTime() });
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const pin = pins.get(entry.message.provider);
				if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
			}
		}
		return pins;
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		const entry = this.#index.leafEntry();
		return entry ? this.#materializeEntry(entry) : undefined;
	}

	getLastModelChangeRole(): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "model_change") return entry.role ?? "default";
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		const entry = this.#index.get(id);
		return entry ? this.#materializeEntry(entry) : undefined;
	}

	getChildren(parentId: string): SessionEntry[] {
		return this.#materializeEntries(this.#index.childrenOf(parentId));
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		return this.#materializeEntries(this.#index.pathTo(fromId ?? this.#index.leafId()));
	}

	/**
	 * Returns the cached leaf path without copying or materializing retained entries.
	 * Only bookkeeping that does not need the full persisted payload may use this view.
	 */
	getBranchForStats(): readonly SessionEntry[] {
		return this.#index.pathToView();
	}

	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		const branch = this.getBranch();
		const entriesById = new Map(branch.map(entry => [entry.id, entry]));
		return buildSessionContext(branch, this.#index.leafId(), entriesById, options);
	}

	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		const entries = this.#materializeEntries(this.#entries);
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;

			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}
		if (changed) this.#replaceEntries(entries);

		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	getEntries(): SessionEntry[] {
		return this.#materializeEntries(this.#entries);
	}

	/** Metadata-only presence check; does not hydrate retained payloads or expose retained entries. */
	hasAssistantMessage(): boolean {
		return this.#entries.some(entry => entry.type === "message" && entry.message.role === "assistant");
	}

	/** Returns detached custom-entry data snapshots without hydrating unrelated retained entries. */
	getCustomEntryDataForMetadata(customType: string): unknown[] {
		return this.#entries.flatMap(entry =>
			entry.type === "custom" && entry.customType === customType ? [structuredClone(entry.data)] : [],
		);
	}

	getTree(): SessionTreeNode[] {
		// A session is a near-linear chain, so tree depth tracks entry count. Walk
		// it with an explicit stack like SessionEntryIndex.tree() does: recursing
		// here overflowed the stack once a history grew past ~10k entries, taking
		// down the rewind selector that materializes the whole tree.
		const materializeNode = (node: SessionTreeNode): SessionTreeNode => ({
			...node,
			entry: this.#materializeEntry(node.entry),
			children: [],
		});

		const roots = this.#index.tree(this.#entries);
		const materializedRoots = roots.map(materializeNode);
		const stack = roots.map((source, index) => ({ source, target: materializedRoots[index]! }));
		while (stack.length > 0) {
			const { source, target } = stack.pop()!;
			for (const child of source.children) {
				const materializedChild = materializeNode(child);
				target.children.push(materializedChild);
				stack.push({ source: child, target: materializedChild });
			}
		}
		return materializedRoots;
	}

	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#setLeaf(branchFromId);
	}

	resetLeaf(): void {
		this.#setLeaf(null);
	}

	async discardEntryDurably(entryId: string): Promise<void> {
		const entry = this.#index.get(entryId);
		if (!entry) return;
		const children = this.#index.childrenOf(entryId);
		const canReparentChildren = children.every(child => child.type === "service_tier_change");
		let leafId = entry.parentId;
		if (canReparentChildren) {
			const childIds = new Set(children.map(child => child.id));
			const entries = this.#materializeEntries(this.#entries);
			for (const child of entries) {
				if (!childIds.has(child.id)) continue;
				child.parentId = leafId;
				leafId = child.id;
			}
			this.#replaceEntries(entries.filter(candidate => candidate.id !== entryId));
		}
		this.branchWithSummary(leafId, "", {
			kind: DISCARDED_ENTRY_BRANCH_MARKER,
			discardedEntryId: entryId,
		});
		await this.rewriteEntries();
	}

	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	createBranchedSession(leafId: string): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);

		const entriesToKeep = branchPath.filter(entry => entry.type !== "label");
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		const previousState = this.captureState();
		this.#reconcileSessionDirForFallback();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		try {
			this.#replaceEntries([...entriesToKeep, ...labels]);
		} catch (error) {
			// #replaceEntries drops the old retention generation before retaining each entry. Restore it if a spill fails,
			// so a caller that continues cannot rewrite the source without its archived rows or original header.
			this.restoreState(previousState);
			throw error;
		}
		this.#header = header;
		// The branch owns a new transcript without the source archive sidecar; all kept entries are hydrated.
		this.#archivedEntryIds.clear();
		this.#sessionId = newSessionId;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#forceFileCreation = this.#persist;

		if (!this.#persist) {
			this.#sessionFile = undefined;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			return undefined;
		}

		this.#sessionFile = newSessionFile;
		this.#expectedDiskSize = null;
		this.#rewriteSynchronously();
		this.#rememberBreadcrumb(this.#cwd, newSessionFile);
		return newSessionFile;
	}

	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	static create(cwd: string, sessionDir?: string, storage: SessionStorage = new FileSessionStorage()): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#resetToNewSession();
		return manager;
	}

	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`);
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { copyArtifacts?: boolean; suppressBreadcrumb?: boolean; sessionFile?: string },
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		// The loader treats a missing path as a new empty session; a fork must fail instead of minting an empty
		// parentless session.
		let loadedSource: SessionLoadResult;
		try {
			loadedSource = await loadSessionFile(sourcePath, storage, {
				preserveInvalidHeader: true,
				throwIfMissing: true,
			});
		} catch (err) {
			if (isEnoent(err) || isEnotdir(err)) throw new ForkSourceNotFoundError(sourcePath);
			throw err;
		}
		if (loadedSource.malformedRecords > 0 || loadedSource.invalidHeader) {
			logger.warn("Fork source contains malformed records; preserving valid entries", {
				count: Math.max(loadedSource.malformedRecords, loadedSource.invalidHeader ? 1 : 0),
				path: path.resolve(sourcePath),
			});
		}
		const sourceEntries = structuredClone(loadedSource.entries) as FileEntry[];
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const history = sourceEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: sourceHeader?.providerPromptCacheKey ?? sourceHeader?.id,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#additionalDirectories = (sourceHeader?.additionalDirectories ?? []).filter(d => d !== path.resolve(cwd));
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? manager.#additionalDirectories : undefined;
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		manager.#replaceEntries(history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		if (options?.copyArtifacts !== false) {
			await copySessionArtifacts(sourcePath, manager.#sessionFile!);
		}
		return manager;
	}

	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: {
			initialCwd?: string;
			parentSession?: string;
			suppressBreadcrumb?: boolean;
			/** Propagate a missing/empty file instead of minting a new session at the path (revive). */
			throwIfMissing?: boolean;
		},
	): Promise<SessionManager> {
		const throwIfMissing = options?.throwIfMissing === true;
		const probed = await loadSessionFile(filePath, storage, { throwIfMissing });
		const header = probed.entries.find(entry => entry.type === "session") as SessionHeader | undefined;

		// Resume into the recorded cwd only when it can be entered; a deleted or permission-denied (macOS TCC) project
		// would make the chdir interactive mode performs next fail, so fall back to the launch cwd.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryIsEnterable(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		// The cwd probe yields, so a fail-closed caller re-reads and adopts only the fresh snapshot: a transcript
		// deleted, truncated, or replaced mid-probe then fails closed instead of reviving stale history.
		const loaded = throwIfMissing ? await loadSessionFile(filePath, storage, { throwIfMissing }) : probed;
		// A fresh (empty or missing) file records its parent; reopening keeps the existing header.
		await manager.#setSessionFile(filePath, loaded, { parentSession: options?.parentSession }, throwIfMissing);
		return manager;
	}

	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<{ cwd: string; init: PersistedSessionInit | null } | null> {
		let header: SessionHeader | undefined;
		const initEntries: FileEntry[] = [];
		const visit = (entry: FileEntry): void => {
			if (entry.type === "session") {
				header ??= entry;
				return;
			}
			if (entry.type === "session_init") initEntries.push(entry);
		};

		try {
			await visitEntriesFromFile(filePath, visit, storage);
		} catch {
			return null;
		}

		if (!header) return null;
		return { cwd: header.cwd ?? getProjectDir(), init: extractSessionInit(initEntries) };
	}

	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { claimOwnership?: (sessionFile: string) => boolean },
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		// Continuing into a session another live proto process owns would write
		// nothing, so every candidate has to be claimed before it is adopted.
		const claim = options?.claimOwnership ?? claimSessionOwnership;
		const newSession = (): SessionManager => {
			const manager = new SessionManager(cwd, dir, true, storage);
			manager.#resetToNewSession();
			claim(manager.getSessionFile() ?? "");
			return manager;
		};
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// An explicit session directory fences the terminal breadcrumb: a crumb
			// recorded for another directory must not decide this continue.
			if (
				breadcrumb.fresh &&
				!breadcrumb.exists &&
				(!sessionDir || pathIsWithin(dir, path.dirname(breadcrumb.sessionFile)))
			) {
				return newSession();
			}

			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				if (!sessionDir || pathIsWithin(dir, breadcrumb.sessionFile)) {
					chosenSession = breadcrumb.sessionFile;
				}
			} else {
				let newestInTargetDir = await findMostRecentNonEmptySession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !(await directoryExists(breadcrumbCwd));
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd &&
							!isEmptySession(session),
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const candidateForMove =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				// A missing recorded cwd is not a move: deleted, unmounted, and offline paths
				// are missing too. Re-root only when this cwd is the same directory inode the
				// breadcrumb recorded (a rename); a cross-filesystem `mv` is not re-rooted.
				const looksLikeMovedProject =
					candidateForMove && hasPositiveMovedProjectEvidence(breadcrumb.cwdIdentity, resolvedCwd);
				if (candidateForMove && !looksLikeMovedProject) {
					logger.warn(
						"Not relocating session: project directory is unavailable and there is no evidence it moved here",
						{ from: breadcrumbCwd, to: resolvedCwd },
					);
				}
				if (looksLikeMovedProject && claim(breadcrumb.sessionFile)) {
					logger.warn("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });

					const manager = await SessionManager.open(breadcrumb.sessionFile, undefined, storage, {
						initialCwd: breadcrumbCwd,
					});
					await manager.moveTo(cwd, sessionDir);
					claim(manager.getSessionFile() ?? "");
					return manager;
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentNonEmptySession(dir, storage);
		if (chosenSession && !claim(chosenSession)) {
			logger.info("Most recent session is open in another proto process; starting a new session", {
				sessionFile: chosenSession,
				ownerPid: liveSessionOwnerPid(chosenSession),
			});
			chosenSession = null;
		}

		if (!chosenSession) return newSession();
		const manager = new SessionManager(cwd, dir, true, storage);
		await manager.setSessionFile(chosenSession);
		return manager;
	}

	/**
	 * Set when history could not be persisted and the run continued in memory, so the
	 * modes can tell the user why nothing is being saved.
	 */
	markPersistenceUnavailable(error: SessionDirectoryError): void {
		this.#persistenceUnavailable = error;
	}

	getPersistenceUnavailable(): SessionDirectoryError | undefined {
		return this.#persistenceUnavailable;
	}

	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir || SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const sessions = await listSessions(dir, storage);
		return sessions;
	}

	static async listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		const sessions = await listAllSessions(storage);
		return sessions;
	}

	/** Picker-facing project list: untitled 0-turn empties dropped; titled empties stay resumable. */
	static async listForPicker(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		return filterSessionsForPicker(await SessionManager.list(cwd, sessionDir, storage));
	}

	/** Picker-facing cross-project list, same empty-session rule as {@link listForPicker}. */
	static async listAllForPicker(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return filterSessionsForPicker(await listAllSessions(storage));
	}
}

/**
 * Whether loaded entries carry a real user/assistant message. A transcript truncated to its header and `session_init`
 * has none; revive fails closed on it rather than replay an empty conversation as a parked agent's history.
 */
export function hasConversationalHistory(entries: readonly FileEntry[]): boolean {
	return entries.some(
		entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
	);
}

/** The persisted `session_init` contract a cold revive rebuilds a subagent from. */
export interface PersistedSessionInit {
	systemPrompt: string;
	task: string;
	tools: string[];
	agent?: string;
	modelRole?: string;
	modelOverride?: string;
	resolvedModel?: string;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	restrictToolNames?: boolean;
	spawns?: string;
	readSummarize?: boolean;
	advisor?: string;
}

/** Latest `session_init` contract among loaded entries, or null when the transcript carries none. */
export function extractSessionInit(entries: readonly FileEntry[]): PersistedSessionInit | null {
	let init: PersistedSessionInit | null = null;
	for (const entry of entries) {
		if (entry.type !== "session_init") continue;
		init = {
			systemPrompt: entry.systemPrompt,
			task: entry.task,
			tools: entry.tools,
			agent: entry.agent,
			modelRole: entry.modelRole,
			modelOverride: entry.modelOverride,
			resolvedModel: entry.resolvedModel,
			outputSchema: entry.outputSchema,
			outputSchemaMode: entry.outputSchemaMode,
			restrictToolNames: entry.restrictToolNames,
			readSummarize: entry.readSummarize,
			spawns: entry.spawns,
			advisor: entry.advisor,
		};
	}
	return init;
}

export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	const entries = sessionManager.getEntries();
	const hasRealMessages = entries.some(
		e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
	);
	if (hasRealMessages) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
