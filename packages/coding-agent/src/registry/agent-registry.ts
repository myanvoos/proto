import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

// `/side --agent` clones mint their id with this reserved prefix, and the prefix is what identifies
// them as the `side` kind everywhere they are rebuilt — in-process registration and the persisted
// restore that only sees transcript filenames. Keep minting and detection on this pair.
const SIDE_AGENT_ID_PREFIX = "Side-";

export function newSideAgentId(): string {
	return `${SIDE_AGENT_ID_PREFIX}${Snowflake.next()}`;
}

export function isSideAgentId(id: string): boolean {
	return id.startsWith(SIDE_AGENT_ID_PREFIX);
}

const AGENT_TOMBSTONE_SUFFIX = ".tombstone";

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

export async function hasAgentTombstone(sessionFile: string): Promise<boolean> {
	try {
		await fs.access(getAgentTombstonePath(sessionFile));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export type AgentStatus = "running" | "idle" | "parked" | "aborted";

/** Public lifecycle vocabulary shared by fleet and history://; `aborted` is the registry's terminal state. */
export interface AgentLifecycleState {
	lifecycle: "live" | "parked" | "terminal";
	/** Absent once terminal: a terminal agent has no turns. */
	turnState?: "running" | "idle";
}

export function agentLifecycle(status: AgentStatus): AgentLifecycleState {
	switch (status) {
		case "aborted":
			return { lifecycle: "terminal" };
		case "parked":
			return { lifecycle: "parked", turnState: "idle" };
		case "running":
			return { lifecycle: "live", turnState: "running" };
		case "idle":
			return { lifecycle: "live", turnState: "idle" };
	}
}

type AgentDurationKind = "active" | "span" | "unknown";

export type AgentKind = "main" | "sub" | "side" | "advisor";

export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}

export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;

	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	readOnly?: boolean;

	outputPath?: string;

	patchPath?: string;

	branchName?: string;
}

export interface AgentRef {
	id: string;
	label: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;

	session: AgentSession | null;
	sessionFile: string | null;
	fleetRoot?: string;
	createdAt: number;
	lastActivity: number;

	activity?: string;

	history?: AgentHistorySummary;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

interface RegisterInput {
	id: string;
	label: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	fleetRoot?: string;
	status?: AgentStatus;

	activity?: string;

	createdAt?: number;

	lastActivity?: number;

	history?: AgentHistorySummary;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	static resetGlobalForTests(): void {
		const current = AgentRegistry.#global;
		if (current) {
			current.#retired?.close();
			current.#retired = undefined;
			current.#refs.clear();
			current.#mainRefs.clear();
			current.#refsByFleet.clear();
			current.#listeners.clear();
			current.#dormant.clear();
		}
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #mainRefs = new Set<AgentRef>();
	readonly #refsByFleet = new Map<string, Set<AgentRef>>();
	readonly #listeners = new Set<RegistryListener>();
	// The transcript remains authoritative across process restarts. An anonymous disk-backed
	// index keeps this process's dormant identities addressable without rooting every AgentRef.
	#retired: Database | undefined;
	readonly #dormant = new Map<string, WeakRef<AgentRef>>();
	readonly #dormantFinalizer = new FinalizationRegistry<{ id: string; weak: WeakRef<AgentRef> }>(entry => {
		if (this.#dormant.get(entry.id) === entry.weak) this.#dormant.delete(entry.id);
	});

	#rememberDormant(ref: AgentRef): void {
		if (this.#dormant.get(ref.id)?.deref() === ref) return;
		const weak = new WeakRef(ref);
		this.#dormant.set(ref.id, weak);
		this.#dormantFinalizer.register(ref, { id: ref.id, weak });
	}

	#lookup(id: string): AgentRef | undefined {
		const current = this.#refs.get(id) ?? this.#dormant.get(id)?.deref();
		if (current) return current;
		const row = this.#retired?.query<{ data: string }, [string]>("SELECT data FROM refs WHERE id = ?").get(id);
		if (!row) return undefined;
		const ref = JSON.parse(row.data) as AgentRef;
		this.#rememberDormant(ref);
		return ref;
	}

	#retain(ref: AgentRef): void {
		if (ref.kind === "main" || ref.session || (ref.status !== "parked" && ref.status !== "aborted")) {
			// A superseded main ref (another session's `Main` in a detached fleet) stays addressable
			// through its fleet index; it must not reclaim the primary id slot from the newer main.
			const current = this.#refs.get(ref.id);
			if (current && current !== ref && this.#mainRefs.has(ref)) {
				this.#indexRef(ref);
				return;
			}
			this.#retired?.query("DELETE FROM refs WHERE id = ?").run(ref.id);
			this.#dormant.delete(ref.id);
			this.#refs.set(ref.id, ref);
			this.#indexRef(ref);
			return;
		}
		if (!this.#retired) {
			// SQLite's empty filename is a private temporary *disk* database, removed on close.
			this.#retired = new Database("");
			this.#retired.run("PRAGMA cache_size = -1024");
			this.#retired.run("CREATE TABLE refs (id TEXT PRIMARY KEY, fleet TEXT, data TEXT NOT NULL)");
			this.#retired.run("CREATE INDEX refs_fleet ON refs(fleet)");
		}
		this.#retired
			.query("INSERT OR REPLACE INTO refs (id, fleet, data) VALUES (?, ?, ?)")
			.run(ref.id, ref.fleetRoot ?? null, JSON.stringify(ref));
		this.#rememberDormant(ref);
		this.#unindexRef(ref);
		if (this.#refs.get(ref.id) === ref) this.#refs.delete(ref.id);
	}

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	#indexRef(ref: AgentRef): void {
		if (!ref.fleetRoot) return;
		let refs = this.#refsByFleet.get(ref.fleetRoot);
		if (!refs) {
			refs = new Set();
			this.#refsByFleet.set(ref.fleetRoot, refs);
		}
		refs.add(ref);
	}

	#unindexRef(ref: AgentRef): void {
		if (!ref.fleetRoot) return;
		const refs = this.#refsByFleet.get(ref.fleetRoot);
		if (!refs) return;
		refs.delete(ref);
		if (refs.size === 0) this.#refsByFleet.delete(ref.fleetRoot);
	}

	#resolveRef(id: string, expected?: AgentRefExpectation): AgentRef | undefined {
		const current = this.#lookup(id);
		if (current && this.#matchesExpected(current, expected)) return current;
		if (id !== MAIN_AGENT_ID || expected === undefined) return undefined;
		for (const ref of this.#mainRefs) {
			if (this.#matchesExpected(ref, expected)) return ref;
		}
		return undefined;
	}

	#resolveRefBySessionFile(id: string, sessionFile: string): AgentRef | undefined {
		const current = this.#lookup(id);
		if (current?.sessionFile === sessionFile) return current;
		if (id !== MAIN_AGENT_ID) return undefined;
		for (const ref of this.#mainRefs) {
			if (ref.sessionFile === sessionFile) return ref;
		}
		return undefined;
	}

	#rejectStatusUpdate(id: string, status: AgentStatus, reason: string): false {
		logger.debug("Agent registry status update rejected", { id, status, reason });
		return false;
	}

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const parentFleetRoot = input.parentId ? this.#lookup(input.parentId)?.fleetRoot : undefined;
		const ref: AgentRef = {
			id: input.id,
			label: input.label,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			fleetRoot: input.fleetRoot ?? parentFleetRoot,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity,
			history: input.history,
		};
		const replaced = this.#lookup(ref.id);
		if (replaced && ref.id !== MAIN_AGENT_ID) this.#unindexRef(replaced);
		if (ref.id === MAIN_AGENT_ID) this.#mainRefs.add(ref);
		this.#refs.set(ref.id, ref);
		this.#indexRef(ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#lookup(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref =
			expectedSessionFile === undefined ? this.#lookup(id) : this.#resolveRefBySessionFile(id, expectedSessionFile);
		if (!ref) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setLabel(id: string, label: string, expectedSessionFile?: string): boolean {
		const ref =
			expectedSessionFile === undefined ? this.#lookup(id) : this.#resolveRefBySessionFile(id, expectedSessionFile);
		const normalized = label.trim();
		if (!ref || !normalized || ref.label === normalized) return false;
		ref.label = normalized;
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	updateSessionScope(
		id: string,
		scope: { fleetRoot: string; sessionFile: string | null },
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#resolveRef(id, expected);
		if (!ref) return false;
		if (ref.fleetRoot === scope.fleetRoot && ref.sessionFile === scope.sessionFile) return true;
		this.#unindexRef(ref);
		ref.fleetRoot = scope.fleetRoot;
		ref.sessionFile = scope.sessionFile;
		this.#indexRef(ref);
		ref.lastActivity = Date.now();
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#resolveRef(id, expected);
		if (!ref) {
			const reason = this.#refs.has(id) ? "session-ownership-changed" : "missing-ref";
			return this.#rejectStatusUpdate(id, status, reason);
		}

		if (ref.status === "aborted") {
			return status === "aborted" || this.#rejectStatusUpdate(id, status, "aborted-is-terminal");
		}
		if (ref.status === status) {
			ref.lastActivity = Date.now();
			this.#retain(ref);
			return true;
		}
		ref.status = status;

		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	setActivity(id: string, activity: string): void {
		const ref = this.#lookup(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
		this.#emit({ type: "metadata_changed", ref });
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#resolveRef(id, expected);

		if (!ref || ref.status === "aborted") return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		this.#retain(ref);
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#resolveRef(id, expected);
		if (!ref) return false;
		ref.session = null;
		this.#retain(ref);
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#resolveRef(id, expected);
		if (!ref) return false;
		this.#unindexRef(ref);
		if (id === MAIN_AGENT_ID) this.#mainRefs.delete(ref);
		if (this.#lookup(id) === ref) {
			this.#refs.delete(id);
			this.#dormant.delete(id);
			this.#retired?.query("DELETE FROM refs WHERE id = ?").run(id);
		}
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string, expected?: AgentRefExpectation): AgentRef | undefined {
		return this.#resolveRef(id, expected);
	}

	getInFleet(id: string, fleetRoot: string): AgentRef | undefined {
		const current = this.#lookup(id);
		if (current?.fleetRoot === fleetRoot) return current;
		if (id !== MAIN_AGENT_ID) return undefined;
		for (const ref of this.#mainRefs) {
			if (ref.fleetRoot === fleetRoot) return ref;
		}
		return undefined;
	}

	activateSession(id: string, session: AgentSession): boolean {
		const ref = this.#resolveRef(id, session);
		if (!ref || ref.status === "aborted") return false;
		this.#refs.set(id, ref);
		ref.lastActivity = Date.now();
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	hasOtherRegistration(id: string, expected: AgentRefExpectation): boolean {
		const owned = this.#resolveRef(id, expected);
		if (!owned || id !== MAIN_AGENT_ID) return false;
		for (const ref of this.#mainRefs) {
			if (ref !== owned) return true;
		}
		return false;
	}

	list(): AgentRef[] {
		const refs = [...this.#refs.values()];
		for (const row of this.#retired?.query<{ id: string }, []>("SELECT id FROM refs").iterate() ?? []) {
			const ref = this.#lookup(row.id);
			if (ref) refs.push(ref);
		}
		return refs;
	}

	listInFleet(id: string, scopedFleetRoot?: string): AgentRef[] {
		const fleetRoot = scopedFleetRoot ?? this.#lookup(id)?.fleetRoot;
		if (!fleetRoot) return [];
		const refs = [...(this.#refsByFleet.get(fleetRoot) ?? [])].filter(ref => ref.id !== MAIN_AGENT_ID);
		for (const row of this.#retired
			?.query<{ id: string }, [string]>("SELECT id FROM refs WHERE fleet = ?")
			.iterate(fleetRoot) ?? []) {
			const ref = this.#lookup(row.id);
			if (ref) refs.push(ref);
		}
		const main = this.getInFleet(MAIN_AGENT_ID, fleetRoot);
		if (main) refs.unshift(main);
		return refs;
	}

	sharesFleet(firstId: string, secondId: string, scopedFleetRoot?: string): boolean {
		const first = scopedFleetRoot ? this.getInFleet(firstId, scopedFleetRoot) : this.#lookup(firstId);
		const fleetRoot = scopedFleetRoot ?? first?.fleetRoot;
		if (!fleetRoot) return false;
		const second = this.getInFleet(secondId, fleetRoot);
		return first?.fleetRoot === fleetRoot && second?.fleetRoot === fleetRoot;
	}

	listVisibleTo(id: string, scopedFleetRoot?: string): AgentRef[] {
		return this.listInFleet(id, scopedFleetRoot).filter(
			ref => ref.id !== id && ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle"),
		);
	}

	syncSessionStatus(id: string, session: AgentSession): () => void {
		const unsubscribe = session.subscribeRunState(status => {
			this.setStatus(id, status, session);
		});
		return unsubscribe;
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		if (event.type !== "removed") this.#retain(event.ref);
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {}
		}
	}
}
