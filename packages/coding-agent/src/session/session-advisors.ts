import {
	type Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	type StreamFn,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
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
import { resolveModelServiceTier } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import {
	AdviseTool,
	type AdvisorConfig,
	AdvisorEmissionGuard,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorRuntime,
	type AdvisorRuntimeStatus,
	type AdvisorSeverity,
	advisorTranscriptFilename,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
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
import type { CursorMcpResourceAdapter } from "../cursor";
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import { resolveThinkingLevelForModel } from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ClientBridge } from "./client-bridge";
import type { CustomMessage, CustomMessagePayload } from "./messages";
import { isAdvisorCard, isTerminalTextAssistantAnswer } from "./queued-messages";
import { formatRetryFallbackSelector, type RetryFallbackSelector } from "./retry-fallback-chains";
import { type ReviewerIdentity, ReviewerTransport } from "./reviewer-transport";
import type { SessionManager } from "./session-manager";
import { buildSessionMetadata } from "./session-metadata";
import type { YieldQueue } from "./yield-queue";

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

interface ActiveAdvisor {
	name: string;
	slug: string;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	instance: ReviewerTransport;
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
		for (const advisor of this.#advisors) advisor.instance.pushTurn(messages, willContinue);
		const syncBacklog = this.#host.settings.get("advisor.syncBacklog");
		if (this.#advisors.length === 0 || syncBacklog === "off") return;
		const threshold = Number.parseInt(syncBacklog, 10);
		await this.#awaitCatchup(threshold, 30_000, signal);
	}

	#awaitCatchup(threshold: number, capMs: number, signal?: AbortSignal): Promise<boolean[]> {
		return Promise.all(this.#advisors.map(advisor => advisor.instance.awaitCatchup(threshold, capMs, signal)));
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
		await Promise.all(this.#advisors.map(advisor => advisor.instance.runtime.pauseForSessionTransition()));
		await this.detachAndCloseRecorders();
	}

	async detachAndCloseRecorders(): Promise<void> {
		const closes: Promise<void>[] = [];
		for (const advisor of this.#advisors) {
			advisor.instance.agentUnsubscribe?.();
			advisor.instance.agentUnsubscribe = undefined;
			advisor.instance.recorderClosed = advisor.instance.recorder.close();
			closes.push(advisor.instance.recorderClosed);
		}
		await Promise.all(closes);
	}

	reattachRecorderFeeds(): void {
		for (const advisor of this.#advisors) {
			if (!advisor.instance.agentUnsubscribe) this.#attachAdvisorRecorderFeed(advisor);
			advisor.instance.runtime.resumeAfterSessionTransition();
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
		advisor.instance.providerSessionId = providerSessionId;
		advisor.instance.agent.sessionId = providerSessionId;
		advisor.instance.agent.promptCacheKey = this.#host.agent.promptCacheKey ?? providerSessionId;
		advisor.instance.agent.getApiKey = requestModel =>
			this.#host.modelRegistry.resolver(requestModel, providerSessionId);
		advisor.instance.agent.setMetadataResolver(
			providerSessionId
				? provider => buildSessionMetadata(providerSessionId, provider, this.#host.modelRegistry.authStorage)
				: undefined,
		);

		const telemetry = advisor.instance.agent.telemetry;
		if (telemetry?.agent) {
			advisor.instance.agent.setTelemetry({
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
			a.instance.resetForConversationBoundary();
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
			if (descriptors[i].signature !== this.#advisors[i].instance.signature) return false;
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

			const identity: ReviewerIdentity = {
				role: "advisor",
				name: advisorName,
				slug,

				sessionLabelSuffix: "advisor",
				transcriptFilename: advisorTranscriptFilename(slug),
				telemetryName: MODEL_ROLES.advisor.name,
				noticeLabel: "Advisor",
			};

			const emissionGuard = new AdvisorEmissionGuard();
			const adviseTool = new AdviseTool((note, severity) => this.#routeAdvice(advisorRef, note, severity));

			const systemPrompt = [advisorSystemPrompt];
			if (this.#advisorContextPrompt) systemPrompt.push(this.#advisorContextPrompt);
			if (this.#advisorWatchdogPrompt) systemPrompt.push(this.#advisorWatchdogPrompt);
			if (this.#advisorSharedInstructions) systemPrompt.push(this.#advisorSharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const transport = new ReviewerTransport(this.#host, {
				identity,
				model: advisorModel,
				thinkingLevel: advisorThinkingLevel,
				signature,
				systemPrompt,

				adviseTool,
				toolNames: config.tools,
				toolPool: this.#advisorTools,
				getToolContext: this.#advisorGetToolContext,
				mcpResources: this.#advisorMcpResources,

				providerSessionIds: this.#advisorProviderSessionIds,
				resolveProviderSessionId: getOrCreateAdvisorProviderSessionId,
				streamFn: this.#advisorStreamFn,
				transformProviderContext: this.#transformProviderContext,
				serviceTierResolver: advisorServiceTierResolver,

				recorderClosed: this.#advisorRecorderClosed,

				createRuntime: advisorAgentFacade =>
					new AdvisorRuntime(advisorAgentFacade, {
						snapshotMessages: () => this.#host.agent.state.messages,
						maintainContext: (incoming, signal) => advisorRef.instance.maintainContext(incoming, signal),
						obfuscator: this.#host.obfuscator,
						getModelIdentity: () => formatModelString(advisorRef.instance.agent.state.model),
						beginAdvisorUpdate: inProgress => {
							advisorRef.adviseTool.beginUpdate(inProgress);
							advisorRef.emissionGuard.beginUpdate();
						},
						onTurnError: (error, failedMessages, signal) =>
							advisorRef.instance.recoverTurn(error, failedMessages, signal),
						onTurnSuccess: async () => {
							const fallback = advisorRef.instance.retryFallback;
							if (!advisorRef.instance.retryFallbackPendingSuccess || !fallback) return;
							advisorRef.instance.retryFallbackPendingSuccess = false;
							await this.#host.emitSessionEvent({
								type: "retry_fallback_succeeded",
								model: formatRetryFallbackSelector(
									advisorRef.instance.agent.state.model,
									advisorRef.instance.thinkingLevel,
								),
								role: fallback.role,
							});
						},
						notifyFailure: error => {
							this.#advisorStatuses.set(slug, { name: advisorName, status: "error" });
							const message = error instanceof Error ? error.message : String(error);
							this.#host.emitNotice(
								"warning",
								`${identity.noticeLabel}${slug ? ` "${advisorName}"` : ""} unavailable for ${formatModelString(advisorRef.instance.agent.state.model)}: ${message}`,
								"advisor",
							);
						},
						notifyQuotaExhausted: () => {
							this.#advisorStatuses.set(slug, { name: advisorName, status: "quota_exhausted" });
							this.#host.emitNotice(
								"warning",
								`${identity.noticeLabel} "${advisorName}" quota exhausted — pausing until reset.`,
								"advisor",
							);
						},
					}),
			});

			const advisorRef: ActiveAdvisor = {
				name: advisorName,
				slug,
				adviseTool,
				emissionGuard,
				instance: transport,
			};
			this.#refreshAdvisorProviderIdentity(advisorRef);
			this.#attachAdvisorRecorderFeed(advisorRef);
			if (seedToCurrent) transport.runtime.seedTo(this.#host.agent.state.messages.length);
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
		for (const a of this.#advisors) a.instance.runtime.reset(reason);
	}

	#stopAdvisorRuntime(): void {
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.instance.agentUnsubscribe?.();
			a.instance.agentUnsubscribe = undefined;
			a.instance.runtime.dispose();

			a.instance.recorderClosed = a.instance.recorder.close();
			closes.push(a.instance.recorderClosed);
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
		advisor.instance.agentUnsubscribe = advisor.instance.agent.subscribe(event => {
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant") this.#recordAdvisorCost(advisor, event.message);
			advisor.instance.recorder.record(event.message);
		});
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
		const results = await this.#awaitCatchup(1, timeoutMs);
		const cardEventsCaughtUp = await this.#waitForPendingAdvisorCardEvents(Math.max(0, deadline - Date.now()));
		const abandoned = this.#advisors.filter(
			(advisor, index) => results[index] === false && advisor.instance.runtime.backlog > 0,
		);
		if (abandoned.length > 0 || !cardEventsCaughtUp) {
			logger.warn("advisor shutdown drain incomplete; disposal will abandon reviews or cards", {
				timeoutMs,
				advisors: abandoned.map(advisor => ({ name: advisor.name, backlog: advisor.instance.runtime.backlog })),
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
		return this.#advisors[0]?.instance.agent;
	}

	getAdvisorStatusOverview(): { configured: boolean; advisors: { name: string; status: AdvisorRuntimeStatus }[] } {
		const liveStatusBySlug = new Map<string, AdvisorRuntimeStatus>();
		for (const a of this.#advisors) {
			liveStatusBySlug.set(
				a.slug,
				a.instance.runtime.quotaExhausted
					? "quota_exhausted"
					: a.instance.runtime.failureNotified
						? "error"
						: "running",
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
			return this.#advisors.some(a => this.#host.modelRegistry.isUsingOAuth(a.instance.model));
		}
		const sel = resolveAdvisorRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
		return sel ? this.#host.modelRegistry.isUsingOAuth(sel.model) : false;
	}

	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const liveAdvisors = this.#advisors.map(a => a.instance.stats(a.name, this.#advisorCosts.get(a.slug) ?? 0));

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
}
