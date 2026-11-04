import * as fs from "node:fs/promises";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { readNodeTopology } from "../session/node-topology";
import { readSessionLiveState } from "../session/session-liveness";
import { ExecutionAdmission } from "../task/execution-admission";
import { trackLateCleanup } from "../utils/late-cleanup";
import {
	type AgentRef,
	type AgentRefExpectation,
	AgentRegistry,
	getAgentTombstonePath,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";

export type AgentReviver = (expected: AgentRef) => Promise<AgentSession>;

const AGENT_RELEASE_GRACE_MS = 5000;
const MAX_PARKED_LOCAL_REVIVERS = 128;

/** Marks a stopped agent so its row renders as stopped rather than failed after the session ends. */
export async function persistAgentTombstone(sessionFile: string): Promise<void> {
	try {
		await fs.writeFile(getAgentTombstonePath(sessionFile), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

interface AdoptOptions {
	idleTtlMs: number;

	revive?: AgentReviver;
}

interface AdoptedAgent {
	ref: AgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
}

interface ParkInFlight {
	ref: AgentRef;

	promise: Promise<void>;

	cancel: () => boolean;

	cancelled: boolean;

	detached: boolean;
}

interface RevivingAgent {
	ref: AgentRef;
	promise: Promise<AgentSession>;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		const current = AgentLifecycleManager.#global;
		if (current) {
			// Tests may swap the global registry alone; a manager still bound to the old
			// one would publish terminal transitions nobody observes. Production never resets.
			if (current.#registry === AgentRegistry.global()) return current;
			current.#retire();
		}
		AgentLifecycleManager.#global = new AgentLifecycleManager();
		return AgentLifecycleManager.#global;
	}

	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) current.#retire();
		AgentLifecycleManager.#global = undefined;
	}

	#retire(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const adopted of this.#adopted.values()) {
			clearTimeout(adopted.timer);
		}
		this.#adopted.clear();
		this.#revivals.clear();
		this.#parks.clear();
		this.#focusHeldId = undefined;
		this.#persistedReviverFactory = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();

	readonly #parks = new Map<string, ParkInFlight>();

	readonly #revivals = new Map<string, RevivingAgent>();
	readonly #cleanupSessions = new Map<AgentRef, AgentSession>();
	readonly #releases = new Map<AgentRef, Promise<boolean>>();
	#focusHeldId: string | undefined;
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;

	#persistedReviveTtlMs = 0;

	#disposed = false;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
		this.#trimParkedRevivers();
	}

	#trimParkedRevivers(): void {
		if (!this.#persistedReviverFactory) return;
		const parked = [...this.#adopted.values()].filter(
			adopted =>
				adopted.ref.status === "parked" &&
				adopted.ref.sessionFile &&
				!adopted.ref.session &&
				adopted.ref.kind === "sub" &&
				adopted.ref.id !== this.#focusHeldId &&
				!this.#parks.has(adopted.ref.id) &&
				!this.#revivals.has(adopted.ref.id),
		);
		parked.sort((left, right) => right.ref.lastActivity - left.ref.lastActivity);
		for (const adopted of parked.slice(MAX_PARKED_LOCAL_REVIVERS)) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(adopted.ref.id);
		}
	}

	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref || (expected !== undefined && ref !== expected && ref.session !== expected)) {
			logger.warn("AgentLifecycleManager.adopt: unknown or replaced agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = {
			ref,
			idleTtlMs: opts.idleTtlMs,
			revive: opts.revive,
		};
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	// The user reading or typing to an agent is activity the idle TTL cannot see: without this hold a
	// focused agent parks mid-conversation and the view snaps back to the main session.
	holdForFocus(id: string | undefined): void {
		const released = this.#focusHeldId;
		if (released === id) return;
		this.#focusHeldId = id;
		if (id !== undefined) {
			const held = this.#adopted.get(id);
			if (held?.timer) {
				clearTimeout(held.timer);
				held.timer = undefined;
			}
		}
		if (released === undefined) return;
		const adopted = this.#adopted.get(released);
		if (adopted && this.#registry.get(released)?.status === "idle") this.#armTimer(released, adopted);
	}

	has(id: string, expected?: AgentRefExpectation): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected),
		);
	}

	async reclaimDeadCorpse(id: string, expected: AgentRef): Promise<boolean> {
		const ref = this.#registry.get(id);
		if (ref !== expected || ref.status !== "parked" || ref.session) return false;
		if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;
		if (ref.sessionFile && readSessionLiveState(ref.sessionFile).fresh) return false;
		return this.#registry.unregister(id, ref);
	}

	manages(registry: AgentRegistry): boolean {
		return this.#registry === registry;
	}

	isParking(id: string, expected?: AgentRefExpectation): boolean {
		const park = this.#parks.get(id);
		return Boolean(
			park && !park.cancelled && (expected === undefined || park.ref === expected || park.ref.session === expected),
		);
	}

	releaseRuntime(id: string): Promise<void> {
		return this.park(id);
	}

	async stopTurn(id: string): Promise<void> {
		const ref = this.#registry.getNode(id) ?? this.#registry.get(id);
		if (ref?.session) await ref.session.abort();
	}

	async terminateSubtree(id: string, deadlineAt = Date.now() + AGENT_RELEASE_GRACE_MS): Promise<void> {
		const ref = this.#registry.getNode(id) ?? this.#registry.get(id);
		if (!ref) throw new Error(`Unknown node "${id}"`);
		const refs = [...this.#registry.descendants(ref.nodeId ?? id).reverse(), ref];
		// Freeze every generation synchronously before cleanup can yield to a pending revival.
		for (const node of refs) {
			node.generation = (node.generation ?? 0) + 1;
			node.nodeState = "stopped";
			this.#registry.setStatus(node.id, "aborted", node);
		}
		const cleanup = Promise.all(refs.map(node => this.release(node.id, node, { tombstone: true }))).then(() => {});
		try {
			await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => cleanup);
		} catch (error) {
			if (Date.now() >= deadlineAt) trackLateCleanup(cleanup, { id, resource: "agent-subtree" });
			throw error;
		}
	}

	async closeTree(rootId: string): Promise<void> {
		const ref = this.#registry.getNode(rootId);
		if (!ref || ref.nodeId !== ref.rootId) throw new Error(`Unknown tree "${rootId}"`);
		await this.terminateSubtree(rootId);
	}

	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref || adopted.ref !== ref) return;
		const session = ref.session;
		if (!session || ref.status !== "idle") return;
		// Parking disposes the session. A live monitor must retain its owner and wake sink.
		if (session.hasActiveMonitors() || session.ircWakesPending) {
			this.#armTimer(id, adopted);
			return;
		}

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				await Promise.resolve();
				if (cancelled) return;

				const live = this.#registry.get(id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;
				if (session.hasActiveMonitors() || session.ircWakesPending) {
					this.#armTimer(id, adopted);
					return;
				}

				try {
					const directCost = session.sessionManager.getUsageStatistics().cost;
					if (Number.isFinite(directCost) && directCost >= 0)
						this.#registry.setHistory(id, { directCost }, ref.sessionFile ?? undefined);
				} catch (error) {
					logger.debug("Agent park cost snapshot failed", { id, error: String(error) });
				}

				await ExecutionAdmission.global().withMutation([ref.nodeId ?? id], () =>
					session.prepareRuntimeRelease(async () => {
						if (cancelled || this.#registry.get(id) !== ref || ref.status !== "idle") return;
						park.detached = true;
						this.#registry.detachSession(id, ref);
						this.#registry.setStatus(id, "parked", ref);
						try {
							await session.dispose({ disposition: "runtime-release" });
						} catch (error) {
							this.#cleanupSessions.set(ref, session);
							throw error;
						}
					}),
				);
			} finally {
				if (this.#parks.get(id) === park) this.#parks.delete(id);
				this.#trimParkedRevivers();
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	async ensureLive(id: string): Promise<AgentSession> {
		const park = this.#parks.get(id);
		if (park) {
			const parked = this.#registry.get(id);

			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = this.#registry.get(id)?.session;
				if (kept) {
					const adopted = this.#adopted.get(id);
					if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				await park.promise;
			}
		}

		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.sessionFile) {
			const node = await readNodeTopology(ref.sessionFile);
			if (node && (node.state !== "active" || node.generation !== ref.generation)) {
				throw new Error(`Agent "${id}" generation is no longer active.`);
			}
		}
		if (ref.status === "aborted" || (ref.nodeState !== undefined && ref.nodeState !== "active")) {
			throw new Error(`Agent "${id}" is ${ref.nodeState ?? ref.status} and cannot be revived.`);
		}
		if (this.#cleanupSessions.has(ref)) throw new Error(`Agent "${id}" runtime cleanup is incomplete.`);
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		if (ref.session) return ref.session;
		const revival = this.#resolveAndRevive(id, ref);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return await revival;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		const generation = ref.generation;
		let adoption = this.#adopted.get(id);
		let revive = adoption?.ref === ref ? adoption.revive : undefined;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);

			if (this.#disposed) {
				throw new Error(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was being prepared.`,
				);
			}
			if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs, revive };
				coldAdopted = true;
			}
		}
		if (
			this.#registry.get(id) !== ref ||
			ref.generation !== generation ||
			(ref.nodeState !== undefined && ref.nodeState !== "active")
		) {
			throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		}
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		if (coldAdopted) this.#adopted.set(id, adoption);
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			if (coldAdopted && this.#adopted.get(id) === adoption) this.#adopted.delete(id);
			throw error;
		}
	}

	async release(id: string, expected?: AgentRefExpectation, options?: { tombstone?: boolean }): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = this.#registry.get(id);
		const currentMatches =
			current && (expected === undefined || current === expected || current.session === expected);
		const adoptedMatches =
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (!ref) return false;
		const pending = this.#releases.get(ref);
		if (pending) return pending;
		const { promise: release, resolve, reject } = Promise.withResolvers<boolean>();
		this.#releases.set(ref, release);
		void this.#releaseRef(id, ref, options).then(resolve, reject);
		try {
			return await release;
		} finally {
			if (this.#releases.get(ref) === release) this.#releases.delete(ref);
		}
	}

	async #releaseRef(id: string, ref: AgentRef, options?: { tombstone?: boolean }): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}

		const park = this.#parks.get(id);
		if (park && park.ref === ref) {
			if (!park.detached) park.cancel();
			await park.promise;
		}

		const live = (this.#registry.get(id) === ref ? ref.session : null) ?? this.#cleanupSessions.get(ref);
		// The terminal transition lands before any await: the dying session's dispose path unregisters every ref
		// that is not already aborted and detached, so a later transition would let it delete the tombstone. Detach
		// first, because `setStatus` notifies subscribers synchronously and they must never see an aborted ref that
		// still holds a session.
		if (
			options?.tombstone &&
			(!this.#registry.detachSession(id, ref) || !this.#registry.setStatus(id, "aborted", ref))
		) {
			logger.warn("AgentLifecycleManager.release: terminal transition rejected", { id });
		}
		let persistenceFailure: { error: unknown } | undefined;
		try {
			// The sidecar keeps a later discovery pass from reviving this transcript as a fresh parked ref.
			if (options?.tombstone && ref.sessionFile) await persistAgentTombstone(ref.sessionFile);
		} catch (error) {
			persistenceFailure = { error };
		}
		// Cleanup remains required even if persisting the terminal receipt failed.
		if (live) {
			try {
				await live.dispose();
				await ExecutionAdmission.global().settleNode(ref.nodeId ?? id);
				this.#cleanupSessions.delete(ref);
			} catch (error) {
				this.#cleanupSessions.set(ref, live);
				logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
				if (persistenceFailure)
					throw new AggregateError(
						[persistenceFailure.error, error],
						"Agent termination persistence and cleanup failed",
					);
				throw error;
			}
		}
		if (persistenceFailure) throw persistenceFailure.error;
		if (ref.sessionFile) await this.#registry.closeJournal(ref.sessionFile);
		if (!options?.tombstone) this.#registry.unregister(id, ref);
		return true;
	}

	async #releaseWithinDeadline(refs: AgentRef[], deadlineAt: number): Promise<void> {
		await Promise.all(
			refs
				.filter(ref => !this.#releases.has(ref))
				.map(async ref => {
					const { id } = ref;
					const release = this.release(id, ref).then(() => {});
					try {
						await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => release);
					} catch (error) {
						if (Date.now() >= deadlineAt) {
							trackLateCleanup(release, { id, resource: "adopted-agent" });
						}
						logger.warn("Agent cleanup exceeded its deadline", {
							id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}),
		);
	}

	disposeFleet(fleetRoot: string, deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS): Promise<void> {
		const refs = new Set(
			[
				...this.#adopted.values(),
				...this.#parks.values(),
				...this.#revivals.values(),
				...[...this.#cleanupSessions.keys()].map(ref => ({ ref })),
			].map(pending => pending.ref),
		);
		return this.#releaseWithinDeadline(
			[...refs].filter(ref => ref.fleetRoot === fleetRoot),
			deadlineAt,
		);
	}

	async dispose(deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS): Promise<void> {
		this.#unsubscribe?.();
		this.#disposed = true;
		this.#focusHeldId = undefined;
		this.#unsubscribe = undefined;
		const refs = new Set(
			[
				...this.#adopted.values(),
				...this.#parks.values(),
				...this.#revivals.values(),
				...[...this.#cleanupSessions.keys()].map(ref => ({ ref })),
			].map(pending => pending.ref),
		);
		await this.#releaseWithinDeadline([...refs], deadlineAt);
		for (const adopted of this.#adopted.values()) clearTimeout(adopted.timer);
		this.#adopted.clear();
		this.#revivals.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
		if (AgentLifecycleManager.#global === this) AgentLifecycleManager.#global = undefined;
	}

	async #revive(id: string, revive: AgentReviver, ref: AgentRef, adopted: AdoptedAgent): Promise<AgentSession> {
		const generation = ref.generation;
		let session: AgentSession;
		try {
			session = await revive(ref);
		} catch (error) {
			// A reviver builds its session with createAgentSession, which attaches it to this ref and marks it
			// running before returning. If the reviver then fails while wiring tools, extensions or monitors, an
			// attached-but-half-initialized session is left behind — and ensureLive short-circuits on ref.session,
			// so every later wake hands back that broken session instead of retrying. Put the ref back the way
			// we found it and dispose what was built.
			const attached = this.#registry.get(id) === ref ? ref.session : null;
			if (attached) {
				this.#registry.detachSession(id, ref);
				this.#registry.setStatus(id, "parked", ref);
				await attached.dispose().catch(disposeError => {
					logger.error("Failed to dispose a session whose revival failed", {
						id,
						error: disposeError instanceof Error ? disposeError.message : String(disposeError),
					});
				});
			}
			throw error;
		}
		if (
			this.#disposed ||
			ref.generation !== generation ||
			(ref.nodeState !== undefined && ref.nodeState !== "active")
		) {
			await session.prepareRuntimeRelease(() => session.dispose({ disposition: "runtime-release" }));
			throw new Error(
				`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was reviving.`,
			);
		}
		let liveRef = this.#registry.get(id);
		if (liveRef === ref && ref.status === "parked" && !ref.session) {
			if (!this.#registry.attachSession(id, session, ref.sessionFile, ref)) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			await session.dispose();
			throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
		}
		adopted.ref = liveRef;

		if (!this.#registry.setStatus(id, "idle", liveRef)) {
			await session.dispose();
			throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
		}
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		// Side agents (`/side --agent`) are a background conversation the user owns, not a task runner
		// the orchestrator reclaims, and a focused agent is one the user is actively reading or typing
		// to: neither is idle in the sense this timer reclaims.
		if (adopted.idleTtlMs <= 0 || adopted.ref.kind === "side" || this.#focusHeldId === id) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id).catch(error => logger.warn("Idle runtime release refused", { id, error: String(error) }));
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.ref !== event.ref) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		} else if (event.ref.status === "aborted") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
		}
	}
}
