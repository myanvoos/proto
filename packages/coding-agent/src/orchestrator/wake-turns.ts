import { logger } from "@oh-my-pi/pi-utils";
import type { AgentProgress, SingleResult } from "../task/types";

/**
 * A worker turn started by an IRC wake rather than by `orchestrate_send` still belongs to whoever
 * owns the worker: its result has to reach that owner's `orchestrate_wait`, and the turn has to be
 * visible in `orchestrate_list` while it runs. The executor drives the turn and the orchestrator
 * owns the bookkeeping, so the two meet here instead of importing each other.
 */
export interface WakeTurnClaim {
	/** Live activity of the wake turn, so the owner can render it while it runs. */
	progress(progress: AgentProgress): void;
	/** The wake turn produced a result; deliver it as this worker's next turn. */
	settle(result: SingleResult): void;
	/** The wake turn could not produce a result. */
	fail(error: unknown): void;
}

/** Returns a claim when the owner wants to track this wake turn, or undefined to leave it untracked. */
export type WakeTurnOwner = (task: string) => WakeTurnClaim | undefined;

const owners = new Map<string, WakeTurnOwner>();

export function registerWakeTurnOwner(id: string, owner: WakeTurnOwner): () => void {
	owners.set(id, owner);
	return () => {
		if (owners.get(id) === owner) owners.delete(id);
	};
}

export function claimWakeTurn(id: string, task: string): WakeTurnClaim | undefined {
	const owner = owners.get(id);
	if (!owner) return undefined;
	try {
		return owner(task);
	} catch (error) {
		logger.warn("orchestrator: wake turn claim failed; the turn runs untracked", {
			id,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export function resetWakeTurnOwnersForTests(): void {
	owners.clear();
}
