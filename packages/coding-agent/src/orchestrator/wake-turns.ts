import { logger } from "@oh-my-pi/pi-utils";
import type { AgentProgress, SingleResult } from "../task/types";

/**
 * A worker turn started by an IRC or monitor wake rather than by fleet `send` still belongs to whoever
 * owns the worker: its result has to reach that owner through the turn's job, and the turn has to be
 * visible in the owner's fleet listing while it runs. The executor drives the turn and the orchestrator
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
const resolvers = new Set<(id: string, task: string) => WakeTurnClaim | undefined>();

/** Lazy owners route dormant worker identities without one closure per historical worker. */
export function registerWakeTurnResolver(resolve: (id: string, task: string) => WakeTurnClaim | undefined): () => void {
	resolvers.add(resolve);
	return () => {
		resolvers.delete(resolve);
	};
}

export function registerWakeTurnOwner(id: string, owner: WakeTurnOwner): () => void {
	owners.set(id, owner);
	return () => {
		if (owners.get(id) === owner) owners.delete(id);
	};
}

export function claimWakeTurn(id: string, task: string): WakeTurnClaim | undefined {
	const owner = owners.get(id);
	try {
		if (owner) return owner(task);
		for (const resolve of resolvers) {
			const claim = resolve(id, task);
			if (claim) return claim;
		}
		return undefined;
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
	resolvers.clear();
}
