import type { Agent, AgentEvent, AgentTool, AgentToolContext, StreamFn } from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, ServiceTier } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import {
	AdvisorOutputQuarantinedError,
	type AdvisorRuntimeStatus,
	getOrCreateAdvisorProviderSessionId,
	type ReviewerGeneratedTextExtractor,
	ReviewerRuntime,
} from "../advisor";
import { formatModelString, resolveConductorRoleSelection } from "../config/model-resolver";
import { MODEL_ROLES } from "../config/model-roles";
import type { CursorMcpResourceAdapter } from "../cursor";
import type { GoalRuntime } from "../goals/runtime";
import { renderTrustedObjective } from "../goals/runtime";
import type { Goal } from "../goals/state";
import conductorCommissionPrompt from "../prompts/conductor/commission.md" with { type: "text" };
import conductorCommissionSystemPrompt from "../prompts/conductor/commission-system.md" with { type: "text" };
import conductorEpochPrompt from "../prompts/conductor/epoch.md" with { type: "text" };
import conductorEpochSystemPrompt from "../prompts/conductor/epoch-system.md" with { type: "text" };
import conductorSystemPrompt from "../prompts/conductor/system.md" with { type: "text" };
import conductorVerifyPrompt from "../prompts/conductor/verify.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { CustomMessagePayload } from "../session/messages";
import { type ReviewerIdentity, ReviewerTransport, type ReviewerTransportHost } from "../session/reviewer-transport";
import { type AgentProgress, oneLineLabel } from "../task/types";
import { resolveThinkingLevelForModel } from "../thinking";
import { READ_ONLY_EXPLORATORY_COMMANDS } from "../tools/bash-allowlist";
import * as git from "../utils/git";
import { type ConductorGateRuling, type ConductorRuling, type ConductorTempoRuling, CueTool } from "./cue-tool";
import { assembleEpochDigest } from "./digest";
import { type ConductorProposal, ProgramTool } from "./program-tool";
import { CONDUCTOR_TRANSCRIPT_FILENAME, type ConductorJournalEntry, conductorTranscriptPath } from "./transcript";

/**
 * Investigative grant for a verification turn. `bash` is included because the objective's "## Verification"
 * commands are the whitelist there (prompt-enforced in v0). No mutating grants, ever.
 */
export const CONDUCTOR_TOOL_NAMES: readonly string[] = ["read", "bash"];

/**
 * Commissioning investigates read-only: `read` plus an exploratory bash allowlist (`rg`, `ls`, ...) that the
 * bash tool itself enforces — every other program, mutation flag, and file-writing redirection is rejected.
 * The contract still has to be reproducible by the working agent and the auditor, so nothing the commissioner
 * could only learn by executing may enter it; the grant exists to locate evidence, not to produce it.
 */
export const CONDUCTOR_COMMISSION_TOOL_NAMES: readonly string[] = ["read", "bash"];

export type ConductorStatus = AdvisorRuntimeStatus | "off";

/** Which turn the single transport slot is currently built for; the three are mutually exclusive by design. */
type ConductorTurnMode = "verify" | "commission" | "epoch";

/** Attempts per verification turn: the first try plus two retries on retriable failures. */
const MAX_VERIFICATION_ATTEMPTS = 3;

/** Commissioning gets the same bounded retry budget as verification. */
const MAX_COMMISSIONING_ATTEMPTS = 3;

/** Epoch turns get the same bounded retry budget as verification and commissioning. */
const MAX_EPOCH_ATTEMPTS = 3;

/** Consecutive dropped epochs before epoch steering halts (the degradation ladder's warning step). */
const MAX_DROPPED_EPOCHS = 3;

/** Journal entries kept in memory for `/conduct status`; the transcript holds the full history. */
const JOURNAL_LIMIT = 50;

const CONDUCTOR_QUARANTINE_PREFIX = "Conductor response quarantined";

const extractConductorGeneratedText: ReviewerGeneratedTextExtractor = call => {
	if (call.name === "program") {
		return typeof call.arguments.objective === "string" ? [call.arguments.objective] : [];
	}
	if (call.name !== "cue") return [];
	const parts: string[] = [];
	if (typeof call.arguments.evidence === "string") parts.push(call.arguments.evidence);
	if (typeof call.arguments.question === "string") parts.push(call.arguments.question);
	if (typeof call.arguments.prompt === "string") parts.push(call.arguments.prompt);
	return parts;
};

/**
 * One-line description of how the conductor's most recent assistant turn ended. Degraded models tend to stop
 * after a thinking block without ever calling the turn's single-shot channel (`program`/`cue`); retry
 * diagnostics and failure notices should say that instead of reporting an opaque "no contract".
 */
function describeLastAssistantTurn(instance: ReviewerTransport): string {
	const messages = instance.agent.state.messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const toolCalls = message.content.filter(block => block.type === "toolCall").length;
		const produced =
			toolCalls > 0
				? `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`
				: message.content.map(block => block.type).join("+") || "no content";
		return `${produced}, stop=${message.stopReason}, ${message.usage.output} output tokens`;
	}
	return "no assistant turn";
}

export const CONDUCTOR_VERIFICATION_MESSAGE_TYPE = "conductor-verification";

export const CONDUCTOR_EPOCH_MESSAGE_TYPE = "conductor-epoch";

export interface ConductorMessageDeliveryOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** The prompt/reset pair the transport hands back for one turn kind; verification and commissioning share it. */
type ConductorFacade = { prompt(input: string): Promise<void>; reset(): void };

/**
 * Live display payload for one conductor run, emitted through the host so UIs can stream the conductor's activity
 * the same way they stream subagent progress. The transcript is written live during the run, so a viewer can tail
 * `sessionFile` while `status` is `"running"`; terminal statuses end the display.
 */
export interface ConductorActivity {
	/** Which single-shot channel this run drives. */
	mode: ConductorTurnMode;
	/** `"running"` while the turn is in flight; terminal values end the display. */
	status: "running" | "completed" | "failed" | "aborted";
	/** One-line objective (verification) or rough ask (commissioning) preview. */
	label: string;
	/** Absolute path of the conductor's transcript (`__conductor.jsonl`), or `undefined` when unpersisted. */
	sessionFile: string | undefined;
	startedAt: number;
	/** Subagent-shaped progress snapshot; every UI surface that renders subagent activity renders this as-is. */
	progress: AgentProgress;
}

export interface ConductorHost extends ReviewerTransportHost {
	obfuscator: SecretObfuscator | undefined;
	isDisposed(): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	sendCustomMessage(message: CustomMessagePayload, options?: ConductorMessageDeliveryOptions): Promise<boolean>;
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	goalRuntime(): GoalRuntime | undefined;
	currentGoal(): Goal | undefined;
	/**
	 * Folds the primary session's context down on the conductor's request (an epoch `context:"compact"` ruling).
	 * Optional: hosts without a compaction entry point silently skip the ruling's compact half.
	 */
	requestCompaction?(): Promise<unknown>;
	/**
	 * Streams one conductor run's activity to display surfaces. Called on turn start, on a coalesced cadence while
	 * the turn streams, and once with a terminal status when the run settles. Absent hosts (SDK, RPC) simply get
	 * no streaming display.
	 */
	emitConductorActivity?(activity: ConductorActivity): void;
}

export interface SessionConductorOptions {
	enabled: boolean;

	/**
	 * Deferred tool-pool build. Called at most once, and only when a verification turn actually needs the
	 * conductor's isolated tools — a disabled conductor never constructs a `ToolSession` or a tool pool.
	 */
	toolsFactory?: () => Promise<AgentTool[]>;
	getToolContext?: () => AgentToolContext | undefined;
	mcpResources?: CursorMcpResourceAdapter;
	contextPrompt?: string;
	streamFn?: StreamFn;
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	initialCost?: number;

	/**
	 * Arms the commissioning turn's exploratory bash allowlist on the conductor's ToolSession, or disarms it
	 * (`undefined`) for verification and teardown. The slot is single-tenant, so this flips with turn kind.
	 */
	setBashCommandAllowlist?: (allowlist: readonly string[] | undefined) => void;
}

export interface ConductorStats {
	configured: boolean;
	active: boolean;
	status: ConductorStatus;
	model?: Model;
	pendingGoalId?: string;
	commissioning: boolean;
	rejections: number;
	escalated: boolean;
	cost: number;
	/** Epoch turns that produced a tempo ruling over this session's lifetime. */
	epochCount: number;
	/** Consecutive epoch turns that produced no ruling (reset by every successful ruling). */
	droppedEpochs: number;
	/** True when epoch steering halted after repeated drops; the verification gate is unaffected. */
	epochsHalted: boolean;
}

/**
 * Result of one commissioning turn. Nothing is persisted by any of these outcomes — the contract only becomes a
 * goal when the host creates it through the `/goal set` machinery, so every non-`proposed` outcome is inert.
 */
export type ConductorCommissionOutcome =
	| { status: "proposed"; objective: string; tokenBudget?: number }
	| { status: "busy"; reason: string }
	| { status: "unavailable"; reason: string }
	| { status: "failed"; reason: string };

/** How often a running conductor's activity is re-emitted while only text deltas arrive. */
const ACTIVITY_EMIT_COALESCE_MS = 250;

/** Observable id for the conductor's live progress; distinct from every worker id by construction. */
const CONDUCTOR_PROGRESS_ID = "conductor";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mirrors the subagent executor's tool-args preview: the first recognizably meaningful string arg, capped. */
function conductorToolArgsPreview(args: Record<string, unknown>): string {
	for (const key of ["command", "file_path", "path", "pattern", "query"]) {
		const value = args[key];
		if (typeof value === "string" && value) {
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}
	return "";
}

function renderCommissionPrompt(ask: string): string {
	return prompt.render(conductorCommissionPrompt, { ask });
}

function renderVerifyPrompt(goal: Goal): string {
	return prompt.render(conductorVerifyPrompt, {
		objective: renderTrustedObjective(goal.objective),
		tokensUsed: String(goal.tokensUsed),
		tokenBudget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
		remainingTokens:
			goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed)),
		timeUsedSeconds: String(goal.timeUsedSeconds),
	});
}

function renderEpochPrompt(goal: Goal, epochNumber: number, wakeReasons: string, digest: string): string {
	return prompt.render(conductorEpochPrompt, {
		epoch: String(epochNumber),
		wakeReasons,
		objective: renderTrustedObjective(goal.objective),
		tokensUsed: String(goal.tokensUsed),
		tokenBudget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
		remainingTokens:
			goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed)),
		timeUsedSeconds: String(goal.timeUsedSeconds),
		digest,
	});
}

/** Collapses a multi-line ruling prompt into the journal's one-line headline. */
function journalHeadline(text: string): string {
	const line = text.split("\n").find(candidate => candidate.trim()) ?? "";
	const collapsed = line.replace(/\s+/g, " ").trim();
	return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

function formatRejectionContent(evidence: string): string {
	return [
		`<conductor-verification verdict="reject" guidance="resolve every discrepancy before claiming completion again">`,
		escapeXmlText(evidence),
		"</conductor-verification>",
	].join("\n");
}

/**
 * Conductor runtime. Owns one {@link ReviewerTransport} on the `conductor` model role, the commissioning turn
 * (`program`) and the completion gate (`cue`). Every path is inert unless `conductor.enabled` is on.
 */
export class SessionConductor {
	readonly #host: ConductorHost;
	readonly #options: SessionConductorOptions;

	#enabled: boolean;
	#status: ConductorStatus = "off";
	#instance: ReviewerTransport | undefined;
	#instanceMode: ConductorTurnMode | undefined;
	#facade: ConductorFacade | undefined;
	#cueTool: CueTool | undefined;
	#programTool: ProgramTool | undefined;
	#toolsPromise: Promise<AgentTool[]> | undefined;
	#buildPromise: Promise<ReviewerTransport | undefined> | undefined;

	readonly #providerSessionIds = new Map<string, string>();
	#recorderClosed: Promise<void> = Promise.resolve();
	#cost = 0;

	/** Nesting count of active session-persistence suspensions; > 0 blocks new turns and gate arming. */
	#transitionDepth = 0;

	#pendingGoalId: string | undefined;
	#pendingGoalUpdatedAt: number | undefined;
	#rejectionGoalId: string | undefined;
	#rejectionCount = 0;
	#gateTimer: NodeJS.Timeout | undefined;
	#startWhenIdle = false;
	#verificationInFlight = false;
	#commissioningInFlight = false;
	#escalated = false;
	#ruling: ConductorRuling | undefined;

	/** Reads and clears the ruling slot; the method read defeats tsgo's property-assignment narrowing. */
	#takeRuling(): ConductorRuling | undefined {
		const ruling = this.#ruling;
		this.#ruling = undefined;
		return ruling;
	}
	#proposal: ConductorProposal | undefined;

	// Epoch cadence: the conductor wakes between primary turns to review a mechanical digest of the stretch and
	// rule on the next stretch's tempo. All counters are event-driven; nothing here ticks on a timer.
	#epochCount = 0;
	#epochInFlight = false;
	#epochRuling: ConductorRuling | undefined;

	/** Reads and clears the tempo-ruling slot; the method read defeats tsgo's property-assignment narrowing. */
	#takeEpochRuling(): ConductorRuling | undefined {
		const ruling = this.#epochRuling;
		this.#epochRuling = undefined;
		return ruling;
	}
	#turnsSinceWake = 0;
	#digestCursor = 0;
	#pendingWakeReasons: string[] = [];
	#cadenceGoalId: string | undefined;
	#thresholdGoalId: string | undefined;
	#thresholdFraction = 0;
	#lastEpochPrompt: string | undefined;
	#droppedEpochs = 0;
	#epochsHalted = false;
	#journal: ConductorJournalEntry[] = [];

	// Streaming display state for the run in flight. `#activity` doubles as the in-flight flag for the
	// subscription below: with no run active, agent events are ignored by the display path.
	#activity: ConductorActivity | undefined;
	#activityEmitTimer: NodeJS.Timeout | undefined;
	#lastActivityEmitMs = 0;
	#activityOutputTail = "";

	constructor(host: ConductorHost, options: SessionConductorOptions) {
		this.#host = host;
		this.#options = options;
		this.#enabled = options.enabled;
		this.#cost = options.initialCost ?? 0;
		this.#status = this.#enabled ? (this.#resolveModelSelection() ? "running" : "no_model") : "off";
	}

	// ---------------------------------------------------------------- gate authority

	/**
	 * Supplies `GoalRuntimeHost.completionAuthority`. Synchronous by contract, so it only answers the cheap
	 * question "is there a healthy conductor that will rule on this?" — the audit itself runs out of band.
	 */
	completionAuthority(_goal: Goal): "commit" | "pend" {
		return this.isHealthy() ? "pend" : "commit";
	}

	isEnabled(): boolean {
		return this.#enabled;
	}

	isActive(): boolean {
		return this.#instance !== undefined;
	}

	isHealthy(): boolean {
		if (!this.#enabled || this.#host.isDisposed()) return false;
		if (this.#escalated) return false;
		if (this.#status === "error" || this.#status === "quota_exhausted") return false;
		return this.#resolveModelSelection() !== undefined;
	}

	#resolveModelSelection(): { model: Model; thinkingLevel?: ThinkingLevel } | undefined {
		return resolveConductorRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
	}

	// ---------------------------------------------------------------- wake conditions

	/**
	 * Wake condition. Records the pend and re-derives the gate timer: the idle watchdog attaches to the claim,
	 * not to any particular run — a primary still streaming its pend turn or an in-flight audit suspends it, and
	 * it re-arms fresh only when the claim sits idle with nothing verifying it.
	 */
	onGoalUpdated(goal: Goal | null): void {
		if (!this.#enabled) return;
		this.#trackEpochCadence(goal);
		// Rejection accounting is keyed on the goal, not on the pend: a rejected goal re-pends under the same id,
		// and only a genuinely different goal clears the consecutive-rejection streak.
		if (goal && this.#rejectionGoalId !== goal.id) {
			this.#rejectionGoalId = goal.id;
			this.#rejectionCount = 0;
		}
		if (goal?.status !== "verifying") {
			this.#clearGate();
			return;
		}
		// The gate owns one pend at a time, keyed on id + updatedAt: a rejected goal re-pends under the same id
		// with a fresh updatedAt, and that re-pend is a new claim that must be re-armed and re-audited — the
		// in-flight verification for the previous pend has its ruling discarded as stale.
		if (
			this.#pendingGoalId === goal.id &&
			this.#pendingGoalUpdatedAt === goal.updatedAt &&
			(this.#startWhenIdle || this.#verificationInFlight)
		) {
			return;
		}
		this.#pendingGoalId = goal.id;
		this.#pendingGoalUpdatedAt = goal.updatedAt;
		if (this.#escalated) return;
		this.#startWhenIdle = true;
		if (!this.#host.agent.state.isStreaming) this.#startVerification();
		this.#syncGateTimer();
	}

	/**
	 * The verification turn starts at the first settled primary turn end after the pend, never mid-turn: the
	 * conductor audits current repo state, and reading files while the primary still has edits in flight would
	 * race the very state it is grading.
	 */
	onPrimaryTurnEnd(willContinue: boolean | undefined): void {
		if (!this.#enabled) return;
		// Epoch accounting counts every primary turn of an active stretch; the wake itself only fires at a
		// settled boundary, never mid-chain. Verification preempts epochs: a pended claim owns the slot.
		const goal = this.#host.currentGoal();
		if (goal && (goal.status === "active" || goal.status === "budget-limited")) {
			this.#turnsSinceWake++;
			if (willContinue !== true) this.#maybeStartEpoch();
		}
		// A continuation hand-off is not a settled turn end: nothing starts verification here, so a pended claim
		// falls back to the idle watchdog instead of stranding silently.
		if (willContinue === true) {
			this.#syncGateTimer();
			return;
		}
		this.#startVerification();
	}

	/** Idle-watchdog budget for the verification gate: the only clock left in the conductor. */
	#gateTimeoutMs(): number {
		const seconds = this.#host.settings.get("conductor.gateTimeoutSeconds") as number;
		return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds) * 1000 : 3_600_000;
	}

	#armGate(): void {
		this.#clearGateTimer();
		const timeoutMs = this.#gateTimeoutMs();
		this.#gateTimer = setTimeout(() => {
			this.#gateTimer = undefined;
			this.#escalate(
				"The pended completion claim sat unresolved with no verification activity for the full gate timeout.",
			);
		}, timeoutMs);
	}

	#clearGateTimer(): void {
		if (!this.#gateTimer) return;
		clearTimeout(this.#gateTimer);
		this.#gateTimer = undefined;
	}

	#clearGate(): void {
		this.#clearGateTimer();
		this.#pendingGoalId = undefined;
		this.#pendingGoalUpdatedAt = undefined;
		this.#startWhenIdle = false;
	}

	/**
	 * Re-derives the gate timer from current state. The gate is an idle watchdog over one pended claim: it fires
	 * only when the claim sits unresolved while nothing is working toward a verdict — no audit in flight, the
	 * primary idle, the conductor not parked, not halted, not mid-commission. Any of those states suspends the
	 * timer, and returning to idle with the same claim arms a fresh period; active work is never cut off by the
	 * clock.
	 */
	#syncGateTimer(): void {
		if (!this.#enabled || this.#pendingGoalId === undefined) {
			this.#clearGateTimer();
			return;
		}
		if (
			this.#transitionDepth > 0 ||
			this.#escalated ||
			this.#verificationInFlight ||
			this.#commissioningInFlight ||
			this.#epochInFlight ||
			!this.#startWhenIdle ||
			this.#host.agent.state.isStreaming
		) {
			this.#clearGateTimer();
			return;
		}
		if (this.#gateTimer !== undefined) return;
		this.#armGate();
	}

	/**
	 * Restores gate tracking for a goal whose completion is still pended. Called when the conductor (re)gains the
	 * ability to verify — `/conduct on` after an escalation or `/conduct off`, a conductor model-role change, a
	 * conversation boundary reset, or a verification turn settling over a re-pend. Without this the claim strands:
	 * `#pendCompletion` refuses a second pend, and no `goal_updated` fires to re-arm the gate. Deliberate parks
	 * (quota exhausted, turn error, no model) stay parked — only an explicit re-enable clears those.
	 */
	#rearmPendedVerification(): void {
		if (!this.#enabled || this.#host.isDisposed()) return;
		if (this.#verificationInFlight || this.#commissioningInFlight || this.#epochInFlight || this.#escalated) {
			return;
		}
		if (this.#status !== "running") return;
		const goal = this.#host.currentGoal();
		if (goal?.status !== "verifying") return;
		this.#pendingGoalId = goal.id;
		this.#pendingGoalUpdatedAt = goal.updatedAt;
		this.#startWhenIdle = true;
		if (!this.#host.agent.state.isStreaming) this.#startVerification();
		this.#syncGateTimer();
	}

	/**
	 * Degradation ladder step 3: an escalated conductor stops auto-verifying and stops pending new claims, so a
	 * dead verdict source can never strand the session. `/conduct on` rebuilds it, mirroring `/advisor`.
	 */
	#escalate(reason: string): void {
		this.#clearGateTimer();
		this.#startWhenIdle = false;
		this.#escalated = true;
		this.#host.emitNotice(
			"warning",
			`Conductor escalation: ${reason} The goal stays pending verification — run /goal resume to continue manually, or /conduct on to re-arm verification.`,
			"conductor",
		);
	}

	// ---------------------------------------------------------------- verification turn

	#startVerification(): void {
		if (!this.#enabled || !this.#startWhenIdle || this.#verificationInFlight || this.#escalated) return;
		// The single transport slot is built for one turn kind at a time; a commissioning or epoch turn in
		// flight owns it. The claim is re-armed when that turn settles.
		if (this.#commissioningInFlight || this.#epochInFlight) return;
		// A session transition owns the slot and the recorder; the claim is re-armed when the transition releases.
		if (this.#transitionDepth > 0) return;
		if (this.#host.isDisposed()) return;
		const goal = this.#host.currentGoal();
		if (
			goal?.status !== "verifying" ||
			goal.id !== this.#pendingGoalId ||
			goal.updatedAt !== this.#pendingGoalUpdatedAt
		) {
			return;
		}
		this.#startWhenIdle = false;
		this.#verificationInFlight = true;
		// The audit is now the active work on the claim: the idle watchdog stands down for its whole duration.
		this.#clearGateTimer();
		void this.#runVerification(goal)
			.catch(error => logger.warn("conductor verification failed", { err: String(error) }))
			.finally(() => {
				this.#verificationInFlight = false;
				// A claim pended (or re-pended) while this turn ran was parked behind it; re-arm the gate for it and
				// start now that the slot is free — still never mid-primary-turn. Deliberate parks stay parked.
				this.#rearmPendedVerification();
			});
	}

	async #runVerification(goal: Goal): Promise<void> {
		const instance = await this.#ensureInstance("verify");
		const facade = this.#facade;
		const cueTool = this.#cueTool;
		if (!instance || !facade || !cueTool) {
			this.#escalate("The conductor could not be started, so no verdict is available.");
			return;
		}

		this.#beginActivity("verify", oneLineLabel(goal.objective));
		let terminal: ConductorActivity["status"] = "failed";
		try {
			terminal = await this.#verificationTurns(goal, facade, cueTool);
		} finally {
			this.#endActivity(terminal);
		}
	}

	/** Runs the audit attempts for one pend; returns the display terminal status. */
	async #verificationTurns(
		goal: Goal,
		facade: ConductorFacade,
		cueTool: CueTool,
	): Promise<ConductorActivity["status"]> {
		const instance = this.#instance;
		if (!instance) return "aborted";
		const promptText = renderVerifyPrompt(goal);
		let ruling: ConductorGateRuling | undefined;
		let lastTurn = "no assistant turn";
		for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt++) {
			if (this.#host.isDisposed()) return "aborted";
			this.#ruling = undefined;
			cueTool.beginTurn();
			try {
				await facade.prompt(promptText);
			} catch (error) {
				if (error instanceof AdvisorOutputQuarantinedError) {
					logger.warn("conductor turn quarantined; discarding ruling", { err: String(error) });
					facade.reset();
					continue;
				}
				if (await this.#handleTurnError(error, instance)) continue;
				return "failed";
			}
			const candidate = this.#takeRuling();
			switch (candidate?.op) {
				case "verify":
				case "escalate":
					ruling = candidate;
					break;
				case "next":
					// Tempo rulings belong to epoch turns; a verification turn has no stretch to steer.
					logger.warn("conductor verification turn ruled next outside an epoch; treating as no verdict");
					break;
				default:
					break;
			}
			if (ruling) break;
			// Mirror commissioning: a turn without a `cue` call carries nothing worth keeping, so the next attempt
			// starts from a clean context instead of stacking failed turns into the prompt.
			lastTurn = describeLastAssistantTurn(instance);
			logger.warn("conductor verification turn produced no verdict", { attempt: attempt + 1, turn: lastTurn });
			if (attempt + 1 < MAX_VERIFICATION_ATTEMPTS) facade.reset();
		}

		if (!ruling) {
			this.#escalate(
				`The conductor returned no verdict after ${MAX_VERIFICATION_ATTEMPTS} attempts; every turn ended without a \`cue\` call (last: ${lastTurn}).`,
			);
			return "failed";
		}
		await this.#applyRuling(goal, ruling);
		return "completed";
	}

	// ---------------------------------------------------------------- commissioning turn

	/**
	 * Commissioning turn. Investigates the repo read-only and drafts the contract; the proposal is returned to the
	 * host, never written anywhere, so a refusal, an abort, or a user rejection strands nothing.
	 */
	async commission(ask: string): Promise<ConductorCommissionOutcome> {
		const trimmed = ask.trim();
		if (!trimmed) return { status: "failed", reason: "No rough ask was given." };
		if (!this.#enabled) return { status: "unavailable", reason: "Conductor is disabled." };
		if (this.#host.isDisposed()) return { status: "unavailable", reason: "The session is shutting down." };
		if (this.#commissioningInFlight) {
			return { status: "busy", reason: "A commissioning turn is already running." };
		}
		if (this.#transitionDepth > 0) {
			return { status: "busy", reason: "A session transition is in progress." };
		}
		if (this.#epochInFlight) {
			return { status: "busy", reason: "An epoch ruling is in progress." };
		}
		if (this.#pendingGoalId !== undefined || this.#verificationInFlight) {
			return { status: "busy", reason: "A completion claim is pending verification." };
		}
		const goal = this.#host.currentGoal();
		if (goal && goal.status !== "complete" && goal.status !== "dropped") {
			return { status: "busy", reason: "This session already has a goal." };
		}
		if (this.#escalated) {
			return { status: "unavailable", reason: "Conductor is halted — run /conduct on to rebuild it." };
		}
		if (!this.#resolveModelSelection()) {
			return { status: "unavailable", reason: "No model is assigned to the 'conductor' role." };
		}
		if (this.#status === "error" || this.#status === "quota_exhausted") {
			return { status: "unavailable", reason: `Conductor is ${this.#status.replace("_", " ")}.` };
		}

		this.#commissioningInFlight = true;
		try {
			return await this.#runCommissioning(trimmed);
		} finally {
			this.#commissioningInFlight = false;
			this.#proposal = undefined;
			// The slot is released for the next turn kind: verification needs the auditor persona, the `cue` tool, and
			// its unrestricted-bash verification whitelist instead of the commissioning exploration allowlist. Gate
			// state is untouched.
			this.#disposeInstance();
			// A verdict that pended while this turn ran (the user can still `/goal set` by hand mid-commission) was
			// parked behind it; re-arm the gate and start it now that the slot is free, still never mid-primary-turn.
			this.#rearmPendedVerification();
		}
	}

	async #runCommissioning(ask: string): Promise<ConductorCommissionOutcome> {
		const instance = await this.#ensureInstance("commission");
		const facade = this.#facade;
		const programTool = this.#programTool;
		if (!instance || !facade || !programTool) {
			return { status: "unavailable", reason: "The conductor could not be started." };
		}

		this.#beginActivity("commission", oneLineLabel(ask));
		let terminal: ConductorActivity["status"] = "failed";
		try {
			const outcome = await this.#commissioningTurns(ask, facade, programTool);
			terminal = outcome.status === "proposed" ? "completed" : "failed";
			return outcome;
		} finally {
			this.#endActivity(terminal);
		}
	}

	/** Runs the contract-drafting attempts for one rough ask; the display terminal status is set by the caller. */
	async #commissioningTurns(
		ask: string,
		facade: ConductorFacade,
		programTool: ProgramTool,
	): Promise<ConductorCommissionOutcome> {
		const instance = this.#instance;
		if (!instance) return { status: "unavailable", reason: "The conductor could not be started." };

		const promptText = renderCommissionPrompt(ask);
		let proposal: ConductorProposal | undefined;
		let lastTurn = "no assistant turn";
		for (let attempt = 0; attempt < MAX_COMMISSIONING_ATTEMPTS; attempt++) {
			if (this.#host.isDisposed()) return { status: "unavailable", reason: "The session is shutting down." };
			this.#proposal = undefined;
			programTool.beginTurn();
			try {
				await facade.prompt(promptText);
			} catch (error) {
				if (error instanceof AdvisorOutputQuarantinedError) {
					logger.warn("conductor commissioning turn quarantined; discarding contract", {
						err: String(error),
					});
					facade.reset();
					continue;
				}
				if (await this.#handleTurnError(error, instance, "commissioning")) continue;
				return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
			}
			proposal = this.#proposal;
			this.#proposal = undefined;
			if (proposal) break;
			// A turn that ends without a `program` call carries nothing worth keeping: retrying against the same
			// conversation stacks degenerate thinking-only stops (the failure this loop exists to survive) and
			// grows the prompt for no corrective value. Start the next attempt clean, like the quarantine path.
			lastTurn = describeLastAssistantTurn(instance);
			logger.warn("conductor commissioning turn produced no contract", { attempt: attempt + 1, turn: lastTurn });
			if (attempt + 1 < MAX_COMMISSIONING_ATTEMPTS) facade.reset();
		}

		if (!proposal) {
			return {
				status: "failed",
				reason: `The conductor proposed no contract after ${MAX_COMMISSIONING_ATTEMPTS} attempts; every turn ended without a \`program\` call (last: ${lastTurn}).`,
			};
		}
		return proposal.tokenBudget === undefined
			? { status: "proposed", objective: proposal.objective }
			: { status: "proposed", objective: proposal.objective, tokenBudget: proposal.tokenBudget };
	}

	// ---------------------------------------------------------------- epoch cadence

	/**
	 * Wake bookkeeping on every goal update. A new stretch resets the cadence; budget threshold crossings
	 * (50/80/100% of the token budget) queue wake reasons that fire at the next eligible settled boundary.
	 */
	#trackEpochCadence(goal: Goal | null): void {
		if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) {
			// The stretch is pended, paused, or over: counters stop, but a halt (degradation) persists — only
			// `/conduct on`, a conversation reset, or a genuinely new stretch re-arms epoch steering.
			this.#pauseEpochCounters();
			return;
		}
		if (this.#cadenceGoalId !== goal.id) {
			// A fresh stretch starts its own cadence: prior streaks, pending reasons, and dedupe memory are stale.
			this.#resetEpochCadence();
			this.#cadenceGoalId = goal.id;
		}
		if (goal.tokenBudget === undefined || goal.tokenBudget <= 0) return;
		const fraction = goal.tokensUsed / goal.tokenBudget;
		if (this.#thresholdGoalId !== goal.id) {
			this.#thresholdGoalId = goal.id;
			this.#thresholdFraction = fraction;
			return;
		}
		for (const threshold of [0.5, 0.8, 1]) {
			if (fraction >= threshold && this.#thresholdFraction < threshold) {
				this.#queueWakeReason(
					`budget ${Math.round(threshold * 100)}% used (${goal.tokensUsed} of ${goal.tokenBudget} tokens)`,
				);
			}
		}
		this.#thresholdFraction = Math.max(this.#thresholdFraction, fraction);
	}

	#queueWakeReason(reason: string): void {
		if (this.#pendingWakeReasons.includes(reason)) return;
		this.#pendingWakeReasons.push(reason);
		if (this.#pendingWakeReasons.length > 6) this.#pendingWakeReasons.shift();
	}

	#pauseEpochCounters(): void {
		this.#turnsSinceWake = 0;
		this.#pendingWakeReasons = [];
	}

	#resetEpochCadence(): void {
		this.#pauseEpochCounters();
		this.#cadenceGoalId = undefined;
		this.#thresholdGoalId = undefined;
		this.#thresholdFraction = 0;
		this.#lastEpochPrompt = undefined;
		this.#droppedEpochs = 0;
		this.#epochsHalted = false;
	}

	/**
	 * Wake gate at a settled primary turn end. Ordinary epochs wait for `conductor.minEpochTurns` primary turns;
	 * queued event reasons (budget thresholds) persist until the spacing is satisfied — spacing governs, reasons
	 * are never lost. The primary never blocks on the conductor here: the epoch turn runs beside the stretch,
	 * and the ruling lands at the next turn boundary.
	 */
	#maybeStartEpoch(): void {
		if (!this.isHealthy()) return;
		if (this.#transitionDepth > 0) return;
		if (this.#epochInFlight || this.#verificationInFlight || this.#commissioningInFlight) return;
		// The verification gate owns the slot once a claim is pending.
		if (this.#pendingGoalId !== undefined) return;
		if (this.#epochsHalted) return;
		const goal = this.#host.currentGoal();
		if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) return;
		if (this.#turnsSinceWake < this.#minEpochTurns()) return;
		this.#startEpochTurn();
	}

	#startEpochTurn(): void {
		const reasons = this.#pendingWakeReasons;
		this.#pendingWakeReasons = [];
		this.#turnsSinceWake = 0;
		this.#epochInFlight = true;
		void this.#runEpochTurn(reasons)
			.catch(error => {
				logger.warn("conductor epoch turn failed", { err: String(error) });
				// An escaped crash (digest assembly, unexpected transport state) counts as a dropped epoch too —
				// the degradation ladder must see it even though the attempt loop never completed.
				this.#dropEpoch(`epoch turn crashed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				this.#epochInFlight = false;
				// A claim pended while this epoch ran was parked behind it; re-arm the gate for it now that the
				// slot is free — still never mid-primary-turn.
				this.#rearmPendedVerification();
			});
	}

	/** Runs one epoch: digest, tempo review, exactly one `cue` ruling. */
	async #runEpochTurn(reasons: string[]): Promise<void> {
		const goal = this.#host.currentGoal();
		if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) return;
		const epochNumber = this.#epochCount + 1;
		const instance = await this.#ensureInstance("epoch");
		const facade = this.#facade;
		const cueTool = this.#cueTool;
		if (!instance || !facade || !cueTool) {
			this.#dropEpoch("the conductor could not be started");
			return;
		}

		this.#beginActivity("epoch", `epoch ${epochNumber}: ${oneLineLabel(goal.objective)}`);
		let terminal: ConductorActivity["status"] = "failed";
		try {
			const promptText = await this.#buildEpochPrompt(goal, epochNumber, reasons);
			let ruling: ConductorTempoRuling | undefined;
			let lastTurn = "no assistant turn";
			for (let attempt = 0; attempt < MAX_EPOCH_ATTEMPTS; attempt++) {
				if (this.#host.isDisposed()) {
					terminal = "aborted";
					return;
				}
				this.#epochRuling = undefined;
				cueTool.beginTurn();
				try {
					await facade.prompt(promptText);
				} catch (error) {
					if (error instanceof AdvisorOutputQuarantinedError) {
						logger.warn("conductor epoch turn quarantined; discarding ruling", { err: String(error) });
						facade.reset();
						continue;
					}
					if (await this.#handleTurnError(error, instance, "epoch")) continue;
					this.#dropEpoch(`epoch turn failed: ${error instanceof Error ? error.message : String(error)}`);
					return;
				}
				const candidate = this.#takeEpochRuling();
				switch (candidate?.op) {
					case "next":
					case "escalate":
						ruling = candidate;
						break;
					case "verify":
						// Verification rulings belong to the completion gate; an epoch turn has no claim to rule on.
						logger.warn("conductor epoch turn ruled verify outside the gate; treating as no ruling");
						break;
					default:
						break;
				}
				if (ruling) break;
				lastTurn = describeLastAssistantTurn(instance);
				logger.warn("conductor epoch turn produced no tempo ruling", { attempt: attempt + 1, turn: lastTurn });
				if (attempt + 1 < MAX_EPOCH_ATTEMPTS) facade.reset();
			}
			if (!ruling) {
				this.#dropEpoch(`no tempo ruling after ${MAX_EPOCH_ATTEMPTS} attempts (last: ${lastTurn})`);
				return;
			}
			terminal = "completed";
			await this.#applyEpochRuling(ruling, epochNumber, reasons);
		} finally {
			this.#endActivity(terminal);
		}
	}

	/** Assembles the mechanical epoch digest and renders the epoch turn's prompt. */
	async #buildEpochPrompt(goal: Goal, epochNumber: number, reasons: string[]): Promise<string> {
		const digest = assembleEpochDigest({
			messages: this.#host.agent.state.messages,
			cursor: this.#digestCursor,
			wakeReasons: reasons,
			epochNumber,
			goalSummary: this.#epochGoalSummary(goal),
			diffStat: await this.#workingTreeSummary(),
		});
		this.#digestCursor = digest.cursor;
		const text = this.#host.obfuscator ? this.#host.obfuscator.obfuscate(digest.text) : digest.text;
		const wakeLines = reasons.length > 0 ? reasons.map(reason => `- ${reason}`).join("\n") : "- routine cadence wake";
		return renderEpochPrompt(goal, epochNumber, wakeLines, text);
	}

	#epochGoalSummary(goal: Goal): string {
		const budget =
			goal.tokenBudget === undefined
				? `${goal.tokensUsed} tokens (no budget)`
				: `${goal.tokensUsed} of ${goal.tokenBudget} tokens`;
		return `status: ${goal.status}; usage: ${budget}; time used: ${goal.timeUsedSeconds}s`;
	}

	/**
	 * `git diff HEAD --numstat` rendered as a churn summary — the mechanical stand-in for the design doc's
	 * "git diff --stat since last wake". Untracked files do not appear in numstat; the conductor's read grant
	 * covers those. Any failure (not a repo, git missing) yields undefined and the digest says so.
	 */
	async #workingTreeSummary(): Promise<string | undefined> {
		try {
			const raw = await git.diff(this.#host.sessionManager.getCwd(), { numstat: true, base: "HEAD" });
			const files: Array<{ path: string; added: number; deleted: number }> = [];
			for (const line of raw.split("\n")) {
				const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
				if (!match) continue;
				files.push({
					path: match[3],
					added: match[1] === "-" ? 0 : Number.parseInt(match[1], 10),
					deleted: match[2] === "-" ? 0 : Number.parseInt(match[2], 10),
				});
			}
			if (files.length === 0) return "no tracked changes vs HEAD";
			files.sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
			const added = files.reduce((sum, file) => sum + file.added, 0);
			const deleted = files.reduce((sum, file) => sum + file.deleted, 0);
			const top = files.slice(0, 20).map(file => `${file.path} +${file.added} -${file.deleted}`);
			const more = files.length > top.length ? ` (+${files.length - top.length} more files)` : "";
			return `${files.length} files changed, +${added} -${deleted} vs HEAD${more}\n${top.join("\n")}`;
		} catch (error) {
			logger.debug("conductor working-tree summary failed", { err: String(error) });
			return undefined;
		}
	}

	/** Applies one tempo ruling: journal it, fold context if ruled, deliver the authored prompt, or escalate. */
	async #applyEpochRuling(ruling: ConductorTempoRuling, epochNumber: number, reasons: string[]): Promise<void> {
		if (ruling.op === "escalate") {
			this.#escalate(ruling.question);
			return;
		}
		this.#epochCount++;
		this.#droppedEpochs = 0;
		const prompt = ruling.prompt?.trim() || undefined;
		const action: ConductorJournalEntry["action"] = !prompt
			? "template"
			: prompt === this.#lastEpochPrompt
				? "deduped"
				: "prompt";
		this.#journal.push({
			epoch: epochNumber,
			at: Date.now(),
			wakeReasons: [...reasons],
			action,
			context: ruling.context,
			promptHeadline: prompt ? journalHeadline(prompt) : undefined,
			note: ruling.note,
		});
		if (this.#journal.length > JOURNAL_LIMIT) this.#journal.splice(0, this.#journal.length - JOURNAL_LIMIT);

		// Compaction runs first so an authored prompt lands in the folded context, not the bloated one.
		if (ruling.context === "compact") await this.#requestConductorCompaction(epochNumber);
		if (prompt && action === "prompt") {
			this.#lastEpochPrompt = prompt;
			await this.#deliverEpochPrompt(epochNumber, prompt);
		}
	}

	/**
	 * The epoch prompt reaches the primary through the same channel as a verification rejection: a synthetic
	 * agent-attributed message at a turn boundary (steer when the continuation machinery already re-fired).
	 */
	async #deliverEpochPrompt(epochNumber: number, prompt: string): Promise<void> {
		const content = [
			`<conductor-epoch epoch="${epochNumber}" guidance="the conductor authored this iteration prompt after reviewing the stretch">`,
			escapeXmlText(prompt),
			"</conductor-epoch>",
		].join("\n");
		await this.#host
			.sendCustomMessage(
				{ customType: CONDUCTOR_EPOCH_MESSAGE_TYPE, content, display: false, attribution: "agent" },
				{ deliverAs: "steer", triggerTurn: true },
			)
			.catch(error => logger.debug("conductor epoch prompt delivery failed", { err: String(error) }));
	}

	async #requestConductorCompaction(epochNumber: number): Promise<void> {
		if (!this.#host.requestCompaction) {
			logger.debug("conductor compact ruling skipped: the host exposes no compaction entry point");
			return;
		}
		try {
			await this.#host.requestCompaction();
			this.#host.emitNotice("info", `Conductor epoch ${epochNumber}: session context compacted.`, "conductor");
		} catch (error) {
			logger.debug("conductor-requested compaction failed", { err: String(error) });
		}
	}

	/**
	 * Degradation ladder for epochs: a dropped epoch falls back to the contract template — the goal's own
	 * continuation keeps driving, which is exactly the pre-epoch behavior. `conductor.fallback: "pause"` pauses
	 * the stretch instead. Repeated drops halt epoch steering with a host warning; the verification gate is
	 * unaffected either way.
	 */
	#dropEpoch(reason: string): void {
		this.#droppedEpochs++;
		logger.warn("conductor epoch dropped", { reason, droppedEpochs: this.#droppedEpochs });
		if (this.#fallbackPolicy() === "pause") {
			this.#droppedEpochs = 0;
			void this.#host
				.goalRuntime()
				?.pauseGoal()
				.then(() => {
					this.#host.emitNotice(
						"warning",
						`Conductor could not rule an epoch (${reason}); the stretch was paused (conductor.fallback = pause). /goal resume continues it.`,
						"conductor",
					);
				})
				.catch(error => logger.debug("conductor fallback pause failed", { err: String(error) }));
			return;
		}
		if (this.#droppedEpochs < MAX_DROPPED_EPOCHS) return;
		this.#epochsHalted = true;
		this.#host.emitNotice(
			"warning",
			`Conductor dropped ${this.#droppedEpochs} consecutive epochs (${reason}); epoch steering is paused. Verification at the completion gate is unaffected. /conduct on re-arms it.`,
			"conductor",
		);
	}

	#minEpochTurns(): number {
		const configured = this.#host.settings.get("conductor.minEpochTurns") as number;
		if (!Number.isFinite(configured) || configured < 0) return 4;
		return Math.trunc(configured);
	}

	#fallbackPolicy(): "loop" | "pause" {
		return this.#host.settings.get("conductor.fallback") === "pause" ? "pause" : "loop";
	}

	/** @returns true when the turn should be retried. */
	async #handleTurnError(
		error: unknown,
		instance: ReviewerTransport,
		context: "verification" | "commissioning" | "epoch" = "verification",
	): Promise<boolean> {
		// A session transition aborted this turn on purpose: never retry into the rewrite window, never surface a
		// conductor error for it — the claim is re-armed when the transition releases.
		if (this.#transitionDepth > 0) return false;
		const quotaNotice =
			context === "commissioning"
				? "Conductor quota exhausted — no contract was drafted. Run /goal to set an objective manually."
				: context === "epoch"
					? "Conductor quota exhausted — epoch steering is paused; the contract template keeps driving."
					: "Conductor quota exhausted — the pending completion cannot be verified. Run /goal resume to continue manually.";
		const strandedNotice =
			context === "commissioning"
				? "No contract was created — run /conduct <rough ask> again, or /goal to set an objective manually."
				: context === "epoch"
					? "Epoch steering is paused; the contract template keeps driving the stretch."
					: "The goal stays pending verification — run /goal resume to continue manually.";
		const controller = new AbortController();
		let recovered = false;
		try {
			recovered = await instance.recoverTurn(error, instance.agent.state.messages, controller.signal);
		} catch (recoveryError) {
			logger.debug("conductor turn recovery threw", { err: String(recoveryError) });
		}
		if (recovered) return true;

		const errorId = AIError.classify(error, instance.agent.state.model.api);
		if (AIError.is(errorId, AIError.Flag.UsageLimit)) {
			this.#status = "quota_exhausted";
			this.#host.emitNotice("warning", quotaNotice, "conductor");
			if (context === "verification") {
				this.#clearGateTimer();
				this.#startWhenIdle = false;
			}
			return false;
		}
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) {
			if (context === "verification") this.#startWhenIdle = true;
			return false;
		}
		this.#status = "error";
		const message = error instanceof Error ? error.message : String(error);
		this.#host.emitNotice(
			"warning",
			`Conductor unavailable for ${formatModelString(instance.agent.state.model)}: ${message}. ${strandedNotice}`,
			"conductor",
		);
		if (context === "verification") {
			this.#clearGateTimer();
			this.#startWhenIdle = false;
		}
		return false;
	}

	async #applyRuling(goal: Goal, ruling: ConductorGateRuling): Promise<void> {
		// The audit graded a snapshot; the claim it pended may have been paused, re-pended, or replaced while the
		// turn was in flight. A ruling may only resolve the exact pend it audited — anything else is stale and
		// discarded (the gate re-arms for the current claim when the turn settles).
		const current = this.#host.currentGoal();
		if (
			!current ||
			current.id !== goal.id ||
			current.updatedAt !== goal.updatedAt ||
			current.status !== "verifying"
		) {
			logger.debug("conductor discarded a stale ruling; the pended claim changed during the audit", {
				auditedGoalId: goal.id,
				currentGoalId: current?.id,
			});
			return;
		}
		this.#clearGateTimer();
		const runtime = this.#host.goalRuntime();
		if (!runtime) return;

		if (ruling.op === "escalate") {
			this.#escalate(ruling.question);
			return;
		}

		if (ruling.verdict === "accept") {
			try {
				await runtime.acceptCompletion(goal.updatedAt);
			} catch (error) {
				logger.warn("conductor accept failed", { err: String(error) });
				return;
			}
			this.#clearGate();
			this.#rejectionCount = 0;
			this.#host.emitNotice("info", "Conductor verified the completion claim.", "conductor");
			return;
		}

		// The ruling that would reach the cap becomes a forced escalation instead of another round trip, so a
		// soloist/conductor disagreement loop cannot burn the goal's budget.
		const maxRejections = this.#maxRejections();
		if (maxRejections > 0 && this.#rejectionCount + 1 >= maxRejections) {
			this.#escalate(
				`${this.#rejectionCount + 1} consecutive verification rejections. Latest discrepancies: ${ruling.evidence}`,
			);
			return;
		}

		try {
			await runtime.rejectCompletion(goal.updatedAt);
		} catch (error) {
			logger.warn("conductor reject failed", { err: String(error) });
			return;
		}
		this.#rejectionCount++;
		this.#startWhenIdle = false;
		this.#pendingGoalId = undefined;
		this.#pendingGoalUpdatedAt = undefined;

		// `deliverAs` only matters while the primary is streaming; verification always runs at a settled turn
		// boundary, so this lands on the idle branch and drives one fresh turn. That turn's `agent_end` is what
		// re-arms the goal's own continuation — seeding context without a turn would strand the goal, because
		// `goal_updated` deliberately never arms the continuation timer.
		await this.#host
			.sendCustomMessage(
				{
					customType: CONDUCTOR_VERIFICATION_MESSAGE_TYPE,
					content: formatRejectionContent(ruling.evidence),
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "steer", triggerTurn: true },
			)
			.catch(error => logger.debug("conductor rejection delivery failed", { err: String(error) }));
	}

	#maxRejections(): number {
		const configured = this.#host.settings.get("conductor.maxRejections") as number;
		if (!Number.isFinite(configured) || configured <= 0) return 0;
		return Math.trunc(configured);
	}

	// ---------------------------------------------------------------- construction

	async #ensureInstance(mode: ConductorTurnMode): Promise<ReviewerTransport | undefined> {
		// Commissioning and verification need different personas, different tools, and different single-shot tools,
		// and they are mutually exclusive in time, so one slot is rebuilt rather than two kept alive.
		if (this.#instance && this.#instanceMode !== mode) this.#disposeInstance();
		if (this.#instance) return this.#instance;
		this.#buildPromise ??= this.#buildInstance(mode).finally(() => {
			this.#buildPromise = undefined;
		});
		return await this.#buildPromise;
	}

	async #buildInstance(mode: ConductorTurnMode): Promise<ReviewerTransport | undefined> {
		if (!this.#enabled || this.#host.isDisposed()) return undefined;
		const selection = this.#resolveModelSelection();
		if (!selection) {
			this.#status = "no_model";
			logger.debug("conductor enabled but no model assigned to the 'conductor' role; conductor inactive");
			return undefined;
		}

		let toolPool: AgentTool[] | undefined;
		try {
			this.#toolsPromise ??= this.#options.toolsFactory?.();
			toolPool = await this.#toolsPromise;
		} catch (error) {
			logger.warn("conductor tool pool build failed", { err: String(error) });
		}
		if (this.#host.isDisposed()) return undefined;

		const model = selection.model;
		const requestedLevel = selection.thinkingLevel ?? ThinkingLevel.High;
		const thinkingLevel = resolveThinkingLevelForModel(model, requestedLevel) ?? ThinkingLevel.Inherit;

		const identity: ReviewerIdentity = {
			role: "conductor",
			name: "Conductor",
			slug: "",

			sessionLabelSuffix: "conductor",
			transcriptFilename: CONDUCTOR_TRANSCRIPT_FILENAME,
			telemetryName: MODEL_ROLES.conductor.name,
			noticeLabel: "Conductor",
		};

		// Each turn kind gets its own single-shot channel; the other tool is never even constructed, so a
		// commissioning turn cannot rule on a verdict and a verification/epoch turn cannot rewrite the contract.
		const commissioning = mode === "commission";
		// Verification keeps unrestricted bash (prompt-enforced verification whitelist); commissioning and epoch
		// turns get the exploratory read-only allowlist the bash tool itself enforces.
		this.#options.setBashCommandAllowlist?.(mode === "verify" ? undefined : READ_ONLY_EXPLORATORY_COMMANDS);
		let cueTool: CueTool | undefined;
		let programTool: ProgramTool | undefined;
		let adviseTool: AgentTool<any>;
		if (commissioning) {
			programTool = new ProgramTool(proposal => {
				this.#proposal = proposal;
			});
			adviseTool = programTool;
		} else {
			cueTool = new CueTool(ruling => {
				if (mode === "epoch") this.#epochRuling = ruling;
				else this.#ruling = ruling;
			});
			adviseTool = cueTool;
		}

		const systemPrompt = [
			commissioning
				? conductorCommissionSystemPrompt
				: mode === "epoch"
					? conductorEpochSystemPrompt
					: conductorSystemPrompt,
		];
		if (this.#options.contextPrompt) systemPrompt.push(this.#options.contextPrompt);

		let facade: { prompt(input: string): Promise<void>; reset(): void } | undefined;
		const transport = new ReviewerTransport(this.#host, {
			identity,
			model,
			thinkingLevel,
			signature: `conductor-${mode}\u001f${formatModelString(model)}\u001f${thinkingLevel}`,
			systemPrompt,

			adviseTool,
			toolNames: [...(commissioning ? CONDUCTOR_COMMISSION_TOOL_NAMES : CONDUCTOR_TOOL_NAMES)],
			toolPool,
			getToolContext: this.#options.getToolContext,
			mcpResources: this.#options.mcpResources,

			generatedTextExtractor: extractConductorGeneratedText,
			quarantinePrefix: CONDUCTOR_QUARANTINE_PREFIX,

			// Its own map: the conductor's slug is "" like the legacy advisor's, so sharing the advisor map would
			// collide on the key and hand both reviewers the same provider session id.
			providerSessionIds: this.#providerSessionIds,
			resolveProviderSessionId: getOrCreateAdvisorProviderSessionId,
			streamFn: this.#options.streamFn,
			transformProviderContext: this.#options.transformProviderContext,
			serviceTierResolver: candidate => this.#host.effectiveServiceTier(candidate),

			recorderClosed: this.#recorderClosed,

			createRuntime: agentFacade => {
				facade = agentFacade;
				// The conductor does not consume transcript deltas in this slice; this runtime exists for the
				// transport's lifecycle contract (dispose/reset/quota state), never for its backlog drain.
				return new ReviewerRuntime(agentFacade, {
					snapshotMessages: () => [],
					obfuscator: this.#host.obfuscator,
					getModelIdentity: () => formatModelString(transport.agent.state.model),
				});
			},
		});

		this.#instance = transport;
		this.#instanceMode = mode;
		this.#facade = facade;
		this.#cueTool = cueTool;
		this.#programTool = programTool;
		this.#status = "running";
		this.#attachRecorderFeed();
		return transport;
	}

	#attachRecorderFeed(): void {
		const instance = this.#instance;
		if (!instance || instance.agentUnsubscribe) return;
		instance.agentUnsubscribe = instance.agent.subscribe(event => {
			this.#observeActivityEvent(event);
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant") {
				this.#cost += (event.message as AssistantMessage).usage.cost.total;
			}
			instance.recorder.record(event.message);
		});
	}

	// ---------------------------------------------------------------- streaming display

	/** Starts a fresh activity snapshot and emits it immediately; the subscription keeps it updated from here. */
	#beginActivity(mode: ConductorTurnMode, label: string): void {
		const model = this.#instance?.agent.state.model;
		const progress: AgentProgress = {
			index: 0,
			id: CONDUCTOR_PROGRESS_ID,
			agent: "conductor",
			agentSource: "bundled",
			status: "running",
			task: label,
			description: label,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
			// Role id, not display name: the fleet resolves badges through `getRoleInfo(role)`, keyed by id.
			modelRole: "conductor",
			resolvedModel: model ? formatModelString(model) : undefined,
		};
		this.#activity = {
			mode,
			status: "running",
			label,
			sessionFile: conductorTranscriptPath(this.#host.sessionManager.getSessionFile()),
			startedAt: Date.now(),
			progress,
		};
		this.#activityOutputTail = "";
		this.#flushActivity();
	}

	/** Mutates the in-flight activity from raw agent events; emits on tool boundaries, coalesces text deltas. */
	#observeActivityEvent(event: AgentEvent): void {
		const activity = this.#activity;
		if (!activity) return;
		const progress = activity.progress;
		switch (event.type) {
			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = conductorToolArgsPreview(isRecord(event.args) ? event.args : {});
				progress.currentToolStartMs = Date.now();
				const intent = event.intent?.trim();
				if (intent) progress.lastIntent = intent;
				this.#flushActivity();
				break;
			}
			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs ?? "",
						endMs: Date.now(),
					});
					if (progress.recentTools.length > 5) progress.recentTools.pop();
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;
				this.#flushActivity();
				break;
			}
			case "message_update": {
				if (event.message.role !== "assistant") break;
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta" && typeof delta.delta === "string") {
					this.#activityOutputTail = `${this.#activityOutputTail}${delta.delta}`.slice(-2048);
					this.#scheduleActivityEmit();
				}
				break;
			}
			case "message_end": {
				if (event.message.role !== "assistant") break;
				const message = event.message as AssistantMessage;
				progress.requests++;
				progress.tokens += message.usage.input + message.usage.output + message.usage.cacheWrite;
				if (message.usage.totalTokens > 0) progress.contextTokens = message.usage.totalTokens;
				progress.cost += message.usage.cost.total;
				this.#flushActivity();
				break;
			}
			default:
				break;
		}
	}

	/** Emits an activity snapshot now: fresh duration, materialized output tail, defensive copies. */
	#flushActivity(explicit?: ConductorActivity): void {
		this.#cancelActivityEmitTimer();
		const activity = explicit ?? this.#activity;
		if (!activity) return;
		activity.progress.durationMs = Date.now() - activity.startedAt;
		activity.progress.recentOutput = this.#activityOutputTail
			.split("\n")
			.filter(line => line.trim())
			.slice(-8)
			.reverse();
		this.#lastActivityEmitMs = Date.now();
		this.#host.emitConductorActivity?.({
			...activity,
			progress: { ...activity.progress, recentTools: [...activity.progress.recentTools] },
		});
	}

	/** Coalesces text-delta-driven emissions so streaming cannot flood the host. */
	#scheduleActivityEmit(): void {
		if (!this.#activity || this.#activityEmitTimer) return;
		const delay = Math.max(0, ACTIVITY_EMIT_COALESCE_MS - (Date.now() - this.#lastActivityEmitMs));
		this.#activityEmitTimer = setTimeout(() => {
			this.#activityEmitTimer = undefined;
			this.#flushActivity();
		}, delay);
		this.#activityEmitTimer.unref?.();
	}

	#cancelActivityEmitTimer(): void {
		if (!this.#activityEmitTimer) return;
		clearTimeout(this.#activityEmitTimer);
		this.#activityEmitTimer = undefined;
	}

	/** Stamps the terminal status, emits the final snapshot, and closes the run. */
	#endActivity(status: ConductorActivity["status"]): void {
		const activity = this.#activity;
		if (!activity) return;
		this.#activity = undefined;
		this.#activityOutputTail = "";
		activity.status = status;
		activity.progress.status = status;
		activity.progress.currentTool = undefined;
		activity.progress.currentToolArgs = undefined;
		activity.progress.currentToolStartMs = undefined;
		// Pass the closed snapshot explicitly: the slot is already cleared, and the terminal emit must go out.
		this.#flushActivity(activity);
	}

	// ---------------------------------------------------------------- lifecycle

	stopRuntime(): void {
		this.#clearGate();
		this.#verificationInFlight = false;
		this.#ruling = undefined;
		this.#proposal = undefined;
		this.#epochRuling = undefined;
		this.#disposeInstance();
	}

	/**
	 * Drops the transport without touching gate state. Swapping the slot between turn kinds must never disarm a
	 * verdict that is already pending — only {@link stopRuntime} owns the gate.
	 */
	#disposeInstance(): void {
		this.#options.setBashCommandAllowlist?.(undefined);
		const instance = this.#instance;
		this.#instance = undefined;
		this.#instanceMode = undefined;
		this.#facade = undefined;
		this.#cueTool = undefined;
		this.#programTool = undefined;
		if (!instance) return;
		instance.agentUnsubscribe?.();
		instance.agentUnsubscribe = undefined;
		instance.runtime.dispose();
		instance.recorderClosed = instance.recorder.close();
		this.#recorderClosed = instance.recorderClosed;
	}

	recorderClosed(): Promise<void> {
		return this.#recorderClosed;
	}

	async drainAndDetachRecorders(): Promise<void> {
		await this.#instance?.runtime.pauseForSessionTransition();
		await this.detachAndCloseRecorders();
	}

	async detachAndCloseRecorders(): Promise<void> {
		const instance = this.#instance;
		if (!instance) return;
		instance.agentUnsubscribe?.();
		instance.agentUnsubscribe = undefined;
		instance.recorderClosed = instance.recorder.close();
		this.#recorderClosed = instance.recorderClosed;
		await instance.recorderClosed;
	}

	reattachRecorderFeeds(): void {
		const instance = this.#instance;
		if (!instance) return;
		this.#attachRecorderFeed();
		instance.runtime.resumeAfterSessionTransition();
	}

	/**
	 * Suspension bracket across a main-session persistence transition (compaction, fork, branch, session
	 * switch). Aborts any in-flight turn, drains and detaches the recorder, and blocks new verification,
	 * commissioning, and gate arming until {@link resumeFromTransition} — a verdict delivered or a turn restarted
	 * mid-transition would stream into a conversation that is being rewritten and damage the transcript. Nests:
	 * transitions can overlap (auto-compaction inside recovery compaction), so the depth counts.
	 */
	async suspendForTransition(): Promise<void> {
		this.#transitionDepth++;
		this.#clearGateTimer();
		await this.drainAndDetachRecorders();
	}

	/** Releases one suspension; the last one reattaches the recorder feed and re-arms a still-pended claim. */
	resumeFromTransition(): void {
		if (this.#transitionDepth === 0) return;
		this.#transitionDepth--;
		if (this.#transitionDepth > 0) return;
		this.reattachRecorderFeeds();
		// The transition rewrote or replaced the conversation: a claim still pended must be audited against the
		// post-transition state, and the idle watchdog must re-arm for it.
		this.#rearmPendedVerification();
		this.#syncGateTimer();
	}

	/** A transcript rewrite invalidates any pending verdict: the claim it was grading no longer exists. */
	resetSessionState(options: { preserveCost?: boolean } = {}): void {
		if (options.preserveCost !== true) this.#cost = 0;
		this.#clearGate();
		this.#rejectionCount = 0;
		this.#escalated = false;
		this.#ruling = undefined;
		this.#proposal = undefined;
		this.#epochRuling = undefined;
		// The conversation was rewritten or replaced: the digest cursor is meaningless and the cadence restarts.
		// Journal history and the epoch count survive — they are session-level record, not cadence state.
		this.#digestCursor = 0;
		this.#resetEpochCadence();
		// The pending verdict was invalidated with the conversation boundary; if the goal is still pended, re-arm
		// the gate so the claim is audited again instead of stranding.
		this.#rearmPendedVerification();
		const instance = this.#instance;
		if (!instance) return;
		instance.resetForConversationBoundary();
		this.#attachRecorderFeed();
	}

	resetAllRuntimes(reason?: string): void {
		this.#instance?.runtime.reset(reason);
	}

	/** Drop a built conductor whose model no longer matches the `conductor` role; the next gate rebuilds it. */
	onModelRolesChanged(): void {
		if (!this.#enabled || this.#host.isDisposed()) return;
		const selection = this.#resolveModelSelection();
		if (!selection) {
			this.stopRuntime();
			this.#status = "no_model";
			return;
		}
		const current = this.#instance?.agent.state.model;
		if (current && formatModelString(current) !== formatModelString(selection.model)) this.stopRuntime();
		if (this.#status === "no_model") this.#status = "running";
		// A swap mid-verification drops the pended claim with the old slot; re-arm it under the new model.
		this.#rearmPendedVerification();
	}

	refreshProviderIdentity(): void {
		const instance = this.#instance;
		if (!instance) return;
		const primaryProviderSessionId = this.#host.sessionId();
		if (!primaryProviderSessionId) return;
		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			this.#providerSessionIds,
			primaryProviderSessionId,
			"",
		);
		if (!providerSessionId) return;
		instance.providerSessionId = providerSessionId;
		instance.agent.sessionId = providerSessionId;
		instance.agent.promptCacheKey = this.#host.agent.promptCacheKey ?? providerSessionId;
		instance.agent.getApiKey = requestModel => this.#host.modelRegistry.resolver(requestModel, providerSessionId);
		const telemetry = instance.agent.telemetry;
		if (telemetry?.agent) {
			instance.agent.setTelemetry({
				...telemetry,
				agent: { ...telemetry.agent, id: `${primaryProviderSessionId}-conductor` },
			});
		}
	}

	clearCost(): void {
		this.#cost = 0;
	}

	/** Replaces the accumulated spend; session switches restore it from the conductor transcript. */
	restoreCost(cost: number): void {
		this.#cost = cost;
	}

	/** Replaces the decision journal; session switches restore it from the conductor transcript. */
	restoreJournal(entries: ConductorJournalEntry[]): void {
		this.#journal = entries.slice(-JOURNAL_LIMIT);
		this.#epochCount = Math.max(this.#epochCount, entries.length);
	}

	getJournal(): readonly ConductorJournalEntry[] {
		return this.#journal;
	}

	// ---------------------------------------------------------------- command surface

	setEnabled(enabled: boolean): boolean {
		this.#enabled = enabled;
		if (!enabled) {
			this.stopRuntime();
			this.#escalated = false;
			this.#rejectionCount = 0;
			this.#status = "off";
			return false;
		}
		// `/conduct on` doubles as the rebuild hatch: it clears a halted conductor's escalation and its
		// consecutive-rejection streak so the next completion claim is verified again.
		this.#escalated = false;
		this.#rejectionCount = 0;
		this.#rejectionGoalId = undefined;
		this.#status = this.#resolveModelSelection() ? "running" : "no_model";
		// A claim pended before the conductor was halted or disabled is still waiting; re-arm it so the promise in
		// the escalation notice holds. Parks rooted in quota/error clear here too — re-enabling is the retry.
		this.#rearmPendedVerification();
		return this.#status === "running";
	}

	toggleEnabled(): boolean {
		return this.setEnabled(!this.#enabled);
	}

	getCost(): number {
		return this.#cost;
	}

	getAgent(): Agent | undefined {
		return this.#instance?.agent;
	}

	getStats(): ConductorStats {
		const live = this.#instance;
		const status: ConductorStatus = !this.#enabled
			? "off"
			: live?.runtime.quotaExhausted
				? "quota_exhausted"
				: this.#status;
		return {
			configured: this.#enabled,
			active: live !== undefined,
			status,
			model: live?.agent.state.model ?? this.#resolveModelSelection()?.model,
			pendingGoalId: this.#pendingGoalId,
			commissioning: this.#commissioningInFlight,
			rejections: this.#rejectionCount,
			escalated: this.#escalated,
			cost: this.#cost,
			epochCount: this.#epochCount,
			droppedEpochs: this.#droppedEpochs,
			epochsHalted: this.#epochsHalted,
		};
	}

	formatStatus(): string {
		const stats = this.getStats();
		if (!stats.configured) return "Conductor is disabled.";
		if (!stats.model) {
			return "Conductor setting is enabled, but no model is assigned to the 'conductor' role.";
		}
		const parts = [`Conductor is enabled (${stats.model.provider}/${stats.model.id}).`];
		if (stats.status !== "running") parts.push(`Status: ${stats.status.replace("_", " ")}.`);
		if (stats.commissioning) parts.push("Commissioning: in progress.");
		parts.push(stats.pendingGoalId ? "Verification: pending." : "Verification: idle.");
		if (stats.rejections > 0) parts.push(`Rejections: ${stats.rejections}.`);
		if (stats.escalated) parts.push("Escalated — /goal resume to continue manually.");
		if (stats.epochsHalted) {
			parts.push("Epoch steering halted after repeated drops — /conduct on re-arms it.");
		} else if (stats.epochCount > 0 || stats.droppedEpochs > 0) {
			parts.push(`Epochs: ${stats.epochCount} ruled, ${stats.droppedEpochs} dropped.`);
		}
		parts.push(`Spend: $${stats.cost.toFixed(4)}.`);
		const journal = this.formatJournal(3);
		return journal ? `${parts.join(" ")}\n${journal}` : parts.join(" ");
	}

	/** Renders the decision journal tail: one line per recent epoch ruling. */
	formatJournal(limit = 10): string {
		return this.#journal
			.slice(-limit)
			.map(entry => {
				const action =
					entry.action === "prompt"
						? `prompt: ${entry.promptHeadline ?? ""}`
						: entry.action === "deduped"
							? "prompt deduped (already standing)"
							: "template continuation";
				const context = entry.context === "compact" ? ", context compacted" : "";
				const note = entry.note ? ` — ${entry.note}` : "";
				return `epoch ${entry.epoch}: ${action}${context}${note}`;
			})
			.join("\n");
	}
}
