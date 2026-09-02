import type { Agent, AgentTool, AgentToolContext, StreamFn } from "@oh-my-pi/pi-agent-core";
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
import conductorSystemPrompt from "../prompts/conductor/system.md" with { type: "text" };
import conductorVerifyPrompt from "../prompts/conductor/verify.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { CustomMessagePayload } from "../session/messages";
import { type ReviewerIdentity, ReviewerTransport, type ReviewerTransportHost } from "../session/reviewer-transport";
import { resolveThinkingLevelForModel } from "../thinking";
import { type ConductorRuling, CueTool } from "./cue-tool";
import { type ConductorProposal, ProgramTool } from "./program-tool";
import { CONDUCTOR_TRANSCRIPT_FILENAME } from "./transcript";

/**
 * Investigative grant for a verification turn. `bash` is included because the objective's "## Verification"
 * commands are the whitelist there (prompt-enforced in v0). No mutating grants, ever.
 */
export const CONDUCTOR_TOOL_NAMES: readonly string[] = ["read", "bash"];

/**
 * Commissioning is strictly read-only: the contract has to be reproducible by the working agent and the auditor,
 * so nothing the commissioner could only learn by executing may enter it.
 */
export const CONDUCTOR_COMMISSION_TOOL_NAMES: readonly string[] = ["read"];

export type ConductorStatus = AdvisorRuntimeStatus | "off";

/** Which turn the single transport slot is currently built for; the two are mutually exclusive by design. */
type ConductorTurnMode = "verify" | "commission";

/** Attempts per verification turn: the first try plus two retries on retriable failures. */
const MAX_VERIFICATION_ATTEMPTS = 3;

/** Commissioning gets the same bounded retry budget as verification. */
const MAX_COMMISSIONING_ATTEMPTS = 3;

const CONDUCTOR_QUARANTINE_PREFIX = "Conductor response quarantined";

const extractConductorGeneratedText: ReviewerGeneratedTextExtractor = call => {
	if (call.name === "program") {
		return typeof call.arguments.objective === "string" ? [call.arguments.objective] : [];
	}
	if (call.name !== "cue") return [];
	const parts: string[] = [];
	if (typeof call.arguments.evidence === "string") parts.push(call.arguments.evidence);
	if (typeof call.arguments.question === "string") parts.push(call.arguments.question);
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

export interface ConductorMessageDeliveryOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface ConductorHost extends ReviewerTransportHost {
	obfuscator: SecretObfuscator | undefined;
	isDisposed(): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	sendCustomMessage(message: CustomMessagePayload, options?: ConductorMessageDeliveryOptions): Promise<boolean>;
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	goalRuntime(): GoalRuntime | undefined;
	currentGoal(): Goal | undefined;
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
}

/**
 * Result of one commissioning turn. Nothing is persisted by any of these outcomes — the contract only becomes a
 * goal when the host creates it through the `/goal set` machinery, so every non-`proposed` outcome is inert.
 */
export type ConductorCommissionOutcome =
	| { status: "proposed"; objective: string; tokenBudget?: number }
	| { status: "busy"; reason: string }
	| { status: "unavailable"; reason: string }
	| { status: "timeout" }
	| { status: "failed"; reason: string };

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
	#facade: { prompt(input: string): Promise<void>; reset(): void } | undefined;
	#cueTool: CueTool | undefined;
	#programTool: ProgramTool | undefined;
	#toolsPromise: Promise<AgentTool[]> | undefined;
	#buildPromise: Promise<ReviewerTransport | undefined> | undefined;

	readonly #providerSessionIds = new Map<string, string>();
	#recorderClosed: Promise<void> = Promise.resolve();
	#cost = 0;

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
	#proposal: ConductorProposal | undefined;

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
	 * Wake condition. The gate timer is armed the moment the goal pends — the user-visible clock starts when the
	 * primary hands off, so a primary that never yields cannot silently extend the gate.
	 */
	onGoalUpdated(goal: Goal | null): void {
		if (!this.#enabled) return;
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
		this.#armGate();
		this.#startWhenIdle = true;
		if (!this.#host.agent.state.isStreaming) this.#startVerification();
	}

	/**
	 * The verification turn starts at the first settled primary turn end after the pend, never mid-turn: the
	 * conductor audits current repo state, and reading files while the primary still has edits in flight would
	 * race the very state it is grading.
	 */
	onPrimaryTurnEnd(willContinue: boolean | undefined): void {
		if (!this.#enabled || willContinue === true) return;
		this.#startVerification();
	}

	/** One clock for both bounded waits: the verification gate and the commissioning turn. */
	#gateTimeoutMs(): number {
		const seconds = this.#host.settings.get("conductor.gateTimeoutSeconds") as number;
		return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds) * 1000 : 300_000;
	}

	#armGate(): void {
		this.#clearGateTimer();
		const timeoutMs = this.#gateTimeoutMs();
		this.#gateTimer = setTimeout(() => {
			this.#gateTimer = undefined;
			this.#escalate("Verification gate timed out before a verdict was returned.");
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
	 * Restores gate tracking for a goal whose completion is still pended. Called when the conductor (re)gains the
	 * ability to verify — `/conduct on` after an escalation or `/conduct off`, a conductor model-role change, a
	 * conversation boundary reset, or a verification turn settling over a re-pend. Without this the claim strands:
	 * `#pendCompletion` refuses a second pend, and no `goal_updated` fires to re-arm the gate. Deliberate parks
	 * (quota exhausted, turn error, no model) stay parked — only an explicit re-enable clears those.
	 */
	#rearmPendedVerification(): void {
		if (!this.#enabled || this.#host.isDisposed()) return;
		if (this.#verificationInFlight || this.#commissioningInFlight || this.#escalated) return;
		if (this.#status !== "running") return;
		const goal = this.#host.currentGoal();
		if (goal?.status !== "verifying") return;
		const tracked =
			this.#pendingGoalId === goal.id &&
			this.#pendingGoalUpdatedAt === goal.updatedAt &&
			this.#gateTimer !== undefined;
		this.#pendingGoalId = goal.id;
		this.#pendingGoalUpdatedAt = goal.updatedAt;
		this.#startWhenIdle = true;
		if (!tracked) this.#armGate();
		if (!this.#host.agent.state.isStreaming) this.#startVerification();
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
		// The single transport slot is built for one turn kind at a time; a commissioning turn in flight owns it.
		if (this.#commissioningInFlight) return;
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

		const promptText = renderVerifyPrompt(goal);
		let ruling: ConductorRuling | undefined;
		let lastTurn = "no assistant turn";
		for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt++) {
			if (this.#host.isDisposed()) return;
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
				return;
			}
			ruling = this.#ruling;
			this.#ruling = undefined;
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
			return;
		}
		await this.#applyRuling(goal, ruling);
	}

	// ---------------------------------------------------------------- commissioning turn

	/**
	 * Commissioning turn. Investigates the repo read-only and drafts the contract; the proposal is returned to the
	 * host, never written anywhere, so a refusal, a timeout, or a user rejection strands nothing.
	 */
	async commission(ask: string): Promise<ConductorCommissionOutcome> {
		const trimmed = ask.trim();
		if (!trimmed) return { status: "failed", reason: "No rough ask was given." };
		if (!this.#enabled) return { status: "unavailable", reason: "Conductor is disabled." };
		if (this.#host.isDisposed()) return { status: "unavailable", reason: "The session is shutting down." };
		if (this.#commissioningInFlight) {
			return { status: "busy", reason: "A commissioning turn is already running." };
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
			// the `bash` grant that commissioning deliberately does not hold. Gate state is untouched.
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

		const promptText = renderCommissionPrompt(ask);
		// Commissioning has no pended goal to strand, so the timeout aborts the turn and reports instead of
		// escalating; the user can re-run /conduct or fall back to /goal.
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			instance.agent.abort("conductor commissioning timed out");
		}, this.#gateTimeoutMs());

		try {
			let proposal: ConductorProposal | undefined;
			let lastTurn = "no assistant turn";
			for (let attempt = 0; attempt < MAX_COMMISSIONING_ATTEMPTS; attempt++) {
				if (this.#host.isDisposed()) return { status: "unavailable", reason: "The session is shutting down." };
				this.#proposal = undefined;
				programTool.beginTurn();
				try {
					await facade.prompt(promptText);
				} catch (error) {
					if (timedOut) return { status: "timeout" };
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
				if (timedOut) return { status: "timeout" };
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
		} finally {
			clearTimeout(timer);
		}
	}

	/** @returns true when the turn should be retried. */
	async #handleTurnError(
		error: unknown,
		instance: ReviewerTransport,
		context: "verification" | "commissioning" = "verification",
	): Promise<boolean> {
		const commissioning = context === "commissioning";
		const quotaNotice = commissioning
			? "Conductor quota exhausted — no contract was drafted. Run /goal to set an objective manually."
			: "Conductor quota exhausted — the pending completion cannot be verified. Run /goal resume to continue manually.";
		const strandedNotice = commissioning
			? "No contract was created — run /conduct <rough ask> again, or /goal to set an objective manually."
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
			if (!commissioning) {
				this.#clearGateTimer();
				this.#startWhenIdle = false;
			}
			return false;
		}
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) {
			if (!commissioning) this.#startWhenIdle = true;
			return false;
		}
		this.#status = "error";
		const message = error instanceof Error ? error.message : String(error);
		this.#host.emitNotice(
			"warning",
			`Conductor unavailable for ${formatModelString(instance.agent.state.model)}: ${message}. ${strandedNotice}`,
			"conductor",
		);
		if (!commissioning) {
			this.#clearGateTimer();
			this.#startWhenIdle = false;
		}
		return false;
	}

	async #applyRuling(goal: Goal, ruling: ConductorRuling): Promise<void> {
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
		// commissioning turn cannot rule on a verdict and a verification turn cannot rewrite the contract.
		const commissioning = mode === "commission";
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
				this.#ruling = ruling;
			});
			adviseTool = cueTool;
		}

		const systemPrompt = [commissioning ? conductorCommissionSystemPrompt : conductorSystemPrompt];
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
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant") {
				this.#cost += (event.message as AssistantMessage).usage.cost.total;
			}
			instance.recorder.record(event.message);
		});
	}

	// ---------------------------------------------------------------- lifecycle

	stopRuntime(): void {
		this.#clearGate();
		this.#verificationInFlight = false;
		this.#ruling = undefined;
		this.#proposal = undefined;
		this.#disposeInstance();
	}

	/**
	 * Drops the transport without touching gate state. Swapping the slot between turn kinds must never disarm a
	 * verdict that is already pending — only {@link stopRuntime} owns the gate.
	 */
	#disposeInstance(): void {
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

	/** A transcript rewrite invalidates any pending verdict: the claim it was grading no longer exists. */
	resetSessionState(options: { preserveCost?: boolean } = {}): void {
		if (options.preserveCost !== true) this.#cost = 0;
		this.#clearGate();
		this.#rejectionCount = 0;
		this.#escalated = false;
		this.#ruling = undefined;
		this.#proposal = undefined;
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
		parts.push(`Spend: $${stats.cost.toFixed(4)}.`);
		return parts.join(" ");
	}
}
