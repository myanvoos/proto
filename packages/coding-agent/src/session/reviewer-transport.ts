import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	AppendOnlyContextManager,
	type CompactionSummaryMessage,
	resolveTelemetry,
	type StreamFn,
	ThinkingLevel,
	type Tokenizer,
} from "@oh-my-pi/pi-agent-core";
import {
	type CompactionResult,
	compact,
	compactionContextTokens,
	createCompactionSummaryMessage,
	estimateTranscriptTokens,
	NativeCompactionError,
	prepareCompaction,
	type SessionMessageEntry,
	shouldCompact,
	shouldUseProviderNativeCompaction,
} from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	CodexCompactionContext,
	Context,
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { isUsageLimitOutcome, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	type AdvisorAgent,
	AdvisorOutputQuarantinedError,
	AdvisorTranscriptRecorder,
	buildAdvisorQuarantineSourceText,
	quarantineAdvisorUnsafeOutput,
	type ReviewerGeneratedTextExtractor,
	type ReviewerRuntime,
} from "../advisor";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, formatModelStringWithRouting, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { CursorExecHandlers, type CursorMcpResourceAdapter } from "../cursor";
import { bridgeToolMap } from "../cursor-bridge-tools";
import { estimateToolSchemaTokens } from "../modes/utils/context-usage";
import { resolveThinkingLevelForModel, shouldDisableReasoning, toReasoningEffort } from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import { resolveCompactionMethodOrder } from "./compaction-methods";
import {
	formatRetryFallbackSelector,
	getRetryFallbackRevertPolicy,
	parseRetryFallbackSelector,
	type RetryFallbackSelector,
} from "./retry-fallback-chains";
import type { PerAdvisorStat } from "./session-advisors";
import type { CompactionEntry, SessionEntry } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import type { SessionManager } from "./session-manager";
import { buildSessionMetadata } from "./session-metadata";

const ADVISOR_CODEX_SSE_MAX_ATTEMPTS = 1;

export interface AdvisorRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel;
	lastAppliedThinkingLevel: ThinkingLevel;
}

export interface ReviewerIdentity {
	role: "advisor" | "conductor";
	name: string;
	slug: string;

	sessionLabelSuffix: string;
	transcriptFilename: string;
	telemetryName: string;
	noticeLabel: string;
}

export type ReviewerProviderSessionIdResolver = (
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
) => string | undefined;

export interface ReviewerInstance {
	agent: Agent;
	runtime: ReviewerRuntime;
	recorder: AdvisorTranscriptRecorder;
	recorderClosed: Promise<void>;
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	providerSessionId: string | undefined;
	retryFallback?: AdvisorRetryFallbackState;
	retryFallbackPendingSuccess: boolean;
	signature: string;
}

export interface ReviewerTransportHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	providerSessionState: Map<string, ProviderSessionState>;
	preferWebsockets: boolean | undefined;
	onPayload: SimpleStreamOptions["onPayload"] | undefined;
	onResponse: SimpleStreamOptions["onResponse"] | undefined;
	onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	resolveContextPromotionTarget(
		currentModel: Model,
		contextWindow: number,
		signal: AbortSignal,
	): Promise<Model | undefined>;
	resolveCompactionModelCandidates(preferredModel: Model | null | undefined, availableModels: Model[]): Model[];
	retryFallbackChainKeys(
		currentSelector: string,
		currentModel?: Model | null,
		options?: { pinnedRole?: string; roleHint?: string },
	): string[];
	findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		currentModel?: Model | null,
	): RetryFallbackSelector[];
	isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean;
	noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void;
	createCodexCompactionContext(options: {
		trigger: CodexCompactionContext["trigger"];
		reason: CodexCompactionContext["reason"];
		phase: CodexCompactionContext["phase"];
	}): CodexCompactionContext;
	sessionId(): string;
}

interface AdvisorCompactionSummaryMessage extends CompactionSummaryMessage {
	firstKeptEntryId?: string;
	advisorUsageAnchorStartIndex?: number;
}

export interface ReviewerTransportOptions {
	identity: ReviewerIdentity;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
	systemPrompt: string[];

	adviseTool: AgentTool<any>;
	toolNames: string[] | undefined;
	toolPool: AgentTool[] | undefined;

	/**
	 * Which tool arguments count as reviewer-generated text for output-hazard quarantine. Omitted keeps
	 * `quarantineAdvisorUnsafeOutput`'s own default (the `advise` note extractor), so the advisor path is unchanged.
	 */
	generatedTextExtractor?: ReviewerGeneratedTextExtractor;
	/** Omitted keeps `quarantineAdvisorUnsafeOutput`'s own default prefix. */
	quarantinePrefix?: string;
	createEditTool?(): AgentTool | undefined;
	getToolContext?: () => AgentToolContext | undefined;
	mcpResources?: CursorMcpResourceAdapter;

	providerSessionIds: Map<string, string>;
	resolveProviderSessionId: ReviewerProviderSessionIdResolver;
	streamFn: StreamFn | undefined;
	transformProviderContext: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
	serviceTierResolver(model: Model): ServiceTier | undefined;

	recorderClosed: Promise<void>;

	createRuntime(agent: AdvisorAgent): ReviewerRuntime;
}

export class ReviewerTransport implements ReviewerInstance {
	readonly #host: ReviewerTransportHost;
	readonly #identity: ReviewerIdentity;
	readonly #providerSessionIds: Map<string, string>;
	readonly #resolveProviderSessionId: ReviewerProviderSessionIdResolver;

	readonly agent: Agent;
	readonly runtime: ReviewerRuntime;
	readonly recorder: AdvisorTranscriptRecorder;
	recorderClosed: Promise<void> = Promise.resolve();
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	providerSessionId: string | undefined;
	retryFallback?: AdvisorRetryFallbackState;
	retryFallbackPendingSuccess = false;
	readonly signature: string;

	#quarantinedAdvisorOutput: string | undefined;
	#currentAdvisorInput = "";

	constructor(host: ReviewerTransportHost, options: ReviewerTransportOptions) {
		const identity = options.identity;
		this.#host = host;
		this.#identity = identity;
		this.#providerSessionIds = options.providerSessionIds;
		this.#resolveProviderSessionId = options.resolveProviderSessionId;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel;
		this.signature = options.signature;

		const slug = identity.slug;
		const advisorName = identity.name;
		const advisorModel = options.model;
		const advisorThinkingLevel = options.thinkingLevel;
		const systemPrompt = options.systemPrompt;

		const names = options.toolNames === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(options.toolNames);
		const tools = (options.toolPool ?? []).filter(t => names.has(t.name));
		const advisorLoopTools: AgentTool<any>[] = [options.adviseTool, ...tools];
		const advisorToolMap = new Map<string, AgentTool<any>>();
		const availableAdvisorToolNames = new Set<string>();
		for (const tool of advisorLoopTools) {
			availableAdvisorToolNames.add(tool.name);
			advisorToolMap.set(tool.name, tool);
			if (tool.customWireName !== undefined) {
				availableAdvisorToolNames.add(tool.customWireName);
				advisorToolMap.set(tool.customWireName, tool);
			}
		}

		const primaryProviderSessionId = this.#host.sessionId();
		const advisorSessionLabel = slug
			? `${primaryProviderSessionId}-${identity.sessionLabelSuffix}-${slug}`
			: `${primaryProviderSessionId}-${identity.sessionLabelSuffix}`;
		const advisorProviderSessionId = options.resolveProviderSessionId(
			options.providerSessionIds,
			primaryProviderSessionId,
			slug,
		);
		this.providerSessionId = advisorProviderSessionId;
		const appendOnlyContext = new AppendOnlyContextManager();

		const advisorTelemetry = this.#host.agent.telemetry
			? {
					...this.#host.agent.telemetry,
					agent: {
						id: advisorSessionLabel,
						name: slug ? `${identity.telemetryName}: ${advisorName}` : identity.telemetryName,
						description: formatModelString(advisorModel),
					},
					conversationId: undefined,
				}
			: undefined;

		const advisorPromptCacheKey = this.#host.agent.promptCacheKey ?? advisorProviderSessionId;

		const advisorCanMutateFiles = advisorToolMap.has("write") || advisorToolMap.has("edit");
		if (advisorCanMutateFiles) availableAdvisorToolNames.add("delete");

		const advisorCursorExecHandlers = new CursorExecHandlers({
			cwd: this.#host.sessionManager.getCwd(),
			getCwd: () => this.#host.sessionManager.getCwd(),
			tools: bridgeToolMap(advisorToolMap, options.createEditTool),

			getToolContext: options.getToolContext,
			allowDirectFileMutation: advisorCanMutateFiles,

			mcpResources: options.mcpResources,
		});
		const baseAdvisorStreamFn = options.streamFn ?? streamSimple;
		const advisorStreamFn: StreamFn = (requestModel, context, streamOptions) => {
			if (requestModel.api === "openai-codex-responses") {
				return baseAdvisorStreamFn(requestModel, context, {
					...streamOptions,
					codexSseMaxAttempts: ADVISOR_CODEX_SSE_MAX_ATTEMPTS,
				});
			}
			if (
				requestModel.api === "google-generative-ai" ||
				requestModel.api === "google-gemini-cli" ||
				requestModel.api === "google-vertex"
			) {
				return baseAdvisorStreamFn(requestModel, context, { ...streamOptions, acceptEmptyResponse: true });
			}
			return baseAdvisorStreamFn(requestModel, context, streamOptions);
		};
		const advisorAgent = new Agent({
			initialState: {
				systemPrompt,
				model: advisorModel,
				thinkingLevel: toReasoningEffort(advisorThinkingLevel),
				tools: advisorLoopTools,
			},
			appendOnlyContext,
			sessionId: advisorProviderSessionId,
			promptCacheKey: advisorPromptCacheKey,
			providerSessionState: this.#host.providerSessionState,
			cursorExecHandlers: advisorCursorExecHandlers,
			cwdResolver: () => this.#host.sessionManager.getCwd(),
			preferWebsockets: this.#host.preferWebsockets,
			getApiKey: requestModel => this.#host.modelRegistry.resolver(requestModel, advisorProviderSessionId),
			streamFn: advisorStreamFn,
			onPayload: this.#host.onPayload,
			onResponse: this.#host.onResponse,
			onSseEvent: this.#host.onSseEvent,
			transformProviderContext: options.transformProviderContext,
			intentTracing: false,
			transformAssistantMessage: message => {
				this.#quarantinedAdvisorOutput = quarantineAdvisorUnsafeOutput(
					message,
					availableAdvisorToolNames,
					buildAdvisorQuarantineSourceText(this.#currentAdvisorInput, advisorAgent.state.messages),
					options.generatedTextExtractor,
					options.quarantinePrefix,
				);
			},
			telemetry: advisorTelemetry,
			serviceTier: undefined,
			serviceTierResolver: options.serviceTierResolver,
		});
		advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
		this.agent = advisorAgent;

		const advisorAgentFacade: AdvisorAgent = {
			prompt: async input => {
				let quarantined: string | undefined;
				try {
					this.#quarantinedAdvisorOutput = undefined;

					this.#currentAdvisorInput = Array.isArray(input)
						? formatSessionHistoryMarkdown(input, { watchedRoles: true })
						: input;

					if (Array.isArray(input)) await advisorAgent.prompt(input);
					else await advisorAgent.prompt(input);
					quarantined = this.#quarantinedAdvisorOutput;
				} finally {
					this.#quarantinedAdvisorOutput = undefined;
					this.#currentAdvisorInput = "";
				}
				if (quarantined) throw new AdvisorOutputQuarantinedError(quarantined);
			},
			abort: reason => advisorAgent.abort(reason),
			reset: () => {
				advisorAgent.reset();
				appendOnlyContext.log.clear();
			},
			rollbackTo: count => {
				const messages = advisorAgent.state.messages;
				if (count < messages.length) {
					messages.length = count;
				}
				appendOnlyContext.resetSyncCursor();
				advisorAgent.state.error = undefined;
			},
			state: advisorAgent.state,
		};

		this.recorder = new AdvisorTranscriptRecorder(
			() => this.#host.sessionManager.getSessionFile(),
			() => this.#host.sessionManager.getCwd(),
			identity.transcriptFilename,

			options.recorderClosed,
		);
		this.runtime = options.createRuntime(advisorAgentFacade);
	}

	setModel(model: Model, requestedThinkingLevel: ThinkingLevel): ThinkingLevel {
		const resolvedThinkingLevel = resolveThinkingLevelForModel(model, requestedThinkingLevel);
		const nextThinkingLevel = resolvedThinkingLevel ?? ThinkingLevel.Inherit;
		this.agent.setModel(model);
		this.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel));
		this.agent.setDisableReasoning(shouldDisableReasoning(nextThinkingLevel));
		this.agent.appendOnlyContext?.invalidateForModelChange();
		this.model = model;
		this.thinkingLevel = nextThinkingLevel;
		return nextThinkingLevel;
	}

	pushTurn(messages: AgentMessage[], willContinue: boolean | undefined): void {
		if (this.runtime.disposed) return;
		try {
			this.runtime.onTurnEnd(messages, { willContinue });
		} catch (error) {
			logger.warn("advisor onTurnEnd threw; delta dropped", { advisor: this.#identity.name, err: String(error) });
		}
	}

	awaitCatchup(threshold: number, capMs: number, signal?: AbortSignal): Promise<boolean> {
		return this.runtime.waitForCatchup(capMs, threshold, signal);
	}

	resetForConversationBoundary(): void {
		this.agentUnsubscribe?.();
		this.agentUnsubscribe = undefined;
		this.runtime.reset("conversation-boundary");
	}

	async #maybeRestoreRetryFallbackPrimary(signal: AbortSignal): Promise<void> {
		const fallback = this.retryFallback;
		if (!fallback || getRetryFallbackRevertPolicy(this.#host.settings) !== "cooldown-expiry") return;

		const originalSelector = parseRetryFallbackSelector(fallback.originalSelector, this.#host.modelRegistry);
		if (!originalSelector) {
			this.retryFallback = undefined;
			this.retryFallbackPendingSuccess = false;
			return;
		}
		const currentSelector = formatRetryFallbackSelector(this.agent.state.model, this.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#host.isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.retryFallback = undefined;
				this.retryFallbackPendingSuccess = false;
			}
			return;
		}
		if (this.#host.isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride(
			[originalSelector.raw],
			this.#host.modelRegistry,
			this.#host.settings,
		);
		const primaryModel =
			resolvedPrimary.model ?? this.#host.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#host.modelRegistry.getApiKey(primaryModel, this.providerSessionId, {
			signal,
		});
		if (!apiKey) return;
		signal.throwIfAborted();

		const thinkingToApply =
			this.thinkingLevel === fallback.lastAppliedThinkingLevel ? fallback.originalThinkingLevel : this.thinkingLevel;
		this.setModel(primaryModel, thinkingToApply);
		this.#host.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(primaryModel));
		this.retryFallback = undefined;
		this.retryFallbackPendingSuccess = false;
	}

	async recoverTurn(error: unknown, failedMessages: readonly AgentMessage[], signal: AbortSignal): Promise<boolean> {
		if (error instanceof AdvisorOutputQuarantinedError) return false;

		const failedMessage = failedMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const assistantFailure = failedMessage?.stopReason === "error" ? failedMessage : undefined;
		if (assistantFailure?.content.some(block => block.type === "toolCall")) return false;

		const currentModel = this.agent.state.model;
		const message = assistantFailure?.errorMessage ?? (error instanceof Error ? error.message : String(error));
		const errorId = assistantFailure
			? AIError.classifyMessage({
					api: currentModel.api,
					errorId: assistantFailure.errorId,
					errorMessage: message,
					errorStatus: assistantFailure.errorStatus,
				})
			: AIError.classify(error, currentModel.api);
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) return false;
		if (
			AIError.is(errorId, AIError.Flag.ContextOverflow) ||
			(assistantFailure && AIError.isContextOverflow(assistantFailure, currentModel.contextWindow ?? 0))
		) {
			return false;
		}

		const accountPolicyDenial = AIError.is(errorId, AIError.Flag.AccountPolicy);
		if (accountPolicyDenial) {
			const switched = await this.#host.modelRegistry.authStorage.rotateSessionCredential(
				currentModel.provider,
				this.providerSessionId,
				{ error: message, modelId: currentModel.id, signal },
			);
			if (switched) return true;
		}

		const retryAfterMs = extractRetryHint(undefined, message);
		const usageLimit =
			AIError.is(errorId, AIError.Flag.UsageLimit) ||
			isUsageLimitOutcome(extractHttpStatusFromError(error), message);
		if (usageLimit) {
			const outcome = await this.#host.modelRegistry.authStorage.markUsageLimitReached(
				currentModel.provider,
				this.providerSessionId,
				{
					retryAfterMs,
					baseUrl: currentModel.baseUrl,
					modelId: currentModel.id,
					signal,
				},
			);
			if (outcome.switched) return true;
		}
		if (!assistantFailure && !accountPolicyDenial && !usageLimit) return false;

		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);

		const retrySettings = this.#host.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;

		const chainKeys = this.#host.retryFallbackChainKeys(currentSelector, currentModel, {
			pinnedRole: this.retryFallback?.role,
			roleHint: this.#identity.role,
		});
		if (
			!chainKeys.some(role => this.#host.findRetryFallbackCandidates(role, currentSelector, currentModel).length > 0)
		) {
			return false;
		}

		this.#host.noteRetryFallbackCooldown(currentSelector, retryAfterMs, message);
		for (const role of chainKeys) {
			for (const selector of this.#host.findRetryFallbackCandidates(role, currentSelector, currentModel)) {
				if (this.#host.isRetryFallbackSelectorSuppressed(selector)) continue;
				const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
				const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
				if (!candidate || modelsAreEqual(candidate, currentModel)) continue;
				const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.providerSessionId, {
					signal,
				});
				if (!apiKey) continue;
				signal.throwIfAborted();

				const originalThinkingLevel = this.thinkingLevel;
				const requestedThinkingLevel = selector.thinkingLevel ?? originalThinkingLevel;
				const nextThinkingLevel = this.setModel(candidate, requestedThinkingLevel);
				if (this.retryFallback) {
					this.retryFallback.lastAppliedThinkingLevel = nextThinkingLevel;
				} else {
					this.retryFallback = {
						role,
						originalSelector: currentSelector,
						originalThinkingLevel,
						lastAppliedThinkingLevel: nextThinkingLevel,
					};
				}
				this.retryFallbackPendingSuccess = true;
				this.#host.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(candidate));
				await this.#host.emitSessionEvent({
					type: "retry_fallback_applied",
					from: currentSelector,
					to: selector.raw,
					role,
				});
				return true;
			}
		}
		return false;
	}

	async #promoteContextModel(currentModel: Model, signal: AbortSignal): Promise<boolean> {
		const promotionSettings = this.#host.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#host.resolveContextPromotionTarget(currentModel, contextWindow, signal);
		if (!targetModel) return false;
		signal.throwIfAborted();

		const advisorThinkingLevel = this.thinkingLevel;
		try {
			this.setModel(targetModel, advisorThinkingLevel);
			logger.debug("Advisor context promotion switched model on overflow", {
				advisor: this.#identity.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Advisor context promotion failed", {
				advisor: this.#identity.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async maintainContext(incoming: AgentMessage, signal: AbortSignal): Promise<boolean> {
		await this.#maybeRestoreRetryFallbackPrimary(signal);
		const agent = this.agent;
		const incomingTokens = agent.tokenizer.countMessage(incoming);

		const compactionSettings = this.#host.settings.getGroup("compaction");
		if (!compactionSettings.enabled || resolveCompactionMethodOrder(compactionSettings.methodOrder).length === 0) {
			return false;
		}

		const advisorModel = agent.state.model;
		const contextWindow = advisorModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = agent.state.messages;
		const storedConversationTokens = agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });

		const providerContextTokens = this.#estimateContextTokens(messages, agent.tokenizer) + incomingTokens;
		const localContextTokens =
			agent.tokenizer.countTokens(agent.state.systemPrompt) +
			estimateToolSchemaTokens(agent.state.tools, agent.tokenizer) +
			storedConversationTokens +
			incomingTokens;
		const contextTokens = compactionContextTokens(providerContextTokens, localContextTokens);

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		if (await this.#promoteContextModel(advisorModel, signal)) {
			const newModel = agent.state.model;
			const newWindow = newModel.contextWindow ?? 0;
			if (newWindow > 0) {
				const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
				if (!stillNeedsCompaction) return false;
			}
		}

		const pathEntries: SessionEntry[] = messages.map((message, i) => {
			const id = `msg-${i}`;
			const parentId = i > 0 ? `msg-${i - 1}` : null;
			const timestamp = String(message.timestamp || Date.now());

			if (message.role === "compactionSummary") {
				const advisorSummary = message as AdvisorCompactionSummaryMessage;
				return {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: message.summary,
					shortSummary: message.shortSummary,
					firstKeptEntryId: advisorSummary.firstKeptEntryId || `msg-${i + 1}`,
					tokensBefore: message.tokensBefore,
				} satisfies CompactionEntry;
			}

			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message,
			} satisfies SessionMessageEntry;
		});

		const availableModels = this.#host.modelRegistry.getAvailable();
		const candidates = this.#host.resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			return true;
		}
		const advisorProviderSessionId = this.#resolveProviderSessionId(
			this.#providerSessionIds,
			this.#host.sessionId(),
			this.#identity.slug,
		);
		const preparation = prepareCompaction(pathEntries, compactionSettings, advisorModel, agent.tokenizer);
		if (!preparation) {
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
			? ThinkingLevel.Off
			: agent.state.thinkingLevel;

		let compactResult: CompactionResult | undefined;
		let lastError: unknown;
		let nativeCompactionFailure: { error: NativeCompactionError; provider: string } | undefined;

		const telemetry = resolveTelemetry(agent.telemetry, advisorProviderSessionId);

		const codexCompaction = this.#host.createCodexCompactionContext({
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
		});

		for (const candidate of candidates) {
			const apiKey = await this.#host.modelRegistry.getApiKey(candidate, advisorProviderSessionId, { signal });
			if (!apiKey) continue;
			if (
				nativeCompactionFailure &&
				(candidate.provider !== nativeCompactionFailure.provider ||
					!shouldUseProviderNativeCompaction(candidate, compactionSettings))
			) {
				throw nativeCompactionFailure.error;
			}

			const advisorMetadata = advisorProviderSessionId
				? buildSessionMetadata(advisorProviderSessionId, candidate.provider, this.#host.modelRegistry.authStorage)
				: undefined;
			try {
				compactResult = await compact(
					preparation,
					candidate,
					this.#host.modelRegistry.resolver(candidate, advisorProviderSessionId),
					undefined,
					signal,
					{
						thinkingLevel: advisorCompactionThinkingLevel,
						convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
						telemetry,
						tools: agent.state.tools,
						sessionId: advisorProviderSessionId,
						promptCacheKey: advisorProviderSessionId,
						metadata: advisorMetadata,
						providerSessionState: this.#host.providerSessionState,
						preferWebsockets: this.#host.preferWebsockets,
						codexCompaction,
					},
				);
				break;
			} catch (error) {
				if (signal.aborted) throw error;
				const id = AIError.classify(error, candidate.api);
				if (error instanceof NativeCompactionError && !AIError.is(id, AIError.Flag.AuthFailed)) {
					nativeCompactionFailure ??= { error, provider: candidate.provider };
					lastError = nativeCompactionFailure.error;
					continue;
				}
				lastError = error;
			}
		}

		if (!compactResult && nativeCompactionFailure) throw nativeCompactionFailure.error;

		if (!compactResult) {
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: String(lastError) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;

		const advisorUsageAnchorStartIndex = preparation.recentMessages.length + 1;
		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), { shortSummary }),
			firstKeptEntryId,
			advisorUsageAnchorStartIndex,
		} satisfies AdvisorCompactionSummaryMessage;

		agent.replaceMessages([summaryMessage, ...preparation.recentMessages]);
		return false;
	}
	stats(name: string, cost: number): PerAdvisorStat {
		const model = this.agent.state.model;
		const messages = this.agent.state.messages;
		const contextTokens = this.#estimateContextTokens(messages, this.agent.tokenizer);
		let input = 0;
		let output = 0;
		let reasoning = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let user = 0;
		let assistant = 0;
		for (const message of messages) {
			if (message.role === "user") user++;
			if (message.role === "assistant") {
				assistant++;
				const assistantMsg = message as AssistantMessage;
				input += assistantMsg.usage.input;
				output += assistantMsg.usage.output;
				reasoning += assistantMsg.usage.reasoningTokens ?? 0;
				cacheRead += assistantMsg.usage.cacheRead;
				cacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
			}
		}
		return {
			name,
			status: this.runtime.quotaExhausted ? "quota_exhausted" : this.runtime.failureNotified ? "error" : "running",
			model,
			contextWindow: model.contextWindow ?? 0,
			contextTokens,
			tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
			cost,
			messages: { user, assistant, total: messages.length },
			sessionId: this.agent.sessionId,
		};
	}
	#estimateContextTokens(messages: AgentMessage[], tokenizer: Tokenizer): number {
		let usageAnchorStartIndex = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "compactionSummary") continue;
			const advisorSummary = message as AdvisorCompactionSummaryMessage;

			usageAnchorStartIndex = advisorSummary.advisorUsageAnchorStartIndex ?? messages.length;
			break;
		}
		return estimateTranscriptTokens(messages, tokenizer, {
			anchorFromIndex: usageAnchorStartIndex,
			excludeEncryptedReasoning: true,
		});
	}
}
