import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSession } from "../tools";
import { defaultEvalSessionId } from "./session-id";
import type { EvalStatusEvent } from "./types";

export type FsObservationKind = "read" | "write";

export interface FsObservation {
	path: string;
	kind: FsObservationKind;
	mtimeNs: string | null;
	size: number | null;
	sha?: string | null;
}

const MAX_PENDING = 8192;

export class FsObservationLedger {
	readonly #pending = new Map<string, FsObservation>();
	readonly #pendingReads = new Set<string>();
	readonly #mutationPaths = new Set<string>();

	record(observation: FsObservation): void {
		this.#pending.delete(observation.path);
		this.#pendingReads.delete(observation.path);
		this.#pending.set(observation.path, observation);
		if (observation.kind === "write") this.#mutationPaths.add(observation.path);
		else if (!this.#mutationPaths.has(observation.path)) this.#pendingReads.add(observation.path);
		if (this.#pending.size > MAX_PENDING) {
			// Host writes re-arm or invalidate the kernel's stale-read guard and
			// therefore cannot be dropped. Prefer evicting an advisory host read;
			// if every pending entry is a mutation, allow the soft cap to grow
			// until the next drain rather than silently lose correctness.
			const oldestRead = this.#pendingReads.values().next().value;
			if (oldestRead !== undefined) {
				this.#pendingReads.delete(oldestRead);
				this.#pending.delete(oldestRead);
			}
		}
	}

	recordAll(observations: Iterable<FsObservation>): void {
		for (const observation of observations) this.record(observation);
	}

	async recordAllWithContent(observations: Iterable<FsObservation>): Promise<void> {
		for (const observation of observations) {
			if (observation.mtimeNs === null || observation.size === null) {
				this.record(observation);
				continue;
			}
			const stamped = await observe(observation.path, observation.kind);
			if (stamped.mtimeNs === observation.mtimeNs && stamped.size === observation.size) {
				this.record({ ...observation, sha: stamped.sha });
			} else {
				// Preserve the command-time metadata. A mismatch is itself enough
				// to stop a later stale write; adopting the newer stamp would hide it.
				this.record(observation);
			}
		}
	}

	async recordRead(absPath: string): Promise<void> {
		this.record(await observe(absPath, "read"));
	}

	async recordWrite(absPath: string): Promise<void> {
		this.record(await observe(absPath, "write"));
	}

	drain(): FsObservation[] {
		const drained = [...this.#pending.values()];
		this.#pending.clear();
		this.#pendingReads.clear();
		this.#mutationPaths.clear();
		return drained;
	}
}

export async function recordMutationEvents(
	ledger: FsObservationLedger,
	cwd: string,
	events: readonly EvalStatusEvent[] | undefined,
): Promise<void> {
	for (const event of events ?? []) {
		if (typeof event.path !== "string") continue;
		const absPath = path.resolve(cwd, event.path);
		if (event.op === "revert") {
			// A revert tombstone replaces the earlier write/delete event in the
			// visible status stream. Re-stat the restored file so the next
			// Python cell does not compare against the stale pre-cell stamp.
			await ledger.recordRead(absPath);
		} else if (event.op === "write" || event.op === "delete") {
			await ledger.recordWrite(absPath);
		}
	}
}

async function observe(absPath: string, kind: FsObservationKind): Promise<FsObservation> {
	try {
		const before = await fs.stat(absPath, { bigint: true });
		if (!before.isFile()) return { path: absPath, kind, mtimeNs: null, size: null, sha: null };
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(absPath).stream()) hasher.update(chunk);
		const after = await fs.stat(absPath, { bigint: true });
		if (before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
			return { path: absPath, kind, mtimeNs: null, size: null, sha: null };
		}
		return {
			path: absPath,
			kind,
			mtimeNs: after.mtimeNs.toString(),
			size: Number(after.size),
			sha: hasher.digest("hex").slice(0, 16),
		};
	} catch {}
	return { path: absPath, kind, mtimeNs: null, size: null, sha: null };
}

export type FsObservationSession = Pick<ToolSession, "cwd" | "getSessionFile" | "getEvalSessionId">;

interface OwnedFsObservationLedger {
	ledger: FsObservationLedger;
	owners: Set<string>;
}

const ledgers = new Map<string, OwnedFsObservationLedger>();

export function fsObservationLedger(sessionId: string): FsObservationLedger {
	let entry = ledgers.get(sessionId);
	if (!entry) {
		entry = { ledger: new FsObservationLedger(), owners: new Set() };
		ledgers.set(sessionId, entry);
	}
	return entry.ledger;
}

export function retainFsObservationLedger(sessionId: string, ownerId: string): void {
	fsObservationLedger(sessionId);
	ledgers.get(sessionId)?.owners.add(ownerId);
}

export function releaseFsObservationLedger(sessionId: string, ownerId: string): void {
	const entry = ledgers.get(sessionId);
	if (!entry?.owners.delete(ownerId) || entry.owners.size > 0) return;
	ledgers.delete(sessionId);
}

export function fsObservationLedgerFor(session: FsObservationSession): FsObservationLedger {
	return fsObservationLedger(session.getEvalSessionId?.() ?? defaultEvalSessionId(session));
}
