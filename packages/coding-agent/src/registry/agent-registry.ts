import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

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

type AgentDurationKind = "active" | "span" | "unknown";

type AgentKind = "main" | "sub" | "advisor";

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
	displayName: string;
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
	displayName: string;
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
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #mainRefs = new Set<AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	#resolveRef(id: string, expected?: AgentRefExpectation): AgentRef | undefined {
		const current = this.#refs.get(id);
		if (current && this.#matchesExpected(current, expected)) return current;
		if (id !== MAIN_AGENT_ID || expected === undefined) return undefined;
		for (const ref of this.#mainRefs) {
			if (this.#matchesExpected(ref, expected)) return ref;
		}
		return undefined;
	}

	#resolveRefBySessionFile(id: string, sessionFile: string): AgentRef | undefined {
		const current = this.#refs.get(id);
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
		const parentFleetRoot = input.parentId ? this.#refs.get(input.parentId)?.fleetRoot : undefined;
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
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
		if (ref.id === MAIN_AGENT_ID) this.#mainRefs.add(ref);
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref =
			expectedSessionFile === undefined
				? this.#refs.get(id)
				: this.#resolveRefBySessionFile(id, expectedSessionFile);
		if (!ref) return false;
		const definedHistory = Object.fromEntries(
			Object.entries(history).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	setDisplayName(id: string, displayName: string, expectedSessionFile?: string): boolean {
		const ref =
			expectedSessionFile === undefined
				? this.#refs.get(id)
				: this.#resolveRefBySessionFile(id, expectedSessionFile);
		const normalized = displayName.trim();
		if (!ref || !normalized || ref.displayName === normalized) return false;
		ref.displayName = normalized;
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
		ref.fleetRoot = scope.fleetRoot;
		ref.sessionFile = scope.sessionFile;
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
			return true;
		}
		ref.status = status;

		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
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
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#resolveRef(id, expected);
		if (!ref) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#resolveRef(id, expected);
		if (!ref) return false;
		if (id === MAIN_AGENT_ID) this.#mainRefs.delete(ref);
		if (this.#refs.get(id) === ref) this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string, expected?: AgentRefExpectation): AgentRef | undefined {
		return this.#resolveRef(id, expected);
	}

	getInFleet(id: string, fleetRoot: string): AgentRef | undefined {
		const current = this.#refs.get(id);
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
		return [...this.#refs.values()];
	}

	listInFleet(id: string, scopedFleetRoot?: string): AgentRef[] {
		const fleetRoot = scopedFleetRoot ?? this.#refs.get(id)?.fleetRoot;
		if (!fleetRoot) return [];
		const refs = this.list().filter(ref => ref.id !== MAIN_AGENT_ID && ref.fleetRoot === fleetRoot);
		const main = this.getInFleet(MAIN_AGENT_ID, fleetRoot);
		if (main) refs.unshift(main);
		return refs;
	}

	sharesFleet(firstId: string, secondId: string, scopedFleetRoot?: string): boolean {
		const first = scopedFleetRoot ? this.getInFleet(firstId, scopedFleetRoot) : this.#refs.get(firstId);
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
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {}
		}
	}
}
