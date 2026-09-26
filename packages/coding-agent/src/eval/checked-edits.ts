import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFilePreservingMode, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { capEventDiff } from "../utils/diff";
import { type FsObservation, fsObservationLedgerFor } from "./fs-observations";

export interface CheckedEdit {
	/** Canonical path (real parent directory) used for locking, writing and reporting. */
	path: string;
	/** The caller's path resolved against the session cwd, before canonicalization. */
	requested: string;
	before: string | null;
	after: string;
}
/**
 * Why a file was not left as the batch intended:
 * - `stale`: `before` text no longer matches the file.
 * - `exists`: `before` was null (create) but the file already exists.
 * - `missing`: `before` was text but the file does not exist.
 * - `changed`: rollback found a newer edit in place of ours and kept it.
 * - `rollback-failed`: restoring the pre-batch content failed.
 */
export type CheckedEditConflictReason = "stale" | "exists" | "missing" | "changed" | "rollback-failed";
export interface CheckedEditConflict {
	path: string;
	reason: CheckedEditConflictReason;
}
/** Post-batch file stamp; the kernel re-arms its stale-write guard from it. */
export interface CheckedEditStamp {
	path: string;
	mtimeNs: string;
	size: number;
	sha: string;
}
export interface CheckedEditResult {
	state: "preview" | "conflict" | "applied" | "rolled-back" | "partial";
	files: Array<{ path: string; diff?: string; diffTruncated?: true }>;
	/** Paths written during this attempt, including writes subsequently rolled back. */
	applied: string[];
	conflicts: CheckedEditConflict[];
	error?: string;
	/**
	 * `apply` only: stamps of written files that still hold the content this batch
	 * left there (after, or before once rolled back), keyed by the caller's path.
	 * Kernel wrappers consume and strip it.
	 */
	stamps?: CheckedEditStamp[];
}

function contentSha(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

function conflictReason(edit: CheckedEdit, current: string | null): CheckedEditConflictReason | undefined {
	if (current === edit.before) return undefined;
	if (edit.before === null) return "exists";
	return current === null ? "missing" : "stale";
}

async function readRegular(file: string): Promise<string | null> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error(`Checked edits require a regular, non-symlink file: ${file}`);
		if (stat.size > 8 * 1024 * 1024) throw new Error(`Checked edit file exceeds 8 MiB: ${file}`);
		return await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export async function checkedEdits(
	raw: unknown,
	options: {
		session: ToolSession;
		apply?: boolean;
		signal?: AbortSignal;
	},
): Promise<CheckedEditResult> {
	options.signal?.throwIfAborted();
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100)
		throw new Error("edit_batch expects 1–100 {path, before, after} entries; before=null requires a new file");
	let bytes = 0;
	const edits: CheckedEdit[] = raw.map((entry: unknown) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error("Invalid checked edit; expected an object");
		const value = entry as Record<string, unknown>;
		if (
			typeof value.path !== "string" ||
			!value.path ||
			value.path.includes("\0") ||
			(value.before !== null && typeof value.before !== "string") ||
			typeof value.after !== "string"
		)
			throw new Error("Invalid checked edit; expected {path, before: string|null, after: string}");
		if (Buffer.byteLength(value.after) > 8 * 1024 * 1024) throw new Error("Checked edit replacement exceeds 8 MiB");
		bytes += Buffer.byteLength(value.before ?? "") + Buffer.byteLength(value.after);
		const requested = resolveToCwd(value.path, options.session.cwd);
		return { path: requested, requested, before: value.before, after: value.after };
	});
	if (bytes > 16 * 1024 * 1024) throw new Error("Checked edit batch exceeds 16 MiB");
	const canonical = await Promise.all(
		edits.map(async edit => path.join(await fs.realpath(path.dirname(edit.path)), path.basename(edit.path))),
	);
	if (new Set(canonical).size !== edits.length) throw new Error("Checked edit batch contains duplicate paths");
	for (let i = 0; i < edits.length; i++) edits[i].path = canonical[i];
	edits.sort((a, b) => a.path.localeCompare(b.path));
	const result: CheckedEditResult = {
		state: "preview",
		files: edits.map(edit => {
			const capped = capEventDiff(edit.before ?? "", edit.after);
			if (!capped) return { path: edit.path };
			return capped.diffTruncated
				? { path: edit.path, diff: capped.diff, diffTruncated: true }
				: { path: edit.path, diff: capped.diff };
		}),
		applied: [],
		conflicts: [],
	};
	const ledger = fsObservationLedgerFor(options.session);
	// Last observation per written path, kept only while it matches the content we left.
	const stamps = new Map<string, FsObservation>();
	const observeWrite = async (edit: CheckedEdit, expected: string | null) => {
		const observation = await ledger.recordWrite(edit.path);
		if (expected !== null && observation.sha === contentSha(expected)) stamps.set(edit.requested, observation);
		else stamps.delete(edit.requested);
	};
	const validate = async (edit: CheckedEdit) => {
		options.signal?.throwIfAborted();
		const reason = conflictReason(edit, await readRegular(edit.path));
		if (reason) throw new Error(`Stale checked edit (${reason}): ${edit.path}; re-read and recompute the batch`);
	};
	const commit = async () => {
		const identities = new Set<string>();
		for (const edit of edits) {
			options.signal?.throwIfAborted();
			const reason = conflictReason(edit, await readRegular(edit.path));
			if (reason) result.conflicts.push({ path: edit.path, reason });
			try {
				const stat = await fs.lstat(edit.path, { bigint: true });
				const identity = `${stat.dev}:${stat.ino}`;
				if (identities.has(identity)) throw new Error("Checked edit batch contains duplicate file aliases");
				identities.add(identity);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		if (result.conflicts.length) {
			result.state = "conflict";
			const stale = result.conflicts.map(conflict => `${conflict.path} (${conflict.reason})`).join(", ");
			result.error = `Stale checked edit; nothing written. Re-read and recompute the batch: ${stale}`;
			return result;
		}
		if (!options.apply) return result;
		try {
			for (const edit of edits) {
				await validate(edit);
				if (edit.before === edit.after) continue;
				await atomicWriteFilePreservingMode(edit.path, edit.after);
				result.applied.push(edit.path);
				await observeWrite(edit, edit.after);
			}
			options.signal?.throwIfAborted();
			result.state = "applied";
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
			for (const file of [...result.applied].reverse()) {
				const edit = edits.find(entry => entry.path === file)!;
				try {
					// Never roll a newer user edit back to our old snapshot.
					if ((await readRegular(file)) !== edit.after) {
						result.conflicts.push({ path: file, reason: "changed" });
						await observeWrite(edit, null);
						continue;
					}
					if (edit.before === null) await fs.unlink(file);
					else await atomicWriteFilePreservingMode(file, edit.before);
					await observeWrite(edit, edit.before);
				} catch {
					result.conflicts.push({ path: file, reason: "rollback-failed" });
					await observeWrite(edit, null);
				}
			}
			result.state = result.conflicts.length ? "partial" : "rolled-back";
		}
		result.stamps = [...stamps].flatMap(([requested, observation]) =>
			observation.mtimeNs !== null && observation.size !== null && observation.sha
				? [{ path: requested, mtimeNs: observation.mtimeNs, size: observation.size, sha: observation.sha }]
				: [],
		);
		return result;
	};
	// Replacement is atomic per file, NOT across the batch. Locks coordinate cooperating
	// writers; external writers can still race validation and replacement. Rollback
	// refuses to overwrite edits observed since our write.
	// Stable lock order prevents competing batches from deadlocking.
	const locked = (index: number): Promise<CheckedEditResult> =>
		index === edits.length ? commit() : withFileLock(edits[index].path, () => locked(index + 1));
	return options.apply ? locked(0) : commit();
}
