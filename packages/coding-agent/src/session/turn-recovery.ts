import { scheduler } from "node:timers/promises";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	isSyntheticToolResultMessage,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantRetryRecovery,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Effort,
	Model,
	ModelUsageHealth,
	TextContent,
	ThinkingContent,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { extractRetryHint, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveModelOverride } from "../config/model-resolver";

import type { Settings } from "../config/settings";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import emptyStopRetryTemplate from "../prompts/system/empty-stop-retry.md" with { type: "text" };
import thinkingLoopRedirectTemplate from "../prompts/system/thinking-loop-redirect.md" with { type: "text" };
import unexpectedStopRetryTemplate from "../prompts/system/unexpected-stop-retry.md" with { type: "text" };
import { clampThinkingLevelToCeiling, modelSupportsEffortCeiling } from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type {
	InitialRetryFallbackState,
	UsageFallbackConfirmation,
	UsageFallbackConfirmer,
} from "./agent-session-types";
import { assistantTurnProducedOutput, isEmptyAssistantStop, isEmptyErrorTurn } from "./messages";
import {
	type ActiveRetryFallbackState,
	calculateRetryBackoffDelayMs,
	findRetryFallbackCandidates,
	formatRetryFallbackSelector,
	getRetryFallbackChains,
	getRetryFallbackRevertPolicy,
	parseRetryFallbackSelector,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	type RetryFallbackRevertPolicy,
	type RetryFallbackSelector,
	resolveRetryFallbackChainKey,
	type ServingModel,
	validateRetryFallbackChains,
} from "./retry-fallback-chains";
import { getLatestCompactionEntry } from "./session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";

const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;
const USAGE_PREFLIGHT_BLOCKED_PREFIX = "Usage preflight blocked:";
const STREAM_STALL_ERROR_RE = /stream stall/i;
const HTTP2_STREAM_RESET_ERROR_RE =
	/stream closed with error code\s+nghttp2_(?:internal_error|refused_stream)|nghttp2_(?:internal_error|refused_stream)|HTTP2(?:StreamReset|RefusedStream)/i;

const PREMATURE_STREAM_CLOSE_ERROR_RE = /stream closed before a (?:finish_reason|terminal response event)/i;
const IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN =
	/messages\.\d+\.content\.\d+.*\b(?:thinking|redacted_thinking)\b.*\blatest assistant message cannot be modified\b/is;

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

export interface RecoveryCompactionResult {
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}

export interface TurnRecoveryHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	configWarnings: string[];
	model(): Model | undefined;

	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean;

	textOutputCommitted(): boolean;
	thinkingLevel(): ThinkingLevel | undefined;
	configuredThinkingLevel(): ThinkingLevel | undefined;
	setThinkingLevel(level: ThinkingLevel | undefined): void;

	thinkingLevelCeiling(): Effort | undefined;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isCompacting(): boolean;
	abortInProgress(): boolean;
	streamingEditAbortTriggered(): boolean;
	promptGeneration(): number;
	sessionId(): string;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { delayMs?: number; generation?: number; onError?: (error: unknown) => void }): void;
	waitForSessionMessagePersistence(message: AssistantMessage): Promise<void>;
	appendSessionMessage(message: AssistantMessage): void;
	persistedAssistantEntryId(message: AssistantMessage): string | undefined;
	sessionMessageAlreadyPersisted(message: AssistantMessage): boolean;
	setModelWithProviderSessionReset(model: Model): Promise<void>;
	resetCurrentResponsesProviderSession(reason: string): void;

	maybeAutoRedeemCodexReset(activeBlockUnblockAtMs?: number): Promise<boolean>;
	runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		options?: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
		},
	): Promise<RecoveryCompactionResult>;
	withBashBranchTransition<T>(operation: () => T): T;
}

interface TurnRecoveryOptions {
	initialRetryFallback?: InitialRetryFallbackState;
}

type PendingRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

type UsageLimitOutcome = {
	switchedCredential: boolean;
	retryAfterMs: number;
	retryAtMs: number | undefined;
};

export class TurnRecovery {
	readonly #host: TurnRecoveryHost;
	#retryAbortController: AbortController | undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined;
	#retryResolve: (() => void) | undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined;
	#usageReserveApprovedSelector: string | undefined;
	#pendingRetryErrors: PendingRetryError[] = [];
	#usageLimitOutcomes = new WeakMap<AssistantMessage, Promise<UsageLimitOutcome>>();
	#emptyStopRetryCount = 0;
	#unexpectedStopRetryCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;

	#lastServed: { attribution: ServingModel; sessionId: string } | undefined;

	#fallbackRoutedFor: string | undefined;

	#bootstrapCache:
		| { model: Model; level: ThinkingLevel | undefined; routed: boolean; value: ServingModel }
		| undefined;

	constructor(host: TurnRecoveryHost, options: TurnRecoveryOptions = {}) {
		this.#host = host;
		if (options.initialRetryFallback) {
			this.#activeRetryFallback = {
				...options.initialRetryFallback,
				lastAppliedFallbackThinkingLevel: host.configuredThinkingLevel(),
				pinned: options.initialRetryFallback.pinned ?? false,
			};
			this.#markFallbackRouted();
		}
		this.#validateRetryFallbackChains();
	}

	get attempt(): number {
		return this.#retryAttempt;
	}

	get retryPromise(): Promise<void> | undefined {
		return this.#retryPromise;
	}

	get #fallbackRouted(): boolean {
		return (
			this.#fallbackRoutedFor !== undefined && this.#fallbackRoutedFor === this.#host.sessionManager.getSessionId()
		);
	}

	#markFallbackRouted(): void {
		this.#fallbackRoutedFor = this.#host.sessionManager.getSessionId();
	}

	get servingModel(): ServingModel | undefined {
		const served = this.#lastServed;
		if (served && served.sessionId === this.#host.sessionManager.getSessionId()) return served.attribution;
		const model = this.#host.model();
		if (!model) return undefined;

		const level = this.#host.thinkingLevel();
		const cached = this.#bootstrapCache;
		if (cached && cached.model === model && cached.level === level && cached.routed === this.#fallbackRouted) {
			return cached.value;
		}
		const value: ServingModel = {
			selector: formatRetryFallbackSelector(model, level),
			isFallback: this.#fallbackRouted,
		};
		this.#bootstrapCache = { model, level, routed: this.#fallbackRouted, value };
		return value;
	}

	reanchorServedAttribution(previousSessionId: string): void {
		const sessionId = this.#host.sessionManager.getSessionId();
		if (this.#lastServed?.sessionId === previousSessionId) {
			this.#lastServed = { ...this.#lastServed, sessionId };
		}
		if (this.#fallbackRoutedFor === previousSessionId) {
			this.#fallbackRoutedFor = sessionId;
		}
	}

	resetForNewPrompt(): void {
		this.#emptyStopRetryCount = 0;
		this.#unexpectedStopRetryCount = 0;
		this.#acceptTerminalEmptyStopForPrompt = false;
	}

	setAcceptTerminalEmptyStop(accept: boolean): void {
		this.#acceptTerminalEmptyStopForPrompt = accept;
	}

	async onAssistantSettledSuccessfully(message: AssistantMessage): Promise<void> {
		if (!assistantTurnProducedOutput(message)) {
			return;
		}
		const model = this.#host.model();
		if (model) {
			this.#lastServed = {
				attribution: {
					selector: formatRetryFallbackSelector(model, this.#host.thinkingLevel()),
					isFallback: this.#fallbackRouted,
				},
				sessionId: this.#host.sessionManager.getSessionId(),
			};
		}

		if (this.#activeRetryFallback && !this.#activeRetryFallback.served && model) {
			this.#activeRetryFallback.served = true;
			await this.#host.emitSessionEvent({
				type: "retry_fallback_succeeded",
				model:
					this.#lastServed?.attribution.selector ?? formatRetryFallbackSelector(model, this.#host.thinkingLevel()),
				role: this.#activeRetryFallback.role,
			});
		}
		if (this.#retryAttempt === 0) {
			return;
		}
		const retryErrors = await this.#markPendingRetryErrors({
			status: "recovered",
			supersedingMessage: message,
		});
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: true,
			attempt: this.#retryAttempt,
			retryErrors,
		});
		this.#clearPendingRetryErrors();
		this.#retryAttempt = 0;
	}

	async onErrorSettledWithoutRetry(message: AssistantMessage, compaction: RecoveryCompactionResult): Promise<void> {
		if (message.stopReason !== "error" || this.#retryAttempt === 0 || compaction.continuationScheduled) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: message.errorMessage,
		});
		this.#clearPendingRetryErrors();
	}

	persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		return this.#persistTerminalEmptyErrorTurn(message);
	}

	handleEmptyAssistantStop(message: AssistantMessage): Promise<"continue" | "terminal" | undefined> {
		return this.#handleEmptyAssistantStop(message);
	}

	handleUnexpectedAssistantStop(message: AssistantMessage): Promise<boolean> {
		return this.#handleUnexpectedAssistantStop(message);
	}

	dropPersistedAssistantTurn(message: AssistantMessage): Promise<string | undefined> {
		return this.#dropPersistedAssistantTurn(message);
	}

	runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		message: AssistantMessage,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<RecoveryCompactionResult> {
		return this.#runRecoveryCompactionWithRollback(reason, message, options);
	}

	maybeRestoreRetryFallbackPrimary(): Promise<boolean> {
		return this.#maybeRestoreRetryFallbackPrimary();
	}

	maybeApplyUsageAwareFallback(signal: AbortSignal, confirmer?: UsageFallbackConfirmer): Promise<boolean> {
		return this.#maybeApplyUsageAwareFallback(signal, confirmer);
	}

	handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			preserveFailedTurn?: boolean;
		},
	): Promise<boolean> {
		return this.#handleRetryableError(message, options);
	}

	async recordUsageLimitOutcome(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		const activeModel = this.#host.model();
		if (!activeModel || !AIError.is(id, AIError.Flag.UsageLimit)) return false;

		let recorded = this.#usageLimitOutcomes.get(message);
		if (!recorded) {
			const errorMessage = message.errorMessage || "Unknown error";
			const retryAfterMs =
				this.#parseRetryAfterMsFromError(errorMessage) ??
				calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			recorded = (async (): Promise<UsageLimitOutcome> => {
				const outcome = await this.#host.modelRegistry.authStorage.markUsageLimitReached(
					activeModel.provider,
					this.#host.sessionId(),
					{ retryAfterMs, baseUrl: activeModel.baseUrl, modelId: activeModel.id },
				);
				return {
					switchedCredential: outcome.switched,
					retryAfterMs,
					retryAtMs: outcome.retryAtMs,
				};
			})();
			this.#usageLimitOutcomes.set(message, recorded);
		}
		return (await recorded).switchedCredential;
	}

	promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		return this.#promptAgentWithIdleRetry(messages, options);
	}

	parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		return this.#parseRetryAfterMsFromError(errorMessage);
	}

	resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	#clearPendingRetryErrors(): void {
		this.#pendingRetryErrors = [];
	}

	async #persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		await this.#host.waitForSessionMessagePersistence(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#host.sessionMessageAlreadyPersisted(message)) return;
		this.#host.appendSessionMessage(message);
	}

	#retryRecoveryKind(
		id: number,
		switchedCredential: boolean,
		switchedModel: boolean,
		delayMs: number,
	): AssistantRetryRecoveryKind {
		if (switchedCredential) return "credential";
		if (switchedModel) return "model";
		if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
		return "plain";
	}

	#retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
		const parts: string[] = [];
		if (rateLimited) {
			parts.push("rate-limited");
		} else if (recovery === "plain") {
			parts.push("error");
		}
		if (recovery === "credential") {
			parts.push("switched account");
		} else if (recovery === "model") {
			parts.push("switched model");
		} else if (recovery === "wait") {
			parts.push("waited");
		}
		parts.push("retried");
		return parts.join("; ");
	}

	async #recordPendingRetryError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; switchedModel: boolean; delayMs: number },
	): Promise<void> {
		await this.persistTerminalEmptyErrorTurn(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		let branchEntry: SessionEntry | undefined;
		for (const entry of this.#host.sessionManager.getBranch().slice().reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
			if (!sameMessageContent(entry.message, message) && !this.#isSameAssistantMessage(entry.message, message)) {
				continue;
			}
			branchEntry = entry;
			break;
		}
		if (!branchEntry) return;
		if (this.#pendingRetryErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = this.#retryRecoveryKind(id, options.switchedCredential, options.switchedModel, options.delayMs);
		const note = this.#retryRecoveryNote(recovery, rateLimited);
		this.#pendingRetryErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#retryAttempt,
			note,
		});
	}

	async #markPendingRetryErrors(
		completion: { status: "recovered"; supersedingMessage: AssistantMessage } | { status: "superseded" },
	): Promise<RetryErrorUpdate[]> {
		if (this.#pendingRetryErrors.length === 0) return [];
		const branch = this.#host.sessionManager.getBranch();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const retryErrors: RetryErrorUpdate[] = [];
		for (const pending of this.#pendingRetryErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				entry = branch
					.slice()
					.reverse()
					.find(
						candidate =>
							candidate.type === "message" &&
							candidate.message.role === "assistant" &&
							sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
					);
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			let retryRecovery: AssistantRetryRecovery;
			if (completion.status === "recovered") {
				retryRecovery = {
					kind: "auto-retry",
					status: "recovered",
					attempt: pending.attempt,
					recoveredAt: new Date().toISOString(),
					recovery: pending.recovery,
					note: pending.note,
					supersededBy: {
						timestamp: completion.supersedingMessage.timestamp,
						...(completion.supersedingMessage.responseId === undefined
							? {}
							: { responseId: completion.supersedingMessage.responseId }),
						provider: completion.supersedingMessage.provider,
						model: completion.supersedingMessage.model,
					},
				};
			} else {
				retryRecovery = {
					kind: "auto-retry",
					status: "superseded",
					attempt: pending.attempt,
					recovery: pending.recovery,
					note: pending.note,
				};
			}
			entry.message.retryRecovery = retryRecovery;
			retryErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (retryErrors.length > 0) {
			await this.#host.sessionManager.rewriteEntries();
		}
		return retryErrors;
	}

	#isRecoverableProviderEmptyOutput(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		if (!AIError.is(id, AIError.Flag.EmptyResponse)) return false;
		return message.content.every(
			block => block.type === "thinking" || (block.type === "text" && !hasNonWhitespace(block.text)),
		);
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<"continue" | "terminal" | undefined> {
		const providerEmptyOutput = this.#isRecoverableProviderEmptyOutput(assistantMessage);
		if (!isEmptyAssistantStop(assistantMessage) && !providerEmptyOutput) {
			this.#emptyStopRetryCount = 0;
			return undefined;
		}

		if (this.#acceptTerminalEmptyStopForPrompt && assistantMessage.stopReason === "stop") {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#discardAcceptedTerminalEmptyStop(assistantMessage);
			this.#emptyStopRetryCount = 0;
			return undefined;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStopRetryCount - 1;
			const outputTokens = assistantMessage.usage.output;
			const outputTokensExcludingKnownReasoning = Math.max(
				0,
				outputTokens - (assistantMessage.usage.reasoningTokens ?? 0),
			);
			let finalError: string;
			if (providerEmptyOutput) {
				finalError = "Assistant returned no final output after retry cap; try switching models";
			} else if (outputTokensExcludingKnownReasoning > 0 && assistantMessage.content.length === 0) {
				finalError = `Assistant returned an empty stop after retry cap, but the provider billed ${outputTokens} output token${outputTokens === 1 ? "" : "s"} for it; content was generated and then dropped before delivery, which usually points to a provider-side content filter or a lossy API translation rather than a context problem`;
			} else {
				finalError =
					"Assistant returned empty stop after retry cap; try switching models or `/shake images` to remove archived frames";
			}
			assistantMessage.errorMessage = finalError;
			if (providerEmptyOutput) assistantMessage.errorId = AIError.create();
			logger.warn(finalError, {
				attempts,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
				outputTokens,
			});
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : attempts,
				finalError,
			});
			this.#clearPendingRetryErrors();
			this.#retryAttempt = 0;
			this.resolveRetry();

			await this.#dropAssistantTurnDurably(assistantMessage);
			return "terminal";
		}

		await this.#dropAssistantTurnDurably(assistantMessage);
		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
		return "continue";
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(emptyStopRetryTemplate, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}
	async #handleUnexpectedAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.#host.settings.get("features.unexpectedStopDetection")) {
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		let text = assistantMessage.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("\n");

		if (!hasNonWhitespace(text)) {
			text = assistantMessage.content
				.filter((content): content is ThinkingContent => content.type === "thinking")
				.map(content => content.thinking)
				.join("\n");
		}
		if (!hasNonWhitespace(text)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
		let classification: boolean | undefined;
		try {
			classification = await classifyUnexpectedStop(text, {
				settings: this.#host.settings,
				registry: this.#host.modelRegistry,
				sessionId: this.#host.sessionId(),
				metadataResolver: (provider: string) => this.#host.agent.metadataForProvider(provider),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}

		if (classification !== true) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(unexpectedStopRetryTemplate, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	removeAssistantMessageFromActiveContext(
		assistantMessage: AssistantMessage,
		reason = "assistant-context-cleanup",
	): void {
		const messages = this.#host.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.#host.agent.replaceMessages(messages.slice(0, -1));
			return;
		}

		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<string | undefined> {
		await this.#host.waitForSessionMessagePersistence(assistantMessage);
		return this.discardAssistantTurn(assistantMessage);
	}

	async #dropAssistantTurnDurably(assistantMessage: AssistantMessage): Promise<void> {
		const droppedEntryId = await this.#dropPersistedAssistantTurn(assistantMessage);
		if (droppedEntryId) await this.#host.sessionManager.discardEntryDurably(droppedEntryId);
	}

	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<RecoveryCompactionResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		await this.dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#host.runAutoCompaction(reason, true, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.#host.sessionManager.appendMessage(assistantMessage);
		const lastMessage = this.#host.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.#host.agent.appendMessage(assistantMessage);
	}

	#discardAcceptedTerminalEmptyStop(assistantMessage: AssistantMessage): void {
		const branch = this.#host.sessionManager.getBranch();
		const branchEntry = branch
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message, assistantMessage),
			);
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined
				? undefined
				: branch.find(entry => entry.id === branchEntry.parentId);
		const prunePrompt = parentEntry?.type === "custom_message";

		this.removeAssistantMessageFromActiveContext(assistantMessage, "accepted-terminal-empty-stop");
		if (prunePrompt && this.#host.agent.state.messages.at(-1)?.role === "custom") {
			this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		this.#host.withBashBranchTransition(() => {
			if (targetParentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(targetParentId);
			}
		});
		this.#host.sessionManager.appendCustomEntry("accepted-terminal-empty-stop");
	}

	discardAssistantTurn(assistantMessage: AssistantMessage): string | undefined {
		this.removeAssistantMessageFromActiveContext(assistantMessage);

		const branch = this.#host.sessionManager.getBranch();
		const persistedEntryId = this.#host.persistedAssistantEntryId(assistantMessage);
		const branchEntry =
			(persistedEntryId === undefined
				? undefined
				: branch.find(
						entry =>
							entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
					)) ??
			branch
				.slice()
				.reverse()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
				);
		if (!branchEntry) {
			return undefined;
		}
		this.#host.withBashBranchTransition(() => {
			if (branchEntry.parentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(branchEntry.parentId);
			}
		});
		return branchEntry.id;
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason &&
				left.errorMessage === right.errorMessage &&
				Bun.hash(JSON.stringify(left.content)) === Bun.hash(JSON.stringify(right.content)))
		);
	}

	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.#host.model();
		if (!activeModel || message.api === activeModel.api) {
			return AIError.classifyMessage(message);
		}

		const id = AIError.classifyMessage({
			api: activeModel.api,
			errorId: message.errorId,
			errorMessage: message.errorMessage,
			errorStatus: message.errorStatus,
		});
		message.errorId = id;
		return id;
	}

	#isUsagePreflightBlocked(message: AssistantMessage): boolean {
		return message.errorMessage?.startsWith(USAGE_PREFLIGHT_BLOCKED_PREFIX) === true;
	}

	isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			message.content.length !== 0 ||
			this.#host.abortInProgress() ||
			this.#host.isDisposed() ||
			this.#host.streamingEditAbortTriggered()
		) {
			return false;
		}

		const id = this.#classifyRetryMessage(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (message.errorMessage !== "Request was aborted" && message.errorMessage !== "Request was aborted.") {
			return false;
		}

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		const model = this.#host.model();
		const immutableAnthropicThinkingError =
			model?.api === "anthropic-messages" &&
			(message.errorStatus === 400 ||
				message.errorId === 400 ||
				message.errorMessage?.startsWith("400 ") === true) &&
			IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN.test(message.errorMessage ?? "");
		if (immutableAnthropicThinkingError) return false;

		const id = this.#classifyRetryMessage(message);

		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		const replaySafeUnexecutedTools =
			(this.isClassifierRefusal(message) || AIError.is(id, AIError.Flag.MalformedFunctionCall)) &&
			this.#unexecutedToolCallsReplaySafe(message);
		if (this.#hasReplayUnsafeOutput(message) && !replaySafeUnexecutedTools) return false;
		if (AIError.is(id, AIError.Flag.AccountPolicy) || this.isClassifierRefusal(message)) return true;
		return AIError.retriable(id);
	}

	#unexecutedToolCallsReplaySafe(message: AssistantMessage): boolean {
		const emittedToolCallIds = new Set<string>();
		for (const block of message.content) {
			if (block.type === "toolCall") {
				emittedToolCallIds.add(block.id);
				continue;
			}
			if (block.type === "image" || block.type === "anthropicServerTool") return false;
			if (block.type === "text" && this.#host.textOutputCommitted() && hasNonWhitespace(block.text)) return false;
		}
		if (emittedToolCallIds.size === 0) return false;

		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return false;

		const unexecutedToolCallIds = new Set<string>();
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role !== "toolResult" || !emittedToolCallIds.has(candidate.toolCallId)) continue;

			if (!isSyntheticToolResultMessage(candidate) || candidate.details?.executed !== false) return false;
			unexecutedToolCallIds.add(candidate.toolCallId);
		}
		return unexecutedToolCallIds.size === emittedToolCallIds.size;
	}

	classifyResolvedInterruptedToolTurn(message: AssistantMessage): "reasonless-abort" | "stream-stall" | undefined {
		const id = this.#classifyRetryMessage(message);
		const genericAbort =
			message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
		const reasonlessAbort =
			(message.stopReason === "aborted" || message.stopReason === "error") &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered() &&
			((message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) || genericAbort);
		const errorMessage = message.errorMessage ?? "";
		const streamStall =
			message.stopReason === "error" && STREAM_STALL_ERROR_RE.test(errorMessage) && AIError.retriable(id);
		const transportReset =
			message.stopReason === "error" &&
			HTTP2_STREAM_RESET_ERROR_RE.test(errorMessage) &&
			AIError.retriable(id) &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered();

		const prematureClose =
			message.stopReason === "error" &&
			PREMATURE_STREAM_CLOSE_ERROR_RE.test(errorMessage) &&
			AIError.retriable(id) &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered();
		if (!reasonlessAbort && !streamStall && !transportReset && !prematureClose) return undefined;
		if (reasonlessAbort && genericAbort) message.errorId = AIError.create(AIError.Flag.Abort);

		const resolvedToolCallIds: string[] = [];
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			resolvedToolCallIds.push(block.id);
		}
		if (resolvedToolCallIds.length === 0) return undefined;

		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return undefined;

		const unresolvedToolCallIds = new Set(resolvedToolCallIds);
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role === "toolResult") unresolvedToolCallIds.delete(candidate.toolCallId);
		}
		if (unresolvedToolCallIds.size > 0) return undefined;
		return reasonlessAbort ? "reasonless-abort" : "stream-stall";
	}

	#hasReplayUnsafeOutput(message: AssistantMessage): boolean {
		return message.content.some(
			block =>
				block.type === "toolCall" ||
				block.type === "image" ||
				block.type === "anthropicServerTool" ||
				(block.type === "text" && this.#host.textOutputCommitted() && block.text.trim().length > 0),
		);
	}

	#isOpenRouterThinkingStreamClose(message: AssistantMessage): boolean {
		return (
			message.provider === "openrouter" &&
			/server_error:\s*stream closed with reason:\s*error/i.test(message.errorMessage ?? "") &&
			message.content.some(block => block.type === "thinking" && block.thinking.trim().length > 0)
		);
	}

	isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#getRetryFallbackResolutionContext(): RetryFallbackResolutionContext {
		return {
			chains: this.#getRetryFallbackChains(),
			getModelRole: role => this.#host.settings.getModelRole(role),
			modelLookup: this.#host.modelRegistry,
		};
	}
	#getRetryFallbackChains(): RetryFallbackChains {
		return getRetryFallbackChains(this.#host.settings);
	}

	#validateRetryFallbackChains(): void {
		validateRetryFallbackChains(this.#host.settings, this.#host.modelRegistry, message =>
			this.#host.configWarnings.push(message),
		);
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return getRetryFallbackRevertPolicy(this.#host.settings);
	}

	clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
		this.#fallbackRoutedFor = undefined;
	}

	isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#host.modelRegistry.isSelectorSuppressed(selector.raw);
	}

	noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#host.modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	resolveRetryFallbackRole(
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
		roleHint?: string,
	): string | undefined {
		return resolveRetryFallbackChainKey(
			this.#getRetryFallbackResolutionContext(),
			currentSelector,
			currentModel,
			roleHint ?? this.#liveRetryRoleHint(currentModel),
		);
	}

	retryFallbackChainKeys(
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
		options?: { pinnedRole?: string; roleHint?: string },
	): string[] {
		const pinned = options?.pinnedRole ?? this.#activeRetryFallback?.role;
		const current = this.resolveRetryFallbackRole(currentSelector, currentModel, options?.roleHint);
		if (!pinned) return current ? [current] : [];
		return current && current !== pinned ? [pinned, current] : [pinned];
	}

	#liveRetryRoleHint(currentModel: Model | null | undefined): string | undefined {
		const role = this.#host.sessionManager?.getLastModelChangeRole?.();
		if (!role || role === EPHEMERAL_MODEL_CHANGE_ROLE || !currentModel) return undefined;
		const configured = this.#host.settings.getModelRole(role);
		if (!configured) return undefined;
		const resolved = resolveModelOverride([configured], this.#host.modelRegistry, this.#host.settings);
		return resolved.model && modelsAreEqual(resolved.model, currentModel) ? role : undefined;
	}

	findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
	): RetryFallbackSelector[] {
		return findRetryFallbackCandidates(
			this.#getRetryFallbackResolutionContext(),
			role,
			currentSelector,
			currentModel,
		);
	}

	async #maybeApplyUsageAwareFallback(signal: AbortSignal, confirmer?: UsageFallbackConfirmer): Promise<boolean> {
		if (!this.#host.settings.get("retry.usageAwareFallback")) return false;
		const currentModel = this.#host.model();
		if (!currentModel) return false;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel());
		let health: ModelUsageHealth;
		try {
			health = await this.#host.modelRegistry.authStorage.getModelUsageHealth(currentModel.provider, {
				modelId: currentModel.id,
				sessionId: this.#host.sessionId(),
				baseUrl: currentModel.baseUrl,
				reserveFraction: this.#host.settings.get("retry.usageReservePct") / 100,
				signal,
			});
		} catch (error) {
			if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
			logger.debug("Usage-aware runtime preflight failed open", {
				provider: currentModel.provider,
				model: currentModel.id,
				error: String(error),
			});
			return false;
		}
		if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
		const selectedAccount = health.accounts.find(account => account.selected);
		if (health.state === "healthy") {
			this.#usageReserveApprovedSelector = undefined;
			if (
				selectedAccount &&
				selectedAccount.state !== "healthy" &&
				health.accounts.some(account => account.state === "healthy")
			) {
				this.#host.modelRegistry.authStorage.releaseSessionCredentialForReselection(
					currentModel.provider,
					this.#host.sessionId(),
				);
			}
			return false;
		}
		if (health.state === "unknown") {
			this.#usageReserveApprovedSelector = undefined;
			return false;
		}
		if (health.state !== "reserve") this.#usageReserveApprovedSelector = undefined;

		const reservePolicy = this.#host.settings.get("retry.usageReservePolicy");
		if (reservePolicy === "fail-closed") {
			const condition = health.state === "reserve" ? "reserve reached" : "usage depleted";
			throw new Error(
				`${USAGE_PREFLIGHT_BLOCKED_PREFIX} ${condition} for ${currentSelector}; reserve policy is fail-closed.`,
			);
		}
		if (
			reservePolicy === "confirm" &&
			health.state === "reserve" &&
			this.#usageReserveApprovedSelector === currentSelector
		) {
			return false;
		}
		if (!this.#host.settings.get("retry.modelFallback")) return false;

		let fallback: { role: string; selector: RetryFallbackSelector; apiKey: string } | undefined;
		const ceiling = this.#host.thinkingLevelCeiling();
		const chainKeys = this.retryFallbackChainKeys(currentSelector, currentModel);
		for (const role of chainKeys) {
			for (const candidate of this.findRetryFallbackCandidates(role, currentSelector, currentModel)) {
				if (this.isRetryFallbackSelectorSuppressed(candidate)) continue;
				const resolved = resolveModelOverride([candidate.raw], this.#host.modelRegistry, this.#host.settings);
				const candidateModel = resolved.model ?? this.#host.modelRegistry.find(candidate.provider, candidate.id);
				if (!candidateModel || !this.#host.modelRegistry.hasConfiguredAuth(candidateModel)) continue;
				if (ceiling !== undefined && !modelSupportsEffortCeiling(candidateModel, ceiling)) continue;

				if (!this.#host.contextFitsModel(candidateModel)) continue;
				try {
					const candidateHealth = await this.#host.modelRegistry.authStorage.getModelUsageHealth(
						candidateModel.provider,
						{
							modelId: candidateModel.id,
							sessionId: this.#host.sessionId(),
							baseUrl: candidateModel.baseUrl,
							reserveFraction: this.#host.settings.get("retry.usageReservePct") / 100,
							signal,
						},
					);
					if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
					if (candidateHealth.state === "depleted" || candidateHealth.state === "reserve") continue;
					if (candidateHealth.state === "healthy") {
						const selected = candidateHealth.accounts.find(account => account.selected);
						if (
							selected &&
							selected.state !== "healthy" &&
							candidateHealth.accounts.some(account => account.state === "healthy")
						) {
							this.#host.modelRegistry.authStorage.releaseSessionCredentialForReselection(
								candidateModel.provider,
								this.#host.sessionId(),
							);
						}
					}
				} catch {
					if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
				}
				if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
				let apiKey: string | undefined;
				try {
					apiKey = await this.#host.modelRegistry.getApiKey(candidateModel, this.#host.sessionId(), { signal });
				} catch {
					if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
					continue;
				}
				if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
				if (!apiKey) continue;
				fallback = { role, selector: candidate, apiKey };
				break;
			}
			if (fallback) break;
		}
		if (!fallback) return false;

		let shouldFallback = health.state === "depleted" || reservePolicy === "auto" || !confirmer;
		if (!shouldFallback && health.state === "reserve" && confirmer) {
			const remainingFraction =
				selectedAccount?.remainingFraction ??
				health.accounts.reduce<number | undefined>((minimum, account) => {
					if (account.remainingFraction === undefined) return minimum;
					return minimum === undefined ? account.remainingFraction : Math.min(minimum, account.remainingFraction);
				}, undefined);
			shouldFallback = await this.#confirmUsageFallback(
				confirmer,
				{
					from: currentSelector,
					to: fallback.selector.raw,
					remainingPercent: remainingFraction === undefined ? undefined : Math.max(0, remainingFraction * 100),
				},
				signal,
			);
			if (signal.aborted || !modelsAreEqual(this.#host.model(), currentModel)) return false;
		}
		if (!shouldFallback) {
			this.#usageReserveApprovedSelector = currentSelector;
			return false;
		}
		this.#usageReserveApprovedSelector = undefined;
		return this.applyRetryFallbackCandidate(fallback.role, fallback.selector, currentSelector, {
			pinFallback: true,
			apiKey: fallback.apiKey,
			signal,
		});
	}

	async #confirmUsageFallback(
		confirmer: UsageFallbackConfirmer,
		confirmation: UsageFallbackConfirmation,
		signal: AbortSignal,
	): Promise<boolean> {
		if (signal.aborted) return false;
		const aborted = Promise.withResolvers<boolean>();
		const onAbort = () => aborted.resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([confirmer(confirmation, signal), aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean; apiKey?: string; signal?: AbortSignal },
	): Promise<boolean> {
		const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
		const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey =
			options?.apiKey ??
			(await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId(), { signal: options?.signal }));
		if (!apiKey) {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}
		if (options?.signal?.aborted) return false;

		const currentThinkingLevel = this.#host.configuredThinkingLevel();
		const requestedThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;

		const nextThinkingLevel = clampThinkingLevelToCeiling(
			candidate,
			requestedThinkingLevel,
			this.#host.thinkingLevelCeiling(),
		);
		const candidateSelector = formatModelStringWithRouting(candidate);
		const previousModel = this.#host.model();

		const routedBeforeSwap = this.#fallbackRoutedFor;
		const servedBeforeSwap = this.#activeRetryFallback?.served;
		this.#markFallbackRouted();
		if (this.#activeRetryFallback) this.#activeRetryFallback.served = false;
		await this.#host.setModelWithProviderSessionReset(candidate);
		if (options?.signal?.aborted) {
			this.#fallbackRoutedFor = routedBeforeSwap;
			if (this.#activeRetryFallback) this.#activeRetryFallback.served = servedBeforeSwap;
			if (previousModel && this.#host.model() === candidate) {
				await this.#host.setModelWithProviderSessionReset(previousModel);
			}
			return false;
		}
		if (this.#host.model() !== candidate) {
			this.#fallbackRoutedFor = routedBeforeSwap;
			if (this.#activeRetryFallback) this.#activeRetryFallback.served = servedBeforeSwap;
			return false;
		}
		this.#host.sessionManager.appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE, true);
		this.#host.settings.getStorage()?.recordModelUsage(candidateSelector);
		this.#host.setThinkingLevel(nextThinkingLevel);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeRetryFallback.pinned = this.#activeRetryFallback.pinned || options?.pinFallback === true;
		}
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
		return true;
	}

	async #tryRetryModelFallback(
		currentSelector: string,
		failedMessage: AssistantMessage,
		options?: { pinFallback?: boolean },
	): Promise<boolean> {
		const ceiling = this.#host.thinkingLevelCeiling();
		const latestAssistant = this.#host.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant" && message !== failedMessage,
		);
		for (const role of this.retryFallbackChainKeys(currentSelector)) {
			for (const selector of this.findRetryFallbackCandidates(role, currentSelector)) {
				if (this.isRetryFallbackSelectorSuppressed(selector)) continue;
				const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
				const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
				if (!candidate) continue;

				if (
					candidate.api === "anthropic-messages" &&
					latestAssistant?.api === "anthropic-messages" &&
					latestAssistant.provider === candidate.provider &&
					latestAssistant.model !== candidate.id &&
					latestAssistant.content.some(
						block =>
							(block.type === "thinking" && Boolean(block.thinkingSignature?.trim())) ||
							block.type === "redactedThinking",
					)
				) {
					continue;
				}

				if (ceiling !== undefined && !modelSupportsEffortCeiling(candidate, ceiling)) continue;

				if (!this.#host.contextFitsModel(candidate, failedMessage)) continue;
				const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId());
				if (!apiKey) continue;
				return this.applyRetryFallbackCandidate(role, selector, currentSelector, options);
			}
		}

		return false;
	}

	#activeFireworksFastModel(): Model | undefined {
		const model = this.#host.model();
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;

		if (this.isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;

		if (AIError.is(id, AIError.Flag.ThinkingLoop)) return false;
		return this.#host.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		const model = this.#host.model();
		if (!model) return false;
		const immutableAnthropicThinkingError =
			model.api === "anthropic-messages" &&
			(message.errorStatus === 400 ||
				message.errorId === 400 ||
				message.errorMessage?.startsWith("400 ") === true) &&
			IMMUTABLE_ANTHROPIC_THINKING_ERROR_PATTERN.test(message.errorMessage ?? "");
		if (immutableAnthropicThinkingError) return false;
		const retrySettings = this.#host.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (this.isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.#host.thinkingLevel());
		return this.retryFallbackChainKeys(currentSelector).some(
			role => this.findRetryFallbackCandidates(role, currentSelector).length > 0,
		);
	}

	async #tryFireworksFastFallback(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const baseModel = this.#host.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await this.#host.modelRegistry.getApiKey(baseModel, this.#host.sessionId());
		if (!apiKey) return false;
		const baseSelector = formatModelStringWithRouting(baseModel);

		this.#markFallbackRouted();
		await this.#host.setModelWithProviderSessionReset(baseModel);
		this.#host.sessionManager.appendModelChange(baseSelector, EPHEMERAL_MODEL_CHANGE_ROLE, true);
		this.#host.settings.getStorage()?.recordModelUsage(baseSelector);
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<boolean> {
		if (!this.#activeRetryFallback) return false;
		if (this.#activeRetryFallback.pinned) return false;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return false;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#host.modelRegistry);
		if (!originalSelector) {
			this.#activeRetryFallback = undefined;
			return false;
		}

		const currentModel = this.#host.model();
		if (!currentModel) return false;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel());
		if (currentSelector === originalSelector.raw) {
			if (!this.isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.clearActiveRetryFallback();
			}
			return false;
		}
		if (this.isRetryFallbackSelectorSuppressed(originalSelector)) return false;

		const resolvedPrimary = resolveModelOverride(
			[originalSelector.raw],
			this.#host.modelRegistry,
			this.#host.settings,
		);
		const primaryModel =
			resolvedPrimary.model ?? this.#host.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return false;
		const apiKey = await this.#host.modelRegistry.getApiKey(primaryModel, this.#host.sessionId());
		if (!apiKey) return false;

		const currentThinkingLevel = this.#host.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const primarySelector = formatModelStringWithRouting(primaryModel);

		this.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(primaryModel);
		this.#host.sessionManager.appendModelChange(primarySelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#host.settings.getStorage()?.recordModelUsage(primarySelector);
		this.#host.setThinkingLevel(thinkingToApply);
		return true;
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		return undefined;
	}

	async #handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			preserveFailedTurn?: boolean;
		},
	): Promise<boolean> {
		const retrySettings = this.#host.settings.getGroup("retry");

		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
		const classifierRefusal = this.isClassifierRefusal(message);

		const generation = this.#host.promptGeneration();
		this.#retryAttempt++;

		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		const maxRetries = this.#isOpenRouterThinkingStreamClose(message)
			? Math.min(retrySettings.maxRetries, 1)
			: retrySettings.maxRetries;
		const retryBudgetExhausted = this.#retryAttempt > maxRetries;

		const errorMessage = message.errorMessage || "Unknown error";
		const id = this.#classifyRetryMessage(message);
		const preserveFailedTurn =
			options?.preserveFailedTurn === true ||
			((classifierRefusal || AIError.is(id, AIError.Flag.MalformedFunctionCall)) &&
				this.#unexecutedToolCallsReplaySafe(message));
		const rateLimitReason = parseRateLimitReason(errorMessage);
		const staleOpenAIResponsesReplayError = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const accountPolicyDenial = AIError.is(id, AIError.Flag.AccountPolicy);
		const recordedUsageLimitOutcome = await this.#usageLimitOutcomes.get(message);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, this.#retryAttempt);

		if (
			!staleOpenAIResponsesReplayError &&
			!AIError.is(id, AIError.Flag.UsageLimit) &&
			parsedRetryAfterMs === undefined &&
			(rateLimitReason === "CONCURRENT_LIMIT" || rateLimitReason === "RATE_LIMIT_EXCEEDED")
		) {
			const reasonBackoffMs = calculateRateLimitBackoffMs(rateLimitReason);
			if (reasonBackoffMs > delayMs) delayMs = reasonBackoffMs;
		}
		let switchedCredential = false;
		let switchedModel = false;

		let usageLimitWaitMs: number | undefined;

		if (staleOpenAIResponsesReplayError) {
			this.#host.resetCurrentResponsesProviderSession("stale replay error");
		}

		if (!retryBudgetExhausted && !staleOpenAIResponsesReplayError && recordedUsageLimitOutcome) {
			if (
				recordedUsageLimitOutcome.switchedCredential ||
				(await this.#host.maybeAutoRedeemCodexReset(
					parsedRetryAfterMs === undefined ? undefined : Date.now() + parsedRetryAfterMs,
				))
			) {
				switchedCredential = true;
				delayMs = 0;
			} else {
				usageLimitWaitMs = recordedUsageLimitOutcome.retryAfterMs;
				if (recordedUsageLimitOutcome.retryAtMs !== undefined) {
					const siblingWaitMs =
						Math.max(0, recordedUsageLimitOutcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;
					if (siblingWaitMs < usageLimitWaitMs) {
						usageLimitWaitMs = siblingWaitMs;
					}
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const allowModelFallback = options?.allowModelFallback !== false;
		const currentModel = this.#host.model();
		const currentSelector = currentModel
			? formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel())
			: undefined;
		if (accountPolicyDenial && currentModel) {
			switchedCredential = await this.#host.modelRegistry.authStorage.rotateSessionCredential(
				currentModel.provider,
				this.#host.sessionId(),
				{ error: errorMessage, modelId: currentModel.id },
			);
			if (switchedCredential) delayMs = 0;
		}

		const thinkingLoop = AIError.is(id, AIError.Flag.ThinkingLoop);
		if (!staleOpenAIResponsesReplayError && !switchedCredential && currentSelector) {
			if (
				allowModelFallback &&
				retrySettings.modelFallback &&
				!thinkingLoop &&
				!(retryBudgetExhausted && classifierRefusal)
			) {
				if (!classifierRefusal) {
					this.noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, message, {
					pinFallback: classifierRefusal,
				});
			}

			if (!switchedModel && allowModelFallback && options?.fireworksFastFallback) {
				switchedModel = await this.#tryFireworksFastFallback(currentSelector);
			}
			if (switchedModel) {
				delayMs = 0;
			} else if (usageLimitWaitMs === undefined && parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}

		if (retryBudgetExhausted) {
			if (!switchedModel && !switchedCredential) {
				const attempt = this.#retryAttempt - 1;
				message.errorMessage = `Retry budget exhausted after ${attempt} ${attempt === 1 ? "retry" : "retries"}: ${errorMessage}`;
				await this.persistTerminalEmptyErrorTurn(message);
				const retryErrors = await this.#markPendingRetryErrors({ status: "superseded" });
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: errorMessage,
					retryErrors,
				});
				this.#clearPendingRetryErrors();
				this.#retryAttempt = 0;
				this.resolveRetry();
				return false;
			}

			if (switchedModel) this.#retryAttempt = 1;
		}
		if ((classifierRefusal || accountPolicyDenial) && !switchedCredential && !switchedModel) {
			if (this.#retryAttempt > 1) {
				await this.persistTerminalEmptyErrorTurn(message);
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: errorMessage,
				});
				this.#clearPendingRetryErrors();
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}

		if (
			(options?.fireworksFastFallback || options?.hardErrorFallback) &&
			!switchedModel &&
			!this.isRetryableError(message)
		) {
			if (this.#retryAttempt > 1) {
				await this.persistTerminalEmptyErrorTurn(message);
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: errorMessage,
				});
				this.#clearPendingRetryErrors();
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}

		const maxDelayMs = retrySettings.maxDelayMs;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedModel) {
			await this.persistTerminalEmptyErrorTurn(message);
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Provider requested ${delayMs}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
			});
			this.#clearPendingRetryErrors();
			this.resolveRetry();
			return false;
		}

		await this.#recordPendingRetryError(message, id, { switchedCredential, switchedModel, delayMs });

		await this.#host.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: maxRetries,
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		if (!preserveFailedTurn) {
			this.removeAssistantMessageFromActiveContext(message, "auto-retry");
		}

		this.#maybeInjectThinkingLoopRedirect(id);

		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}

			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#clearPendingRetryErrors();
			this.resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		if (!preserveFailedTurn && this.#host.promptGeneration() === generation) {
			this.#stripFailedAssistantTail();
		}

		this.#host.scheduleAgentContinue({
			delayMs: 1,
			generation,
			onError: error => void this.#failRetryAfterLocalContinueError(message, error),
		});

		return true;
	}

	#stripFailedAssistantTail(): void {
		const messages = this.#host.agent.state.messages;
		const tail = messages[messages.length - 1];
		if (tail?.role !== "assistant") return;
		if (tail.stopReason !== "error" && tail.stopReason !== "aborted") return;
		logger.debug("agent active context failed assistant tail stripped positionally", {
			stopReason: tail.stopReason,
			timestamp: tail.timestamp,
		});
		this.#host.agent.replaceMessages(messages.slice(0, -1));
	}

	async #failRetryAfterLocalContinueError(message: AssistantMessage, error: unknown): Promise<void> {
		if (this.#retryAttempt === 0) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		const localError = error instanceof Error ? error.message : String(error);
		await this.persistTerminalEmptyErrorTurn(message);
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: `Retry continuation failed locally: ${localError}. Original error: ${message.errorMessage ?? "Unknown error"}`,
		});
		this.#clearPendingRetryErrors();
		this.resolveRetry();
	}

	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (this.#host.settings.get("model.loopGuard.enabled") !== true) return;
		this.#host.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: thinkingLoopRedirectTemplate,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			thinkingLoopRedirectTemplate,
			false,
			undefined,
			"agent",
		);
	}

	abortRetry(): void {
		this.#retryAbortController?.abort();

		this.resolveRetry();
	}

	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	get autoRetryEnabled(): boolean {
		return this.#host.settings.get("retry.enabled") ?? true;
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.#host.settings.set("retry.enabled", enabled);
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.#host.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.#host.agent.waitForIdle();
			}
		}
	}
}
