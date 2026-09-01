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
}

const MAX_PENDING = 8192;

export class FsObservationLedger {
	readonly #pending = new Map<string, FsObservation>();

	record(observation: FsObservation): void {
		this.#pending.delete(observation.path);
		this.#pending.set(observation.path, observation);
		if (this.#pending.size > MAX_PENDING) {
			const oldest = this.#pending.keys().next().value;
			if (oldest !== undefined) this.#pending.delete(oldest);
		}
	}

	recordAll(observations: Iterable<FsObservation>): void {
		for (const observation of observations) this.record(observation);
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
		return drained;
	}
}

export async function recordMutationEvents(
	ledger: FsObservationLedger,
	cwd: string,
	events: readonly EvalStatusEvent[] | undefined,
): Promise<void> {
	for (const event of events ?? []) {
		if ((event.op === "write" || event.op === "delete") && typeof event.path === "string") {
			await ledger.recordWrite(path.resolve(cwd, event.path));
		}
	}
}

async function observe(absPath: string, kind: FsObservationKind): Promise<FsObservation> {
	try {
		const stat = await fs.stat(absPath, { bigint: true });
		if (stat.isFile()) {
			return { path: absPath, kind, mtimeNs: stat.mtimeNs.toString(), size: Number(stat.size) };
		}
	} catch {}
	return { path: absPath, kind, mtimeNs: null, size: null };
}

export type FsObservationSession = Pick<ToolSession, "cwd" | "getSessionFile" | "getEvalSessionId">;

const ledgers = new Map<string, FsObservationLedger>();

export function fsObservationLedger(sessionId: string): FsObservationLedger {
	let ledger = ledgers.get(sessionId);
	if (!ledger) {
		ledger = new FsObservationLedger();
		ledgers.set(sessionId, ledger);
	}
	return ledger;
}

export function fsObservationLedgerFor(session: FsObservationSession): FsObservationLedger {
	return fsObservationLedger(session.getEvalSessionId?.() ?? defaultEvalSessionId(session));
}
