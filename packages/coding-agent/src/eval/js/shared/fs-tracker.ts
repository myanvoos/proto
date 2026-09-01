import { constants, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { capEventDiff } from "../../../edit/diff";
import type { JsStatusEvent } from "./types";

/**
 * Filesystem mutation tracking for JS kernel cells — the counterpart of the
 * Python prelude's audit hook (eval/py/prelude.py). Bun has no audit hook, so
 * the tracker wraps the mutation APIs user code can reach: the `fs` global,
 * `import`/`require` of node:fs and node:fs/promises (via `trackedFsModule` /
 * `maybeTrackedModule`), and `Bun.write` in dedicated worker processes
 * (`installBunWriteTracking`; never installed inline, where the runtime
 * shares the host process with the agent). Records hold each touched path's
 * pre-mutation content; `flushFileTracking` runs at cell end and emits
 * write/delete status events with the same shape as the Python flush, so the
 * host walker dedupes both identically (writes by path + final sha, deletes
 * by path). Helper events also record the content they already showed a diff
 * for, and the flush diffs from that last-reported content so it never
 * re-prints hunks the cell has seen.
 */

const DIFF_MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 50;
const SHA_LENGTH = 16;
// Cache/build noise by directory-name component; mirrors PRUNED_DIRS in
// eval/cell-file-diff.ts and the Python prelude tracker.
const PRUNED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".cache",
	".cargo",
	".rustup",
	".bun",
	".npm",
	".local",
	"target",
	"build",
	"dist",
	".next",
	".nuxt",
	".output",
	".turbo",
	".parcel-cache",
	"coverage",
]);
const SKIPPED_SUFFIXES = [".pyc", ".pyo"];
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

interface ReportedContent {
	sha: string;
	text: string | null;
}

const touched = new Map<string, TouchedRecord>();
const reported = new Map<string, ReportedContent>();
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
		const pre = readContent(absPath);
		record.before = pre.text;
		record.beforeSha = pre.sha;
	}
	touched.set(absPath, record);
}

export function noteReported(absPath: string, sha: string, text?: string): void {
	reported.set(path.resolve(absPath), {
		sha,
		text: typeof text === "string" && text.length <= DIFF_MAX_BYTES ? text : null,
	});
}

export function resetFileTracking(): void {
	touched.clear();
	reported.clear();
}

export function flushFileTracking(emit: (event: JsStatusEvent) => void): void {
	if (touched.size > 0) {
		const entries = [...touched.entries()].sort(([a], [b]) => a.localeCompare(b));
		touched.clear();
		let emitted = 0;
		let truncated = false;
		for (const [absPath, record] of entries) {
			if (emitted >= MAX_EVENTS) {
				truncated = true;
				break;
			}
			let stat: { mtimeMs: number; size: number; isFile: boolean } | null = null;
			try {
				const s = statSync(absPath);
				stat = { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
			} catch {
				stat = null;
			}
			if (!stat?.isFile) {
				if (!record.existed) continue;
				const event: JsStatusEvent = { op: "delete", path: absPath };
				if (record.before !== null) {
					const capped = capEventDiff(record.before, "");
					if (capped) {
						event.diff = capped.diff;
						if (capped.diffTruncated) event.diffTruncated = true;
					}
				}
				emit(event);
				emitted += 1;
				continue;
			}
			if (record.key !== null && record.key === `${stat.mtimeMs}:${stat.size}`) continue;
			const { text, sha } = readContent(absPath);
			const seen = reported.get(absPath);
			if ((record.beforeSha !== null && record.beforeSha === sha) || seen?.sha === sha) continue;
			if (text !== null) {
				const event: JsStatusEvent = { op: "write", path: absPath, chars: text.length, sha };
				const beforeText = seen?.text ?? (record.existed ? record.before : "");
				if (beforeText !== null) {
					const capped = capEventDiff(beforeText, text);
					if (capped) {
						event.diff = capped.diff;
						if (capped.diffTruncated) event.diffTruncated = true;
					}
				}
				emit(event);
			} else {
				emit({ op: "write", path: absPath, bytes: stat.size, sha });
			}
			emitted += 1;
		}
		if (truncated) {
			emit({ op: "files", count: entries.length - emitted, action: "truncated" });
		}
	}
	reported.clear();
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

function wrapTrackedFunction(original: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown {
	const existing = wrappedFunctions.get(original);
	if (existing) return existing;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		recordMutation(name, args);
		return original.apply(this, args);
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
		try {
			if (typeof destination === "string") noteTouched(destination);
			else if (destination instanceof URL) noteTouched(destination.pathname);
		} catch {
			// tracking must never break the write
		}
		return await (original as (...a: unknown[]) => Promise<number>)(destination, ...rest);
	}) as typeof Bun.write;
}

export function snapshotBeforeText(absPath: string): string | null {
	const resolved = path.resolve(absPath);
	const existing = touched.get(resolved);
	if (existing) return existing.existed ? existing.before : "";
	try {
		const s = statSync(resolved);
		if (!s.isFile() || s.size > DIFF_MAX_BYTES) return null;
		return readContent(resolved).text;
	} catch (err) {
		// missing file: helper writes diff against empty content, like write()
		// in the Python prelude; unreadable files get no diff
		return (err as { code?: string }).code === "ENOENT" ? "" : null;
	}
}

export function shaOfBytes(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, SHA_LENGTH);
}
