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
import conductorSystemPrompt from "../prompts/conductor/system.md" with { type: "text" };
import conductorVerifyPrompt from "../prompts/conductor/verify.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { CustomMessagePayload } from "../session/messages";
import { type ReviewerIdentity, ReviewerTransport, type ReviewerTransportHost } from "../session/reviewer-transport";
import { resolveThinkingLevelForModel } from "../thinking";
import { type ConductorRuling, CueTool } from "./cue-tool";
import { CONDUCTOR_TRANSCRIPT_FILENAME } from "./transcript";

/**
 * Investigative grant. `bash` is included because this slice only ever runs verification turns, where the
 * objective's "## Verification" commands are the whitelist (prompt-enforced in v0). No mutating grants, ever.
 */
export const CONDUCTOR_TOOL_NAMES: readonly string[] = ["read", "grep", "glob", "bash"];

export type ConductorStatus = AdvisorRuntimeStatus | "off";

/** Attempts per verification turn: the first try plus two retries on retriable failures. */
const MAX_VERIFICATION_ATTEMPTS = 3;

const CONDUCTOR_QUARANTINE_PREFIX = "Conductor response quarantined";

const extractCueGeneratedText: ReviewerGeneratedTextExtractor = call => {
	if (call.name !== "cue") return [];
	const parts: string[] = [];
	if (typeof call.arguments.evidence === "string") parts.push(call.arguments.evidence);
	if (typeof call.arguments.question === "string") parts.push(call.arguments.question);
	return parts;
};

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
	createEditTool?(): AgentTool | undefined;
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
	rejections: number;
	escalated: boolean;
	cost: number;
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
 * Verification-only conductor (build-order step 3). Owns one {@link ReviewerTransport} on the `conductor` model
 * role, the `cue` tool, and the completion gate. Every path is inert unless `conductor.enabled` is on.
 */
export class SessionConductor {
	readonly #host: ConductorHost;
	readonly #options: SessionConductorOptions;

	#enabled: boolean;
	#status: ConductorStatus = "off";
	#instance: ReviewerTransport | undefined;
	#facade: { prompt(input: string): Promise<void>; reset(): void } | undefined;
	#cueTool: CueTool | undefined;
	#toolsPromise: Promise<AgentTool[]> | undefined;
	#buildPromise: Promise<ReviewerTransport | undefined> | undefined;

	readonly #providerSessionIds = new Map<string, string>();
	#recorderClosed: Promise<void> = Promise.resolve();
	#cost = 0;

	#pendingGoalId: string | undefined;
	#rejectionGoalId: string | undefined;
	#rejectionCount = 0;
	#gateTimer: NodeJS.Timeout | undefined;
	#startWhenIdle = false;
	#verificationInFlight = false;
	#escalated = false;
	#ruling: ConductorRuling | undefined;

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
		if (this.#pendingGoalId === goal.id && (this.#startWhenIdle || this.#verificationInFlight)) return;
		this.#pendingGoalId = goal.id;
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

	#armGate(): void {
		this.#clearGateTimer();
		const seconds = this.#host.settings.get("conductor.gateTimeoutSeconds") as number;
		const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds) * 1000 : 300_000;
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
		this.#startWhenIdle = false;
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
		if (!this.#startWhenIdle || this.#verificationInFlight || this.#escalated) return;
		if (this.#host.isDisposed()) return;
		const goal = this.#host.currentGoal();
		if (goal?.status !== "verifying" || goal.id !== this.#pendingGoalId) return;
		this.#startWhenIdle = false;
		this.#verificationInFlight = true;
		void this.#runVerification(goal)
			.catch(error => logger.warn("conductor verification failed", { err: String(error) }))
			.finally(() => {
				this.#verificationInFlight = false;
			});
	}

	async #runVerification(goal: Goal): Promise<void> {
		const instance = await this.#ensureInstance();
		const facade = this.#facade;
		const cueTool = this.#cueTool;
		if (!instance || !facade || !cueTool) {
			this.#escalate("The conductor could not be started, so no verdict is available.");
			return;
		}

		const promptText = renderVerifyPrompt(goal);
		let ruling: ConductorRuling | undefined;
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
			logger.debug("conductor verification turn produced no ruling; retrying");
		}

		if (!ruling) {
			this.#escalate("The conductor returned no verdict after repeated attempts.");
			return;
		}
		await this.#applyRuling(ruling);
	}

	/** @returns true when the turn should be retried. */
	async #handleTurnError(error: unknown, instance: ReviewerTransport): Promise<boolean> {
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
			this.#host.emitNotice(
				"warning",
				"Conductor quota exhausted — the pending completion cannot be verified. Run /goal resume to continue manually.",
				"conductor",
			);
			this.#clearGateTimer();
			this.#startWhenIdle = false;
			return false;
		}
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) {
			this.#startWhenIdle = true;
			return false;
		}
		this.#status = "error";
		const message = error instanceof Error ? error.message : String(error);
		this.#host.emitNotice(
			"warning",
			`Conductor unavailable for ${formatModelString(instance.agent.state.model)}: ${message}. The goal stays pending verification — run /goal resume to continue manually.`,
			"conductor",
		);
		this.#clearGateTimer();
		this.#startWhenIdle = false;
		return false;
	}

	async #applyRuling(ruling: ConductorRuling): Promise<void> {
		this.#clearGateTimer();
		const runtime = this.#host.goalRuntime();
		if (!runtime) return;

		if (ruling.op === "escalate") {
			this.#escalate(ruling.question);
			return;
		}

		if (ruling.verdict === "accept") {
			try {
				await runtime.acceptCompletion();
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
			await runtime.rejectCompletion();
		} catch (error) {
			logger.warn("conductor reject failed", { err: String(error) });
			return;
		}
		this.#rejectionCount++;
		this.#startWhenIdle = false;
		this.#pendingGoalId = undefined;

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

	async #ensureInstance(): Promise<ReviewerTransport | undefined> {
		if (this.#instance) return this.#instance;
		this.#buildPromise ??= this.#buildInstance().finally(() => {
			this.#buildPromise = undefined;
		});
		return await this.#buildPromise;
	}

	async #buildInstance(): Promise<ReviewerTransport | undefined> {
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

		const cueTool = new CueTool(ruling => {
			this.#ruling = ruling;
		});

		const systemPrompt = [conductorSystemPrompt];
		if (this.#options.contextPrompt) systemPrompt.push(this.#options.contextPrompt);

		let facade: { prompt(input: string): Promise<void>; reset(): void } | undefined;
		const transport = new ReviewerTransport(this.#host, {
			identity,
			model,
			thinkingLevel,
			signature: `conductor\u001f${formatModelString(model)}\u001f${thinkingLevel}`,
			systemPrompt,

			adviseTool: cueTool,
			toolNames: [...CONDUCTOR_TOOL_NAMES],
			toolPool,
			createEditTool: this.#options.createEditTool,
			getToolContext: this.#options.getToolContext,
			mcpResources: this.#options.mcpResources,

			generatedTextExtractor: extractCueGeneratedText,
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
		this.#facade = facade;
		this.#cueTool = cueTool;
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
		const instance = this.#instance;
		this.#clearGate();
		this.#verificationInFlight = false;
		this.#ruling = undefined;
		this.#instance = undefined;
		this.#facade = undefined;
		this.#cueTool = undefined;
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
		parts.push(stats.pendingGoalId ? "Verification: pending." : "Verification: idle.");
		if (stats.rejections > 0) parts.push(`Rejections: ${stats.rejections}.`);
		if (stats.escalated) parts.push("Escalated — /goal resume to continue manually.");
		parts.push(`Spend: $${stats.cost.toFixed(4)}.`);
		return parts.join(" ");
	}
}
