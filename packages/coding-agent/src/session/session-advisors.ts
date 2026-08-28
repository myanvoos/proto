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
import { isUsageLimitOutcome, resolveModelServiceTier, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	AdviseTool,
	type AdvisorAgent,
	type AdvisorConfig,
	AdvisorEmissionGuard,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	type AdvisorRuntimeStatus,
	type AdvisorSeverity,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	buildAdvisorQuarantineSourceText,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
	quarantineAdvisorUnsafeOutput,
	resolveAdvisorDeliveryChannel,
	slugifyAdvisorName,
} from "../advisor";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	resolveAdvisorRoleSelection,
	resolveModelOverride,
} from "../config/model-resolver";
import { MODEL_ROLES } from "../config/model-roles";
import { serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import type { Settings } from "../config/settings";
import { CursorExecHandlers, type CursorMcpResourceAdapter } from "../cursor";
import { bridgeToolMap } from "../cursor-bridge-tools";
import { estimateToolSchemaTokens } from "../modes/utils/context-usage";
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import { resolveThinkingLevelForModel, shouldDisableReasoning, toReasoningEffort } from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ClientBridge } from "./client-bridge";
import { resolveCompactionMethodOrder } from "./compaction-methods";
import type { CustomMessage, CustomMessagePayload } from "./messages";
import { isAdvisorCard, isTerminalTextAssistantAnswer } from "./queued-messages";
import {
	formatRetryFallbackSelector,
	getRetryFallbackRevertPolicy,
	parseRetryFallbackSelector,
	type RetryFallbackSelector,
} from "./retry-fallback-chains";
import type { CompactionEntry, SessionEntry } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import type { SessionManager } from "./session-manager";
import { buildSessionMetadata } from "./session-metadata";
import type { YieldQueue } from "./yield-queue";

const ADVISOR_CODEX_SSE_MAX_ATTEMPTS = 1;

export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};

	advisors: PerAdvisorStat[];
}

export interface PerAdvisorStat {
	name: string;
	status: AdvisorRuntimeStatus;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
	sessionId?: string;
}

interface AdvisorRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel;
	lastAppliedThinkingLevel: ThinkingLevel;
}

interface ActiveAdvisor {
	name: string;
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
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

interface AdvisorCompactionSummaryMessage extends CompactionSummaryMessage {
	firstKeptEntryId?: string;
	advisorUsageAnchorStartIndex?: number;
}

interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
}

interface SessionAdvisorsOptions {
	enabled: boolean;
	tools?: AgentTool[];

	createEditTool?(): AgentTool | undefined;

	getToolContext?: () => AgentToolContext | undefined;

	mcpResources?: CursorMcpResourceAdapter;
	watchdogPrompt?: string;
	sharedInstructions?: string;
	contextPrompt?: string;
	configs?: AdvisorConfig[];
	streamFn?: StreamFn;
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	initialCosts?: ReadonlyMap<string, number>;
}

interface AdvisorMessageDeliveryOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
	queueChipText?: string;
	acceptTerminalEmptyStop?: boolean;
}

export interface SessionAdvisorsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	yieldQueue: YieldQueue;
	obfuscator: SecretObfuscator | undefined;
	providerSessionState: Map<string, ProviderSessionState>;
	preferWebsockets: boolean | undefined;
	onPayload: SimpleStreamOptions["onPayload"] | undefined;
	onResponse: SimpleStreamOptions["onResponse"] | undefined;
	onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	isDisposed(): boolean;
	abortInProgress(): boolean;
	allowAgentInitiatedTurns(): boolean;
	clientBridge(): ClientBridge | undefined;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	sendCustomMessage(message: CustomMessagePayload, options?: AdvisorMessageDeliveryOptions): Promise<boolean>;
	extractQueuedAdvisorCards(): CustomMessage[];
	dropPendingAdvisorCards(): void;
	preserveAdvisorCard(card: CustomMessage): void;
	hasPendingNextTurnMessages(): boolean;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	resolveContextPromotionTarget(
		currentModel: Model,
		contextWindow: number,
		signal: AbortSignal,
	): Promise<Model | undefined>;
	resolveCompactionModelCandidates(preferredModel: Model | null | undefined, availableModels: Model[]): Model[];
	resolveRetryFallbackRole(
		currentSelector: string,
		currentModel?: Model | null,
		roleHint?: string,
	): string | undefined;
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

export class SessionAdvisors {
	readonly #host: SessionAdvisorsHost;
	#advisorEnabled: boolean;
	#advisorTools: AgentTool[] | undefined;
	#advisorCreateEditTool: SessionAdvisorsOptions["createEditTool"];
	#advisorGetToolContext: SessionAdvisorsOptions["getToolContext"];
	#advisorMcpResources: SessionAdvisorsOptions["mcpResources"];
	#advisorWatchdogPrompt: string | undefined;
	#advisorSharedInstructions: string | undefined;
	#advisorContextPrompt: string | undefined;
	#advisorStreamFn: StreamFn | undefined;
	#transformProviderContext: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
	#advisors: ActiveAdvisor[] = [];
	#advisorConfigs: AdvisorConfig[] | undefined;
	#advisorStatuses = new Map<string, { name: string; status: AdvisorRuntimeStatus }>();
	#advisorProviderSessionIds = new Map<string, string>();
	#advisorCosts = new Map<string, number>();
	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	#advisorAutoResumeSuppressed = false;
	#preserveAdvisorAdvice = false;
	#advisorPrimaryTurnsCompleted = 0;
	#advisorInterruptImmuneTurnStart: number | undefined;
	#pendingAdvisorCardEvents = new Set<Promise<void>>();
	#advisorYieldQueueUnsubscribe: (() => void) | undefined;

	constructor(host: SessionAdvisorsHost, options: SessionAdvisorsOptions) {
		this.#host = host;
		this.#advisorEnabled = options.enabled;
		this.#advisorTools = options.tools;
		this.#advisorCreateEditTool = options.createEditTool;
		this.#advisorGetToolContext = options.getToolContext;
		this.#advisorMcpResources = options.mcpResources;
		this.#advisorWatchdogPrompt = options.watchdogPrompt;
		this.#advisorSharedInstructions = options.sharedInstructions;
		this.#advisorContextPrompt = options.contextPrompt;
		this.#advisorConfigs = options.configs;
		this.#advisorStreamFn = options.streamFn;
		this.#transformProviderContext = options.transformProviderContext;
		if (options.initialCosts) this.#advisorCosts = new Map(options.initialCosts);
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();
	}

	async onPrimaryTurnEnd(
		messages: AgentMessage[],
		willContinue: boolean | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		this.#advisorPrimaryTurnsCompleted++;
		for (const advisor of this.#advisors) {
			if (advisor.runtime.disposed) continue;
			try {
				advisor.runtime.onTurnEnd(messages, { willContinue });
			} catch (error) {
				logger.warn("advisor onTurnEnd threw; delta dropped", { advisor: advisor.name, err: String(error) });
			}
		}
		const syncBacklog = this.#host.settings.get("advisor.syncBacklog");
		if (this.#advisors.length === 0 || syncBacklog === "off") return;
		const threshold = Number.parseInt(syncBacklog, 10);
		await Promise.all(this.#advisors.map(advisor => advisor.runtime.waitForCatchup(30_000, threshold, signal)));
	}

	onModelRolesChanged(): void {
		if (!this.#advisorEnabled || this.#host.isDisposed()) return;
		if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
	}

	hasInactiveNoModelAdvisor(): boolean {
		if (!this.#advisorEnabled) return false;
		for (const entry of this.#advisorStatuses.values()) {
			if (entry.status === "no_model") return true;
		}
		return false;
	}

	retryAfterModelDiscovery(): boolean {
		if (this.#host.isDisposed() || !this.hasInactiveNoModelAdvisor()) return false;
		const before = this.#advisors.length;
		if (before > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true, false);
		return this.#advisors.length > before;
	}

	buildRuntime(seedToCurrent = false): boolean {
		return this.#buildAdvisorRuntime(seedToCurrent);
	}

	stopRuntime(): void {
		this.#stopAdvisorRuntime();
	}

	async drainAndDetachRecorders(): Promise<void> {
		await Promise.all(this.#advisors.map(advisor => advisor.runtime.pauseForSessionTransition()));
		await this.detachAndCloseRecorders();
	}

	async detachAndCloseRecorders(): Promise<void> {
		const closes: Promise<void>[] = [];
		for (const advisor of this.#advisors) {
			advisor.agentUnsubscribe?.();
			advisor.agentUnsubscribe = undefined;
			advisor.recorderClosed = advisor.recorder.close();
			closes.push(advisor.recorderClosed);
		}
		await Promise.all(closes);
	}

	reattachRecorderFeeds(): void {
		for (const advisor of this.#advisors) {
			if (!advisor.agentUnsubscribe) this.#attachAdvisorRecorderFeed(advisor);
			advisor.runtime.resumeAfterSessionTransition();
		}
	}

	resetSessionState(options: { preserveCost?: boolean } = {}): void {
		this.#resetAdvisorSessionState(options.preserveCost === true);
	}

	clearCost(): void {
		this.#advisorCosts.clear();
	}

	restoreCost(costs: ReadonlyMap<string, number>): void {
		this.#advisorCosts = new Map(costs);
	}

	refreshProviderIdentity(): void {
		for (const advisor of this.#advisors) this.#refreshAdvisorProviderIdentity(advisor);
	}

	resetAllRuntimes(reason?: string): void {
		this.#resetAllAdvisorRuntimes(reason);
	}

	runtimeMatchesCurrentConfig(): boolean {
		return this.#advisorRuntimeMatchesCurrentConfig();
	}

	isInterruptImmuneTurnActive(): boolean {
		return this.#isAdvisorInterruptImmuneTurnActive();
	}

	recorderClosed(): Promise<void> {
		return this.#advisorRecorderClosed;
	}

	get autoResumeSuppressed(): boolean {
		return this.#advisorAutoResumeSuppressed;
	}

	set autoResumeSuppressed(value: boolean) {
		this.#advisorAutoResumeSuppressed = value;
	}

	trackCardEvent(processing: Promise<void>): void {
		this.#pendingAdvisorCardEvents.add(processing);
		void processing.finally(() => this.#pendingAdvisorCardEvents.delete(processing)).catch(() => {});
	}

	async waitForPendingCardEvents(): Promise<void> {
		await Promise.allSettled([...this.#pendingAdvisorCardEvents]);
	}

	#advisorImmuneTurnLimit(): number {
		const immuneTurns = this.#host.settings.get("advisor.immuneTurns") as number;
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isAdvisorInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#advisorPrimaryTurnsCompleted,
			immuneTurnStart: this.#advisorInterruptImmuneTurnStart,
			immuneTurns: this.#advisorImmuneTurnLimit(),
		});
	}

	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	#refreshAdvisorProviderIdentity(advisor: ActiveAdvisor): void {
		const primaryProviderSessionId = this.#host.sessionId();
		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			primaryProviderSessionId,
			advisor.slug,
		);
		advisor.providerSessionId = providerSessionId;
		advisor.agent.sessionId = providerSessionId;
		advisor.agent.promptCacheKey = this.#host.agent.promptCacheKey ?? providerSessionId;
		advisor.agent.getApiKey = requestModel => this.#host.modelRegistry.resolver(requestModel, providerSessionId);
		advisor.agent.setMetadataResolver(
			providerSessionId
				? provider => buildSessionMetadata(providerSessionId, provider, this.#host.modelRegistry.authStorage)
				: undefined,
		);

		const telemetry = advisor.agent.telemetry;
		if (telemetry?.agent) {
			advisor.agent.setTelemetry({
				...telemetry,
				agent: {
					...telemetry.agent,
					id: advisor.slug
						? `${primaryProviderSessionId}-advisor-${advisor.slug}`
						: `${primaryProviderSessionId}-advisor`,
				},
			});
		}
	}

	#resetAdvisorSessionState(preserveCost: boolean): void {
		if (!preserveCost) this.#advisorCosts.clear();

		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.reset("conversation-boundary");
			a.adviseTool.resetDeliveredNotes();
			a.emissionGuard.reset();
			this.#attachAdvisorRecorderFeed(a);
		}
		this.#advisorPrimaryTurnsCompleted = 0;
		this.#advisorInterruptImmuneTurnStart = undefined;
		this.#advisorAutoResumeSuppressed = false;
		this.#host.yieldQueue.clear("advisor");
		this.#host.extractQueuedAdvisorCards();
		this.#host.dropPendingAdvisorCards();
	}

	#resolveAdvisorRuntimeDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const legacy = !this.#advisorConfigs?.length;
		const roster: AdvisorConfig[] = legacy ? [{ name: "default" }] : this.#advisorConfigs!;
		const descriptors: AdvisorRuntimeDescriptor[] = [];
		const usedSlugs = new Set<string>();
		for (const config of roster) {
			let slug = legacy ? "" : slugifyAdvisorName(config.name);
			if (slug) {
				let candidate = slug;
				let n = 2;
				while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
				slug = candidate;
				usedSlugs.add(slug);
			}

			if (config.enabled === false) {
				this.#advisorStatuses.set(slug, { name: config.name, status: "paused" });
				continue;
			}

			let model: Model | undefined;
			let thinkingLevel: ThinkingLevel | undefined;
			if (config.model) {
				const resolved = resolveModelOverride([config.model], this.#host.modelRegistry, this.#host.settings);
				model = resolved.model;
				thinkingLevel = resolved.thinkingLevel;
				if (!model) {
					this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
					if (emitWarnings) {
						this.#host.emitNotice(
							"warning",
							`Advisor "${config.name}": no model matched "${config.model}"`,
							"advisor",
						);
					}
					continue;
				}
			} else {
				const sel = resolveAdvisorRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
				if (!sel) {
					this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
					if (emitWarnings) {
						logger.debug("advisor enabled but no model assigned to the 'advisor' role; advisor inactive", {
							advisor: config.name,
						});
					}
					continue;
				}
				model = sel.model;
				thinkingLevel = sel.thinkingLevel;
			}

			const requestedLevel = thinkingLevel ?? ThinkingLevel.Medium;
			const resolvedLevel = resolveThinkingLevelForModel(model, requestedLevel);
			const advisorThinkingLevel: ThinkingLevel = resolvedLevel ?? ThinkingLevel.Inherit;

			this.#advisorStatuses.set(slug, { name: config.name, status: "running" });
			descriptors.push({
				config,
				name: config.name,
				slug,
				model,
				thinkingLevel: advisorThinkingLevel,
				signature: this.#advisorRuntimeSignature(config, slug, model, advisorThinkingLevel),
			});
		}
		return descriptors;
	}

	#advisorRuntimeSignature(config: AdvisorConfig, slug: string, model: Model, thinkingLevel: ThinkingLevel): string {
		const tools = config.tools?.length ? config.tools.join("\u001e") : "";
		const instructions = config.instructions?.trim() ?? "";
		return [config.name, slug, formatModelStringWithRouting(model), thinkingLevel, tools, instructions].join(
			"\u001f",
		);
	}

	#advisorRuntimeMatchesCurrentConfig(): boolean {
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			if (descriptors[i].signature !== this.#advisors[i].signature) return false;
		}
		return true;
	}

	#buildAdvisorRuntime(seedToCurrent = false, emitWarnings = true): boolean {
		if (this.#host.isDisposed()) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#advisorEnabled) return false;

		this.#advisorStatuses.clear();
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(emitWarnings);

		const advisorTierSetting = this.#host.settings.get("tier.advisor");
		const advisorTierMap =
			advisorTierSetting === "inherit"
				? undefined
				: serviceTierForAllFamilies(serviceTierSettingToTier(advisorTierSetting));
		const advisorServiceTierResolver = (model: Model): ServiceTier | undefined =>
			advisorTierSetting === "inherit"
				? this.#host.effectiveServiceTier(model)
				: resolveModelServiceTier(advisorTierMap, model);

		for (const descriptor of descriptors) {
			const {
				config,
				slug,
				model: advisorModel,
				name: advisorName,
				thinkingLevel: advisorThinkingLevel,
				signature,
			} = descriptor;

			const emissionGuard = new AdvisorEmissionGuard();
			const adviseTool = new AdviseTool((note, severity) => this.#routeAdvice(advisorRef, note, severity));

			const systemPrompt = [advisorSystemPrompt];
			if (this.#advisorContextPrompt) systemPrompt.push(this.#advisorContextPrompt);
			if (this.#advisorWatchdogPrompt) systemPrompt.push(this.#advisorWatchdogPrompt);
			if (this.#advisorSharedInstructions) systemPrompt.push(this.#advisorSharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const names = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
			const tools = (this.#advisorTools ?? []).filter(t => names.has(t.name));
			const advisorLoopTools: AgentTool<any>[] = [adviseTool, ...tools];
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
			let quarantinedAdvisorOutput: string | undefined;
			let currentAdvisorInput = "";

			const primaryProviderSessionId = this.#host.sessionId();
			const advisorSessionLabel = slug
				? `${primaryProviderSessionId}-advisor-${slug}`
				: `${primaryProviderSessionId}-advisor`;
			const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
				this.#advisorProviderSessionIds,
				primaryProviderSessionId,
				slug,
			);
			const appendOnlyContext = new AppendOnlyContextManager();

			const advisorTelemetry = this.#host.agent.telemetry
				? {
						...this.#host.agent.telemetry,
						agent: {
							id: advisorSessionLabel,
							name: slug ? `${MODEL_ROLES.advisor.name}: ${advisorName}` : MODEL_ROLES.advisor.name,
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
				tools: bridgeToolMap(advisorToolMap, this.#advisorCreateEditTool),

				getToolContext: this.#advisorGetToolContext,
				allowDirectFileMutation: advisorCanMutateFiles,

				mcpResources: this.#advisorMcpResources,
			});
			const baseAdvisorStreamFn = this.#advisorStreamFn ?? streamSimple;
			const advisorStreamFn: StreamFn = (requestModel, context, options) => {
				if (requestModel.api === "openai-codex-responses") {
					return baseAdvisorStreamFn(requestModel, context, {
						...options,
						codexSseMaxAttempts: ADVISOR_CODEX_SSE_MAX_ATTEMPTS,
					});
				}
				if (
					requestModel.api === "google-generative-ai" ||
					requestModel.api === "google-gemini-cli" ||
					requestModel.api === "google-vertex"
				) {
					return baseAdvisorStreamFn(requestModel, context, { ...options, acceptEmptyResponse: true });
				}
				return baseAdvisorStreamFn(requestModel, context, options);
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
				transformProviderContext: this.#transformProviderContext,
				intentTracing: false,
				transformAssistantMessage: message => {
					quarantinedAdvisorOutput = quarantineAdvisorUnsafeOutput(
						message,
						availableAdvisorToolNames,
						buildAdvisorQuarantineSourceText(currentAdvisorInput, advisorAgent.state.messages),
					);
				},
				telemetry: advisorTelemetry,
				serviceTier: undefined,
				serviceTierResolver: advisorServiceTierResolver,
			});
			advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));

			const advisorAgentFacade: AdvisorAgent = {
				prompt: async input => {
					let quarantined: string | undefined;
					try {
						quarantinedAdvisorOutput = undefined;

						currentAdvisorInput = Array.isArray(input)
							? formatSessionHistoryMarkdown(input, { watchedRoles: true })
							: input;

						if (Array.isArray(input)) await advisorAgent.prompt(input);
						else await advisorAgent.prompt(input);
						quarantined = quarantinedAdvisorOutput;
					} finally {
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = "";
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

			const recorder = new AdvisorTranscriptRecorder(
				() => this.#host.sessionManager.getSessionFile(),
				() => this.#host.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),

				this.#advisorRecorderClosed,
			);
			const runtime = new AdvisorRuntime(advisorAgentFacade, {
				snapshotMessages: () => this.#host.agent.state.messages,
				enqueueAdvice: (note, severity) => this.#routeAdvice(advisorRef, note, severity),
				maintainContext: (incoming, signal) => this.#maintainAdvisorContext(advisorRef, incoming, signal),
				obfuscator: this.#host.obfuscator,
				getModelIdentity: () => formatModelString(advisorRef.agent.state.model),
				beginAdvisorUpdate: inProgress => {
					advisorRef.adviseTool.beginUpdate(inProgress);
					advisorRef.emissionGuard.beginUpdate();
				},
				onTurnError: (error, failedMessages, signal) =>
					this.#recoverAdvisorTurn(advisorRef, error, failedMessages, signal),
				onTurnSuccess: async () => {
					const fallback = advisorRef.retryFallback;
					if (!advisorRef.retryFallbackPendingSuccess || !fallback) return;
					advisorRef.retryFallbackPendingSuccess = false;
					await this.#host.emitSessionEvent({
						type: "retry_fallback_succeeded",
						model: formatRetryFallbackSelector(advisorRef.agent.state.model, advisorRef.thinkingLevel),
						role: fallback.role,
					});
				},
				notifyFailure: error => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "error" });
					const message = error instanceof Error ? error.message : String(error);
					this.#host.emitNotice(
						"warning",
						`Advisor${slug ? ` "${advisorName}"` : ""} unavailable for ${formatModelString(advisorAgent.state.model)}: ${message}`,
						"advisor",
					);
				},
				notifyQuotaExhausted: () => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "quota_exhausted" });
					this.#host.emitNotice(
						"warning",
						`Advisor "${advisorName}" quota exhausted — pausing until reset.`,
						"advisor",
					);
				},
			});

			const advisorRef: ActiveAdvisor = {
				name: advisorName,
				slug,
				agent: advisorAgent,
				runtime,
				adviseTool,
				emissionGuard,
				recorder,
				recorderClosed: Promise.resolve(),
				model: advisorModel,
				thinkingLevel: advisorThinkingLevel,
				providerSessionId: advisorProviderSessionId,
				retryFallbackPendingSuccess: false,
				signature,
			};
			this.#refreshAdvisorProviderIdentity(advisorRef);
			this.#attachAdvisorRecorderFeed(advisorRef);
			if (seedToCurrent) runtime.seedTo(this.#host.agent.state.messages.length);
			this.#advisorStatuses.set(slug, { name: advisorName, status: "running" });
			this.#advisors.push(advisorRef);
		}

		if (this.#advisors.length > 0 && !this.#advisorYieldQueueUnsubscribe) {
			this.#advisorYieldQueueUnsubscribe = this.#host.yieldQueue.register<AdvisorNote>("advisor", {
				build: entries =>
					entries.length === 0
						? null
						: ({
								role: "custom",
								customType: "advisor",
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
								content: formatAdvisorBatchContent(entries),
								details: { notes: entries } satisfies AdvisorMessageDetails,
							} satisfies CustomMessage),
				skipIdleFlush: true,
			});
		}

		return this.#advisors.length > 0;
	}

	#hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.#host.agent.hasQueuedMessages() || this.#host.hasPendingNextTurnMessages()) return false;
		const messages = this.#host.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	#routeAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity): void {
		if (!advisor.emissionGuard.accept(note)) {
			logger.debug("advisor advice suppressed by emission guard", { severity, advisor: advisor.name });
			return;
		}

		const source = advisor.slug ? advisor.name : undefined;
		const interrupting = isInterruptingSeverity(severity);
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
			preserveOnly: this.#preserveAdvisorAdvice,

			streaming: this.#host.agent.state.isStreaming,
			aborting: this.#host.abortInProgress(),
			terminalAnswerNoQueuedWork: this.#hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: interrupting && this.#isAdvisorInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			this.#host.yieldQueue.enqueue("advisor", { note, severity, advisor: source });
			return;
		}
		const notes: AdvisorNote[] = [{ note, severity, advisor: source }];
		const content = formatAdvisorBatchContent(notes);
		const details = { notes } satisfies AdvisorMessageDetails;
		if (channel === "preserve") {
			this.#host.preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}

		const cannotAutoTrigger =
			!this.#host.agent.state.isStreaming &&
			this.#host.clientBridge()?.deferAgentInitiatedTurns === true &&
			!this.#host.allowAgentInitiatedTurns();
		if (cannotAutoTrigger) {
			this.#host.preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}

		this.#recordAdvisorInterruptDelivered();
		void this.#host
			.sendCustomMessage(
				{ customType: "advisor", content, display: true, attribution: "agent", details },
				{ deliverAs: "steer", triggerTurn: true },
			)
			.catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
	}

	#resetAllAdvisorRuntimes(reason?: string): void {
		for (const a of this.#advisors) a.runtime.reset(reason);
	}

	#stopAdvisorRuntime(): void {
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.dispose();

			a.recorderClosed = a.recorder.close();
			closes.push(a.recorderClosed);
		}
		this.#advisorRecorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	#recordAdvisorCost(advisor: ActiveAdvisor, message: AssistantMessage): void {
		this.#advisorCosts.set(advisor.slug, (this.#advisorCosts.get(advisor.slug) ?? 0) + message.usage.cost.total);
	}

	#attachAdvisorRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant") this.#recordAdvisorCost(advisor, event.message);
			advisor.recorder.record(event.message);
		});
	}

	#setAdvisorModel(advisor: ActiveAdvisor, model: Model, requestedThinkingLevel: ThinkingLevel): ThinkingLevel {
		const resolvedThinkingLevel = resolveThinkingLevelForModel(model, requestedThinkingLevel);
		const nextThinkingLevel = resolvedThinkingLevel ?? ThinkingLevel.Inherit;
		advisor.agent.setModel(model);
		advisor.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel));
		advisor.agent.setDisableReasoning(shouldDisableReasoning(nextThinkingLevel));
		advisor.agent.appendOnlyContext?.invalidateForModelChange();
		advisor.model = model;
		advisor.thinkingLevel = nextThinkingLevel;
		return nextThinkingLevel;
	}

	async #maybeRestoreAdvisorRetryFallbackPrimary(advisor: ActiveAdvisor, signal: AbortSignal): Promise<void> {
		const fallback = advisor.retryFallback;
		if (!fallback || getRetryFallbackRevertPolicy(this.#host.settings) !== "cooldown-expiry") return;

		const originalSelector = parseRetryFallbackSelector(fallback.originalSelector, this.#host.modelRegistry);
		if (!originalSelector) {
			advisor.retryFallback = undefined;
			advisor.retryFallbackPendingSuccess = false;
			return;
		}
		const currentSelector = formatRetryFallbackSelector(advisor.agent.state.model, advisor.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#host.isRetryFallbackSelectorSuppressed(originalSelector)) {
				advisor.retryFallback = undefined;
				advisor.retryFallbackPendingSuccess = false;
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
		const apiKey = await this.#host.modelRegistry.getApiKey(primaryModel, advisor.providerSessionId, { signal });
		if (!apiKey) return;
		signal.throwIfAborted();

		const thinkingToApply =
			advisor.thinkingLevel === fallback.lastAppliedThinkingLevel
				? fallback.originalThinkingLevel
				: advisor.thinkingLevel;
		this.#setAdvisorModel(advisor, primaryModel, thinkingToApply);
		this.#host.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(primaryModel));
		advisor.retryFallback = undefined;
		advisor.retryFallbackPendingSuccess = false;
	}

	async #recoverAdvisorTurn(
		advisor: ActiveAdvisor,
		error: unknown,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean> {
		if (error instanceof AdvisorOutputQuarantinedError) return false;

		const failedMessage = failedMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const assistantFailure = failedMessage?.stopReason === "error" ? failedMessage : undefined;
		if (assistantFailure?.content.some(block => block.type === "toolCall")) return false;

		const currentModel = advisor.agent.state.model;
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
				advisor.providerSessionId,
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
				advisor.providerSessionId,
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

		const currentSelector = formatRetryFallbackSelector(currentModel, advisor.thinkingLevel);

		const retrySettings = this.#host.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;

		const chainKeys = this.#host.retryFallbackChainKeys(currentSelector, currentModel, {
			pinnedRole: advisor.retryFallback?.role,
			roleHint: "advisor",
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
				const apiKey = await this.#host.modelRegistry.getApiKey(candidate, advisor.providerSessionId, { signal });
				if (!apiKey) continue;
				signal.throwIfAborted();

				const originalThinkingLevel = advisor.thinkingLevel;
				const requestedThinkingLevel = selector.thinkingLevel ?? originalThinkingLevel;
				const nextThinkingLevel = this.#setAdvisorModel(advisor, candidate, requestedThinkingLevel);
				if (advisor.retryFallback) {
					advisor.retryFallback.lastAppliedThinkingLevel = nextThinkingLevel;
				} else {
					advisor.retryFallback = {
						role,
						originalSelector: currentSelector,
						originalThinkingLevel,
						lastAppliedThinkingLevel: nextThinkingLevel,
					};
				}
				advisor.retryFallbackPendingSuccess = true;
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

	async #promoteAdvisorContextModel(
		advisor: ActiveAdvisor,
		currentModel: Model,
		signal: AbortSignal,
	): Promise<boolean> {
		const promotionSettings = this.#host.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#host.resolveContextPromotionTarget(currentModel, contextWindow, signal);
		if (!targetModel) return false;
		signal.throwIfAborted();

		const advisorThinkingLevel = advisor.thinkingLevel;
		try {
			this.#setAdvisorModel(advisor, targetModel, advisorThinkingLevel);
			logger.debug("Advisor context promotion switched model on overflow", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Advisor context promotion failed", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #maintainAdvisorContext(
		advisor: ActiveAdvisor,
		incoming: AgentMessage,
		signal: AbortSignal,
	): Promise<boolean> {
		await this.#maybeRestoreAdvisorRetryFallbackPrimary(advisor, signal);
		const agent = advisor.agent;
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

		const providerContextTokens = this.#estimateAdvisorContextTokens(messages, agent.tokenizer) + incomingTokens;
		const localContextTokens =
			agent.tokenizer.countTokens(agent.state.systemPrompt) +
			estimateToolSchemaTokens(agent.state.tools, agent.tokenizer) +
			storedConversationTokens +
			incomingTokens;
		const contextTokens = compactionContextTokens(providerContextTokens, localContextTokens);

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		if (await this.#promoteAdvisorContextModel(advisor, advisorModel, signal)) {
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
		const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			this.#host.sessionId(),
			advisor.slug,
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

	prepareForHeadlessAdvisorDrain(): void {
		this.#preserveAdvisorAdvice = true;
	}

	async #waitForPendingAdvisorCardEvents(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (this.#pendingAdvisorCardEvents.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = Promise.allSettled([...this.#pendingAdvisorCardEvents]).then(() => true as const);
			const { promise: timedOut, resolve } = Promise.withResolvers<false>();
			const timer = setTimeout(() => resolve(false), remainingMs);
			try {
				if (!(await Promise.race([settled, timedOut]))) return false;
			} finally {
				clearTimeout(timer);
			}
		}
		return true;
	}

	async waitForAdvisorCatchup(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const results = await Promise.all(this.#advisors.map(advisor => advisor.runtime.waitForCatchup(timeoutMs, 1)));
		const cardEventsCaughtUp = await this.#waitForPendingAdvisorCardEvents(Math.max(0, deadline - Date.now()));
		const abandoned = this.#advisors.filter(
			(advisor, index) => results[index] === false && advisor.runtime.backlog > 0,
		);
		if (abandoned.length > 0 || !cardEventsCaughtUp) {
			logger.warn("advisor shutdown drain incomplete; disposal will abandon reviews or cards", {
				timeoutMs,
				advisors: abandoned.map(advisor => ({ name: advisor.name, backlog: advisor.runtime.backlog })),
				pendingAdvisorCards: this.#pendingAdvisorCardEvents.size,
			});
			return false;
		}
		return true;
	}

	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
	}

	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		this.#advisorConfigs = advisors;
		this.#advisorSharedInstructions = sharedInstructions;
		if (!this.#advisorEnabled) return 0;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
		return this.#advisors.length;
	}

	setContextPrompt(contextPrompt: string | undefined): void {
		if (contextPrompt === this.#advisorContextPrompt) return;
		this.#advisorContextPrompt = contextPrompt;
		if (!this.#advisorEnabled || this.#advisors.length === 0) return;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
	}

	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	isAdvisorActive(): boolean {
		return this.#advisors.length > 0;
	}

	getAdvisorAvailableToolNames(): string[] {
		return (this.#advisorTools ?? []).map(tool => tool.name);
	}

	getAdvisorAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	getAdvisorStatusOverview(): { configured: boolean; advisors: { name: string; status: AdvisorRuntimeStatus }[] } {
		const liveStatusBySlug = new Map<string, AdvisorRuntimeStatus>();
		for (const a of this.#advisors) {
			liveStatusBySlug.set(
				a.slug,
				a.runtime.quotaExhausted ? "quota_exhausted" : a.runtime.failureNotified ? "error" : "running",
			);
		}
		const advisors = [...this.#advisorStatuses.entries()].map(([slug, { name, status }]) => ({
			name,
			status: liveStatusBySlug.get(slug) ?? status,
		}));
		return { configured: this.#advisorEnabled, advisors };
	}

	getAdvisorCost(): number {
		let cost = 0;
		for (const advisorCost of this.#advisorCosts.values()) cost += advisorCost;
		return cost;
	}

	isUsingSubscription(): boolean {
		if (this.#advisors.length > 0) {
			return this.#advisors.some(a => this.#host.modelRegistry.isUsingOAuth(a.model));
		}
		const sel = resolveAdvisorRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
		return sel ? this.#host.modelRegistry.isUsingOAuth(sel.model) : false;
	}

	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const liveAdvisors = this.#advisors.map(a => this.#computeAdvisorStat(a));

		const liveStatBySlug = new Map(this.#advisors.map((a, i) => [a.slug, liveAdvisors[i]]));
		const roster: PerAdvisorStat[] = [];
		for (const [slug, entry] of this.#advisorStatuses) {
			const live = liveStatBySlug.get(slug);
			if (live) {
				roster.push(live);
			} else {
				roster.push({
					name: entry.name,
					status: entry.status,
					contextWindow: 0,
					contextTokens: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: this.#advisorCosts.get(slug) ?? 0,
					messages: { user: 0, assistant: 0, total: 0 },
				});
			}
		}
		const active = liveAdvisors.length > 0;
		const cost = this.getAdvisorCost();
		if (liveAdvisors.length === 0) {
			return {
				configured,
				active,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost,
				messages: { user: 0, assistant: 0, total: 0 },
				advisors: roster,
			};
		}
		const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const messages = { user: 0, assistant: 0, total: 0 };
		let contextTokens = 0;
		for (const a of liveAdvisors) {
			tokens.input += a.tokens.input;
			tokens.output += a.tokens.output;
			tokens.reasoning += a.tokens.reasoning;
			tokens.cacheRead += a.tokens.cacheRead;
			tokens.cacheWrite += a.tokens.cacheWrite;
			tokens.total += a.tokens.total;
			messages.user += a.messages.user;
			messages.assistant += a.messages.assistant;
			messages.total += a.messages.total;
			contextTokens += a.contextTokens;
		}

		return {
			configured,
			active,
			model: liveAdvisors[0].model,
			contextWindow: liveAdvisors[0].contextWindow,
			contextTokens,
			tokens,
			cost,
			messages,
			advisors: roster,
		};
	}

	#computeAdvisorStat(advisor: ActiveAdvisor): PerAdvisorStat {
		const model = advisor.agent.state.model;
		const messages = advisor.agent.state.messages;
		const contextTokens = this.#estimateAdvisorContextTokens(messages, advisor.agent.tokenizer);
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
			name: advisor.name,
			status: advisor.runtime.quotaExhausted
				? "quota_exhausted"
				: advisor.runtime.failureNotified
					? "error"
					: "running",
			model,
			contextWindow: model.contextWindow ?? 0,
			contextTokens,
			tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
			cost: this.#advisorCosts.get(advisor.slug) ?? 0,
			messages: { user, assistant, total: messages.length },
			sessionId: advisor.agent.sessionId,
		};
	}

	formatAdvisorStatus(): string {
		const stats = this.getAdvisorStats();
		if (!stats.active && stats.advisors.length === 0) {
			return stats.configured
				? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
				: "Advisor is disabled.";
		}
		if (stats.advisors.length <= 1) {
			const s = stats.advisors[0];
			if (s && s.status === "no_model") {
				return stats.configured
					? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
					: "Advisor is disabled.";
			}
			const contextLine =
				s.contextWindow > 0
					? `Context: ${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `Context: ${s.contextTokens.toLocaleString()} tokens`;
			const spendParts = [`${s.tokens.input.toLocaleString()} input`, `${s.tokens.output.toLocaleString()} output`];
			if (s.tokens.cacheRead > 0) spendParts.push(`${s.tokens.cacheRead.toLocaleString()} cache read`);
			if (s.tokens.cacheWrite > 0) spendParts.push(`${s.tokens.cacheWrite.toLocaleString()} cache write`);
			const spendLine = `Spend: ${spendParts.join(", ")}, $${stats.cost.toFixed(4)}`;
			if (!s.model || s.status !== "running") return `Advisor "${s.name}" is ${s.status.replace("_", " ")}.`;
			return `Advisor is enabled (${s.model.provider}/${s.model.id}). ${contextLine}. ${spendLine}.`;
		}
		const lines = [`Advisors enabled (${stats.advisors.length}):`];
		for (const s of stats.advisors) {
			const ctx =
				s.contextWindow > 0
					? `${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `${s.contextTokens.toLocaleString()}`;
			lines.push(
				`  • ${s.name}${s.model && s.status === "running" ? ` (${s.model.provider}/${s.model.id})` : ` [${s.status}]`} — context ${ctx} tokens, $${s.cost.toFixed(4)}`,
			);
		}
		lines.push(
			`Totals: ${stats.tokens.input.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output, $${stats.cost.toFixed(4)}.`,
		);
		return lines.join("\n");
	}

	#estimateAdvisorContextTokens(messages: AgentMessage[], tokenizer: Tokenizer): number {
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
