import { AsyncLocalStorage } from "node:async_hooks";
import { AgentRegistry } from "../registry/agent-registry";
import type { SessionNodeTopology } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import { trackLateCleanup } from "../utils/late-cleanup";
import { Semaphore } from "./parallel";

export interface ExecutionTurn {
	nodeId: string;
	treeId: string;
	maxConcurrency: number;
	signal: AbortSignal;
	onFailure?: (error: unknown) => void;
	onSettlement?: (completion: Promise<void>) => void;
}

export interface ExecutionPermit {
	release(): Promise<void>;
}

/** A host installs the broker-backed implementation; SDK embeddings remain process-local. */
export interface ExecutionBroker {
	acquire(turn: ExecutionTurn): Promise<ExecutionPermit>;
}

interface RunnableTurn {
	turn: ExecutionTurn;
	held: boolean;
	waits: number;
	broker?: ExecutionPermit;
	resuming?: Promise<void>;
	releasing?: Promise<void>;
	finished: boolean;
	cleanup?: Promise<void>[];
	cleanupAttempt?: { completion: Promise<void>; state: "pending" | "failed" | "settled" };
	settlement?: Promise<void>;
	settlements?: Set<(completion: Promise<void>) => void>;
	failures?: Set<(error: unknown) => void>;
	waitBarrier?: { promise: Promise<void>; resolve(): void; reject(reason: unknown): void };
}

export interface SpawnReservation {
	commit(): void;
	release(settlement?: Promise<void>): void;
}

/** One node gate and one fair runnable budget, shared by every turn entrypoint in this host. */
export class ExecutionAdmission {
	static #global: ExecutionAdmission | undefined;
	static global(): ExecutionAdmission {
		ExecutionAdmission.#global ??= new ExecutionAdmission();
		return ExecutionAdmission.#global;
	}

	static resetGlobalForTests(): void {
		ExecutionAdmission.#global = undefined;
	}

	readonly #context = new AsyncLocalStorage<RunnableTurn>();
	readonly #semaphore = new Semaphore(0);
	readonly #turns = new Map<string, RunnableTurn>();
	readonly #tails = new Map<string, Promise<void>>();
	readonly #pending = new Map<string, number>();
	readonly #frozen = new Set<string>();
	readonly #blockedCleanup = new Map<string, () => Promise<void>>();
	readonly #children = new Map<string, { parentId: string; treeId: string; pending: boolean }>();
	#broker?: ExecutionBroker;

	setBroker(broker: ExecutionBroker): void {
		if (this.#turns.size > 0) throw new Error("Cannot replace execution broker during a turn");
		this.#broker = broker;
	}

	/** Reject rather than silently queue a mutation behind accepted work. The caller supplies durable descendants. */
	async withMutation<T>(nodeIds: readonly string[], run: () => Promise<T>): Promise<T> {
		for (const id of nodeIds) {
			if (
				this.#frozen.has(id) ||
				this.#pending.has(id) ||
				this.#turns.has(id) ||
				[...this.#children.values()].some(child => child.parentId === id && child.pending)
			) {
				throw new Error(`Node "${id}" has accepted work or a transition in progress`);
			}
		}
		for (const id of nodeIds) this.#frozen.add(id);
		try {
			return await run();
		} finally {
			for (const id of nodeIds) this.#frozen.delete(id);
		}
	}

	reserveSpawn(options: {
		nodeId: string;
		parentId: string;
		treeId: string;
		maxChildren: number;
		maxNodes: number;
	}): SpawnReservation {
		this.#assertUnfrozen(options.parentId);
		if (this.#children.has(options.nodeId)) throw new Error(`Node "${options.nodeId}" is already admitted`);
		let children = 0;
		let nodes = 0;
		for (const child of this.#children.values()) {
			if (child.parentId === options.parentId) children++;
			if (child.treeId === options.treeId) nodes++;
		}
		if (options.maxChildren > 0 && children >= options.maxChildren)
			throw new Error("Per-node child admission limit reached");
		if (options.maxNodes > 0 && nodes >= options.maxNodes) throw new Error("Per-tree node admission limit reached");
		const child = { parentId: options.parentId, treeId: options.treeId, pending: true };
		this.#children.set(options.nodeId, child);
		return {
			commit: () => {
				child.pending = false;
			},
			release: settlement => {
				if (settlement)
					trackLateCleanup(
						settlement.then(() => {
							this.#children.delete(options.nodeId);
						}),
						{ id: options.nodeId, resource: "node-admission" },
					);
				else this.#children.delete(options.nodeId);
			},
		};
	}

	/** Rebuild reservations already durably accepted before this host started; new admissions see them. */
	restoreNode(nodeId: string, parentId: string, treeId: string): void {
		this.#children.set(nodeId, { parentId, treeId, pending: false });
	}

	/** Called only by the lifecycle owner after actual resource cleanup, including a successful retry. */
	async settleNode(nodeId: string): Promise<void> {
		const attempt = this.#turns.get(nodeId)?.cleanupAttempt;
		if (attempt?.state === "pending") await attempt.completion;
		await this.#blockedCleanup.get(nodeId)?.();
		this.#blockedCleanup.delete(nodeId);
		this.#children.delete(nodeId);
	}

	retainUntilSettled(completion: Promise<void>): void {
		const runnable = this.#context.getStore();
		if (!runnable || runnable.finished) throw new Error("Cleanup reservation has no owning execution turn");
		runnable.cleanup ??= [];
		runnable.cleanup.push(completion);
		if (runnable.settlement) {
			runnable.turn.onSettlement?.(runnable.settlement);
			for (const retain of runnable.settlements ?? []) retain(runnable.settlement);
		}
		// The lifecycle owner observes rejection again at settlement; avoid a detached unhandled rejection.
		void completion.catch(() => {});
	}

	/** Executor-owned prompt calls reuse their accepted turn; unrelated focused calls must reserve independently. */
	ownsTurn(nodeId: string): boolean {
		const current = this.#context.getStore();
		return !!current && !current.finished && current.turn.nodeId === nodeId;
	}

	async runTurn<T>(turn: ExecutionTurn, run: () => Promise<T>): Promise<T> {
		const inherited = this.#context.getStore();
		if (inherited && !inherited.finished && inherited.turn.nodeId === turn.nodeId) {
			if (inherited.held && inherited.waits === 0) {
				if (turn.onFailure) {
					inherited.failures ??= new Set();
					inherited.failures.add(turn.onFailure);
				}
				if (turn.onSettlement) {
					inherited.settlements ??= new Set();
					inherited.settlements.add(turn.onSettlement);
				}
				try {
					return await run();
				} finally {
					if (turn.onFailure) inherited.failures?.delete(turn.onFailure);
					if (turn.onSettlement) inherited.settlements?.delete(turn.onSettlement);
				}
			}
			// Result-delivery wakes can execute while an outer owner barrier is lending its permit.
			const nested: RunnableTurn = { turn, held: false, waits: 0, finished: false };
			await this.#acquire(nested);
			this.#turns.set(turn.nodeId, nested);
			try {
				return await this.#context.run(nested, run);
			} finally {
				nested.finished = true;
				await this.#release(nested);
				this.#turns.set(turn.nodeId, inherited);
			}
		}
		this.#assertUnfrozen(turn.nodeId);
		turn.signal.throwIfAborted();
		const prior = this.#tails.get(turn.nodeId);
		const done = Promise.withResolvers<void>();
		this.#tails.set(turn.nodeId, done.promise);
		this.#pending.set(turn.nodeId, (this.#pending.get(turn.nodeId) ?? 0) + 1);
		const runnable: RunnableTurn = { turn, held: false, waits: 0, finished: false, settlement: done.promise };
		try {
			if (prior) await this.#abortable(prior, turn.signal);
			turn.signal.throwIfAborted();
			this.#semaphore.resize(turn.maxConcurrency);
			await this.#acquire(runnable);
			this.#turns.set(turn.nodeId, runnable);
			return await this.#context.run(runnable, run);
		} finally {
			await this.#finishRunnable(runnable, prior, done);
		}
	}

	async #finishRunnable(
		runnable: RunnableTurn,
		prior: Promise<void> | undefined,
		done: PromiseWithResolvers<void>,
	): Promise<void> {
		const { nodeId } = runnable.turn;
		runnable.finished = true;
		await runnable.resuming;
		let settled = false;
		const settle = async () => {
			if (settled) return;
			await this.#release(runnable);
			if (settled) return;
			settled = true;
			if (this.#turns.get(nodeId) === runnable) this.#turns.delete(nodeId);
			const count = this.#pending.get(nodeId)! - 1;
			if (count === 0) this.#pending.delete(nodeId);
			else this.#pending.set(nodeId, count);
			// A cancelled queued entry must not overtake its still-running predecessor.
			void (prior ?? Promise.resolve()).then(() => {
				done.resolve();
				if (this.#tails.get(nodeId) === done.promise) this.#tails.delete(nodeId);
			});
		};
		if (runnable.cleanup?.length) {
			// Publication is already committed. Resource settlement must not hold the answer hostage,
			// nor may publishing it free the node gate, accepted-work reservation or runnable permits.
			this.#blockedCleanup.set(nodeId, settle);
			const attempt: { completion: Promise<void>; state: "pending" | "failed" | "settled" } = {
				state: "pending",
				completion: Promise.all(runnable.cleanup)
					.then(async () => {
						await settle();
						attempt.state = "settled";
						if (this.#blockedCleanup.get(nodeId) === settle) this.#blockedCleanup.delete(nodeId);
					})
					.catch(error => {
						attempt.state = "failed";
						throw error;
					}),
			};
			runnable.cleanupAttempt = attempt;
			trackLateCleanup(attempt.completion, { id: nodeId, resource: "execution-admission" });
			return;
		}
		try {
			await settle();
		} catch (error) {
			this.#blockedCleanup.set(nodeId, settle);
			throw error;
		}
	}

	/** The cleanup attempt may fail after publication; its failed reservation remains held for lifecycle retry. */
	waitForCleanup(nodeId: string): Promise<void> {
		return this.#turns.get(nodeId)?.cleanupAttempt?.completion ?? Promise.resolve();
	}

	async withWaitPermit<T>(nodeId: string, run: () => Promise<T>): Promise<T> {
		const runnable = this.#turns.get(nodeId);
		if (!runnable) return run();
		runnable.waits++;
		runnable.waitBarrier ??= Promise.withResolvers<void>();
		const barrier = runnable.waitBarrier;
		// A new wait may overlap an outstanding broker reacquisition.
		await runnable.resuming;
		await this.#release(runnable);
		try {
			return await this.#abortable(run(), runnable.turn.signal);
		} finally {
			if (--runnable.waits === 0 && !runnable.finished) {
				runnable.resuming = this.#resume(runnable);
			}
			await barrier.promise;
			runnable.turn.signal.throwIfAborted();
		}
	}

	async #resume(runnable: RunnableTurn): Promise<void> {
		try {
			await this.#acquire(runnable);
			if (runnable.waits > 0 || runnable.finished) await this.#release(runnable);
			else {
				const barrier = runnable.waitBarrier;
				runnable.waitBarrier = undefined;
				barrier?.resolve();
			}
		} catch (error) {
			this.#failTurn(runnable, error);
			runnable.waitBarrier?.reject(error);
		} finally {
			runnable.resuming = undefined;
		}
	}

	#assertUnfrozen(nodeId: string): void {
		const seen = new Set<string>();
		let id: string | undefined = nodeId;
		while (id && !seen.has(id)) {
			if (this.#frozen.has(id)) throw new Error("Session node is transitioning");
			seen.add(id);
			id = this.#children.get(id)?.parentId;
		}
	}

	async #acquire(runnable: RunnableTurn): Promise<void> {
		const { signal, treeId } = runnable.turn;
		await this.#semaphore.acquire(signal, treeId);
		runnable.held = true;
		try {
			runnable.broker = await this.#broker?.acquire(runnable.turn);
			signal.throwIfAborted();
		} catch (error) {
			await this.#release(runnable);
			throw error;
		}
	}

	#failTurn(runnable: RunnableTurn, error: unknown): void {
		runnable.turn.onFailure?.(error);
		for (const abort of runnable.failures ?? []) abort(error);
	}

	async #release(runnable: RunnableTurn): Promise<void> {
		if (runnable.releasing) return runnable.releasing;
		runnable.releasing = (async () => {
			await runnable.broker?.release();
			runnable.broker = undefined;
			if (runnable.held) {
				runnable.held = false;
				this.#semaphore.release();
			}
		})();
		try {
			await runnable.releasing;
		} catch (error) {
			// A lost release reply can mean the broker already lent capacity. Never let a provider resume on uncertainty.
			this.#failTurn(runnable, error);
			throw error;
		} finally {
			runnable.releasing = undefined;
		}
	}

	async #abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			signal.throwIfAborted();
			return await Promise.race([work, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

/** Capture once before accepting work; a display label is never a scheduling identity. */
export function executionIdentity(session: {
	sessionManager?: Pick<SessionManager, "getSessionId" | "getNodeTopology">;
	getSessionId?: () => string | null | undefined;
	getAgentId?: () => string | null | undefined;
}): { nodeId: string; treeId: string } {
	const topology = session.sessionManager?.getNodeTopology?.();
	if (topology) {
		const registered = AgentRegistry.global().getNode(topology.id, topology.rootId);
		const state = registered?.nodeState ?? topology.state;
		if (state !== "active") throw new Error(`Session node "${topology.id}" is ${state}`);
		return { nodeId: topology.id, treeId: topology.rootId };
	}
	const sessionId = session.sessionManager?.getSessionId() ?? session.getSessionId?.();
	if (!sessionId) throw new Error("Execution requires a stable session identity");
	const agentId = session.getAgentId?.();
	return { nodeId: agentId && agentId !== "Main" ? agentId : sessionId, treeId: sessionId };
}

/** SDK roots already have metadata; direct tool embeddings initialize it before accepting children. */
export async function ensureExecutionTopology(session: {
	sessionManager?: Pick<SessionManager, "getNodeTopology" | "setNodeTopology" | "getSessionId" | "getSessionFile">;
	getAgentId?: () => string | null | undefined;
}): Promise<SessionNodeTopology | undefined> {
	const manager = session.sessionManager;
	if (!manager?.getNodeTopology || !manager.setNodeTopology) return;
	const existing = manager.getNodeTopology();
	if (existing) return existing;
	const agentId = session.getAgentId?.();
	if (agentId && agentId !== "Main") throw new Error(`Worker "${agentId}" has no durable node topology`);
	const id = manager.getSessionId();
	const root: SessionNodeTopology = {
		id,
		rootId: id,
		rootSessionFile: manager.getSessionFile(),
		generation: 0,
		state: "active",
	};
	await manager.setNodeTopology(root);
	return root;
}
