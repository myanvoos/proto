import * as path from "node:path";
import type { FsObservation } from "@oh-my-pi/pi-natives";
import type { EvalStatusEvent } from "../eval/types";
import { type CappedEventDiff, capEventDiff } from "../utils/diff";

/**
 * Receipts for files the shell itself wrote through an output redirection
 * (`cat > file`, `>>`, `&>`). The native shell captures the before/after text
 * of every redirection target it opened, so a shell write reports exactly like
 * a kernel cell write: one status event carrying the hunk for the TUI, plus one
 * compact model-visible note line. Wording matches the kernel trackers
 * (eval/js/shared/fs-tracker.ts, eval/py/prelude.py) so both write paths read
 * the same in a transcript.
 */
export interface BashFileMutationReport {
	statusEvents: EvalStatusEvent[];
	notes: string[];
}

/** Cwd-relative in the compact note when that does not climb out of the command's cwd. */
function notePath(cwd: string, absPath: string): string {
	const relative = path.relative(cwd, absPath);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return absPath;
	}
	return relative;
}

function noteLine(cwd: string, absPath: string, existed: boolean, capped: CappedEventDiff | undefined): string {
	const target = notePath(cwd, absPath);
	if (!existed) {
		const suffix = capped ? ` (${capped.added} line${capped.added === 1 ? "" : "s"})` : "";
		return `<shell> note: created ${target}${suffix}`;
	}
	const suffix = capped ? ` (+${capped.added} \u2212${capped.removed})` : "";
	return `<shell> note: wrote ${target}${suffix}`;
}

/**
 * One event and one note per redirection target whose content actually changed.
 * A redirection that left the file byte-identical (`> file` over the same text,
 * an append of nothing) is not a mutation and reports nothing.
 */
export function reportBashFileMutations(
	observations: readonly FsObservation[] | undefined,
	cwd: string,
): BashFileMutationReport {
	// One report per path, like a kernel cell: a command that redirects to the
	// same file twice keeps the first pre-command content and the final content.
	const net = new Map<string, { existed: boolean; before: string | null; after: string | null }>();
	for (const observation of observations ?? []) {
		const mutation = observation.mutation;
		// A redirection target that no longer exists was removed after the shell
		// wrote it; the surviving state is the removal, which is not this write.
		if (observation.kind !== "write" || !mutation || !mutation.exists) continue;
		const after = mutation.after ?? null;
		const existing = net.get(observation.path);
		if (existing) {
			existing.after = after;
			continue;
		}
		net.set(observation.path, {
			existed: mutation.existed,
			before: mutation.existed ? (mutation.before ?? null) : "",
			after,
		});
	}

	const statusEvents: EvalStatusEvent[] = [];
	const notes: string[] = [];
	for (const [absPath, { existed, before, after }] of net) {
		if (before !== null && before === after) continue;
		// Oversized or non-UTF-8 content has no snapshot; the path still reports,
		// without a hunk, exactly like an over-budget kernel write.
		const capped = before === null || after === null ? undefined : capEventDiff(before, after);
		const event: EvalStatusEvent = { op: "write", path: absPath, id: absPath };
		if (capped) {
			event.diff = capped.diff;
			if (capped.diffTruncated) event.diffTruncated = true;
		}
		statusEvents.push(event);
		notes.push(noteLine(cwd, absPath, existed, capped));
	}
	return { statusEvents, notes };
}
