import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveAgentSpawnModelSelection,
	resolveModelOverride,
} from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir, registerSessionFile } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import workerTurnResultTemplate from "../prompts/tools/worker-turn-result.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, hasAgentTombstone, MAIN_AGENT_ID } from "../registry/agent-registry";
import { SessionManager, SessionPersistenceIndeterminateError } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import type { ExecutorOptions } from "../task/executor";
import { generateWorkerName } from "../task/name-generator";
import { Semaphore } from "../task/parallel";
import { describeUnknownAgent, resolveSpawnPreflight } from "../task/spawn-policy";
import type { StructuredSubagentSchemaMode, StructuredSubagentSchemaSource } from "../task/structured-subagent";
import { type AgentDefinition, type AgentProgress, oneLineLabel, type SingleResult } from "../task/types";
import { resolveWorkerEffortLevel, type WorkerEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { formatDuration } from "../tools/render-utils";
import { ToolError } from "../tools/tool-errors";

export type WorkerTurnState = "starting" | "running" | "idle";
export type WorkerLifecycle = "live" | "parked" | "terminal";
type WorkerState = WorkerTurnState | "dead";

interface TraceEntry {
	tool: string;
	args: string;
	endMs: number;
}

const TURN_TRACE_CAP = 40;

const TRACE_LINE_MAX = 120;

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;

const RESPONSE_PREVIEW_MAX = 6000;

const TEARDOWN_GRACE_MS = 5_000;

const MAX_QUEUED_TURNS = 32;
const MAX_QUEUED_TURN_BYTES = 256 * 1024;
const MAX_TERMINAL_RECORDS = 128;

const ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE = "orchestrator-worker-lifecycle";
const WORKER_LIFECYCLE_VERSION = 1;

interface OwnerScope {
	ownerId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	jobOwnerId: string;
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
	getAsyncJobOwnerId?: () => string | null;
}
type WorkerTombstoneReason =
	| "explicit-kill"
	| "spawn-failed"
	| "unrecoverable"
	| "ownership-lost"
	| "parent-session-changed";

interface WorkerTerminalInfo {
	reason: WorkerTombstoneReason;
	at: number;
	lastTurn: number;
	lastJobId?: string;
	history: string;
	output: string;
	context: string;
}
interface WorkerLifecycleBase {
	version: typeof WORKER_LIFECYCLE_VERSION;
	id: string;
	ownerId: string;
	parentSessionId: string;
}

interface WorkerSpawnEvent extends WorkerLifecycleBase {
	action: "spawn";
	agent: string;
	label: string;
	model?: string;
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
	model?: Model;
	modelOverride?: string | string[];

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

	trace: TraceEntry[];

	toolCount: number;
}

interface WorkerRecord {
	id: string;

	agentName: string;
	model?: Model;
	label: string;
	ownerId: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	jobOwnerId: string;
	childSessionFile?: string;
	agent?: AgentDefinition;
	modelOverride?: string | string[];

	modelRole?: string;

	effort?: WorkerEffort;
	outputSchema?: unknown;
	outputSchemaMode: StructuredSubagentSchemaMode;
	outputSchemaSource: StructuredSubagentSchemaSource;
	state: WorkerState;
	createdAt: number;
	lastActivityAt: number;

	lastActivity?: string;

	resolvedModel?: string;
	turn?: WorkerTurn;

	live?: {
		currentTool?: string;
		currentToolArgs?: string;
		lastIntent?: string;

		outputTail: string[];
	};

	lastJobId?: string;

	temporaryArtifacts?: { dir: string; unregister: () => void };
	temporaryArtifactsCleanup?: Promise<void>;
	capacityWaitCleanup?: () => void;

	queue: Array<{ message: string; turn: number }>;
	turnCount: number;
	killed: boolean;

	suspended: boolean;

	terminalPersisted: boolean;
	terminal?: WorkerTerminalInfo;
}
export interface WorkerScreen {
	/** Immutable authoritative worker id; use this for routing. */
	id: string;
	/** User-facing label; labels are not addresses. */
	label?: string;
	ownerId?: string;
	parentSessionId?: string;
	addressable?: boolean;
	terminal?: WorkerTerminalInfo;

	agent: string;
	lifecycle: WorkerLifecycle;
	turnState?: WorkerTurnState;
	model?: string;
	turns: number;
	queued: number;

	turnStartedAt?: number;

	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;

	trace: string[];

	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}
export type WorkerReceiptStatus = "accepted" | "queued" | "delivered" | "rejected" | "terminal";

export interface WorkerReceipt {
	status: WorkerReceiptStatus;
	workerId: string;
	label: string;
	ownerId: string;
	parentSessionId: string;
	turn: number;
	jobId?: string;
	reason?: string;
	terminal?: WorkerTerminalInfo;
}

interface SpawnOutcome {
	id: string;
	label: string;
	jobId: string;
}

export interface SendOutcome {
	id: string;
	label: string;
	mode: "turn" | "steered" | "queued";
	jobId?: string;
	receipt: WorkerReceipt;
}

export interface KillOutcome {
	id: string;
	label: string;
	cancelledTurn: boolean;
	receipt: WorkerReceipt;
}

export interface WaitOutcome {
	settled: Array<{
		id: string;
		label: string;
		jobId: string;
		status: "completed" | "failed" | "cancelled";
		resultText: string;
		receipt: WorkerReceipt;
	}>;

	stillRunning: string[];
	timedOut: boolean;
}
type TeardownStatus = "pending" | "settled" | "failed";

interface TrackedTeardown {
	promise: Promise<void>;
	status: () => TeardownStatus;
}

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
		const label = typeof data.label === "string" && data.label.trim() ? data.label.trim() : data.id;
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
			label,
			childSessionFile: data.childSessionFile,
			createdAt: data.createdAt,
			...(typeof data.model === "string" && data.model.trim() ? { model: data.model.trim() } : {}),
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
		if (
			reason !== "explicit-kill" &&
			reason !== "spawn-failed" &&
			reason !== "unrecoverable" &&
			reason !== "ownership-lost" &&
			reason !== "parent-session-changed"
		) {
			return undefined;
		}
		return { ...base, action: "tombstone", reason };
	}
	return undefined;
}

export function persistedOrchestratorWorkerLabels(entries: Iterable<unknown>): Map<string, string> {
	const labels = new Map<string, string>();
	for (const value of entries) {
		const entry = objectRecord(value);
		if (entry?.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
		const event = parseLifecycleEvent(entry.data);
		if (
			event?.action === "spawn" &&
			/^[A-Za-z0-9_-]+$/.test(event.id) &&
			event.childSessionFile === `${event.id}.jsonl`
		) {
			labels.set(event.id, event.label);
		}
	}
	return labels;
}

export function persistedOrchestratorWorkerIds(entries: Iterable<unknown>): Set<string> {
	return new Set(persistedOrchestratorWorkerLabels(entries).keys());
}
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

class WorkerTurnError extends Error {}

export class OrchestratorRuntime {
	static #global: OrchestratorRuntime | undefined;

	static global(): OrchestratorRuntime {
		if (!OrchestratorRuntime.#global) {
			OrchestratorRuntime.#global = new OrchestratorRuntime();
		}
		return OrchestratorRuntime.#global;
	}

	static resetGlobalForTests(): void {
		OrchestratorRuntime.#global = undefined;
	}

	registerRecordForTests(record: {
		id: string;
		agentName?: string;
		label?: string;
		ownerId: string;
		parentSessionId?: string;
		state?: WorkerState;
		jobId?: string;
		agent?: AgentDefinition;
		outputSchema?: unknown;
	}): void {
		const now = Date.now();
		const scope: OwnerScope = {
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId ?? "test-parent-session",
			parentSessionFile: null,
			jobOwnerId: record.parentSessionId ?? "test-parent-session",
		};
		this.#setRecord(scope, {
			id: record.id,
			agentName: record.agentName ?? "lightbot",
			label: record.label ?? record.agentName ?? "lightbot",
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId ?? "test-parent-session",
			parentSessionFile: null,
			jobOwnerId: record.parentSessionId ?? "test-parent-session",
			agent: record.agent ?? getBundledAgent("lightbot")!,
			...(record.outputSchema !== undefined ? { outputSchema: record.outputSchema } : {}),
			outputSchemaMode: "permissive",
			outputSchemaSource: "none",
			state: record.state ?? "running",
			createdAt: now,
			lastActivityAt: now,
			turn: record.jobId
				? { jobId: record.jobId, message: "test turn", startedAt: now, trace: [], toolCount: 0 }
				: undefined,
			queue: [],
			turnCount: record.jobId ? 1 : 0,
			killed: false,
			suspended: false,
			terminalPersisted: false,
		});
	}

	readonly #recordsByScope = new Map<string, Map<string, WorkerRecord>>();
	readonly #terminationTails = new Map<string, Promise<void>>();
	#turnSemaphoreState: { limit: number; semaphore: Semaphore } | undefined;
	readonly #waitedJobIds = new Set<string>();
	#testResolvedWorker: ResolvedWorker | undefined;
	#teardownGraceMs = TEARDOWN_GRACE_MS;

	setWorkerResolutionForTesting(agent: AgentDefinition, model: Model): void {
		this.#testResolvedWorker = { agent, model };
	}

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
			jobOwnerId: session.getAsyncJobOwnerId?.() ?? parentSessionId,
		};
	}

	#turnSemaphore(session: ToolSession): Semaphore {
		const limit = Math.max(0, Math.trunc(session.settings.get("orchestrator.maxConcurrency") ?? 0));
		const existing = this.#turnSemaphoreState;
		if (existing) {
			if (existing.limit !== limit) {
				existing.limit = limit;
				existing.semaphore.resize(limit);
			}
			return existing.semaphore;
		}
		const semaphore = new Semaphore(limit);
		this.#turnSemaphoreState = { limit, semaphore };
		return semaphore;
	}

	#scopeRecords(scope: OwnerScope): Map<string, WorkerRecord> {
		return this.#recordsByScope.get(scopeKey(scope, "")) ?? new Map();
	}

	#setRecord(scope: OwnerScope, record: WorkerRecord): void {
		const key = scopeKey(scope, "");
		let records = this.#recordsByScope.get(key);
		if (!records) {
			records = new Map();
			this.#recordsByScope.set(key, records);
		}
		records.set(record.id, record);
	}

	#deleteRecord(scope: OwnerScope, id: string): void {
		const key = scopeKey(scope, "");
		const records = this.#recordsByScope.get(key);
		if (!records) return;
		records.delete(id);
		if (records.size === 0) this.#recordsByScope.delete(key);
	}

	#scopeForRecord(record: WorkerRecord): OwnerScope {
		return {
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId,
			parentSessionFile: record.parentSessionFile,
			jobOwnerId: record.jobOwnerId,
		};
	}

	#trimTerminalRecords(scope: OwnerScope): void {
		const records = this.#recordsByScope.get(scopeKey(scope, ""));
		if (!records) return;
		const terminal = [...records.values()].filter(record => record.state === "dead" || record.terminal);
		if (terminal.length <= MAX_TERMINAL_RECORDS) return;
		terminal.sort((left, right) => {
			const leftAt = left.terminal?.at ?? left.lastActivityAt;
			const rightAt = right.terminal?.at ?? right.lastActivityAt;
			return leftAt - rightAt || left.createdAt - right.createdAt;
		});
		for (const record of terminal.slice(0, terminal.length - MAX_TERMINAL_RECORDS))
			this.#deleteRecord(scope, record.id);
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

	async #resolveWorker(
		session: OrchestratorParent,
		cwd: string,
		agentName: string | undefined,
		requestModel?: string,
	): Promise<ResolvedWorker> {
		if (this.#testResolvedWorker) return this.#testResolvedWorker;
		const requested = agentName?.trim() || "worker";
		const { agents } = await discoverAgents(cwd);
		const agent = getAgent(agents, requested);
		if (!agent) {
			throw new ToolError(describeUnknownAgent(requested, agents));
		}
		const agentModelOverrides = session.settings.get("orchestrator.agentModelOverrides");
		const { patterns, role, bankError } = resolveAgentSpawnModelSelection({
			requestModel,
			settingsOverride: agentModelOverrides[requested],
			agentModel: agent.model,
			settings: session.settings,
			activeModelPattern: session.getActiveModelString?.(),
			fallbackModelPattern: session.getModelString?.(),
		});
		if (bankError) throw new ToolError(bankError);
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
		const record = this.#scopeRecords(scope).get(id.trim());
		if (!record || !matchesScope(record, scope)) {
			const roster = this.#listIds(scope);
			throw new ToolError(
				`Unknown worker "${id}".${roster.length > 0 ? ` Active workers: ${roster.join(", ")}` : " No workers — spawn one with orchestrate_spawn."}`,
			);
		}
		return record;
	}

	#terminalInfo(record: WorkerRecord, reason: WorkerTombstoneReason): WorkerTerminalInfo {
		return {
			reason,
			at: Date.now(),
			lastTurn: record.turnCount,
			...(record.turn?.jobId || record.lastJobId ? { lastJobId: record.turn?.jobId ?? record.lastJobId } : {}),
			history: `history://${record.id}`,
			output: `agent://${record.id}`,
			context: `history://${record.id}`,
		};
	}

	#clearPendingCapacityWait(record: WorkerRecord): void {
		record.capacityWaitCleanup?.();
		record.capacityWaitCleanup = undefined;
	}

	#startTemporaryArtifactsCleanup(record: WorkerRecord): Promise<void> {
		if (record.temporaryArtifactsCleanup) return record.temporaryArtifactsCleanup;
		const owned = record.temporaryArtifacts;
		if (!owned) return Promise.resolve();
		record.temporaryArtifacts = undefined;
		owned.unregister();
		record.temporaryArtifactsCleanup = fs.rm(owned.dir, { recursive: true, force: true }).catch(error => {
			logger.warn("orchestrator: failed to remove temporary worker artifacts", {
				id: record.id,
				dir: owned.dir,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return record.temporaryArtifactsCleanup;
	}

	async #awaitTemporaryArtifactsCleanup(record: WorkerRecord): Promise<void> {
		await record.temporaryArtifactsCleanup;
	}

	#compactTerminalRecord(record: WorkerRecord, clearTurn = false): void {
		record.agent = undefined;
		record.model = undefined;
		record.modelOverride = undefined;
		record.modelRole = undefined;
		record.outputSchema = undefined;
		record.live = undefined;
		record.queue.length = 0;
		if (record.turn) {
			const jobId = record.turn.jobId;
			if (clearTurn) {
				record.lastJobId = jobId;
				record.turn = undefined;
			} else {
				record.turn = {
					jobId,
					message: "",
					startedAt: record.turn.startedAt,
					trace: [],
					toolCount: 0,
				};
			}
		}
	}

	#markRecordTerminal(
		record: WorkerRecord,
		reason: WorkerTombstoneReason,
		activity?: string,
		cleanupArtifacts = true,
	): void {
		this.#clearPendingCapacityWait(record);
		record.state = "dead";
		record.terminal = this.#terminalInfo(record, reason);
		record.lastActivityAt = record.terminal.at;
		record.lastActivity = activity ?? `terminal: ${reason}`;
		this.#compactTerminalRecord(record);
		if (cleanupArtifacts) void this.#startTemporaryArtifactsCleanup(record);
		this.#trimTerminalRecords(this.#scopeForRecord(record));
	}

	#receipt(
		record: WorkerRecord,
		status: WorkerReceiptStatus,
		turn: number,
		jobId?: string,
		reason?: string,
	): WorkerReceipt {
		return {
			status,
			workerId: record.id,
			label: record.label,
			ownerId: record.ownerId,
			parentSessionId: record.parentSessionId,
			turn,
			...(jobId ? { jobId } : {}),
			...(reason ? { reason } : {}),
			...(record.terminal ? { terminal: record.terminal } : {}),
		};
	}

	#terminalError(record: WorkerRecord): ToolError {
		return new ToolError(this.#terminalMessage(record), {
			receipt: this.#receipt(record, "terminal", record.terminal?.lastTurn ?? record.turnCount, record.lastJobId),
		});
	}

	#terminalMessage(record: WorkerRecord): string {
		const terminal = record.terminal;
		const reason = terminal?.reason ?? "unrecoverable";
		const turn = terminal?.lastTurn ?? record.turnCount;
		return `Worker "${record.id}" (label "${record.label}") is terminal (${reason}) after turn ${turn}. History: ${terminal?.history ?? `history://${record.id}`}; output: ${terminal?.output ?? `agent://${record.id}`}; context: ${terminal?.context ?? `history://${record.id}`}. Spawn a new worker.`;
	}
	#workerAgent(record: WorkerRecord): AgentDefinition {
		if (!record.agent) throw new ToolError(`Worker "${record.id}" has no live agent definition.`);
		return record.agent;
	}

	#registeredAgent(record: WorkerRecord): AgentRef | undefined {
		const ref = AgentRegistry.global().get(record.id);
		if (ref?.kind !== "sub" || ref.parentId !== record.ownerId) return undefined;
		if (record.childSessionFile && ref.sessionFile !== record.childSessionFile) return undefined;
		if (ref.status === "aborted") return undefined;
		return ref;
	}

	#listIds(scope: OwnerScope): string[] {
		return [...this.#scopeRecords(scope).keys()];
	}

	#displayModel(session: ToolSession, record: WorkerRecord): string | undefined {
		if (record.resolvedModel) return record.resolvedModel;
		let model = record.model;
		let selectedLevel: ThinkingLevel | undefined;
		let explicitLevel = false;
		if (!model && record.modelOverride !== undefined && session.modelRegistry) {
			const patterns = Array.isArray(record.modelOverride) ? record.modelOverride : [record.modelOverride];
			const resolved = resolveModelOverride(patterns, session.modelRegistry, session.settings);
			model = resolved.model;
			selectedLevel = resolved.thinkingLevel;
			explicitLevel = resolved.explicitThinkingLevel;
		}
		if (!model) {
			return record.modelOverride === undefined
				? undefined
				: Array.isArray(record.modelOverride)
					? record.modelOverride.join(",")
					: record.modelOverride;
		}
		let effortLevel: ThinkingLevel | undefined;
		if (record.effort !== undefined) {
			try {
				effortLevel = resolveWorkerEffortLevel(
					model,
					record.effort,
					session.settings.get("orchestrator.maxEffort"),
				);
			} catch {
				// The turn will surface an invalid effort ceiling; keep list rendering available meanwhile.
			}
		}
		const displayLevel = effortLevel ?? (explicitLevel ? selectedLevel : undefined);
		return formatModelSelectorValue(formatModelStringWithRouting(model), displayLevel);
	}

	listIds(session: ToolSession): string[] {
		return this.#listIds(this.ownerScope(session));
	}

	screens(session: ToolSession, ids?: string[]): WorkerScreen[] {
		const scope = this.ownerScope(session);
		const wanted = ids?.length ? new Set(ids.map(id => id.trim())) : undefined;
		const records: WorkerRecord[] = [];
		for (const record of this.#scopeRecords(scope).values()) {
			if (wanted && !wanted.has(record.id)) continue;
			records.push(record);
		}

		records.sort((a, b) => a.createdAt - b.createdAt);
		for (const record of records) {
			if (record.state === "idle" && this.#registeredAgent(record) === undefined) {
				this.#markRecordTerminal(record, "ownership-lost", "terminal: worker ownership is no longer addressable");
			}
		}
		const retainedRecords = records.filter(record => this.#scopeRecords(scope).get(record.id) === record);
		return retainedRecords.map(record => {
			const registered = this.#registeredAgent(record);
			const lifecycle: WorkerLifecycle =
				record.state === "dead" || record.terminal
					? "terminal"
					: registered?.status === "parked"
						? "parked"
						: "live";
			const turnState: WorkerTurnState | undefined =
				record.state === "dead"
					? undefined
					: registered?.status === "parked"
						? "idle"
						: record.state === "idle" && registered?.status === "running"
							? "running"
							: record.state;
			return {
				id: record.id,
				label: record.label,
				ownerId: record.ownerId,
				parentSessionId: record.parentSessionId,
				addressable: record.state !== "dead" && this.#registeredAgent(record) !== undefined,
				...(record.terminal ? { terminal: record.terminal } : {}),
				agent: record.agentName,
				lifecycle,
				turnState,
				model: this.#displayModel(session, record),
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
			};
		});
	}

	#persistedIds(session: OrchestratorParent, scope: OwnerScope): Set<string> {
		const ids = new Set<string>();
		for (const entry of session.sessionManager?.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== ORCHESTRATOR_LIFECYCLE_CUSTOM_TYPE) continue;
			const event = parseLifecycleEvent(entry.data);
			if (event?.ownerId === scope.ownerId && event.parentSessionId === scope.parentSessionId) ids.add(event.id);
		}
		for (const record of this.#scopeRecords(scope).values()) ids.add(record.id);
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
		label = id,
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
			label,
			kind: "sub",
			parentId: ownerId,
			session: null,
			sessionFile: childSessionFile,
			status: "aborted",
		});
	}

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
			await this.#markTerminalRef(id, scope.ownerId, childSessionFile, undefined, undefined, spawn.label);
			this.#deleteRecord(scope, id);
		}

		let restored = 0;
		for (const candidate of candidates.values()) {
			const { spawn } = candidate;
			if (candidate.tombstoneReason || terminalIntents.has(spawn.id) || candidate.turnCount < 1) continue;
			const childSessionFile = await this.#resolvePersistedChild(sessionFile, spawn);
			if (!childSessionFile) continue;
			if (this.#scopeRecords(scope).has(spawn.id)) continue;
			const existing = AgentRegistry.global().get(spawn.id);
			let tombstoned: boolean;
			try {
				tombstoned = await hasAgentTombstone(childSessionFile);
			} catch (error) {
				logger.warn("orchestrator: could not determine persisted worker termination state", {
					id: spawn.id,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (tombstoned) {
				await this.#markTerminalRef(
					spawn.id,
					scope.ownerId,
					childSessionFile,
					existing ?? null,
					Date.now() + this.#teardownGraceMs,
					spawn.label,
				);
				continue;
			}
			const existingIsResumable =
				existing?.kind === "sub" &&
				existing.parentId === scope.ownerId &&
				existing.sessionFile === childSessionFile &&
				(existing.status === "idle" || existing.status === "parked");
			if (existing && !existingIsResumable) continue;
			let resolved: ResolvedWorker | undefined;
			try {
				resolved = await this.#resolveWorker(session, session.cwd ?? process.cwd(), spawn.agent, spawn.model);
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
					label: spawn.label,
					kind: "sub",
					parentId: scope.ownerId,
					session: null,
					sessionFile: childSessionFile,
					status: "parked",
				});
			}
			this.#setRecord(scope, {
				id: spawn.id,
				agentName: spawn.agent,
				label: spawn.label,
				ownerId: scope.ownerId,
				parentSessionId: scope.parentSessionId,
				parentSessionFile: scope.parentSessionFile,
				jobOwnerId: scope.jobOwnerId,
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

	async spawn(
		session: ToolSession,
		args: {
			agent?: string;
			label?: string;
			message: string;
			model?: string;
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
			label?: string;
			message: string;
			model?: string;
			effort?: WorkerEffort;
			outputSchema?: unknown;
			schemaMode?: StructuredSubagentSchemaMode;
		},
	): Promise<SpawnOutcome> {
		const manager = this.#manager(session);
		await session.settings.reloadFromDisk();
		const preflight = resolveSpawnPreflight({
			requestedAgent: args.agent,
			parentSpawns: session.getSessionSpawns(),
			taskDepth: session.taskDepth ?? 0,
			maxRecursionDepth: session.settings.get("orchestrator.maxRecursionDepth") ?? 2,
			blockedAgent: $env.PI_BLOCKED_AGENT,
		});
		if (preflight.error) throw new ToolError(preflight.error);
		const requestedAgent = preflight.agentName;
		const disabledAgents = session.settings.get("orchestrator.disabledAgents");
		if (disabledAgents.includes(requestedAgent)) {
			throw new ToolError(`Worker agent "${requestedAgent}" is disabled in settings.`);
		}
		const { agent, model, modelOverride, modelRole } = await this.#resolveWorker(
			session,
			session.cwd,
			requestedAgent,
			args.model,
		);
		const schema = this.#resolveOutputSchema(session, agent, args);
		const reservedIds = this.#persistedIds(session, scope);
		for (const ref of AgentRegistry.global().list()) reservedIds.add(ref.id);
		const requestedLabel = args.label;
		if (requestedLabel !== undefined && !/^[A-Za-z0-9_-]{1,48}$/.test(requestedLabel)) {
			throw new ToolError(
				"Worker label must be 1–48 characters using only ASCII letters, digits, underscore, or hyphen.",
			);
		}
		const label = requestedLabel ?? generateWorkerName();
		let id = `worker-${Snowflake.next()}`;
		while (reservedIds.has(id) || AgentRegistry.global().get(id)) id = `worker-${Snowflake.next()}`;
		const parentSessionFile = scope.parentSessionFile;
		const childSessionName = `${id}.jsonl`;
		const childSessionFile = parentSessionFile
			? path.resolve(parentSessionFile.slice(0, -6), childSessionName)
			: undefined;
		const createdAt = Date.now();
		const record: WorkerRecord = {
			id,
			agentName: agent.name,
			label,
			model,
			ownerId: scope.ownerId,
			parentSessionId: scope.parentSessionId,
			parentSessionFile,
			jobOwnerId: scope.jobOwnerId,
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
		this.#setRecord(scope, record);
		try {
			if (childSessionFile) {
				const persisted = await this.#appendLifecycleEvent(
					session,
					{
						...this.#eventBase(record),
						action: "spawn",
						agent: agent.name,
						label,
						childSessionFile: childSessionName,
						createdAt,
						...(args.model !== undefined ? { model: args.model } : {}),
						...(record.effort !== undefined ? { effort: record.effort } : {}),
						...(record.outputSchemaSource === "caller" ? { outputSchema: record.outputSchema } : {}),
						schemaMode: record.outputSchemaMode,
					},
					record.parentSessionFile,
				);
				if (!persisted) throw new ToolError("Orchestrator parent session changed before the worker could start.");
			}
			const jobId = this.#registerTurnJob(session, manager, record, args.message, { first: true });
			if (childSessionFile) await registerSessionFile(id, childSessionFile);
			return { id, label, jobId };
		} catch (error) {
			record.killed = true;
			record.state = "dead";
			record.lastActivityAt = Date.now();
			record.lastActivity = "spawn failed";
			if (childSessionFile) {
				record.terminalPersisted = await this.#appendTombstone(session, record, "spawn-failed");
				if (!record.terminalPersisted) {
					throw new ToolError("Orchestrator parent session changed before spawn failure could be persisted.");
				}
			}
			await this.#awaitTemporaryArtifactsCleanup(record);
			this.#deleteRecord(scope, id);
			throw error;
		}
	}

	async send(session: ToolSession, args: { session: string; message: string }): Promise<SendOutcome> {
		const scope = this.ownerScope(session);
		const record = this.#record(scope, args.session);
		if (record.state === "dead" || record.terminal) {
			throw this.#terminalError(record);
		}
		const message = args.message.trim();
		if (!message) throw new ToolError("Message must not be empty.");
		const registered = this.#registeredAgent(record);
		if (!registered && record.state !== "starting") {
			this.#markRecordTerminal(record, "ownership-lost", "terminal: worker ownership is no longer addressable");
			throw this.#terminalError(record);
		}

		if (record.turn) {
			const live = registered?.session;
			if (live?.isStreaming) {
				await live.steer(message);
				record.lastActivityAt = Date.now();
				return {
					id: record.id,
					label: record.label,
					mode: "steered",
					jobId: record.turn.jobId,
					receipt: this.#receipt(record, "accepted", record.turnCount, record.turn.jobId),
				};
			}
			const queuedBytes = record.queue.reduce((total, item) => total + Buffer.byteLength(item.message), 0);
			const messageBytes = Buffer.byteLength(message);
			const queuedTurn = record.turnCount + record.queue.length + 1;
			if (record.queue.length >= MAX_QUEUED_TURNS || queuedBytes + messageBytes > MAX_QUEUED_TURN_BYTES) {
				const reason = `Worker "${record.id}" follow-up queue is full (${record.queue.length}/${MAX_QUEUED_TURNS} turns, ${queuedBytes}/${MAX_QUEUED_TURN_BYTES} bytes). Wait for a turn to settle, then retry this message.`;
				throw new ToolError(reason, {
					receipt: this.#receipt(record, "rejected", queuedTurn, record.turn.jobId, reason),
				});
			}
			record.queue.push({ message, turn: queuedTurn });
			record.lastActivityAt = Date.now();
			return {
				id: record.id,
				label: record.label,
				mode: "queued",
				receipt: this.#receipt(record, "queued", queuedTurn),
			};
		}

		if (
			!registered ||
			(registered.status !== "idle" &&
				registered.status !== "parked" &&
				!(registered.status === "running" && registered.session))
		) {
			this.#markRecordTerminal(record, registered?.status === "aborted" ? "unrecoverable" : "ownership-lost");
			throw this.#terminalError(record);
		}

		const manager = this.#manager(session);
		const jobId = this.#registerTurnJob(session, manager, record, message, { first: false });
		return {
			id: record.id,
			label: record.label,
			mode: "turn",
			jobId,
			receipt: this.#receipt(record, "accepted", record.turnCount, jobId),
		};
	}
	async wait(
		session: ToolSession,
		args: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitOutcome> {
		const scope = this.ownerScope(session);
		const manager = this.#manager(session);

		const watched = args.sessions?.length
			? args.sessions.map(id => this.#record(scope, id))
			: [...this.#scopeRecords(scope).values()].filter(record => record.turn !== undefined);

		const snapshots: Array<{ record: WorkerRecord; jobId: string; turn: number }> = [];
		for (const record of watched) {
			const jobId = record.turn?.jobId ?? record.lastJobId;
			if (jobId) snapshots.push({ record, jobId, turn: record.turnCount });
		}

		const collectSettled = (): WaitOutcome["settled"] => {
			const settled: WaitOutcome["settled"] = [];
			for (const { record, jobId, turn } of snapshots) {
				if (this.#waitedJobIds.has(jobId)) continue;
				const job = manager.getJob(jobId);
				if (!job || job.status === "running") continue;
				const receiptStatus: WorkerReceiptStatus =
					job.status === "cancelled" ? (record.state === "dead" ? "terminal" : "rejected") : "delivered";
				settled.push({
					id: record.id,
					label: record.label,
					jobId,
					status: job.status,
					resultText: job.resultText ?? job.errorText ?? "(no output)",
					receipt: this.#receipt(record, receiptStatus, turn, jobId, job.errorText),
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

		const stillRunning = watched.filter(record => record.turn !== undefined).map(record => record.id);
		return { settled, stillRunning, timedOut: waitEndedByTimeout && settled.length === 0 };
	}

	async suspendScope(scope: OwnerScope, manager?: AsyncJobManager): Promise<number> {
		const records = [...this.#scopeRecords(scope).values()];
		const artifactCleanups: Promise<void>[] = [];
		const teardown = records.map(record => ({
			record,
			ref: this.#registeredAgent(record),
			job: record.turn && manager ? manager.getJob(record.turn.jobId) : undefined,
		}));
		for (const { record } of teardown) {
			this.#clearPendingCapacityWait(record);
			record.suspended = true;
			record.queue.length = 0;
			record.state = "dead";
			record.lastActivityAt = Date.now();
			record.lastActivity = "suspended for parent-session switch";
			this.#deleteRecord(scope, record.id);
			if (record.turn && manager) manager.cancel(record.turn.jobId, { ownerId: record.jobOwnerId });
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
			} else {
				artifactCleanups.push(this.#startTemporaryArtifactsCleanup(record));
			}
			if (this.#scopeRecords(scope).has(record.id)) continue;
			const lateRef = this.#registeredAgent(record);
			if (lateRef && lateRef !== ref) {
				await this.#releaseRefWithinDeadline(record.id, lateRef, deadline, "detach");
			}
		}
		await Promise.all(artifactCleanups);
		return records.length;
	}

	#continueSuspendedCleanup(scope: OwnerScope, record: WorkerRecord, jobTask: TrackedTeardown): void {
		void jobTask.promise
			.then(async () => {
				try {
					if (!this.#scopeRecords(scope).has(record.id)) {
						const lateRef = this.#registeredAgent(record);
						if (lateRef) {
							await this.#releaseRefWithinDeadline(
								record.id,
								lateRef,
								Date.now() + this.#teardownGraceMs,
								"detach",
							);
						}
					}
				} finally {
					await this.#startTemporaryArtifactsCleanup(record);
				}
			})
			.catch(error => {
				logger.warn("orchestrator: failed to finish suspended worker cleanup", {
					id: record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

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
		let cancelledTurn = false;
		this.#markRecordTerminal(record, reason, reason === "explicit-kill" ? "killed" : `terminal: ${reason}`, false);
		if (record.turn && manager) {
			const job = manager.getJob(record.turn.jobId);
			if (job) settlingJobs.add(job);
			cancelledTurn = manager.cancel(record.turn.jobId, { ownerId: record.jobOwnerId });
		}
		this.#compactTerminalRecord(record, true);
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
		await this.#startTemporaryArtifactsCleanup(record);
		await this.#awaitTemporaryArtifactsCleanup(record);
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
		return {
			id: record.id,
			label: record.label,
			cancelledTurn,
			receipt: this.#receipt(record, "terminal", record.turnCount, record.turn?.jobId ?? record.lastJobId, reason),
		};
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
				await this.#markTerminalRef(
					record.id,
					record.ownerId,
					record.childSessionFile,
					expected,
					teardownDeadline,
					record.label,
				);
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

	async #buildSpawnOptions(
		session: ToolSession,
		record: WorkerRecord,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<ExecutorOptions> {
		const agent = this.#workerAgent(record);
		const sessionFile = session.getSessionFile();
		const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `proto-worker-${Snowflake.next()}`);
		await fs.mkdir(artifactsDir, { recursive: true });
		if (!sessionArtifactsDir) {
			record.temporaryArtifacts = { dir: artifactsDir, unregister: registerArtifactsDir(artifactsDir) };
		}
		const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
			getArtifactsDir: session.getArtifactsDir ?? (() => null),
			getSessionId: session.getSessionId ?? (() => null),
		};
		return {
			cwd: session.cwd,
			agent,
			task: message,
			assignment: message,
			description: `worker ${record.label}`,
			agentDisplayName: record.label,
			index: 0,
			id: record.id,
			taskDepth: session.taskDepth ?? 0,
			detached: true,
			modelOverride: record.modelOverride,
			modelRole: record.modelRole,
			parentActiveModelPattern: session.getActiveModelString?.(),
			thinkingLevel: agent.thinkingLevel,
			effort: record.effort,
			outputSchema: record.outputSchema,
			outputSchemaMode: record.outputSchemaMode,
			outputSchemaSource: record.outputSchemaSource,
			outputSchemaOverridesAgent: record.outputSchemaSource === "caller",
			sessionFile,
			persistArtifacts: Boolean(sessionFile),
			artifactsDir,
			signal,
			eventBus: session.eventBus,
			onProgress,
			authStorage: session.authStorage,
			streamFn: session.streamFn,
			customTools: session.customTools,
			modelRegistry: session.modelRegistry,
			model: record.model,
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
			parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
			keepAlive: true,
		};
	}

	#registerTurnJob(
		session: ToolSession,
		manager: AsyncJobManager,
		record: WorkerRecord,
		message: string,
		options: { first: boolean; reserveCapacity?: boolean },
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
			if (record.state === "dead" || record.terminal) return;
			mergeTrace(turn, progress);
			record.resolvedModel = progress.resolvedModel ?? record.resolvedModel;

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

		const semaphore = this.#turnSemaphore(session);
		const jobId = manager.register(
			"worker",
			`${record.label} (${record.id}): ${firstLine(message, 60)}`,
			async ({ jobId: ownJobId, signal, markRunning }) => {
				let acquired = false;
				try {
					await semaphore.acquire(signal);
					acquired = true;
					markRunning();
					record.state = "running";
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
						const { runSubagentFollowUpTurn, runSubprocess } = await import("../task/executor");
						const result = options.first
							? await runSubprocess(await this.#buildSpawnOptions(session, record, message, signal, onProgress))
							: await runSubagentFollowUpTurn({
									id: record.id,
									agent: this.#workerAgent(record),
									message,
									description: `worker ${record.label}`,
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
			{
				id: `${record.id}-t${turnIndex}`,
				agentId: record.id,
				ownerId: record.jobOwnerId,
				queued: options.reserveCapacity !== true,
			},
		);
		turn.jobId = jobId;
		// Reservation precedes semaphore acquisition so cancellation cannot reuse a turn identity.
		record.turnCount = turnIndex;
		record.turn = turn;
		return jobId;
	}

	async #finishTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: WorkerRecord,
		settledJobId: string,
	): Promise<void> {
		if (record.lastJobId === settledJobId && record.turn?.jobId !== settledJobId) return;
		record.lastJobId = settledJobId;
		record.live = undefined;
		record.lastActivityAt = Date.now();
		if (record.killed || record.suspended) {
			record.turn = undefined;
			if (!record.terminal)
				this.#markRecordTerminal(record, record.killed ? "explicit-kill" : "parent-session-changed");
			await this.#awaitTemporaryArtifactsCleanup(record);
			return;
		}

		let registered = this.#registeredAgent(record);
		if (registered?.status === "running" && registered.session) {
			AgentRegistry.global().setStatus(record.id, "idle", registered);
			registered = this.#registeredAgent(record);
		}
		if (!registered || (registered.status !== "idle" && registered.status !== "parked")) {
			record.turn = undefined;
			const reason: WorkerTombstoneReason = registered?.status === "aborted" ? "unrecoverable" : "ownership-lost";
			this.#markRecordTerminal(record, reason, `terminal: ${reason}`);
			record.terminalPersisted = await this.#appendTombstone(session, record, reason);
			await this.#awaitTemporaryArtifactsCleanup(record);
			return;
		}
		record.state = "idle";
		let settledPersisted: boolean;
		try {
			settledPersisted = await this.#appendLifecycleEvent(
				session,
				{
					...this.#eventBase(record),
					action: "turn-settled",
					turn: record.turnCount,
				},
				record.parentSessionFile,
			);
		} catch (error) {
			// A failed job must not retain an active turn or accept messages no job can consume.
			record.turn = undefined;
			this.#markRecordTerminal(record, "unrecoverable", "terminal: turn settlement persistence failed");
			AgentRegistry.global().setStatus(record.id, "aborted", registered);
			try {
				record.terminalPersisted = await this.#appendTombstone(session, record, "unrecoverable");
			} catch (persistenceError) {
				logger.warn("orchestrator: failed to persist terminal turn settlement", {
					id: record.id,
					error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
				});
			}
			const deadline = Date.now() + this.#teardownGraceMs;
			await this.#releaseRefWithinDeadline(record.id, registered, deadline, "release");
			await this.#markTerminalRecord(record, registered, deadline);
			await this.#awaitTemporaryArtifactsCleanup(record);
			throw error;
		}
		if (record.childSessionFile && !settledPersisted) {
			record.turn = undefined;
			this.#markRecordTerminal(
				record,
				"parent-session-changed",
				"terminal: parent session changed before settlement",
			);
			await this.#awaitTemporaryArtifactsCleanup(record);
			return;
		}
		if (record.queue.length === 0) {
			record.turn = undefined;
			return;
		}
		let callbackInvoked = false;
		const unregisterCapacityWait = manager.onCapacityAvailable(error => {
			callbackInvoked = true;
			record.capacityWaitCleanup = undefined;
			if (error) {
				record.turn = undefined;
				this.#markRecordTerminal(
					record,
					"unrecoverable",
					`terminal: queued follow-up could not start: ${error.message}`,
				);
				logger.error("orchestrator: queued follow-up could not start", {
					id: record.id,
					error: error.message,
				});
				return;
			}
			if (record.killed || record.suspended || record.terminal) {
				record.turn = undefined;
				record.queue.length = 0;
				return;
			}
			const next = record.queue.shift();
			if (!next) {
				record.turn = undefined;
				return;
			}
			record.turn = undefined;
			try {
				this.#registerTurnJob(session, manager, record, next.message, {
					first: false,
					reserveCapacity: true,
				});
			} catch (registrationError) {
				record.queue.unshift(next);
				this.#markRecordTerminal(
					record,
					"unrecoverable",
					`terminal: queued follow-up could not start: ${registrationError instanceof Error ? registrationError.message : String(registrationError)}`,
				);
				logger.error("orchestrator: queued follow-up could not start", {
					id: record.id,
					error: registrationError instanceof Error ? registrationError.message : String(registrationError),
				});
			}
		});
		if (!callbackInvoked) record.capacityWaitCleanup = unregisterCapacityWait;
	}

	async #settleTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: WorkerRecord,
		turn: WorkerTurn,
		settledJobId: string,
		turnIndex: number,
		result: SingleResult,
	): Promise<string> {
		const failed = result.exitCode !== 0 || result.aborted === true;
		const status = result.aborted ? "aborted" : failed ? "failed" : "completed";
		record.resolvedModel = result.resolvedModel ?? record.resolvedModel;
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

		// Hold record.turn until persistence and rendering are ready; concurrent sends queue safely.
		await this.#finishTurn(session, manager, record, settledJobId);
		let text: string;
		try {
			text = prompt
				.render(workerTurnResultTemplate, {
					id: record.id,
					label: record.label,
					agent: record.agentName,
					owner: record.ownerId,
					parent: record.parentSessionId,
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
			logger.warn("orchestrator: turn-result template render failed; using plain fallback", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
			text = [
				`[worker:${record.id} label=${record.label} owner=${record.ownerId} parent=${record.parentSessionId} turn=${turnIndex} status=${status}]`,
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
