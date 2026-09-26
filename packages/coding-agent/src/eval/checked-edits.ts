import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFilePreservingMode, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { capEventDiff } from "../utils/diff";
import { fsObservationLedgerFor } from "./fs-observations";
import type { EvalStatusEvent } from "./types";

export interface CheckedEdit {
	path: string;
	before: string | null;
	after: string;
}
export interface CheckedEditResult {
	state: "preview" | "applied" | "rolled-back" | "partial";
	files: Array<{ path: string; diff?: string; diffTruncated?: true }>;
	/** Paths written during this attempt, including writes subsequently rolled back. */
	applied: string[];
	conflicts: string[];
	error?: string;
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
		emitStatus?: (event: EvalStatusEvent) => void;
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
		return { path: resolveToCwd(value.path, options.session.cwd), before: value.before, after: value.after };
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
		files: edits.map(edit => ({ path: edit.path, ...capEventDiff(edit.before ?? "", edit.after) })),
		applied: [],
		conflicts: [],
	};
	const validate = async (edit: CheckedEdit) => {
		options.signal?.throwIfAborted();
		if ((await readRegular(edit.path)) !== edit.before)
			throw new Error(`Stale checked edit: ${edit.path}; re-read and recompute the batch`);
	};
	const commit = async () => {
		const identities = new Set<string>();
		for (const edit of edits) {
			await validate(edit);
			try {
				const stat = await fs.lstat(edit.path, { bigint: true });
				const identity = `${stat.dev}:${stat.ino}`;
				if (identities.has(identity)) throw new Error("Checked edit batch contains duplicate file aliases");
				identities.add(identity);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		if (!options.apply) return result;
		try {
			for (const edit of edits) {
				await validate(edit);
				if (edit.before === edit.after) continue;
				await atomicWriteFilePreservingMode(edit.path, edit.after);
				result.applied.push(edit.path);
				await fsObservationLedgerFor(options.session).recordWrite(edit.path);
				options.emitStatus?.({ op: "write", path: edit.path, ...capEventDiff(edit.before ?? "", edit.after) });
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
						result.conflicts.push(file);
						await fsObservationLedgerFor(options.session).recordWrite(file);
						continue;
					}
					if (edit.before === null) await fs.unlink(file);
					else await atomicWriteFilePreservingMode(file, edit.before);
					await fsObservationLedgerFor(options.session).recordWrite(file);
					// Reporting failure is not a filesystem rollback conflict.
					try {
						options.emitStatus?.({ op: "revert", path: file });
					} catch (error) {
						result.error += `; Revert status failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				} catch {
					result.conflicts.push(file);
					await fsObservationLedgerFor(options.session).recordWrite(file);
				}
			}
			result.state = result.conflicts.length ? "partial" : "rolled-back";
		}
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
