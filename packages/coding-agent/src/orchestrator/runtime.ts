/**
 * Orchestrator worker runtime.
 *
 * Owns the persistent, addressable workers the top-level Orchestrator spawns
 * through `orchestrate_spawn`. Each worker is a real subagent with full tool
 * access: spawned once through {@link runSubprocess} (keep-alive), continued
 * turn-by-turn through {@link runSubagentFollowUpTurn}. Between turns the
 * worker lives in the AgentRegistry / AgentLifecycleManager as an adopted idle
 * agent (TTL park + JSONL revive), so its conversation context survives across
 * turns and even across parking.
 *
 * Every turn runs as an AsyncJobManager job, so a completed turn self-delivers
 * into the orchestrator's conversation exactly like a background job result,
 * and `orchestrate_wait` can block on the first settling turn with fleet-wait
 * semantics.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { resolveAgentModelSelection } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import workerTurnResultTemplate from "../prompts/tools/worker-turn-result.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { SessionManager, SessionPersistenceIndeterminateError } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../task/executor";
import { generateWorkerName } from "../task/name-generator";
import { AgentOutputManager } from "../task/output-manager";
import { Semaphore } from "../task/parallel";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import type { StructuredSubagentSchemaMode, StructuredSubagentSchemaSource } from "../task/structured-subagent";
import { type AgentDefinition, type AgentProgress, oneLineLabel, type SingleResult } from "../task/types";
import type { WorkerEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { formatDuration } from "../tools/render-utils";
import { ToolError } from "../tools/tool-errors";

/** Worker session lifecycle as shown to the director. */
export type WorkerState = "starting" | "running" | "idle" | "dead";

/** One completed tool call in the per-turn activity trace. */
interface TraceEntry {
	tool: string;
	args: string;
	endMs: number;
}

/** Cap on trace entries retained per turn (the run monitor keeps 5; we widen the window). */
const TURN_TRACE_CAP = 40;
/** Cap on a single rendered trace line. */
const TRACE_LINE_MAX = 120;
/** Default `orchestrate_wait` window when no timeout was given (ms). */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** Response text cap inside a delivered turn result; full output stays at agent://<id>. */
const RESPONSE_PREVIEW_MAX = 6000;
/** Grace period for worker cancellation/release cleanup before teardown detaches (ms). */
const TEARDOWN_GRACE_MS = 5_000;

const ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE = "orchestrator-worker-lifecycle";
const WORKER_LIFECYCLE_VERSION = 1;

export interface OwnerScope {
	ownerId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
}

export interface OrchestratorParent {
	cwd?: string;
	getAgentId?: () => string | null;
	getSessionId?: () => string | null;
	getSessionFile: () => string | null;
	sessionManager?: ToolSession["sessionManager"] & Partial<Pick<SessionManager, "recoverPersistenceFromCurrentState">>;
	asyncJobManager?: AsyncJobManager;
	settings: ToolSession["settings"];
	getActiveModelString?: () => string | undefined;
	getModelString?: () => string | undefined;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
}

type WorkerTombstoneReason = "explicit-kill" | "spawn-failed" | "unrecoverable";

interface WorkerLifecycleBase {
	version: typeof WORKER_LIFECYCLE_VERSION;
	id: string;
	ownerId: string;
	parentSessionId: string;
}

interface WorkerSpawnEvent extends WorkerLifecycleBase {
	action: "spawn";
	agent: string;
	childSessionFile: string;
	createdAt: number;
	effort?: WorkerEffort;
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
}

interface WorkerTurnLifecycleEvent extends WorkerLifecycleBase {
	action: "turn-started" | "turn-settled";
	turn: number;
}

interface WorkerTombstoneEvent extends WorkerLifecycleBase {
	action: "tombstone";
	reason: WorkerTombstoneReason;
}

type WorkerLifecycleEvent = WorkerSpawnEvent | WorkerTurnLifecycleEvent | WorkerTombstoneEvent;

interface RestoreCandidate {
	spawn: WorkerSpawnEvent;
	turnCount: number;
	lastActivityAt: number;
	inFlight: boolean;
	tombstoneReason?: WorkerTombstoneReason;
}

interface ResolvedWorker {
	agent: AgentDefinition;
	modelOverride?: string | string[];
	/** Pre-expansion role alias behind {@link modelOverride}, when the worker agent named one. */
	modelRole?: string;
}

interface ResolvedWorkerSchema {
	outputSchema?: unknown;
	outputSchemaMode: StructuredSubagentSchemaMode;
	outputSchemaSource: StructuredSubagentSchemaSource;
}

interface WorkerTurn {
	jobId: string;
	message: string;
	startedAt: number;
	/** Trace of tool calls completed during this turn, oldest first. */
	trace: TraceEntry[];
	/** Total completed tool calls (trace may be narrower than this). */
	toolCount: number;
}

interface WorkerRecord {
	id: string;
	/** Resolved agent type name (display + persistence identity). */
	agentName: string;
	ownerId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	childSessionFile?: string;
	agent: AgentDefinition;
	modelOverride?: string | string[];
	/** Pre-expansion role alias behind {@link modelOverride}, when the worker agent named one. */
	modelRole?: string;
	/** Caller-requested coarse effort for this worker's turns. */
	effort?: WorkerEffort;
	outputSchema?: unknown;
	outputSchemaMode: StructuredSubagentSchemaMode;
	outputSchemaSource: StructuredSubagentSchemaSource;
	state: WorkerState;
	createdAt: number;
	lastActivityAt: number;
	/** One-line gist of the latest activity (intent, tool, or result preview). */
	lastActivity?: string;
	/** Resolved model display string once known. */
	resolvedModel?: string;
	turn?: WorkerTurn;
	/** Live view of the in-flight turn (current tool, intent, streamed text tail). */
	live?: {
		currentTool?: string;
		currentToolArgs?: string;
		lastIntent?: string;
		/** Latest streamed assistant text lines, oldest first. */
		outputTail: string[];
	};
	/** Job id of the most recently settled turn (wait snapshots after settle). */
	lastJobId?: string;
	/** Messages queued while a turn was in flight; drained into the next turn. */
	queue: string[];
	turnCount: number;
	killed: boolean;
	/** True while a parent switch is detaching this process-local record without terminating it. */
	suspended: boolean;
	/** True only after a terminal lifecycle event has durably flushed. */
	terminalPersisted: boolean;
}

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface WorkerScreen {
	id: string;
	/** Agent type name shown as the screen's badge. */
	agent: string;
	state: WorkerState;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

export interface SpawnOutcome {
	id: string;
	jobId: string;
}

export interface SendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

export interface KillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

export interface WaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}

type TeardownStatus = "pending" | "settled" | "failed";

interface TrackedTeardown {
	promise: Promise<void>;
	status: () => TeardownStatus;
}

/** Observe cleanup without propagating a detached late rejection. */
function trackTeardown(promise: Promise<unknown>, onError: (error: unknown) => void): TrackedTeardown {
	let status: TeardownStatus = "pending";
	return {
		promise: promise.then(
			() => {
				status = "settled";
			},
			error => {
				status = "failed";
				onError(error);
			},
		),
		status: () => status,
	};
}

/** Wait for cleanup only until the caller's shared absolute deadline. */
async function waitForTeardown(tasks: readonly TrackedTeardown[], deadline: number): Promise<boolean> {
	if (tasks.length === 0 || tasks.every(task => task.status() !== "pending")) return true;
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return false;
	const timeout = Promise.withResolvers<void>();
	const timer = setTimeout(timeout.resolve, remainingMs);
	timer.unref?.();
	try {
		return await Promise.race([
			Promise.allSettled(tasks.map(task => task.promise)).then(() => true),
			timeout.promise.then(() => false),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Normalize a text fragment to one bounded roster/trace line. */
function firstLine(text: string, max = 100): string {
	return oneLineLabel(text, max);
}

function scopeKey(scope: OwnerScope, id: string): string {
	return `${scope.parentSessionId}\0${scope.parentSessionFile ?? ""}\0${scope.ownerId}\0${id}`;
}

function matchesScope(record: WorkerRecord, scope: OwnerScope): boolean {
	return (
		record.ownerId === scope.ownerId &&
		record.parentSessionId === scope.parentSessionId &&
		record.parentSessionFile === scope.parentSessionFile
	);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function parseLifecycleEvent(value: unknown): WorkerLifecycleEvent | undefined {
	const data = objectRecord(value);
	if (!data || data.version !== WORKER_LIFECYCLE_VERSION) return undefined;
	if (typeof data.id !== "string" || !data.id) return undefined;
	if (typeof data.ownerId !== "string" || !data.ownerId) return undefined;
	if (typeof data.parentSessionId !== "string" || !data.parentSessionId) return undefined;
	const base: WorkerLifecycleBase = {
		version: WORKER_LIFECYCLE_VERSION,
		id: data.id,
		ownerId: data.ownerId,
		parentSessionId: data.parentSessionId,
	};
	if (data.action === "spawn") {
		if (typeof data.agent !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.agent)) return undefined;
		if (typeof data.childSessionFile !== "string") return undefined;
		if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return undefined;
		const effort = data.effort;
		if (effort !== undefined && effort !== "lo" && effort !== "med" && effort !== "hi") return undefined;
		const schemaMode = data.schemaMode;
		if (schemaMode !== undefined && schemaMode !== "permissive" && schemaMode !== "strict") return undefined;
		return {
			...base,
			action: "spawn",
			agent: data.agent,
			childSessionFile: data.childSessionFile,
			createdAt: data.createdAt,
			...(effort !== undefined ? { effort } : {}),
			...(Object.hasOwn(data, "outputSchema") ? { outputSchema: data.outputSchema } : {}),
			...(schemaMode !== undefined ? { schemaMode } : {}),
		};
	}
	if (data.action === "turn-started" || data.action === "turn-settled") {
		if (typeof data.turn !== "number" || !Number.isInteger(data.turn) || data.turn < 1) return undefined;
		return { ...base, action: data.action, turn: data.turn };
	}
	if (data.action === "tombstone") {
		const reason = data.reason;
		if (reason !== "explicit-kill" && reason !== "spawn-failed" && reason !== "unrecoverable") {
			return undefined;
		}
		return { ...base, action: "tombstone", reason };
	}
	return undefined;
}

/** Child ids claimed by valid orchestrator spawn records from untrusted persisted JSON. */
export function persistedOrchestratorWorkerIds(entries: Iterable<unknown>): Set<string> {
	const ids = new Set<string>();
	for (const value of entries) {
		const entry = objectRecord(value);
		if (entry?.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
		const event = parseLifecycleEvent(entry.data);
		if (
			event?.action === "spawn" &&
			/^[A-Za-z0-9_-]+$/.test(event.id) &&
			event.childSessionFile === `${event.id}.jsonl`
		) {
			ids.add(event.id);
		}
	}
	return ids;
}

/** Merge the monitor's rolling `recentTools` window (newest first) into the per-turn trace (oldest first). */
function mergeTrace(turn: WorkerTurn, progress: AgentProgress): void {
	turn.toolCount = progress.toolCount;
	for (let i = progress.recentTools.length - 1; i >= 0; i--) {
		const entry = progress.recentTools[i];
		if (turn.trace.some(seen => seen.endMs === entry.endMs && seen.tool === entry.tool && seen.args === entry.args)) {
			continue;
		}
		turn.trace.push({ tool: entry.tool, args: entry.args, endMs: entry.endMs });
		if (turn.trace.length > TURN_TRACE_CAP) turn.trace.shift();
	}
}

/** Thrown from a turn job body so the job manager marks the job failed while carrying the formatted result. */
export class WorkerTurnError extends Error {}

/**
 * Process-global registry of orchestrator workers, scoped by both owner agent
 * id and stable parent session id. Persisted lifecycle events rebuild idle
 * records after a process restart; live turn jobs remain process-local.
 */
export class OrchestratorRuntime {
	static #global: OrchestratorRuntime | undefined;

	static global(): OrchestratorRuntime {
		if (!OrchestratorRuntime.#global) {
			OrchestratorRuntime.#global = new OrchestratorRuntime();
		}
		return OrchestratorRuntime.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		OrchestratorRuntime.#global = undefined;
	}

	/**
	 * Insert a bare worker record without the spawn machinery. Test-only —
	 * lets focused runtime tests attach an optional synthetic in-flight job.
	 */
	registerRecordForTests(record: {
		id: string;
		agentName?: string;
		ownerId: string;
		state?: WorkerState;
		jobId?: string;
	}): void {
		const now = Date.now();
		const scope: OwnerScope = {
			ownerId: record.ownerId,
			parentSessionId: "test-parent-session",
			parentSessionFile: null,
		};
		this.#records.set(scopeKey(scope, record.id), {
			id: record.id,
			agentName: record.agentName ?? "lightbot",
			ownerId: record.ownerId,
			parentSessionId: "test-parent-session",
			parentSessionFile: null,
			agent: getBundledAgent("lightbot")!,
			outputSchemaMode: "permissive",
			outputSchemaSource: "none",
			state: record.state ?? "running",
			createdAt: now,
			lastActivityAt: now,
			turn: record.jobId
				? { jobId: record.jobId, message: "test turn", startedAt: now, trace: [], toolCount: 0 }
				: undefined,
			queue: [],
			turnCount: 0,
			killed: false,
			suspended: false,
			terminalPersisted: false,
		});
	}

	readonly #records = new Map<string, WorkerRecord>();
	readonly #terminationTails = new Map<string, Promise<void>>();
	readonly #turnSemaphores = new Map<string, { limit: number; semaphore: Semaphore }>();
	readonly #waitedJobIds = new Set<string>();
	#teardownGraceMs = TEARDOWN_GRACE_MS;

	/** Override the teardown grace period for deterministic lifecycle tests. */
	setTeardownGraceForTesting(timeoutMs: number): void {
		this.#teardownGraceMs = Math.max(1, timeoutMs);
	}

	ownerScope(session: OrchestratorParent): OwnerScope {
		const parentSessionId = session.getSessionId?.();
		if (!parentSessionId) {
			throw new ToolError("Orchestrator workers require a stable parent session id.");
		}
		const parentSessionFile = session.getSessionFile();
		return {
			ownerId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentSessionId,
			parentSessionFile: parentSessionFile ? path.resolve(parentSessionFile) : null,
		};
	}

	#turnSemaphore(session: ToolSession, scope: OwnerScope): Semaphore {
		const key = scopeKey(scope, "");
		const limit = Math.max(0, Math.trunc(session.settings.get("orchestrator.maxConcurrency") ?? 0));
		const existing = this.#turnSemaphores.get(key);
		if (existing) {
			if (existing.limit !== limit) {
				existing.limit = limit;
				existing.semaphore.resize(limit);
			}
			return existing.semaphore;
		}
		const semaphore = new Semaphore(limit);
		this.#turnSemaphores.set(key, { limit, semaphore });
		return semaphore;
	}

	async #withTerminationLock<T>(scope: OwnerScope, operation: () => Promise<T>): Promise<T> {
		const key = scopeKey(scope, "");
		const predecessor = this.#terminationTails.get(key) ?? Promise.resolve();
		const released = Promise.withResolvers<void>();
		const tail = predecessor.then(() => released.promise);
		this.#terminationTails.set(key, tail);
		await predecessor;
		try {
			return await operation();
		} finally {
			released.resolve();
			if (this.#terminationTails.get(key) === tail) this.#terminationTails.delete(key);
		}
	}

	/**
	 * Resolve a worker's agent definition (any discovered type — bundled,
	 * user-level, or project-level) and its model selection. Same contract as
	 * the spawn path: the expansion discards the role alias (`@worker`,
	 * `@smol`), so patterns and role identity come from one call — the child's
	 * inherited retry-fallback chain is keyed off the role.
	 */
	async #resolveWorker(
		session: OrchestratorParent,
		cwd: string,
		agentName: string | undefined,
	): Promise<ResolvedWorker> {
		const requested = agentName?.trim() || "worker";
		const { agents } = await discoverAgents(cwd);
		const agent = getAgent(agents, requested);
		if (!agent) {
			throw new ToolError(`Unknown agent "${requested}". Check the available agent types and retry.`);
		}
		const agentModelOverrides = session.settings.get("orchestrator.agentModelOverrides");
		const { patterns, role } = resolveAgentModelSelection({
			settingsOverride: agentModelOverrides[requested],
			agentModel: agent.model,
			settings: session.settings,
			activeModelPattern: session.getActiveModelString?.(),
			fallbackModelPattern: session.getModelString?.(),
		});
		return { agent, modelOverride: patterns, modelRole: role };
	}

	#resolveOutputSchema(
		session: OrchestratorParent,
		agent: AgentDefinition,
		args: { outputSchema?: unknown; schemaMode?: StructuredSubagentSchemaMode },
	): ResolvedWorkerSchema {
		const outputSchemaMode = args.schemaMode ?? session.outputSchemaMode ?? "permissive";
		const callerSchema = Object.hasOwn(args, "outputSchema");
		const outputSchema = callerSchema ? args.outputSchema : (agent.output ?? session.outputSchema);
		const outputSchemaSource: StructuredSubagentSchemaSource = callerSchema
			? "caller"
			: agent.output !== undefined
				? "agent"
				: session.outputSchema !== undefined
					? "session"
					: "none";
		if (outputSchema !== undefined && (callerSchema || outputSchemaMode === "strict")) {
			const { error } = buildOutputValidator(outputSchema);
			if (error) throw new ToolError(`Invalid ${outputSchemaMode} worker output schema: ${error}`);
		}
		return { outputSchema, outputSchemaMode, outputSchemaSource };
	}

	async #appendLifecycleEvent(
		session: OrchestratorParent,
		event: WorkerLifecycleEvent,
		expectedParentSessionFile: string | null,
	): Promise<boolean> {
		if (!expectedParentSessionFile || !session.sessionManager) return false;
		const matchesCurrentScope = (): boolean => {
			const currentSessionFile = session.getSessionFile();
			return (
				session.getSessionId?.() === event.parentSessionId &&
				(session.getAgentId?.() ?? MAIN_AGENT_ID) === event.ownerId &&
				currentSessionFile !== null &&
				path.resolve(currentSessionFile) === expectedParentSessionFile
			);
		};
		if (!matchesCurrentScope()) return false;
		await session.sessionManager.ensureOnDisk();
		if (!matchesCurrentScope()) return false;
		session.sessionManager.appendCustomEntry(ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE, event);
		await session.sessionManager.flush();
		return true;
	}

	#eventBase(record: WorkerRecord): WorkerLifecycleBase {
		return {
			version: WORKER_LIFECYCLE_VERSION,
			id: record.id,
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId,
		};
	}

	async #appendTombstone(
		session: OrchestratorParent,
		record: WorkerRecord,
		reason: WorkerTombstoneReason,
	): Promise<boolean> {
		return this.#appendLifecycleEvent(
			session,
			{
				...this.#eventBase(record),
				action: "tombstone",
				reason,
			},
			record.parentSessionFile,
		);
	}

	#hasInMemoryTombstone(session: OrchestratorParent, record: WorkerRecord): boolean {
		let terminalReason: WorkerTombstoneReason | undefined;
		for (const entry of session.sessionManager?.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (
				!event ||
				event.id !== record.id ||
				event.ownerId !== record.ownerId ||
				event.parentSessionId !== record.parentSessionId
			) {
				continue;
			}
			if (event.action === "tombstone") terminalReason = event.reason;
		}
		return terminalReason !== undefined;
	}

	#manager(session: ToolSession): AsyncJobManager {
		const manager = session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Orchestrator workers require async execution (no background job manager is available).");
		}
		return manager;
	}

	#record(scope: OwnerScope, id: string): WorkerRecord {
		const record = this.#records.get(scopeKey(scope, id.trim()));
		if (!record || !matchesScope(record, scope)) {
			const roster = this.#listIds(scope);
			throw new ToolError(
				`Unknown worker "${id}".${roster.length > 0 ? ` Active workers: ${roster.join(", ")}` : " No workers — spawn one with orchestrate_spawn."}`,
			);
		}
		return record;
	}

	#registeredAgent(record: WorkerRecord): AgentRef | undefined {
		const ref = AgentRegistry.global().get(record.id);
		if (ref?.kind !== "sub" || ref.parentId !== record.ownerId) return undefined;
		if (record.childSessionFile && ref.sessionFile !== record.childSessionFile) return undefined;
		return ref;
	}

	#listIds(scope: OwnerScope): string[] {
		const ids: string[] = [];
		for (const record of this.#records.values()) {
			if (matchesScope(record, scope) && record.state !== "dead") ids.push(record.id);
		}
		return ids;
	}

	listIds(session: ToolSession): string[] {
		return this.#listIds(this.ownerScope(session));
	}

	/**
	 * Live screen snapshots for rich rendering (the "TV wall"): one entry per
	 * session in creation order, carrying the in-flight turn's trace, current
	 * tool, and streamed text tail. All strings are one-line sanitized here so
	 * renderers can print them verbatim.
	 */
	screens(session: ToolSession, ids?: string[]): WorkerScreen[] {
		const scope = this.ownerScope(session);
		const wanted = ids?.length ? new Set(ids.map(id => id.trim())) : undefined;
		const records: WorkerRecord[] = [];
		for (const record of this.#records.values()) {
			if (!matchesScope(record, scope)) continue;
			if (wanted && !wanted.has(record.id)) continue;
			records.push(record);
		}
		// Stable TV-wall ordering: spawn order, not activity order.
		records.sort((a, b) => a.createdAt - b.createdAt);
		return records.map(record => ({
			id: record.id,
			agent: record.agentName,
			state: record.state,
			model: record.resolvedModel,
			turns: record.turnCount,
			queued: record.queue.length,
			turnStartedAt: record.turn?.startedAt,
			turnMessage: record.turn ? firstLine(record.turn.message, 80) : undefined,
			currentTool: record.live?.currentTool,
			currentToolArgs: record.live?.currentToolArgs ? firstLine(record.live.currentToolArgs, 60) : undefined,
			lastIntent: record.live?.lastIntent ? firstLine(record.live.lastIntent, 80) : undefined,
			trace: record.turn
				? record.turn.trace
						.slice(-6)
						.map(entry => firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX))
				: [],
			outputTail: (record.live?.outputTail ?? []).map(line => firstLine(line, 100)),
			lastActivity: record.lastActivity,
			lastActivityAt: record.lastActivityAt,
		}));
	}

	#persistedIds(session: OrchestratorParent, scope: OwnerScope): Set<string> {
		const ids = new Set<string>();
		for (const entry of session.sessionManager?.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (event?.ownerId === scope.ownerId && event.parentSessionId === scope.parentSessionId) ids.add(event.id);
		}
		for (const record of this.#records.values()) {
			if (matchesScope(record, scope)) ids.add(record.id);
		}
		return ids;
	}

	async #resolvePersistedChild(parentSessionFile: string, spawn: WorkerSpawnEvent): Promise<string | undefined> {
		if (!/^[A-Za-z0-9_-]+$/.test(spawn.id) || spawn.childSessionFile !== `${spawn.id}.jsonl`) return undefined;
		const artifactsDir = path.resolve(parentSessionFile.slice(0, -6));
		const childSessionFile = path.resolve(artifactsDir, spawn.childSessionFile);
		const relative = path.relative(artifactsDir, childSessionFile);
		if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") {
			return undefined;
		}
		try {
			const persisted = await SessionManager.peekSessionInit(childSessionFile);
			return persisted?.init ? childSessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	#trackAgentRelease(id: string, ref: AgentRef, action: "detach" | "release"): TrackedTeardown {
		return trackTeardown(AgentLifecycleManager.global().release(id, ref), error => {
			logger.warn(`orchestrator: failed to ${action} worker session`, {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	#finishAgentRelease(id: string, ref: AgentRef, task: TrackedTeardown, action: "detach" | "release"): void {
		if (task.status() === "settled") return;
		if (task.status() === "pending") {
			logger.warn(`orchestrator: timed out waiting to ${action} worker session; detaching registry ref`, { id });
		}
		AgentRegistry.global().unregister(id, ref);
	}

	async #releaseRefWithinDeadline(
		id: string,
		ref: AgentRef,
		deadline: number,
		action: "detach" | "release",
	): Promise<void> {
		const task = this.#trackAgentRelease(id, ref, action);
		await waitForTeardown([task], deadline);
		this.#finishAgentRelease(id, ref, task, action);
	}

	#trackJobSettlement(record: WorkerRecord, job: AsyncJob): TrackedTeardown {
		return trackTeardown(job.promise, error => {
			logger.warn("orchestrator: cancelled worker turn cleanup failed", {
				id: record.id,
				jobId: job.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	async #markTerminalRef(
		id: string,
		ownerId: string,
		childSessionFile: string,
		expected?: AgentRef | null,
		teardownDeadline?: number,
	): Promise<void> {
		const registry = AgentRegistry.global();
		const existing = registry.get(id);
		if (expected !== undefined && existing !== undefined && existing !== expected) return;
		if (
			existing &&
			(existing.kind !== "sub" || existing.parentId !== ownerId || existing.sessionFile !== childSessionFile)
		) {
			return;
		}
		if (existing?.status === "aborted" && !existing.session) return;
		if (existing && !registry.setStatus(id, "aborted", existing)) return;
		if (existing && teardownDeadline !== undefined) {
			await this.#releaseRefWithinDeadline(id, existing, teardownDeadline, "release");
		} else if (existing && AgentLifecycleManager.global().has(id, existing)) {
			await AgentLifecycleManager.global().release(id, existing);
		} else if (existing?.session) {
			await existing.session.dispose();
		}
		const current = registry.get(id);
		if (current && current !== existing) return;
		if (current) registry.unregister(id, current);
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: ownerId,
			session: null,
			sessionFile: childSessionFile,
			status: "aborted",
		});
	}

	/** Reconcile resumable and terminal workers from the persisted parent journal. */
	async rehydrate(session: OrchestratorParent): Promise<number> {
		const sessionFile = session.getSessionFile();
		const sessionManager = session.sessionManager;
		if (!sessionFile || !sessionManager) return 0;
		const scope = this.ownerScope(session);
		const allSpawns = new Map<string, WorkerSpawnEvent>();
		const terminalIntents = new Map<string, WorkerTombstoneReason>();
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (!event || event.ownerId !== scope.ownerId || event.parentSessionId !== scope.parentSessionId) continue;
			if (event.action === "spawn") allSpawns.set(event.id, event);
			else if (event.action === "tombstone") terminalIntents.set(event.id, event.reason);
		}

		const candidates = new Map<string, RestoreCandidate>();
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (!event || event.ownerId !== scope.ownerId || event.parentSessionId !== scope.parentSessionId) continue;
			const eventTime = Date.parse(entry.timestamp);
			if (event.action === "spawn") {
				candidates.set(event.id, {
					spawn: event,
					turnCount: 0,
					lastActivityAt: Number.isFinite(eventTime) ? eventTime : event.createdAt,
					inFlight: false,
				});
				continue;
			}
			const candidate = candidates.get(event.id);
			if (!candidate) continue;
			candidate.lastActivityAt = Number.isFinite(eventTime) ? eventTime : candidate.lastActivityAt;
			if (event.action === "turn-started" && event.turn >= candidate.turnCount) {
				candidate.turnCount = event.turn;
				candidate.inFlight = true;
			} else if (event.action === "turn-settled" && event.turn >= candidate.turnCount) {
				candidate.turnCount = event.turn;
				candidate.inFlight = false;
			} else if (event.action === "tombstone") {
				candidate.tombstoneReason = event.reason;
			}
		}

		for (const id of terminalIntents.keys()) {
			const spawn = allSpawns.get(id);
			if (!spawn) continue;
			const childSessionFile = await this.#resolvePersistedChild(sessionFile, spawn);
			if (!childSessionFile) continue;
			await this.#markTerminalRef(id, scope.ownerId, childSessionFile);
			this.#records.delete(scopeKey(scope, id));
		}

		let restored = 0;
		for (const candidate of candidates.values()) {
			const { spawn } = candidate;
			if (candidate.tombstoneReason || terminalIntents.has(spawn.id) || candidate.turnCount < 1) continue;
			const childSessionFile = await this.#resolvePersistedChild(sessionFile, spawn);
			if (!childSessionFile) continue;
			const key = scopeKey(scope, spawn.id);
			if (this.#records.has(key)) continue;
			const existing = AgentRegistry.global().get(spawn.id);
			const existingIsResumable =
				existing?.kind === "sub" &&
				existing.parentId === scope.ownerId &&
				existing.sessionFile === childSessionFile &&
				(existing.status === "idle" || existing.status === "parked");
			if (existing && !existingIsResumable) continue;
			let resolved: ResolvedWorker | undefined;
			try {
				resolved = await this.#resolveWorker(session, session.cwd ?? process.cwd(), spawn.agent);
			} catch {
				resolved = undefined;
			}
			if (!resolved) continue;
			const { agent, modelOverride, modelRole } = resolved;
			let schema: ResolvedWorkerSchema;
			try {
				schema = this.#resolveOutputSchema(session, agent, {
					...(Object.hasOwn(spawn, "outputSchema") ? { outputSchema: spawn.outputSchema } : {}),
					...(spawn.schemaMode !== undefined ? { schemaMode: spawn.schemaMode } : {}),
				});
			} catch {
				continue;
			}
			if (!existing) {
				AgentRegistry.global().register({
					id: spawn.id,
					displayName: spawn.id,
					kind: "sub",
					parentId: scope.ownerId,
					session: null,
					sessionFile: childSessionFile,
					status: "parked",
				});
			}
			this.#records.set(key, {
				id: spawn.id,
				agentName: spawn.agent,
				ownerId: scope.ownerId,
				parentSessionId: scope.parentSessionId,
				parentSessionFile: scope.parentSessionFile,
				childSessionFile,
				agent,
				modelOverride,
				modelRole,
				...(spawn.effort !== undefined ? { effort: spawn.effort } : {}),
				...schema,
				state: "idle",
				createdAt: spawn.createdAt,
				lastActivityAt: candidate.lastActivityAt,
				lastActivity: candidate.inFlight ? `turn ${candidate.turnCount} interrupted by process restart` : undefined,
				queue: [],
				turnCount: candidate.turnCount,
				killed: false,
				suspended: false,
				terminalPersisted: false,
			});
			restored++;
		}
		return restored;
	}

	/** Spawn a persistent worker and start its first turn in the background. */
	async spawn(
		session: ToolSession,
		args: {
			agent?: string;
			name?: string;
			prompt: string;
			effort?: WorkerEffort;
			outputSchema?: unknown;
			schemaMode?: StructuredSubagentSchemaMode;
		},
	): Promise<SpawnOutcome> {
		const scope = this.ownerScope(session);
		return this.#withTerminationLock(scope, () => this.#spawnLocked(session, scope, args));
	}

	async #spawnLocked(
		session: ToolSession,
		scope: OwnerScope,
		args: {
			agent?: string;
			name?: string;
			prompt: string;
			effort?: WorkerEffort;
			outputSchema?: unknown;
			schemaMode?: StructuredSubagentSchemaMode;
		},
	): Promise<SpawnOutcome> {
		const manager = this.#manager(session);
		await session.settings.reloadFromDisk();
		const requestedAgent = args.agent?.trim() || "worker";
		const spawnPolicy = resolveSpawnPolicy(session.getSessionSpawns());
		if (
			(session.taskDepth ?? 0) > 0 &&
			(!spawnPolicy.enabled ||
				(spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(requestedAgent)))
		) {
			throw new ToolError(`Cannot spawn '${requestedAgent}'. Allowed: ${spawnPolicy.allowedErrorText}`);
		}
		const disabledAgents = session.settings.get("orchestrator.disabledAgents");
		if (disabledAgents.includes(requestedAgent)) {
			throw new ToolError(`Worker agent "${requestedAgent}" is disabled in settings.`);
		}
		const { agent, modelOverride, modelRole } = await this.#resolveWorker(session, session.cwd, requestedAgent);
		const schema = this.#resolveOutputSchema(session, agent, args);
		if (!session.agentOutputManager) {
			session.agentOutputManager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
		}
		const reservedIds = this.#persistedIds(session, scope);
		for (const ref of AgentRegistry.global().list()) reservedIds.add(ref.id);
		await session.agentOutputManager.reserve(reservedIds);
		const requestedName = args.name?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
		const id = await session.agentOutputManager.allocate(requestedName || generateWorkerName());
		const parentSessionFile = scope.parentSessionFile;
		const childSessionName = `${id}.jsonl`;
		const childSessionFile = parentSessionFile
			? path.resolve(parentSessionFile.slice(0, -6), childSessionName)
			: undefined;
		const createdAt = Date.now();
		const record: WorkerRecord = {
			id,
			agentName: agent.name,
			ownerId: scope.ownerId,
			parentSessionId: scope.parentSessionId,
			parentSessionFile,
			childSessionFile,
			agent,
			modelOverride,
			modelRole,
			...(args.effort !== undefined ? { effort: args.effort } : {}),
			...schema,
			state: "starting",
			createdAt,
			lastActivityAt: createdAt,
			queue: [],
			turnCount: 0,
			killed: false,
			suspended: false,
			terminalPersisted: false,
		};
		const key = scopeKey(scope, id);
		this.#records.set(key, record);
		try {
			if (childSessionFile) {
				const persisted = await this.#appendLifecycleEvent(
					session,
					{
						...this.#eventBase(record),
						action: "spawn",
						agent: agent.name,
						childSessionFile: childSessionName,
						createdAt,
						...(record.effort !== undefined ? { effort: record.effort } : {}),
						...(record.outputSchemaSource === "caller" ? { outputSchema: record.outputSchema } : {}),
						schemaMode: record.outputSchemaMode,
					},
					record.parentSessionFile,
				);
				if (!persisted) throw new ToolError("Orchestrator parent session changed before the worker could start.");
			}
			const jobId = this.#registerTurnJob(session, manager, record, args.prompt, { first: true });
			return { id, jobId };
		} catch (error) {
			record.killed = true;
			record.state = "dead";
			record.lastActivityAt = Date.now();
			record.lastActivity = "spawn failed";
			if (childSessionFile) {
				// A rejected terminal write leaves this dead record in the map so kill can retry it.
				record.terminalPersisted = await this.#appendTombstone(session, record, "spawn-failed");
				if (!record.terminalPersisted) {
					throw new ToolError("Orchestrator parent session changed before spawn failure could be persisted.");
				}
			}
			this.#records.delete(key);
			throw error;
		}
	}

	/**
	 * Send a message to a worker. Mid-turn and streaming → steering; mid-turn
	 * otherwise → queued for the next turn; idle/parked → starts a new
	 * background turn immediately.
	 */
	async send(session: ToolSession, args: { session: string; message: string }): Promise<SendOutcome> {
		const scope = this.ownerScope(session);
		const record = this.#record(scope, args.session);
		if (record.state === "dead") {
			throw new ToolError(`Worker "${record.id}" is dead. Spawn a new one with orchestrate_spawn.`);
		}
		const message = args.message.trim();
		if (!message) throw new ToolError("Message must not be empty.");
		const registered = this.#registeredAgent(record);
		if (AgentRegistry.global().get(record.id) && !registered) {
			throw new ToolError(`Worker "${record.id}" no longer resolves to this parent session.`);
		}

		if (record.turn) {
			const live = registered?.session;
			if (live?.isStreaming) {
				await live.steer(message);
				record.lastActivityAt = Date.now();
				return { id: record.id, mode: "steered" };
			}
			record.queue.push(message);
			record.lastActivityAt = Date.now();
			return { id: record.id, mode: "queued" };
		}

		if (!registered || (registered.status !== "idle" && registered.status !== "parked")) {
			throw new ToolError(`Worker "${record.id}" no longer resolves to this parent session.`);
		}

		const manager = this.#manager(session);
		const jobId = this.#registerTurnJob(session, manager, record, message, { first: false });
		return { id: record.id, mode: "turn", jobId };
	}

	/**
	 * Block until one watched worker's in-flight turn settles, the timeout
	 * elapses, or `signal` aborts — fleet-wait semantics. Settled turns are
	 * acknowledged against the job manager so their results are not delivered
	 * a second time as async follow-ups.
	 */
	async wait(
		session: ToolSession,
		args: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitOutcome> {
		const scope = this.ownerScope(session);
		const manager = this.#manager(session);
		// Named workers are watched regardless of state (a just-settled turn is
		// reported from its retained job); the no-args form watches every
		// worker with a turn actually in flight.
		const watched = args.sessions?.length
			? args.sessions.map(id => this.#record(scope, id))
			: [...this.#records.values()].filter(record => matchesScope(record, scope) && record.turn !== undefined);

		// Snapshot each watched turn's job at entry: #finishTurn installs a
		// queued follow-up turn inside the settling job's callback (before that
		// job's promise resolves), so re-reading record.turn after the race
		// would inspect the *next* running job and silently drop the settled
		// result — whose async delivery watchJobs is suppressing on our behalf.
		const snapshots: Array<{ record: WorkerRecord; jobId: string }> = [];
		for (const record of watched) {
			const jobId = record.turn?.jobId ?? record.lastJobId;
			if (jobId) snapshots.push({ record, jobId });
		}

		const collectSettled = (): WaitOutcome["settled"] => {
			const settled: WaitOutcome["settled"] = [];
			for (const { record, jobId } of snapshots) {
				if (this.#waitedJobIds.has(jobId)) continue;
				const job = manager.getJob(jobId);
				if (!job || job.status === "running") continue;
				settled.push({
					id: record.id,
					jobId,
					status: job.status,
					resultText: job.resultText ?? job.errorText ?? "(no output)",
				});
			}
			return settled;
		};

		const runningJobs: AsyncJob[] = [];
		for (const { jobId } of snapshots) {
			const job = manager.getJob(jobId);
			if (job?.status === "running") runningJobs.push(job);
		}

		let waitEndedByTimeout = false;
		if (runningJobs.length > 0 && collectSettled().length === 0) {
			const timeoutMs = Math.max(1, Math.trunc(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
			const watchedJobIds = runningJobs.map(job => job.id);
			manager.watchJobs(watchedJobIds);
			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<"timeout">();
			const timeoutHandle = setTimeout(() => timeoutResolve("timeout"), timeoutMs);
			const racePromises: Array<Promise<"settled" | "timeout" | "aborted">> = [
				...runningJobs.map(job => job.promise.then(() => "settled" as const)),
				timeoutPromise,
			];
			let abortCleanup: (() => void) | undefined;
			if (args.signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<"aborted">();
				const onAbort = () => abortResolve("aborted");
				if (args.signal.aborted) {
					onAbort();
				} else {
					args.signal.addEventListener("abort", onAbort, { once: true });
					abortCleanup = () => args.signal?.removeEventListener("abort", onAbort);
				}
				racePromises.push(abortPromise);
			}
			try {
				waitEndedByTimeout = (await Promise.race(racePromises)) === "timeout";
			} finally {
				manager.unwatchJobs(watchedJobIds);
				clearTimeout(timeoutHandle);
				abortCleanup?.();
			}
		}

		const settled = collectSettled();
		for (const entry of settled) this.#waitedJobIds.add(entry.jobId);
		manager.acknowledgeDeliveries(settled.map(entry => entry.jobId));
		// Current in-flight state, independent of the snapshot: a session whose
		// watched turn settled may already be mid queued follow-up.
		const stillRunning = watched.filter(record => record.turn !== undefined).map(record => record.id);
		return { settled, stillRunning, timedOut: waitEndedByTimeout && settled.length === 0 };
	}

	/** Detach one parent's process-local workers without tombstoning their persisted conversations. */
	async suspendScope(scope: OwnerScope, manager?: AsyncJobManager): Promise<number> {
		const records = [...this.#records.values()].filter(record => matchesScope(record, scope));
		const teardown = records.map(record => ({
			record,
			ref: this.#registeredAgent(record),
			job: record.turn && manager ? manager.getJob(record.turn.jobId) : undefined,
		}));
		for (const { record } of teardown) {
			record.suspended = true;
			record.queue.length = 0;
			record.state = "dead";
			record.lastActivityAt = Date.now();
			record.lastActivity = "suspended for parent-session switch";
			this.#records.delete(scopeKey(scope, record.id));
			if (record.turn && manager) manager.cancel(record.turn.jobId, { ownerId: record.ownerId });
		}
		const deadline = Date.now() + this.#teardownGraceMs;
		const cleanup = teardown.map(entry => ({
			...entry,
			releaseTask: entry.ref ? this.#trackAgentRelease(entry.record.id, entry.ref, "detach") : undefined,
			jobTask: entry.job ? this.#trackJobSettlement(entry.record, entry.job) : undefined,
		}));
		await waitForTeardown(
			cleanup.flatMap(entry => [entry.releaseTask, entry.jobTask].filter(task => task !== undefined)),
			deadline,
		);
		for (const { record, ref, releaseTask, job, jobTask } of cleanup) {
			if (ref && releaseTask) this.#finishAgentRelease(record.id, ref, releaseTask, "detach");
			if (job && jobTask?.status() === "pending") {
				logger.warn(
					"orchestrator: timed out waiting for cancelled worker turn; cleanup continues in the background",
					{
						id: record.id,
						jobId: job.id,
					},
				);
				this.#continueSuspendedCleanup(scope, record, jobTask);
			}
			if (this.#records.has(scopeKey(scope, record.id))) continue;
			const lateRef = this.#registeredAgent(record);
			if (lateRef && lateRef !== ref) {
				await this.#releaseRefWithinDeadline(record.id, lateRef, deadline, "detach");
			}
		}
		return records.length;
	}

	#continueSuspendedCleanup(scope: OwnerScope, record: WorkerRecord, jobTask: TrackedTeardown): void {
		void jobTask.promise
			.then(async () => {
				if (this.#records.has(scopeKey(scope, record.id))) return;
				const lateRef = this.#registeredAgent(record);
				if (!lateRef) return;
				await this.#releaseRefWithinDeadline(record.id, lateRef, Date.now() + this.#teardownGraceMs, "detach");
			})
			.catch(error => {
				logger.warn("orchestrator: failed to finish suspended worker cleanup", {
					id: record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** Terminate one worker; a tombstone failure still tears it down before reconciliation and error delivery. */
	async kill(session: ToolSession, id: string): Promise<KillOutcome> {
		const scope = this.ownerScope(session);
		return this.#withTerminationLock(scope, () => {
			const record = this.#record(scope, id);
			return this.#killRecord(record, session.asyncJobManager, session, "explicit-kill");
		});
	}

	async #killRecord(
		record: WorkerRecord,
		manager: AsyncJobManager | undefined,
		session: OrchestratorParent,
		reason: WorkerTombstoneReason,
		persistTerminal = true,
		teardownDeadline?: number,
	): Promise<KillOutcome> {
		const registered = this.#registeredAgent(record);
		const settlingJobs = new Set<AsyncJob>();
		if (record.turn && manager) {
			const job = manager.getJob(record.turn.jobId);
			if (job) settlingJobs.add(job);
		}
		let persistenceError: unknown;
		if (persistTerminal && !record.terminalPersisted) {
			try {
				if (record.killed) {
					const recover = session.sessionManager?.recoverPersistenceFromCurrentState;
					if (!recover) throw new ToolError("Worker tombstone recovery requires parent-session persistence.");
					await recover.call(session.sessionManager);
				}
				if (!this.#hasInMemoryTombstone(session, record) && record.childSessionFile) {
					if (!(await this.#appendTombstone(session, record, reason))) {
						throw new ToolError(`Worker "${record.id}" changed parent scope before termination.`);
					}
				}
				record.terminalPersisted = true;
			} catch (error) {
				persistenceError = error;
			}
		}
		record.killed = true;
		record.queue.length = 0;
		let cancelledTurn = false;
		if (record.turn && manager) {
			const job = manager.getJob(record.turn.jobId);
			if (job) settlingJobs.add(job);
			cancelledTurn = manager.cancel(record.turn.jobId, { ownerId: record.ownerId });
		}
		record.state = "dead";
		record.lastActivityAt = Date.now();
		record.lastActivity = "killed";
		const deadline = teardownDeadline ?? Date.now() + this.#teardownGraceMs;
		const releaseTask = registered ? this.#trackAgentRelease(record.id, registered, "release") : undefined;
		const jobCleanup = [...settlingJobs].map(job => ({ job, task: this.#trackJobSettlement(record, job) }));
		await waitForTeardown(
			[releaseTask, ...jobCleanup.map(entry => entry.task)].filter(task => task !== undefined),
			deadline,
		);
		if (registered && releaseTask) this.#finishAgentRelease(record.id, registered, releaseTask, "release");
		const pendingJobs = jobCleanup.filter(entry => entry.task.status() === "pending");
		for (const { job } of pendingJobs) {
			logger.warn("orchestrator: timed out waiting for cancelled worker turn; cleanup continues in the background", {
				id: record.id,
				jobId: job.id,
			});
		}
		const terminalRef = registered ?? this.#registeredAgent(record) ?? null;
		await this.#markTerminalRecord(record, terminalRef, deadline);
		if (pendingJobs.length > 0) {
			this.#continueKilledCleanup(
				record,
				pendingJobs.map(entry => entry.task),
				registered,
			);
		}
		if (persistenceError) {
			let finalPersistenceError = persistenceError;
			const recover = session.sessionManager?.recoverPersistenceFromCurrentState;
			if (recover) {
				try {
					await recover.call(session.sessionManager);
					if (!this.#hasInMemoryTombstone(session, record) && record.childSessionFile) {
						if (!(await this.#appendTombstone(session, record, reason))) {
							throw new ToolError(`Worker "${record.id}" changed parent scope before termination.`);
						}
					}
					record.terminalPersisted = true;
				} catch (recoveryError) {
					if (recoveryError instanceof SessionPersistenceIndeterminateError) {
						finalPersistenceError = recoveryError;
					}
					logger.warn("orchestrator: failed to reconcile explicit tombstone persistence", {
						id: record.id,
						error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
					});
				}
			}
			throw finalPersistenceError;
		}
		return { id: record.id, cancelledTurn };
	}

	async #markTerminalRecord(
		record: WorkerRecord,
		expected: AgentRef | null | undefined,
		teardownDeadline: number,
	): Promise<void> {
		if (!record.childSessionFile) return;
		try {
			const persisted = await SessionManager.peekSessionInit(record.childSessionFile);
			if (persisted?.init) {
				await this.#markTerminalRef(record.id, record.ownerId, record.childSessionFile, expected, teardownDeadline);
			}
		} catch (error) {
			logger.warn("orchestrator: failed to retain terminal worker transcript", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#continueKilledCleanup(
		record: WorkerRecord,
		jobTasks: readonly TrackedTeardown[],
		expected: AgentRef | undefined,
	): void {
		void Promise.allSettled(jobTasks.map(task => task.promise))
			.then(() => this.#markTerminalRecord(record, expected, Date.now() + this.#teardownGraceMs))
			.catch(error => {
				logger.warn("orchestrator: failed to finish killed worker cleanup", {
					id: record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** Build the ExecutorOptions for a first spawn, mirroring the shared worker/eval plumbing. */
	async #buildSpawnOptions(
		session: ToolSession,
		record: WorkerRecord,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<ExecutorOptions> {
		const sessionFile = session.getSessionFile();
		const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `proto-worker-${Snowflake.next()}`);
		await fs.mkdir(artifactsDir, { recursive: true });
		if (!sessionArtifactsDir) registerArtifactsDir(artifactsDir);
		const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
			getArtifactsDir: session.getArtifactsDir ?? (() => null),
			getSessionId: session.getSessionId ?? (() => null),
		};
		return {
			cwd: session.cwd,
			agent: record.agent,
			task: message,
			assignment: message,
			description: `worker ${record.agentName}`,
			index: 0,
			id: record.id,
			taskDepth: session.taskDepth ?? 0,
			detached: true,
			modelOverride: record.modelOverride,
			modelRole: record.modelRole,
			parentActiveModelPattern: session.getActiveModelString?.(),
			thinkingLevel: record.agent.thinkingLevel,
			effort: record.effort,
			outputSchema: record.outputSchema,
			outputSchemaMode: record.outputSchemaMode,
			outputSchemaSource: record.outputSchemaSource,
			outputSchemaOverridesAgent: record.outputSchemaSource === "caller",
			sessionFile,
			persistArtifacts: Boolean(sessionFile),
			artifactsDir,
			enableLsp: (session.enableLsp ?? true) && session.settings.get("orchestrator.enableLsp"),
			signal,
			eventBus: session.eventBus,
			onProgress,
			authStorage: session.authStorage,
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			mcpManager: session.mcpManager ?? MCPManager.instance(),
			contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
			skills: [...(session.skills ?? [])],
			workspaceTree: session.workspaceTree,
			promptTemplates: session.promptTemplates,
			rules: session.rules,
			preloadedExtensionPaths: session.extensionPaths,
			preloadedCustomToolPaths: session.customToolPaths,
			localProtocolOptions,
			parentArtifactManager: session.getArtifactManager?.() ?? undefined,
			parentTelemetry: session.getTelemetry?.(),
			parentEvalSessionId: session.getEvalSessionId?.() ?? undefined,
			parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
			keepAlive: true,
		};
	}

	/** Register one background job that runs a single worker turn and self-delivers its result. */
	#registerTurnJob(
		session: ToolSession,
		manager: AsyncJobManager,
		record: WorkerRecord,
		message: string,
		options: { first: boolean },
	): string {
		const turnIndex = record.turnCount + 1;
		if (record.lastJobId) this.#waitedJobIds.delete(record.lastJobId);
		const turn: WorkerTurn = {
			jobId: "",
			message,
			startedAt: Date.now(),
			trace: [],
			toolCount: 0,
		};
		const onProgress = (progress: AgentProgress): void => {
			mergeTrace(turn, progress);
			record.resolvedModel = progress.resolvedModel ?? record.resolvedModel;
			// recentOutput is newest-first; keep the latest lines oldest-first for display.
			record.live = {
				currentTool: progress.currentTool,
				currentToolArgs: progress.currentToolArgs,
				lastIntent: progress.lastIntent,
				outputTail: progress.recentOutput.slice(0, 3).reverse(),
			};
			const gist =
				progress.lastIntent ??
				(progress.currentTool ? `${progress.currentTool} ${progress.currentToolArgs ?? ""}` : undefined);
			if (gist) record.lastActivity = firstLine(gist);
			record.lastActivityAt = Date.now();
		};

		const semaphore = this.#turnSemaphore(session, {
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId,
			parentSessionFile: record.parentSessionFile,
		});
		const jobId = manager.register(
			"worker",
			`worker ${record.agentName} ${record.id}: ${firstLine(message, 60)}`,
			async ({ jobId: ownJobId, signal, markRunning }) => {
				let acquired = false;
				try {
					await semaphore.acquire(signal);
					acquired = true;
					markRunning();
					record.state = "running";
					record.turnCount = turnIndex;
					record.lastActivityAt = Date.now();
					try {
						const turnStartedPersisted = await this.#appendLifecycleEvent(
							session,
							{
								...this.#eventBase(record),
								action: "turn-started",
								turn: turnIndex,
							},
							record.parentSessionFile,
						);
						if (record.childSessionFile && !turnStartedPersisted) {
							throw new ToolError(`Worker "${record.id}" changed parent scope before its turn started.`);
						}
						const result = options.first
							? await runSubprocess(await this.#buildSpawnOptions(session, record, message, signal, onProgress))
							: await runSubagentFollowUpTurn({
									id: record.id,
									agent: record.agent,
									message,
									description: `worker ${record.agentName}`,
									modelRole: record.modelRole,
									outputSchema: record.outputSchema,
									outputSchemaMode: record.outputSchemaMode,
									outputSchemaSource: record.outputSchemaSource,
									signal,
									onProgress,
									eventBus: session.eventBus,
									artifactsDir: session.getSessionFile()?.slice(0, -6),
								});
						return await this.#settleTurn(session, manager, record, turn, ownJobId, turnIndex, result);
					} catch (error) {
						if (error instanceof WorkerTurnError) throw error;
						await this.#finishTurn(session, manager, record, ownJobId);
						const reason = error instanceof Error ? error.message : String(error);
						record.lastActivity = firstLine(`turn failed: ${reason}`);
						throw new WorkerTurnError(
							`[worker:${record.id} agent=${record.agentName} turn=${turnIndex}] turn failed: ${reason}`,
						);
					}
				} catch (error) {
					if (acquired) throw error;
					await this.#finishTurn(session, manager, record, ownJobId);
					const reason = error instanceof Error ? error.message : String(error);
					throw new WorkerTurnError(
						`[worker:${record.id} agent=${record.agentName} turn=${turnIndex}] turn cancelled while queued: ${reason}`,
					);
				} finally {
					if (acquired) semaphore.release();
				}
			},
			{ id: `${record.id}-t${turnIndex}`, agentId: record.id, ownerId: record.ownerId, queued: true },
		);
		turn.jobId = jobId;
		record.turn = turn;
		return jobId;
	}

	/** Post-turn bookkeeping shared by success and failure paths: clear the in-flight turn, flush the queue. */
	async #finishTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: WorkerRecord,
		settledJobId: string,
	): Promise<void> {
		record.lastJobId = settledJobId;
		record.turn = undefined;
		record.live = undefined;
		record.lastActivityAt = Date.now();
		if (record.killed || record.suspended) {
			record.state = "dead";
			return;
		}
		// Only an idle/parked ref with this parent's exact child file is resumable.
		const registered = this.#registeredAgent(record);
		record.state = registered && (registered.status === "idle" || registered.status === "parked") ? "idle" : "dead";
		if (record.state === "dead") {
			record.terminalPersisted = await this.#appendTombstone(session, record, "unrecoverable");
			return;
		}
		const settledPersisted = await this.#appendLifecycleEvent(
			session,
			{
				...this.#eventBase(record),
				action: "turn-settled",
				turn: record.turnCount,
			},
			record.parentSessionFile,
		);
		if (record.childSessionFile && !settledPersisted) {
			record.state = "dead";
			return;
		}
		if (record.queue.length === 0) return;
		const nextMessage = record.queue.splice(0, record.queue.length).join("\n\n");
		try {
			this.#registerTurnJob(session, manager, record, nextMessage, { first: false });
		} catch (error) {
			// Leave the messages recoverable: a later orchestrate_send flushes again.
			record.queue.unshift(nextMessage);
			logger.warn("orchestrator: failed to start queued follow-up turn", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Format a settled turn into the self-delivering result text (activity trace + response). */
	async #settleTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: WorkerRecord,
		turn: WorkerTurn,
		settledJobId: string,
		turnIndex: number,
		result: SingleResult,
	): Promise<string> {
		await this.#finishTurn(session, manager, record, settledJobId);
		const failed = result.exitCode !== 0 || result.aborted === true;
		const status = result.aborted ? "aborted" : failed ? "failed" : "completed";
		record.lastActivity = firstLine(
			failed
				? `turn ${turnIndex} ${status}: ${result.abortReason ?? result.error ?? ""}`
				: (result.lastIntent ?? result.output),
		);

		const traceLines = turn.trace.map(entry =>
			firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX),
		);
		const traceOverflow = Math.max(0, turn.toolCount - turn.trace.length);
		let response = result.output.trim() || "(no output)";
		let responseTruncated = false;
		if (response.length > RESPONSE_PREVIEW_MAX) {
			const slice = response.slice(0, RESPONSE_PREVIEW_MAX);
			const lastNewline = slice.lastIndexOf("\n");
			response = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
			responseTruncated = true;
		}
		let text: string;
		try {
			text = prompt
				.render(workerTurnResultTemplate, {
					id: record.id,
					agent: record.agentName,
					turn: turnIndex,
					status,
					duration: formatDuration(result.durationMs),
					requests: result.requests,
					toolCount: turn.toolCount,
					model: result.resolvedModel ?? record.resolvedModel ?? "",
					trace: traceLines,
					traceOverflow: traceOverflow > 0 ? traceOverflow : undefined,
					response,
					responseTruncated,
					error: failed ? (result.abortReason ?? result.error ?? result.stderr ?? "") : "",
					alive: record.state !== "dead",
				})
				.trim();
		} catch (error) {
			// A formatting bug must never turn a finished worker turn into a false
			// failure — the work is done; degrade to a plain-text assembly.
			logger.warn("orchestrator: turn-result template render failed; using plain fallback", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
			text = [
				`[worker:${record.id} agent=${record.agentName} turn=${turnIndex} status=${status}]`,
				`Activity (${turn.toolCount} tool calls, ${result.requests} requests):`,
				...traceLines.map(line => `- ${line}`),
				"",
				"Response:",
				response,
			].join("\n");
		}
		if (failed) throw new WorkerTurnError(text);
		return text;
	}
}
