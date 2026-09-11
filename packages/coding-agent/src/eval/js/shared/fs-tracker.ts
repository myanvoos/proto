import { constants, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
// Aggregate budget for pre-mutation snapshots kept per cell (mirrors
// MAX_CAPTURE_CONTENT_BYTES in eval/cell-file-diff.ts); past it noteTouched
// stores only the sha and the flush emits writes without diffs.
const CAPTURE_TEXT_BUDGET = 16 * 1024 * 1024;
const WRITE_FLAGS =
	constants.O_WRONLY |
	constants.O_RDWR |
	constants.O_CREAT |
	constants.O_TRUNC |
	constants.O_APPEND |
	// O_TMPFILE is Linux-only and missing from the fs constant typings.
	((constants as typeof constants & { O_TMPFILE?: number }).O_TMPFILE ?? 0);

interface TouchedRecord {
	existed: boolean;
	key: string | null;
	before: string | null;
	beforeSha: string | null;
}

interface CellTracking {
	runId: string;
	emit: (event: JsStatusEvent) => void;
}

const touched = new Map<string, TouchedRecord>();
// abspath → content sha last reported this cell (null: reported deleted).
const reported = new Map<string, string | null>();
// abspath → settle-time reports made this cell.
const eagerReports = new Map<string, number>();
// abspath → chain of in-flight reports, so two settles of one path never
// race their reads and the flush can wait for every eager report.
const pendingReports = new Map<string, Promise<void>>();
let capturedTextBytes = 0;
let cell: CellTracking | undefined;
const wrappedModules = new WeakMap<object, unknown>();
const wrappedFunctions = new WeakMap<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();

const SYNC_TRACKED_NAMES = new Set([
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"rm",
	"rmSync",
	"unlink",
	"unlinkSync",
	"rename",
	"renameSync",
	"truncate",
	"truncateSync",
	"copyFile",
	"copyFileSync",
	"open",
	"openSync",
	"createWriteStream",
]);
function looksPruned(absPath: string): boolean {
	if (SKIPPED_SUFFIXES.some(suffix => absPath.endsWith(suffix))) return true;
	const parts = absPath.split(path.sep);
	for (let index = 0; index < parts.length - 1; index++) {
		if (PRUNED_DIRS.has(parts[index])) return true;
	}
	return false;
}

// Synchronous by design: called inside the sync mutation wrappers, where the
// pre-mutation snapshot must be captured before the wrapped call runs.
function readContent(absPath: string): { text: string | null; sha: string | null } {
	try {
		const bytes = readFileSync(absPath);
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
	if (typeof rawPath !== "string" || rawPath.length === 0) return;
	const absPath = path.resolve(rawPath);
	if (touched.has(absPath) || looksPruned(absPath)) return;
	let stat: { mtimeMs: number; size: number; isFile: boolean };
	try {
		const s = statSync(absPath);
		stat = { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
	} catch {
		// not there yet (create-mode): the flush decides from post-cell state
		touched.set(absPath, { existed: false, key: null, before: null, beforeSha: null });
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
		// The sha is kept even past the capture budget so the flush can still
		// dedupe content-identical rewrites; only the text is dropped, and the
		// flush then emits the write with no diff (mirrors prelude.py _fs_record).
		const pre = readContent(absPath);
		record.beforeSha = pre.sha;
		if (pre.text !== null && capturedTextBytes < CAPTURE_TEXT_BUDGET) {
			record.before = pre.text;
			capturedTextBytes += pre.text.length;
		}
	}
	touched.set(absPath, record);
}

export function beginFileTracking(runId: string, emit: (event: JsStatusEvent) => void): void {
	touched.clear();
	reported.clear();
	eagerReports.clear();
	pendingReports.clear();
	capturedTextBytes = 0;
	cell = { runId, emit };
}

function eventId(absPath: string): string {
	return `${cell?.runId}:${absPath}`;
}

type ReportOutcome = "emitted" | "skipped" | "capped";

// Report one touched path's current state as a write/delete status event
// carrying the net diff from its pre-cell content (mirrors _fs_report_path in
// eval/py/prelude.py). "skipped": unchanged, already reported at this
// content, or unreadable. "capped": the cell already reports MAX_EVENTS
// paths; the flush counts these for its truncation marker.
async function reportPath(absPath: string, record: TouchedRecord): Promise<ReportOutcome> {
	const tracking = cell;
	if (!tracking) return "skipped";
	let stat: { mtimeMs: number; size: number; isFile: boolean } | null = null;
	try {
		const s = await fs.stat(absPath);
		stat = { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
	} catch {
		stat = null;
	}
	if (!stat?.isFile) {
		if (!record.existed) return "skipped";
		if (reported.has(absPath)) {
			if (reported.get(absPath) === null) return "skipped";
		} else if (reported.size >= MAX_EVENTS) {
			return "capped";
		}
		const event: JsStatusEvent = { op: "delete", path: absPath, id: eventId(absPath) };
		if (record.before !== null) {
			const capped = capEventDiff(record.before, "");
			if (capped) {
				event.diff = capped.diff;
				if (capped.diffTruncated) event.diffTruncated = true;
			}
		}
		reported.set(absPath, null);
		tracking.emit(event);
		return "emitted";
	}
	if (record.key !== null && record.key === `${stat.mtimeMs}:${stat.size}`) return "skipped";
	const { text, sha } =
		stat.size > DIFF_MAX_BYTES ? { text: null, sha: await shaOfFileAsync(absPath) } : await readContentAsync(absPath);
	if (sha === null) return "skipped";
	if (record.beforeSha === sha || reported.get(absPath) === sha) return "skipped";
	if (!reported.has(absPath) && reported.size >= MAX_EVENTS) return "capped";
	reported.set(absPath, sha);
	if (text !== null) {
		const event: JsStatusEvent = { op: "write", path: absPath, chars: text.length, sha, id: eventId(absPath) };
		// An existed file whose pre-mutation content was not captured (over
		// budget, or the snapshot read failed) gets no diff rather than a fake
		// one diffed against "".
		const beforeText = record.existed ? record.before : "";
		if (beforeText !== null) {
			const capped = capEventDiff(beforeText, text);
			if (capped) {
				event.diff = capped.diff;
				if (capped.diffTruncated) event.diffTruncated = true;
			}
		}
		tracking.emit(event);
	} else {
		tracking.emit({ op: "write", path: absPath, bytes: stat.size, sha, id: eventId(absPath) });
	}
	return "emitted";
}

// Settle-time report for a path a tracked mutation just finished touching.
// The record stays in `touched` so the flush re-checks the path (a later
// rewrite reports again; an unchanged file dedupes by sha).
function reportSettled(rawPath: unknown): void {
	if (!cell || typeof rawPath !== "string" || rawPath.length === 0) return;
	const absPath = path.resolve(rawPath);
	const record = touched.get(absPath);
	if (!record) return;
	const count = eagerReports.get(absPath) ?? 0;
	if (count >= EAGER_REPORTS_PER_PATH) return;
	eagerReports.set(absPath, count + 1);
	const previous = pendingReports.get(absPath) ?? Promise.resolve();
	const next = previous.then(async () => {
		try {
			await reportPath(absPath, record);
		} catch {
			// reporting must never surface into user code
		}
	});
	pendingReports.set(absPath, next);
}

export async function flushFileTracking(): Promise<void> {
	await Promise.all(pendingReports.values());
	pendingReports.clear();
	if (touched.size > 0) {
		const entries = [...touched.entries()].sort(([a], [b]) => a.localeCompare(b));
		touched.clear();
		capturedTextBytes = 0;
		let capped = 0;
		for (const [absPath, record] of entries) {
			if ((await reportPath(absPath, record)) === "capped") capped += 1;
		}
		if (capped > 0) cell?.emit({ op: "files", count: capped, action: "truncated" });
	}
	reported.clear();
	eagerReports.clear();
	cell = undefined;
}

function isWriteIntentFlags(flags: unknown): boolean {
	if (typeof flags === "number") return (flags & WRITE_FLAGS) !== 0;
	if (typeof flags === "string") return /[wax+]/.test(flags);
	return false;
}

function recordMutation(name: string, args: unknown[]): void {
	try {
		switch (name) {
			case "rename":
			case "renameSync":
				noteTouched(args[0]);
				noteTouched(args[1]);
				return;
			case "copyFile":
			case "copyFileSync":
				noteTouched(args[1]);
				return;
			case "createWriteStream":
				if (isWriteIntentFlags((args[1] as { flags?: unknown } | undefined)?.flags ?? "w")) noteTouched(args[0]);
				return;
			case "open":
			case "openSync":
				if (isWriteIntentFlags(args[1])) noteTouched(args[0]);
				return;
			default:
				// writeFile(Sync), appendFile(Sync), rm(Sync), unlink(Sync),
				// truncate(Sync), and the promise variants all target args[0]
				noteTouched(args[0]);
		}
	} catch {
		// tracking must never break the mutation it observes
	}
}

// Paths a tracked call has finished mutating once it returns (sync) or
// resolves (promise). Handle-based calls (open, createWriteStream) mutate
// after they return, so they report at the cell-end flush instead.
function settledPaths(name: string, args: unknown[]): unknown[] {
	switch (name) {
		case "rename":
		case "renameSync":
			return [args[0], args[1]];
		case "copyFile":
		case "copyFileSync":
			return [args[1]];
		case "open":
		case "openSync":
		case "createWriteStream":
			return [];
		default:
			return [args[0]];
	}
}

function reportSettledCall(name: string, args: unknown[], result: unknown): unknown {
	const report = () => {
		for (const target of settledPaths(name, args)) reportSettled(target);
	};
	if (result instanceof Promise) {
		return result.then(
			value => {
				report();
				return value;
			},
			error => {
				report();
				throw error;
			},
		);
	}
	report();
	return result;
}

function wrapTrackedFunction(original: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown {
	const existing = wrappedFunctions.get(original);
	if (existing) return existing;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		recordMutation(name, args);
		return reportSettledCall(name, args, original.apply(this, args));
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
			if (typeof prop === "string" && typeof value === "function" && SYNC_TRACKED_NAMES.has(prop)) {
				return wrapTrackedFunction(value as (...args: unknown[]) => unknown, prop);
			}
			return value;
		},
	});
	wrappedModules.set(mod, proxy);
	return proxy as T;
}

const FS_MODULE_IDS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

export function maybeTrackedModule(id: string, mod: unknown): unknown {
	if (!FS_MODULE_IDS.has(id) || mod === null || typeof mod !== "object") return mod;
	return trackedFsModule(mod as object);
}

let bunWritePatched = false;

export function installBunWriteTracking(): void {
	if (bunWritePatched) return;
	bunWritePatched = true;
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
			if (target !== undefined) noteTouched(target);
		} catch {
			// tracking must never break the write
		}
		try {
			return await (original as (...a: unknown[]) => Promise<number>)(destination, ...rest);
		} finally {
			reportSettled(target);
		}
	}) as typeof Bun.write;
}
