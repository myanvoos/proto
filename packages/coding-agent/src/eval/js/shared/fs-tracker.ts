import { AsyncLocalStorage } from "node:async_hooks";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

import { capEventDiff } from "../../../utils/diff";
import { PRUNED_DIRS, SKIPPED_SUFFIXES } from "../../fs-policy";
import type { JsStatusEvent } from "./types";

/**
 * Filesystem mutation tracking for JS kernel cells — the counterpart of the
 * Python prelude's audit hook (eval/py/prelude.py). Bun has no audit hook, so
 * the tracker wraps the mutation APIs user code can reach: the `fs` global,
 * `import`/`require` of node:fs and node:fs/promises (via `trackedFsModule` /
 * `maybeTrackedModule`), and `Bun.write` in dedicated worker processes
 * (`installBunWriteTracking`; never installed inline, where the runtime
 * shares the host process with the agent). Records hold each touched path's
 * pre-mutation content. A path is reported as soon as the mutation call that
 * touched it settles (writeFile, appendFile, rm, rename, …, Bun.write), so a
 * cell that edits a file and then keeps running shows the edit immediately;
 * handle-based writes (open, createWriteStream) have no settle point and wait
 * for `flushFileTracking` at cell end. Every report is the NET diff from the
 * pre-cell content, carrying an id of run id + path so the host replaces the
 * earlier report of the same path (eval/status-events.ts): a cell that
 * writes a file twice exposes one mutation — the same shape as the Python
 * flush, so the host walker dedupes both identically (writes by path + final
 * sha, deletes by path).
 */

const DIFF_MAX_BYTES = 8 * 1024 * 1024;
// Distinct paths a cell may report; further changed paths collapse into one
// "files … truncated" event.
const MAX_EVENTS = 50;
// Settle-time reports per path per cell; past it a hot loop rewriting one
// file leaves the net diff to the flush instead of re-diffing every write.
const EAGER_REPORTS_PER_PATH = 8;
const SHA_LENGTH = 16;
// Aggregate budget for pre-mutation snapshots kept per cell (kept aligned
// with _FS_CAPTURE_TEXT_BUDGET in eval/py/prelude.py); past it noteTouched
// stores only the sha and the flush emits writes without diffs.
const CAPTURE_TEXT_BUDGET = 16 * 1024 * 1024;
const WRITE_FLAGS =
	fsSync.constants.O_WRONLY |
	fsSync.constants.O_RDWR |
	fsSync.constants.O_CREAT |
	fsSync.constants.O_TRUNC |
	fsSync.constants.O_APPEND |
	// O_TMPFILE is Linux-only and missing from the fs constant typings.
	((fsSync.constants as typeof fsSync.constants & { O_TMPFILE?: number }).O_TMPFILE ?? 0);

interface TouchedRecord {
	existed: boolean;
	key: string | null;
	before: string | null;
	beforeSha: string | null;
}

interface ReportMeta {
	op: "write" | "delete" | "revert";
	added: number;
	removed: number;
	diff: boolean;
}

interface CellTracking {
	runId: string;
	emit: (event: JsStatusEvent) => void;
	/** Model-visible cell output; the same `<kernel> note:` line the Python kernel prints. */
	note: (text: string) => void;
	cwd: string;
	touched: Map<string, TouchedRecord>;
	reported: Map<string, string | null>;
	reportedMeta: Map<string, ReportMeta>;
	eagerReports: Map<string, number>;
	pendingReports: Map<string, Promise<void>>;
	capturedTextBytes: number;
}

interface ReadStamp {
	mtimeNs: bigint;
	size: bigint;
	sha: string;
}

export class StaleWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleWriteError";
	}
}

const trackingStorage = new AsyncLocalStorage<CellTracking>();
const wrappedModules = new WeakMap<object, unknown>();
const wrappedFunctions = new WeakMap<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();
const wrappedFileHandles = new WeakMap<object, object>();
const fileHandlePaths = new WeakMap<object, string>();
const fdPaths = new Map<number, string>();
// Persistent across cells: a write must still be guarded when the read that
// armed it happened in an earlier cell.
const readSeen = new Map<string, ReadStamp>();
const READ_SEEN_MAX = 8192;

const TRACKED_NAMES: Record<string, true> = {
	writeFile: true,
	writeFileSync: true,
	appendFile: true,
	appendFileSync: true,
	rm: true,
	rmSync: true,
	rmdir: true,
	rmdirSync: true,
	unlink: true,
	unlinkSync: true,
	rename: true,
	renameSync: true,
	truncate: true,
	truncateSync: true,
	copyFile: true,
	copyFileSync: true,
	cp: true,
	cpSync: true,
	link: true,
	linkSync: true,
	symlink: true,
	symlinkSync: true,
	ftruncate: true,
	ftruncateSync: true,
	write: true,
	writeSync: true,
	writev: true,
	writevSync: true,
	open: true,
	openSync: true,
	createWriteStream: true,
};

const READ_NAMES: Record<string, true> = {
	createReadStream: true,
	readFile: true,
	readFileSync: true,
};

const FILE_HANDLE_MUTATION_NAMES: Record<string, true> = {
	appendFile: true,
	createWriteStream: true,
	truncate: true,
	write: true,
	writeFile: true,
	writev: true,
};
function resolveTrackedPath(rawPath: unknown): string | undefined {
	if (typeof rawPath === "number") return fdPaths.get(rawPath);
	if (typeof rawPath === "string") return rawPath.length > 0 ? path.resolve(rawPath) : undefined;
	if (rawPath instanceof URL) {
		try {
			return path.resolve(url.fileURLToPath(rawPath));
		} catch {
			return undefined;
		}
	}
	if (Buffer.isBuffer(rawPath)) {
		const decoded = rawPath.toString();
		return decoded.length > 0 ? path.resolve(decoded) : undefined;
	}
	if (rawPath !== null && typeof rawPath === "object") return fileHandlePaths.get(rawPath);
	return undefined;
}

function looksPruned(absPath: string): boolean {
	if (SKIPPED_SUFFIXES.some(suffix => absPath.endsWith(suffix))) return true;
	const parts = absPath.split(path.sep);
	for (let index = 0; index < parts.length - 1; index++) {
		if (PRUNED_DIRS.has(parts[index])) return true;
	}
	return false;
}

function metadataStamp(absPath: string): Omit<ReadStamp, "sha"> | undefined {
	try {
		const stat = fsSync.statSync(absPath, { bigint: true });
		if (!stat.isFile()) return undefined;
		return { mtimeNs: stat.mtimeNs, size: stat.size };
	} catch {
		return undefined;
	}
}

function fileShaSync(absPath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fsSync.openSync(absPath, "r");
		const hasher = new Bun.CryptoHasher("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		while (true) {
			const read = fsSync.readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hasher.update(buffer.subarray(0, read));
		}
		return hasher.digest("hex").slice(0, SHA_LENGTH);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fsSync.closeSync(fd);
			} catch {}
		}
	}
}

function noteRead(rawPath: unknown): void {
	const absPath = resolveTrackedPath(rawPath);
	if (!absPath || looksPruned(absPath)) return;
	const before = metadataStamp(absPath);
	if (!before) return;
	const sha = fileShaSync(absPath);
	const after = metadataStamp(absPath);
	if (!sha || !after || before.mtimeNs !== after.mtimeNs || before.size !== after.size) return;
	if (readSeen.size >= READ_SEEN_MAX && !readSeen.has(absPath)) {
		const oldest = readSeen.keys().next().value;
		if (oldest !== undefined) readSeen.delete(oldest);
	}
	readSeen.delete(absPath);
	readSeen.set(absPath, { ...after, sha });
}

function forgetRead(rawPath: unknown): void {
	const absPath = resolveTrackedPath(rawPath);
	if (absPath) readSeen.delete(absPath);
}

function checkStaleWrite(rawPath: unknown): void {
	const absPath = resolveTrackedPath(rawPath);
	if (!absPath) return;
	const seen = readSeen.get(absPath);
	if (!seen) return;
	const current = metadataStamp(absPath);
	if (!current) return;
	const metadataMatches = current.mtimeNs === seen.mtimeNs && current.size === seen.size;
	const contentMatches = metadataMatches && fileShaSync(absPath) === seen.sha;
	if (contentMatches) return;
	throw new StaleWriteError(
		`write to ${absPath}: file changed on disk since the kernel last read it ` +
			`(read at mtime ${seen.mtimeNs}, ${seen.size} bytes; now mtime ${current.mtimeNs}, ${current.size} bytes). ` +
			"Re-read the file (any read re-arms the guard) and redo the change.",
	);
}

// Synchronous by design: called inside the sync mutation wrappers, where the
// pre-mutation snapshot must be captured before the wrapped call runs.
function readContent(absPath: string): { text: string | null; sha: string | null } {
	try {
		const bytes = fsSync.readFileSync(absPath);
		const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, SHA_LENGTH);
		if (bytes.subarray(0, 8192).includes(0)) return { text: null, sha };
		return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), sha };
	} catch {
		return { text: null, sha: null };
	}
}

// Async counterpart of readContent for the cell-end flush, which runs outside
// any sync wrapper and must not block the event loop on per-file reads.
async function readContentAsync(absPath: string): Promise<{ text: string | null; sha: string | null }> {
	try {
		const bytes = new Uint8Array(await Bun.file(absPath).arrayBuffer());
		const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, SHA_LENGTH);
		if (bytes.subarray(0, 8192).includes(0)) return { text: null, sha };
		return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), sha };
	} catch {
		return { text: null, sha: null };
	}
}

// Sha-only path for files past DIFF_MAX_BYTES: streamed so a multi-GB write
// never lands in memory just to compute the walker-dedupe sha.
async function shaOfFileAsync(absPath: string): Promise<string | null> {
	try {
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(absPath).stream()) hasher.update(chunk);
		return hasher.digest("hex").slice(0, SHA_LENGTH);
	} catch {
		return null;
	}
}

export function noteTouched(rawPath: unknown): void {
	const tracking = trackingStorage.getStore();
	if (!tracking) return;
	const absPath = resolveTrackedPath(rawPath);
	if (!absPath) return;
	if (tracking.touched.has(absPath) || looksPruned(absPath)) return;
	let stat: { mtimeMs: number; size: number; isFile: boolean };
	try {
		const current = fsSync.statSync(absPath);
		stat = { mtimeMs: current.mtimeMs, size: current.size, isFile: current.isFile() };
	} catch {
		tracking.touched.set(absPath, { existed: false, key: null, before: null, beforeSha: null });
		return;
	}
	if (!stat.isFile) return;
	const record: TouchedRecord = {
		existed: true,
		key: `${stat.mtimeMs}:${stat.size}`,
		before: null,
		beforeSha: null,
	};
	if (stat.size <= DIFF_MAX_BYTES) {
		const pre = readContent(absPath);
		record.beforeSha = pre.sha;
		if (pre.text !== null && tracking.capturedTextBytes < CAPTURE_TEXT_BUDGET) {
			record.before = pre.text;
			tracking.capturedTextBytes += pre.text.length;
		}
	}
	tracking.touched.set(absPath, record);
}

export function beginFileTracking(
	runId: string,
	emit: (event: JsStatusEvent) => void,
	options: { note?: (text: string) => void; cwd?: string } = {},
): void {
	trackingStorage.enterWith({
		runId,
		emit,
		note: options.note ?? (() => {}),
		cwd: options.cwd ?? process.cwd(),
		touched: new Map(),
		reported: new Map(),
		reportedMeta: new Map(),
		eagerReports: new Map(),
		pendingReports: new Map(),
		capturedTextBytes: 0,
	});
}

function setReportMeta(tracking: CellTracking, absPath: string, op: ReportMeta["op"], diff: unknown): void {
	const rows = typeof diff === "string" && diff.length > 0 ? diff.split("\n") : [];
	tracking.reportedMeta.set(absPath, {
		op,
		diff: rows.length > 0,
		added: rows.filter(row => row.startsWith("+")).length,
		removed: rows.filter(row => row.startsWith("-")).length,
	});
}

/** Cwd-relative in the compact note when that does not climb out of the cell's cwd. */
function notePath(tracking: CellTracking, absPath: string): string {
	const relative = path.relative(tracking.cwd, absPath);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return absPath;
	}
	return relative;
}

/**
 * One compact `<kernel> note:` line per net-mutated path, in the cell's own
 * output — the bash tool prompt promises it for every kernel language, and the
 * status events alone are invisible to the model. Same wording and the same
 * once-per-path-per-cell timing as _fs_emit_mutation_note in eval/py/prelude.py.
 */
function emitMutationNote(tracking: CellTracking, absPath: string, record: TouchedRecord): void {
	const meta = tracking.reportedMeta.get(absPath);
	if (!meta) return;
	let line: string;
	if (meta.op === "write") {
		if (!record.existed) {
			const suffix = meta.diff ? ` (${meta.added} line${meta.added === 1 ? "" : "s"})` : "";
			line = `created ${notePath(tracking, absPath)}${suffix}`;
		} else {
			const suffix = meta.diff ? ` (+${meta.added} \u2212${meta.removed})` : "";
			line = `wrote ${notePath(tracking, absPath)}${suffix}`;
		}
	} else {
		line = `${meta.op === "delete" ? "deleted" : "reverted"} ${notePath(tracking, absPath)}`;
	}
	tracking.note(`<kernel> note: ${line}\n`);
}

function eventId(tracking: CellTracking, absPath: string): string {
	return `${tracking.runId}:${absPath}`;
}

type ReportOutcome = "emitted" | "skipped" | "capped";

async function reportPath(tracking: CellTracking, absPath: string, record: TouchedRecord): Promise<ReportOutcome> {
	let stat: { mtimeMs: number; size: number; isFile: boolean } | null = null;
	try {
		const current = await fs.stat(absPath);
		stat = { mtimeMs: current.mtimeMs, size: current.size, isFile: current.isFile() };
	} catch {
		stat = null;
	}
	if (!stat?.isFile) {
		if (!record.existed) {
			if (tracking.reported.has(absPath) && tracking.reported.get(absPath) !== null) {
				tracking.reported.set(absPath, null);
				setReportMeta(tracking, absPath, "revert", undefined);
				tracking.emit({ op: "revert", path: absPath, id: eventId(tracking, absPath) });
				return "emitted";
			}
			return "skipped";
		}
		if (tracking.reported.has(absPath)) {
			if (tracking.reported.get(absPath) === null) return "skipped";
		} else if (tracking.reported.size >= MAX_EVENTS) {
			return "capped";
		}
		const event: JsStatusEvent = { op: "delete", path: absPath, id: eventId(tracking, absPath) };
		if (record.before !== null) {
			const capped = capEventDiff(record.before, "");
			if (capped) {
				event.diff = capped.diff;
				if (capped.diffTruncated) event.diffTruncated = true;
			}
		}
		tracking.reported.set(absPath, null);
		setReportMeta(tracking, absPath, "delete", event.diff);
		tracking.emit(event);
		return "emitted";
	}
	if (record.key !== null && record.key === `${stat.mtimeMs}:${stat.size}`) return "skipped";
	const { text, sha } =
		stat.size > DIFF_MAX_BYTES ? { text: null, sha: await shaOfFileAsync(absPath) } : await readContentAsync(absPath);
	if (sha === null) return "skipped";
	if (record.beforeSha === sha) {
		if (tracking.reported.has(absPath)) {
			tracking.reported.set(absPath, sha);
			setReportMeta(tracking, absPath, "revert", undefined);
			tracking.emit({ op: "revert", path: absPath, id: eventId(tracking, absPath) });
			return "emitted";
		}
		return "skipped";
	}
	if (tracking.reported.get(absPath) === sha) return "skipped";
	if (!tracking.reported.has(absPath) && tracking.reported.size >= MAX_EVENTS) return "capped";
	tracking.reported.set(absPath, sha);
	if (text !== null) {
		const event: JsStatusEvent = {
			op: "write",
			path: absPath,
			chars: text.length,
			sha,
			id: eventId(tracking, absPath),
		};
		const beforeText = record.existed ? record.before : "";
		if (beforeText !== null) {
			const capped = capEventDiff(beforeText, text);
			if (capped) {
				event.diff = capped.diff;
				if (capped.diffTruncated) event.diffTruncated = true;
			}
		}
		setReportMeta(tracking, absPath, "write", event.diff);
		tracking.emit(event);
	} else {
		setReportMeta(tracking, absPath, "write", undefined);
		tracking.emit({ op: "write", path: absPath, bytes: stat.size, sha, id: eventId(tracking, absPath) });
	}
	return "emitted";
}

function reportSettled(rawPath: unknown): void {
	const tracking = trackingStorage.getStore();
	if (!tracking) return;
	const absPath = resolveTrackedPath(rawPath);
	if (!absPath) return;
	const record = tracking.touched.get(absPath);
	if (!record) return;
	const count = tracking.eagerReports.get(absPath) ?? 0;
	if (count >= EAGER_REPORTS_PER_PATH) return;
	tracking.eagerReports.set(absPath, count + 1);
	const previous = tracking.pendingReports.get(absPath) ?? Promise.resolve();
	const next = previous.then(async () => {
		try {
			await reportPath(tracking, absPath, record);
		} catch {}
	});
	tracking.pendingReports.set(absPath, next);
}

export async function flushFileTracking(): Promise<void> {
	const tracking = trackingStorage.getStore();
	if (!tracking) return;
	await Promise.all(tracking.pendingReports.values());
	tracking.pendingReports.clear();
	if (tracking.touched.size > 0) {
		const entries = [...tracking.touched.entries()].sort(([a], [b]) => a.localeCompare(b));
		tracking.touched.clear();
		tracking.capturedTextBytes = 0;
		let capped = 0;
		for (const [absPath, record] of entries) {
			if ((await reportPath(tracking, absPath, record)) === "capped") capped += 1;
			emitMutationNote(tracking, absPath, record);
		}
		if (capped > 0) tracking.emit({ op: "files", count: capped, action: "truncated" });
	}
	tracking.reported.clear();
	tracking.reportedMeta.clear();
	tracking.eagerReports.clear();
}

function isWriteIntentFlags(flags: unknown): boolean {
	if (typeof flags === "number") return (flags & WRITE_FLAGS) !== 0;
	if (typeof flags === "string") return /[wax+]/.test(flags);
	return false;
}

interface TreeEntry {
	source: string;
	relative: string;
}

function collectTreeEntries(rawPath: unknown): TreeEntry[] {
	const root = resolveTrackedPath(rawPath);
	if (!root) return [];
	const entries: TreeEntry[] = [];
	const pending: TreeEntry[] = [{ source: root, relative: "" }];
	while (pending.length > 0) {
		const entry = pending.pop()!;
		let stat: fsSync.Stats;
		try {
			stat = fsSync.lstatSync(entry.source);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) {
			entries.push(entry);
			continue;
		}
		let names: string[];
		try {
			names = fsSync.readdirSync(entry.source);
		} catch {
			continue;
		}
		for (const name of names) {
			pending.push({
				source: path.join(entry.source, name),
				relative: entry.relative ? path.join(entry.relative, name) : name,
			});
		}
	}
	return entries;
}

function treeDestinationTargets(source: unknown, destination: unknown): string[] {
	const destinationRoot = resolveTrackedPath(destination);
	if (!destinationRoot) return [];
	const entries = collectTreeEntries(source);
	return entries.length > 0 ? entries.map(entry => path.join(destinationRoot, entry.relative)) : [destinationRoot];
}

function mutationTargets(name: string, args: unknown[]): unknown[] {
	switch (name) {
		case "rename":
		case "renameSync": {
			const sourceEntries = collectTreeEntries(args[0]);
			const destinationRoot = resolveTrackedPath(args[1]);
			if (sourceEntries.length === 0 || !destinationRoot) return [args[0], args[1]];
			return sourceEntries.flatMap(entry => [entry.source, path.join(destinationRoot, entry.relative)]);
		}
		case "copyFile":
		case "copyFileSync":
		case "link":
		case "linkSync":
		case "symlink":
		case "symlinkSync":
			return [args[1]];
		case "cp":
		case "cpSync":
			return treeDestinationTargets(args[0], args[1]);
		case "rm":
		case "rmSync":
		case "rmdir":
		case "rmdirSync": {
			const entries = collectTreeEntries(args[0]);
			return entries.length > 0 ? entries.map(entry => entry.source) : [args[0]];
		}
		case "createWriteStream": {
			const fd = (args[1] as { fd?: unknown } | undefined)?.fd;
			return [typeof fd === "number" ? fd : args[0]];
		}
		case "open":
		case "openSync":
			return [];
		default:
			return [args[0]];
	}
}

function recordMutation(name: string, args: unknown[]): unknown[] {
	let targets: unknown[];
	try {
		targets = mutationTargets(name, args);
	} catch {
		// Observation failures must not break the mutation. The stale check below
		// is deliberately outside this catch: suppressing it would permit clobbering.
		return [];
	}
	for (const target of targets) checkStaleWrite(target);
	for (const target of targets) noteTouched(target);
	return targets;
}

function reportSettledTargets(targets: readonly unknown[]): void {
	for (const target of targets) reportSettled(target);
}

function finishSuccessfulMutation(targets: readonly unknown[]): void {
	for (const target of targets) forgetRead(target);
	reportSettledTargets(targets);
}

function reportSettledCall(targets: readonly unknown[], result: unknown): unknown {
	if (result instanceof Promise) {
		return result.then(
			value => {
				finishSuccessfulMutation(targets);
				return value;
			},
			error => {
				reportSettledTargets(targets);
				throw error;
			},
		);
	}
	finishSuccessfulMutation(targets);
	return result;
}

function wrapTrackedFunction(original: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown {
	const existing = wrappedFunctions.get(original);
	if (existing) return existing;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const targets = recordMutation(name, args);
		const callback = args.at(-1);
		if (typeof callback === "function" && !name.endsWith("Sync") && name !== "createWriteStream") {
			const callbackArgs = [...args];
			callbackArgs[callbackArgs.length - 1] = function (this: unknown, ...resultArgs: unknown[]) {
				if (resultArgs[0]) reportSettledTargets(targets);
				else finishSuccessfulMutation(targets);
				return callback.apply(this, resultArgs);
			};
			return original.apply(this, callbackArgs);
		}
		const result = original.apply(this, args);
		if (name === "createWriteStream") {
			for (const target of targets) forgetRead(target);
			return result;
		}
		return reportSettledCall(targets, result);
	};
	wrappedFunctions.set(original, wrapped);
	return wrapped;
}

function wrapFileHandle(handle: object, absPath: string): object {
	const existing = wrappedFileHandles.get(handle);
	if (existing) return existing;
	const methodCache = new Map<PropertyKey, unknown>();
	const fd = Reflect.get(handle, "fd", handle);
	if (typeof fd === "number") fdPaths.set(fd, absPath);
	fileHandlePaths.set(handle, absPath);
	const proxy = new Proxy(handle, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (methodCache.has(prop)) return methodCache.get(prop);
			let wrapped: (...args: unknown[]) => unknown;
			if (prop === "close") {
				wrapped = (...args) => {
					const result: unknown = Reflect.apply(value, target, args);
					if (!(result instanceof Promise)) {
						if (typeof fd === "number") fdPaths.delete(fd);
						return result;
					}
					return result.then(closed => {
						if (typeof fd === "number") fdPaths.delete(fd);
						return closed;
					});
				};
			} else if (typeof prop === "string" && FILE_HANDLE_MUTATION_NAMES[prop]) {
				wrapped = (...args) => {
					noteTouched(absPath);
					const result: unknown = Reflect.apply(value, target, args);
					return prop === "createWriteStream" ? result : reportSettledCall([absPath], result);
				};
			} else {
				wrapped = value.bind(target) as (...args: unknown[]) => unknown;
			}
			methodCache.set(prop, wrapped);
			return wrapped;
		},
	});
	wrappedFileHandles.set(handle, proxy);
	fileHandlePaths.set(proxy, absPath);
	return proxy;
}

function wrapReadFunction(original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
	const existing = wrappedFunctions.get(original);
	if (existing) return existing;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const target = args[0];
		const callback = args.at(-1);
		if (typeof callback === "function") {
			const callbackArgs = [...args];
			callbackArgs[callbackArgs.length - 1] = function (this: unknown, ...resultArgs: unknown[]) {
				if (!resultArgs[0]) noteRead(target);
				return callback.apply(this, resultArgs);
			};
			return original.apply(this, callbackArgs);
		}
		const result = original.apply(this, args);
		if (result instanceof Promise) {
			return result.then(value => {
				noteRead(target);
				return value;
			});
		}
		noteRead(target);
		return result;
	};
	wrappedFunctions.set(original, wrapped);
	return wrapped;
}

function wrapOpenFunction(original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
	const existing = wrappedFunctions.get(original);
	if (existing) return existing;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const absPath = resolveTrackedPath(args[0]);
		const writeIntent = isWriteIntentFlags(args[1]);
		if (absPath && writeIntent) {
			checkStaleWrite(absPath);
			noteTouched(absPath);
		}
		const callback = args.at(-1);
		if (typeof callback === "function") {
			const callbackArgs = [...args];
			callbackArgs[callbackArgs.length - 1] = function (this: unknown, ...resultArgs: unknown[]) {
				const [error, fd] = resultArgs;
				if (!error && absPath && typeof fd === "number") {
					fdPaths.set(fd, absPath);
					if (writeIntent) forgetRead(absPath);
					else noteRead(absPath);
				}
				return callback.apply(this, resultArgs);
			};
			return original.apply(this, callbackArgs);
		}
		const result = original.apply(this, args);
		if (typeof result === "number") {
			if (absPath) {
				fdPaths.set(result, absPath);
				if (writeIntent) forgetRead(absPath);
				else noteRead(absPath);
			}
			return result;
		}
		if (result instanceof Promise && absPath) {
			return result.then(handle => {
				if (writeIntent) forgetRead(absPath);
				else noteRead(absPath);
				return wrapFileHandle(handle as object, absPath);
			});
		}
		return result;
	};
	wrappedFunctions.set(original, wrapped);
	return wrapped;
}

function wrapCloseFunction(original: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown {
	const existing = wrappedFunctions.get(original);
	if (existing) return existing;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const fd = args[0];
		const callback = args.at(-1);
		if (typeof callback === "function" && name !== "closeSync") {
			const callbackArgs = [...args];
			callbackArgs[callbackArgs.length - 1] = function (this: unknown, ...resultArgs: unknown[]) {
				if (!resultArgs[0] && typeof fd === "number") fdPaths.delete(fd);
				return callback.apply(this, resultArgs);
			};
			return original.apply(this, callbackArgs);
		}
		const result = original.apply(this, args);
		if (typeof fd === "number") fdPaths.delete(fd);
		return result;
	};
	wrappedFunctions.set(original, wrapped);
	return wrapped;
}

export function trackedFsModule<T extends object>(mod: T): T {
	const cached = wrappedModules.get(mod);
	if (cached) return cached as T;
	const proxy = new Proxy(mod, {
		get(target, prop) {
			if (prop === "promises") {
				return trackedFsModule(Reflect.get(target, prop, target) as object);
			}
			const value = Reflect.get(target, prop, target);
			if (typeof prop !== "string" || typeof value !== "function") return value;
			const fn = value as (...args: unknown[]) => unknown;
			if (prop === "open" || prop === "openSync") return wrapOpenFunction(fn);
			if (prop === "close" || prop === "closeSync") return wrapCloseFunction(fn, prop);
			if (READ_NAMES[prop]) return wrapReadFunction(fn);
			if (TRACKED_NAMES[prop]) return wrapTrackedFunction(fn, prop);
			return value;
		},
	});
	wrappedModules.set(mod, proxy);
	return proxy as T;
}

const FS_MODULE_IDS: Record<string, true> = {
	fs: true,
	"node:fs": true,
	"fs/promises": true,
	"node:fs/promises": true,
};

export function maybeTrackedModule(id: string, mod: unknown): unknown {
	if (!FS_MODULE_IDS[id] || mod === null || typeof mod !== "object") return mod;
	return trackedFsModule(mod as object);
}

let bunWritePatched = false;
const wrappedBunFiles = new WeakSet<object>();
const wrappedBunWriters = new WeakMap<object, object>();
const BUN_FILE_READ_METHODS = ["arrayBuffer", "bytes", "json", "stream", "text"] as const;

function wrapBunWriter(writer: object, target: unknown): object {
	const existing = wrappedBunWriters.get(writer);
	if (existing) return existing;
	const methodCache = new Map<PropertyKey, unknown>();
	const proxy = new Proxy(writer, {
		get(rawWriter, prop) {
			const value: unknown = Reflect.get(rawWriter, prop, rawWriter);
			if (typeof value !== "function") return value;
			if (methodCache.has(prop)) return methodCache.get(prop);
			const wrapped =
				prop === "end" || prop === "flush"
					? (...args: unknown[]) => reportSettledCall([target], Reflect.apply(value, rawWriter, args))
					: (...args: unknown[]) => Reflect.apply(value, rawWriter, args);
			methodCache.set(prop, wrapped);
			return wrapped;
		},
	});
	wrappedBunWriters.set(writer, proxy);
	return proxy;
}

export function installBunWriteTracking(): void {
	if (bunWritePatched) return;
	bunWritePatched = true;
	const originalFile = Bun.file;
	Bun.file = ((...args: Parameters<typeof Bun.file>) => {
		const file = originalFile(...args);
		if (wrappedBunFiles.has(file)) return file;
		wrappedBunFiles.add(file);
		const target = args[0];
		const originalWriter = file.writer;
		if (typeof originalWriter === "function") {
			Object.defineProperty(file, "writer", {
				configurable: true,
				value: (...writerArgs: unknown[]) => {
					checkStaleWrite(target);
					noteTouched(target);
					const writer: unknown = Reflect.apply(originalWriter, file, writerArgs);
					forgetRead(target);
					return writer !== null && typeof writer === "object" ? wrapBunWriter(writer, target) : writer;
				},
			});
		}
		for (const method of BUN_FILE_READ_METHODS) {
			const originalMethod = file[method];
			if (typeof originalMethod !== "function") continue;
			Object.defineProperty(file, method, {
				configurable: true,
				value: (...methodArgs: unknown[]) => {
					const result: unknown = Reflect.apply(originalMethod, file, methodArgs);
					if (result instanceof Promise) {
						return result.then(value => {
							noteRead(target);
							return value;
						});
					}
					noteRead(target);
					return result;
				},
			});
		}
		return file;
	}) as typeof Bun.file;
	const original = Bun.write;
	Bun.write = (async (destination: unknown, ...rest: unknown[]) => {
		let target: string | undefined;
		try {
			if (typeof destination === "string") target = destination;
			else if (destination instanceof URL) target = destination.pathname;
			// Bun.write(Bun.file(path), …): a path-backed BunFile carries its path
			// as `name`; fd-backed files (Bun.stdout, Bun.file(fd)) have none.
			else if (destination !== null && typeof destination === "object") {
				const name = (destination as { name?: unknown }).name;
				if (typeof name === "string") target = name;
			}
		} catch {
			// Resolving an unusual destination must not break the write.
		}
		// This guard is intentionally outside the best-effort tracking catch:
		// suppressing StaleWriteError would silently permit the clobber.
		if (target !== undefined) {
			checkStaleWrite(target);
			noteTouched(target);
		}
		try {
			const written = await (original as (...a: unknown[]) => Promise<number>)(destination, ...rest);
			forgetRead(target);
			return written;
		} finally {
			reportSettled(target);
		}
	}) as typeof Bun.write;
}
