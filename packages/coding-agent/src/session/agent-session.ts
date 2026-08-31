import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isPromise } from "node:util/types";
import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCall,
	type AgentToolContext,
	type AgentToolResult,
	type AgentTurnEndContext,
	AppendOnlyContextManager,
	type AsideMessage,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	EventLoopKeepalive,
	resolveTelemetry,
	type StreamFn,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	type ThinkingLevel,
	type ToolChoiceDirective,
} from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	generateBranchSummary,
} from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	CodexCompactionContext,
	ImageContent,
	Message,
	Model,
	OAuthAccountIdentity,
	ProviderResponseMetadata,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	UsageReport,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { type Effort, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetOpenAICodexHistoryAfterCompaction } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { MacOSPowerAssertion } from "@oh-my-pi/pi-natives";
import {
	$env,
	escapeXmlText,
	formatDuration,
	getAgentDbPath,
	isBunTestRuntime,
	isInteractiveHost,
	isRecord,
	logger,
	postmortem,
	prompt,
	Snowflake,
	stringProperty,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { type AdvisorConfig, type AdvisorRuntimeStatus, loadAdvisorTranscriptCosts } from "../advisor";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJob, AsyncJobManager } from "../async";
import { reset as resetCapabilities } from "../capability";
import { type ConductorStats, SessionConductor } from "../conductor";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import type { ModelRegistry } from "../config/model-registry";
import type { ResolvedModelRoleValue } from "../config/model-resolver";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings, SkillsSettings } from "../config/settings";
import {
	onAppendOnlyModeChanged,
	onCodeModeChanged,
	onExtendedContextChanged,
	onModelRolesChanged,
} from "../config/settings";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import type { PythonResult } from "../eval/py/executor";
import type { BashResult } from "../exec/bash-executor";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionStopEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import { emitSessionShutdownEvent } from "../extensibility/extensions";
import { ManagedTimers } from "../extensibility/extensions/managed-timers";
import { createExtensionModelQuery } from "../extensibility/extensions/model-api";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { normalizeToolEventInput, resolveToolEventInput } from "../extensibility/tool-event-input";
import { GoalRuntime } from "../goals/runtime";
import type { GoalModeState } from "../goals/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { IrcMessage } from "../irc/bus";
import type { DaemonCompletionNotification } from "../launch/protocol";
import { theme } from "../modes/theme/theme";
import { parseTurnBudget } from "../modes/turn-budget";
import { containsUltrathink, ULTRATHINK_NOTICE } from "../modes/ultrathink";
import { computeNonMessageTokens } from "../modes/utils/context-usage";
import { containsWorkflow, renderWorkflowNotice } from "../modes/workflow";
import goalModeContextPrompt from "../prompts/goals/goal-mode-context.md" with { type: "text" };
import goalTodoContextPrompt from "../prompts/goals/goal-todo-context.md" with { type: "text" };
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import checkpointActiveNoticeTemplate from "../prompts/system/checkpoint-active-notice.md" with { type: "text" };
import interruptedThinkingTemplate from "../prompts/system/interrupted-thinking.md" with { type: "text" };
import rewindReportTemplate from "../prompts/system/rewind-report.md" with { type: "text" };
import sideChannelNoToolsReminder from "../prompts/system/side-channel-no-tools.md" with { type: "text" };
import {
	deobfuscateAssistantContent,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateProviderContext,
} from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { parseThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { isLowSignalTitleInput } from "../tiny/text";
import { shutdownTinyTitleClient } from "../tiny/title-client";
import type { ImageAttachmentEntry } from "../tools";
import { type AskToolDetails, type AskToolInput, recoverAskQuestions } from "../tools/ask";
import { releaseTabsForOwner } from "../tools/browser/tab-supervisor";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import { releaseComputerSessionsForOwner } from "../tools/computer/supervisor";
import { buildResolveReminderMessage, isPreviewResolutionToolCall } from "../tools/resolve";
import { supportsExternalThinking } from "../tools/think";
import type { TodoPhase } from "../tools/todo";
import { parseCommandArgs } from "../utils/command-args";
import type { EditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { normalizeModelContextImages } from "../utils/image-loading";
import type { InspectMediaMode } from "../utils/inspect-media-mode";
import { resumeCommand } from "../utils/resume-command";
import { generateSessionTitle } from "../utils/title-generator";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-events";
import type {
	AgentSessionConfig,
	AgentSessionDisposeOptions,
	AsyncJobSnapshot,
	CommandMetadataChangedListener,
	ContextUsageBreakdown,
	DroppedPrompt,
	FollowUpOptions,
	ModelCycleResult,
	Prewalk,
	PromptOptions,
	ResetSessionContextResult,
	ResolvedRoleModel,
	RestoredQueuedMessage,
	RoleModelCycle,
	RoleModelCycleResult,
	SessionOAuthAccountList,
	SessionStats,
	UsageFallbackConfirmer,
} from "./agent-session-types";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	ASYNC_PREVIEW_MAX_CHARS,
	ASYNC_RESULT_MESSAGE_TYPE,
	type AsyncResultEntry,
	buildAsyncResultBatchMessage,
} from "./async-job-delivery";
import { BashRunner, type BashRunnerHost } from "./bash-runner";
import {
	checkpointStartedAtFromEntry,
	completedRewindFromEntry,
	isSuccessfulCheckpointEntry,
	semanticToolResult,
} from "./checkpoint-entries";
import type { ClientBridge } from "./client-bridge";
import {
	type CodexAutoRedeemCoordinator,
	type CodexResetAction,
	type CodexResetPlan,
	type CodexResetTrigger,
	defaultCodexAutoRedeemCoordinator,
	isTerminalRedeemOutcome,
	overlayLiveResetCredits,
	planCodexResetRedemptions,
	REDEEM_RETRY_DEFER_MS,
	SWEEP_MIN_INTERVAL_MS,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { recordCredentialPin, seedCredentialPins } from "./credential-pin";
import { detachedSessionHolder } from "./detached-session-holder";
import { EvalRunner, type EvalRunnerHost } from "./eval-runner";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "./exit-diagnostics";
import { IrcBridge, type IrcBridgeHost } from "./irc-bridge";
import {
	buildLaunchCompletionBatchMessage,
	isLaunchCompletionOwner,
	LAUNCH_COMPLETION_MESSAGE_TYPE,
	type LaunchCompletionEntry,
} from "./launch-completion";
import {
	type BashExecutionMessage,
	buildReplanTitleContext,
	CHECKPOINT_ACTIVE_REMINDER_TYPE,
	type CustomMessage,
	type CustomMessagePayload,
	convertToLlm,
	dedupeEphemeralReply,
	demoteInterruptedThinking,
	didSessionMessagesChange,
	type FileMentionMessage,
	type HookMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
	isUserInterruptAbort,
	logProviderTurnError,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	sanitizeAssistantForReparentedHistory,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { ModelControls, type ModelControlsHost } from "./model-controls";
import { isPrewalkPlanNudge, PrewalkCoordinator, type PrewalkCoordinatorHost } from "./prewalk";
import {
	isAdvisorCard,
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isUserQueuedMessage,
	queueChipText,
	toRestoredQueuedMessage,
} from "./queued-messages";
import type { ServingModel } from "./retry-fallback-chains";
import { type AdvisorStats, SessionAdvisors, type SessionAdvisorsHost } from "./session-advisors";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import { getRestorableSessionModels } from "./session-context";
import type { BranchSummaryEntry, NewSessionOptions } from "./session-entries";
import { createSessionLiveHeartbeat, type SessionLiveHeartbeat } from "./session-liveness";
import {
	COMPACTION_CHECK_NONE,
	createCodexCompactionContext as createMaintenanceCodexCompactionContext,
	SessionMaintenance,
	type SessionMaintenanceHost,
} from "./session-maintenance";
import { cleanupEmptyMoveSession, copySessionArtifacts, type SessionManager } from "./session-manager";
import { buildSessionMetadata } from "./session-metadata";
import { SessionProviderBoundary, type SessionProviderBoundaryHost } from "./session-provider-boundary";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "./session-stats";
import { SessionTools, type SessionToolsHost } from "./session-tools";
import { skillPromptTitleInput } from "./skill-title-input";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { planTurnPersistence, sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { TurnRecovery, type TurnRecoveryHost } from "./turn-recovery";
import { YieldQueue } from "./yield-queue";

export * from "./agent-session-events";
export * from "./agent-session-types";
export type { AdvisorStats, PerAdvisorStat } from "./session-advisors";

const SESSION_STOP_CONTINUATION_CAP = 8;

import { LoopGuards, type StreamGuardsHost, StreamingEditGuard } from "./stream-guards";
import { TodoTracker, type TodoTrackerHost } from "./todo-tracker";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "./ttsr-coordinator";

const POST_PROMPT_DRAIN_TIMEOUT_MS = 5_000;

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};

type PostPromptSkipReason = "aborted" | "stale-generation";

type AgentContinueSkipReason =
	| PostPromptSkipReason
	| "session-unavailable"
	| "should-continue-false"
	| "post-restore-unavailable";

type ScheduledAgentContinueOptions = {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: (reason: AgentContinueSkipReason) => void;
	onError?: (error: unknown) => void;
};

type SessionTitleSource = "auto" | "user";
type SessionNameTrigger = "replan";
type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

const kPersistedSessionEntryId = Symbol("persistedSessionEntryId");
type PersistedAssistantMessage = AssistantMessage & { [kPersistedSessionEntryId]?: string };

function cloneMessageEndNotificationField(value: unknown): unknown {
	try {
		return structuredClone(value);
	} catch {}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return JSON.parse(json) as unknown;
	} catch {}
	return String(value);
}

function cloneMessageEndNotification(message: AgentMessage): AgentMessage {
	const snapshot: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(message)) {
		const descriptor = Object.getOwnPropertyDescriptor(message, key);
		if (!descriptor?.enumerable) continue;
		snapshot[key] = cloneMessageEndNotificationField(Reflect.get(message, key));
	}
	return snapshot as unknown as AgentMessage;
}

const INTERRUPTED_THINKING_MIN_CHARS = 60;

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;

	getXdevToolEntries: () => Array<{ name: string; summary: string }>;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	readonly #models: ModelControls;
	readonly #tools: SessionTools;
	readonly #prewalk: PrewalkCoordinator;

	readonly #providerBoundary: SessionProviderBoundary;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	#unsubscribeAgent?: () => void;
	#cancelExitRecorder?: () => void;
	#cancelFatalRecoveryHint?: () => void;
	#exitRecorded = false;
	#unsubscribeAppendOnly?: () => void;
	#unsubscribeModelRoles?: () => void;
	#unsubscribeExtendedContext?: () => void;
	#unsubscribeCodeMode?: () => void;

	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#runStateListeners = new Set<(state: "running" | "idle") => void>();
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];
	#sessionChangeCallbacks = new Set<() => void>();
	#observedSessionId: string | undefined;

	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;

	#inspectMediaModeOverride: InspectMediaMode | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	readonly #advisors: SessionAdvisors;
	readonly #conductor: SessionConductor;
	#goalTurnCounter = 0;
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;

	#movedFromEmptySessionFile?: string;

	readonly #maintenance: SessionMaintenance;

	#branchSummaryAbortController: AbortController | undefined = undefined;

	readonly #recovery: TurnRecovery;
	#textOutputCommitted = true;
	readonly #todo: TodoTracker;
	#replanTitleRefreshInFlight: Promise<void> | undefined = undefined;

	#titleSystemPrompt: string | undefined;
	#titleGenerationStart: (() => void) | undefined;
	#titleGenerationInFlightFor: string | undefined;

	#promptDropped: ((prompt: DroppedPrompt) => void) | undefined;
	#titleGenerationAbortController = new AbortController();
	#toolChoiceQueue = new ToolChoiceQueue();

	readonly #bash: BashRunner;

	readonly #eval: EvalRunner;

	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;

	readonly #asyncJobManager: AsyncJobManager | undefined;

	#unregisterAsyncDeliverySink: (() => void) | undefined;

	#asyncDeliveryEpoch = 0;

	readonly #irc: IrcBridge;
	#ircWakeTurnObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;

	#agentId: string | undefined;
	#agentKind: "main" | "sub" = "main";
	#scoutAllowedBySpawnPolicy = true;
	#providerSessionId: string | undefined;
	#freshProviderSessionId: string | undefined;
	#inheritedProviderPromptCacheKey: string | undefined;
	#autolearnCaptureAbortController: AbortController | undefined;
	#autolearnCaptureTask: Promise<void> | undefined;
	#liveHeartbeat: SessionLiveHeartbeat | undefined;
	#isDisposed = false;

	#codexResetCoordinator: CodexAutoRedeemCoordinator;

	#extensionRunner: ExtensionRunner | undefined = undefined;

	#fallbackExtensionTimers: ManagedTimers | undefined = undefined;
	#turnIndex = 0;
	#messageEndPersistenceTail: Promise<void> = Promise.resolve();
	#pendingMessageEndPersistence = new Map<string, Promise<void>>();
	#persistedMessageKeys: { anchor: string; keys: Set<string> } | undefined;

	#customCommands: LoadedCustomCommand[] = [];

	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#modelRegistry: ModelRegistry;
	#usageFallbackConfirmer: UsageFallbackConfirmer | undefined;
	#usagePreflightAbortControllers = new Set<AbortController>();
	#queuedMessageDrainBlocked = false;
	#modeExitDrainSuppressionDepth = 0;
	#usagePreflightReadyForNextModelCall = false;
	#usagePreflightReadyModel: Model | undefined;
	#detachUsageBeforeQueueDequeue: (() => void) | undefined;
	#detachUsageBeforeModelCall: (() => void) | undefined;

	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;

	#lazyContextRefreshed = new Set<string>();
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	#sideStreamFn: StreamFn;
	#preferWebsockets: boolean | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#disconnectOwnedMcpManager: (() => Promise<void>) | undefined;

	readonly #ttsr: TtsrCoordinator;
	readonly #stats: SessionStatsTracker;

	#pendingAbortErrorId?: number;

	#postPromptTasks = new Set<Promise<unknown>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	readonly #streamingEditGuard: StreamingEditGuard;
	readonly #loopGuards: LoopGuards;
	#promptInFlightCount = 0;
	#abortInProgress = false;

	#promptGeneration = 0;
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#inFlightSettledCallbacks: Array<() => void | Promise<void>> = [];
	#sessionStopContinuationCount = 0;
	#sessionStopHookActive = false;
	#obfuscator: SecretObfuscator | undefined;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastCompletedRewind: CompletedRewindState | undefined = undefined;
	#rewoundToolResultIds = new Set<string>();
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;

	#yieldTerminationPending = false;
	#synchronouslyTerminatedYieldToolCallIds = new Set<string>();
	#providerSessionState = new Map<string, ProviderSessionState>();
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#resetPromptMaintenanceState(): void {
		this.#recovery.resetForNewPrompt();
		this.#yieldTerminationPending = false;
	}

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (isBunTestRuntime()) return;
		if (this.#powerAssertion) return;
		const mode = this.settings.get("power.sleepPrevention");
		if (mode === "off") return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "Proto agent session",
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	#beginInFlight(): void {
		this.#promptInFlightCount++;
		if (this.#promptInFlightCount === 1) {
			this.#acquirePowerAssertion();
		}
	}

	#endInFlight(onSettled?: () => void | Promise<void>): void {
		if (onSettled) this.#inFlightSettledCallbacks.push(onSettled);
		this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		if (this.#promptInFlightCount !== 0) return;
		this.yieldQueue.requestIdleFlush();
		this.#releasePowerAssertion();
		this.#flushPendingAgentEnd();
		if (this.#inFlightSettledCallbacks.length === 0) {
			this.#drainStrandedQueuedMessages();
			return;
		}
		void this.#flushInFlightSettledCallbacks().finally(() => this.#drainStrandedQueuedMessages());
	}

	async #flushInFlightSettledCallbacks(): Promise<void> {
		const callbacks = this.#inFlightSettledCallbacks;
		this.#inFlightSettledCallbacks = [];
		for (const callback of callbacks) {
			try {
				await callback();
			} catch (error) {
				logger.warn("In-flight settle callback failed", { error: String(error) });
			}
		}
	}

	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;

		if (this.#unsubscribeAgent === undefined) return;

		if (this.#advisors.autoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#extractQueuedAdvisorCards()) {
				this.#preserveAdvisorCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	#resumeStrandedIrcAsides(): void {
		if (this.#modeExitDrainSuppressionDepth > 0 || this.#isDisposed || this.isStreaming || !this.#irc.hasPending()) {
			return;
		}
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const records = this.#irc.drainPending();
		this.#wakeForIrc(records);
	}

	#wakeForIrc(records: CustomMessage[]): void {
		if (this.#modeExitDrainSuppressionDepth > 0) {
			this.#irc.deferWake(records);
			return;
		}

		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? [...this.agent.peekFollowUpQueue()]
				: [];
		const parkedQueueDrainBlocked = parkedFollowUps.length > 0 && this.#queuedMessageDrainBlocked;
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues([...this.agent.peekSteeringQueue()], []);
			if (parkedQueueDrainBlocked) this.#queuedMessageDrainBlocked = false;
		}
		let finishObservation: ((error?: unknown) => void | Promise<void>) | undefined;
		try {
			finishObservation = this.#ircWakeTurnObserver?.(records);
		} catch (error) {
			logger.warn("IRC wake turn observer failed to start", { error: String(error) });
		}
		this.#resetPromptMaintenanceState();

		const generation = this.#promptGeneration;
		this.#beginInFlight();
		let turnError: unknown;
		void this.agent
			.prompt(records)
			.catch(error => {
				turnError = error;
				logger.warn("IRC wake turn failed", { error: String(error) });
			})
			.finally(async () => {
				try {
					await this.#waitForPostPromptRecovery(generation);
				} catch (error) {
					turnError ??= error;
					logger.warn("IRC wake turn recovery failed", { error: String(error) });
				}
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						[...this.agent.peekSteeringQueue()],
						[...parkedFollowUps, ...this.agent.peekFollowUpQueue()],
					);
					this.#queuedMessageDrainBlocked ||= parkedQueueDrainBlocked;
				}
				this.#endInFlight(async () => {
					try {
						await finishObservation?.(turnError);
					} catch (error) {
						logger.warn("IRC wake turn observer failed to finish", { error: String(error) });
					}
				});
			});
	}

	#extractQueuedAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = [...steering, ...followUp].filter(isAdvisorCard);
		if (cards.length === 0) return [];
		this.agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		this.#reconcileQueuedMessageDrain();
		return cards;
	}

	#preserveAdvisorCard(card: CustomMessage): void {
		if (this.#abortInProgress && this.isStreaming) {
			this.#pendingNextTurnMessages.push(card);
			return;
		}
		this.agent.emitExternalEvent({ type: "message_start", message: card });
		this.agent.emitExternalEvent({ type: "message_end", message: card });
	}

	#resetInFlight(): void {
		this.#promptInFlightCount = 0;
		this.yieldQueue.requestIdleFlush();
		this.#releasePowerAssertion();
		this.#flushPendingAgentEnd();
		if (this.#inFlightSettledCallbacks.length === 0) {
			this.#drainStrandedQueuedMessages();
			return;
		}
		void this.#flushInFlightSettledCallbacks().finally(() => this.#drainStrandedQueuedMessages());
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	armPrewalk(target: Model, thinkingLevel?: ThinkingLevel): boolean {
		return this.#prewalk.arm(target, thinkingLevel);
	}

	#codeModeState: { namespacesInfo?: unknown };

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.#codeModeState = config.codeModeState ?? {};
		this.sessionManager = config.sessionManager;
		this.#liveHeartbeat = createSessionLiveHeartbeat(this.sessionManager.getSessionFile());
		this.settings = config.settings;
		this.#modelRegistry = config.modelRegistry;
		this.#codexResetCoordinator = config.codexResetCoordinator ?? defaultCodexAutoRedeemCoordinator;
		const bashHost: BashRunnerHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			extensionRunner: () => this.#extensionRunner,
			isStreaming: () => this.isStreaming,
		};
		this.#bash = new BashRunner(bashHost);

		const evalHost: EvalRunnerHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			extensionRunner: () => this.#extensionRunner,
			isStreaming: () => this.isStreaming,
			appendSessionMessage: message => {
				this.agent.appendMessage(message);
				this.sessionManager.appendMessage(message);
			},
		};
		this.#eval = new EvalRunner(evalHost, {
			kernelOwnerId: config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`,
			parentSessionId: config.parentEvalSessionId,
		});
		const ircHost: IrcBridgeHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			wakeForIrc: records => this.#wakeForIrc(records),
			runEphemeralTurn: args => this.runEphemeralTurn(args),
		};
		this.#irc = new IrcBridge(ircHost);
		const prewalkHost: PrewalkCoordinatorHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			model: () => this.model,
			configuredThinkingLevel: () => this.configuredThinkingLevel(),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			setModelTemporary: (model, thinkingLevel, options) => this.setModelTemporary(model, thinkingLevel, options),
			setActiveToolsByName: names => this.setActiveToolsByName(names),
			runToolRegistryMutation: mutation => this.runToolRegistryMutation(mutation),
			getActiveToolNames: () => this.getActiveToolNames(),
			getEnabledToolNames: () => this.getEnabledToolNames(),
			waitForSessionMessagePersistence: message => this.#waitForSessionMessagePersistence(message),
		};
		this.#prewalk = new PrewalkCoordinator(prewalkHost, {
			prewalk: config.prewalk,
		});
		const todoHost: TodoTrackerHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			model: () => this.model,
			agentKind: () => this.#agentKind,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			promptGeneration: () => this.#promptGeneration,
			hasPendingAsyncWake: () => this.#hasPendingAsyncWake(),
			getActiveToolNames: () => this.getActiveToolNames(),
			getEnabledToolNames: () => this.getEnabledToolNames(),
			toolRegistry: () => this.#tools.registry,
		};
		this.#todo = new TodoTracker(todoHost);
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		const modelControlsHost: ModelControlsHost = {
			agent: this.agent,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			sessionManager: this.sessionManager,
			providerSessionState: this.#providerSessionState,
			model: () => this.model,
			sessionId: () => this.sessionId,
			promptGeneration: () => this.#promptGeneration,
			resolveActiveEditMode: () => this.#tools.resolveActiveEditMode(),
			syncAfterModelChange: previousEditMode => this.#tools.syncAfterModelChange(previousEditMode),
			setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
			clearActiveRetryFallback: () => this.#recovery.clearActiveRetryFallback(),
			clearInheritedProviderPromptCacheKey: () => this.#clearInheritedProviderPromptCacheKey(),
			magicKeywordEnabled: keyword => this.#magicKeywordEnabled(keyword),
			emit: event => this.#emit(event),
			emitSessionEvent: event => this.#emitSessionEvent(event),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
		};
		this.#models = new ModelControls(modelControlsHost, {
			scopedModels: config.scopedModels,
			thinkingLevel: config.thinkingLevel,
			thinkingLevelCeiling: config.thinkingLevelCeiling,
			serviceTierByFamily: config.serviceTierByFamily,
		});

		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#customCommands = config.customCommands ?? [];
		const recoveryHost: TurnRecoveryHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			configWarnings: this.configWarnings,
			model: () => this.model,
			contextFitsModel: (model, excludedMessage) => this.#maintenance.contextFitsModel(model, excludedMessage),
			textOutputCommitted: () => this.#textOutputCommitted,
			thinkingLevel: () => this.thinkingLevel,
			configuredThinkingLevel: () => this.configuredThinkingLevel(),
			setThinkingLevel: level => this.setThinkingLevel(level),
			thinkingLevelCeiling: () => this.#models.thinkingLevelCeiling,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			isCompacting: () => this.isCompacting,
			abortInProgress: () => this.#abortInProgress,
			streamingEditAbortTriggered: () => this.#streamingEditGuard.abortTriggered,
			promptGeneration: () => this.#promptGeneration,
			sessionId: () => this.sessionId,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			waitForSessionMessagePersistence: message => this.#waitForSessionMessagePersistence(message),
			appendSessionMessage: message => this.#appendSessionMessage(message),
			persistedAssistantEntryId: message => (message as PersistedAssistantMessage)[kPersistedSessionEntryId],
			sessionMessageAlreadyPersisted: message => this.#sessionMessageAlreadyPersisted(message),
			setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
			resetCurrentResponsesProviderSession: reason => this.#resetCurrentResponsesProviderSession(reason),
			maybeAutoRedeemCodexReset: activeBlockUnblockAtMs => this.#maybeAutoRedeemCodexReset(activeBlockUnblockAtMs),
			runAutoCompaction: (reason, willRetry, options) =>
				this.#maintenance.runAutoCompaction(reason, willRetry, options),
			withBashBranchTransition: operation => this.#bash.withBranchTransition(operation),
		};
		this.#recovery = new TurnRecovery(recoveryHost, { initialRetryFallback: config.initialRetryFallback });
		this.#detachUsageBeforeQueueDequeue = this.agent.addBeforeQueuedMessageDequeueHook(async signal => {
			if (
				!this.settings.get("retry.usageAwareFallback") ||
				(this.#usagePreflightReadyForNextModelCall && this.#usagePreflightReadyModel === this.model)
			) {
				return;
			}
			if (!(await this.#runQueuedUsageAwarePreflight(signal))) {
				signal?.throwIfAborted();
				throw new DOMException("Usage preflight cancelled", "AbortError");
			}
		});
		this.#detachUsageBeforeModelCall = this.agent.addBeforeModelCallHook(async signal => {
			if (!this.settings.get("retry.usageAwareFallback")) return;
			if (this.#usagePreflightReadyForNextModelCall) {
				const checkedModel = this.#usagePreflightReadyModel;
				this.#usagePreflightReadyForNextModelCall = false;
				this.#usagePreflightReadyModel = undefined;
				if (checkedModel === this.model) return;
			}
			if (!(await this.#runUsageAwarePreflight(signal))) {
				signal?.throwIfAborted();
				throw new DOMException("Usage preflight cancelled", "AbortError");
			}
		});
		const statsHost: SessionStatsTrackerHost = {
			session: this,
			agent: this.agent,
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: () => this.model,
			sessionId: () => this.sessionId,
		};
		this.#stats = new SessionStatsTracker(statsHost);

		this.agent.serviceTierResolver = model => this.#models.effectiveServiceTier(model);
		this.#titleSystemPrompt = config.titleSystemPrompt;
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.#sideStreamFn = config.sideStreamFn ?? streamSimple;
		this.#preferWebsockets = config.preferWebsockets;
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();

		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#stats.ingestProviderUsageHeaders(response, model);
					await this.#maybeRefreshLazyLocalContext(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#stats.ingestProviderUsageHeaders(response, model);

					return this.#maybeRefreshLazyLocalContext(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		this.#onSseEvent = configuredOnSseEvent
			? (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
					configuredOnSseEvent(event, model);
				}
			: (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
				};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			const rewindReport = this.#extractRewindReport(messages);
			if (rewindReport) {
				this.#pendingRewindReport = undefined;
				await this.#applyRewind(rewindReport, messages);
			}
			this.#loopGuards.recordTurn(messages, context);
			await this.#prewalk.advanceAtTurnEnd(messages, context);
			await this.#advisors.onPrimaryTurnEnd(messages, context?.willContinue, signal);
			this.#conductor.onPrimaryTurnEnd(context?.willContinue);
			await this.#maintenance.maintainContextMidRun(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				this.#beginInFlight();
				try {
					await this.agent.prompt(messages.length === 1 ? first : messages);
				} finally {
					this.#endInFlight();
				}
			},
			scheduleIdleFlush: run => {
				const keepalive = new EventLoopKeepalive();
				try {
					this.#schedulePostPromptTask(
						async () => {
							try {
								await run();
							} finally {
								keepalive[Symbol.dispose]();
							}
						},
						{
							delayMs: 1,
							onSkip: () => {
								keepalive[Symbol.dispose]();
								this.yieldQueue.cancelIdleFlushScheduling();
							},
						},
					);
				} catch (error) {
					keepalive[Symbol.dispose]();
					throw error;
				}
			},
		});
		this.yieldQueue.register<LaunchCompletionEntry>(LAUNCH_COMPLETION_MESSAGE_TYPE, {
			isStale: entry =>
				this.#isDisposed || !isLaunchCompletionOwner(entry.owner, this.sessionManager.getSessionId()),
			build: buildLaunchCompletionBatchMessage,
		});

		this.agent.hasIrcInterrupts = () => this.#irc.hasInterrupts();
		this.agent.setAsideMessageProvider(() => {
			const thunks: AsideMessage[] = this.#irc.drainPending().map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());

			thunks.push(() => this.#todo.takeMidRunNudge());
			return thunks;
		});
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.getXdevToolEntries = config.getXdevToolEntries ?? (() => []);
		const sessionToolsHost: SessionToolsHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			extensionRunner: () => this.#extensionRunner,
			agentKind: () => this.#agentKind,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			queuedMessageCount: () => this.queuedMessageCount,
			model: () => this.model,
			setCodeModeNamespacesInfo: info => {
				this.#codeModeState.namespacesInfo = info;
			},
			clearInheritedProviderPromptCacheKey: () => this.#clearInheritedProviderPromptCacheKey(),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			notifyCommandMetadataChanged: () => this.#notifyCommandMetadataChanged(),
			localProtocolOptions: () => this.#localProtocolOptions(),
			getInspectMediaModeOverride: () => this.#inspectMediaModeOverride,
			setInspectMediaModeOverride: mode => {
				this.#inspectMediaModeOverride = mode;
			},
		};
		this.#tools = new SessionTools(sessionToolsHost, {
			toolRegistry: config.toolRegistry,
			createComputerTool: config.createComputerTool,
			createThinkTool: config.createThinkTool,
			createInspectMediaTool: config.createInspectMediaTool,
			builtInToolNames: config.builtInToolNames,
			mcpManagerToolNames: config.mcpManagerToolNames,
			presentationPinnedToolNames: config.presentationPinnedToolNames,
			requiredToolNames: config.requiredToolNames,
			ensureWriteRegistered: config.ensureWriteRegistered,
			rebuildSystemPrompt: config.rebuildSystemPrompt,
			getMcpServerInstructions: config.getMcpServerInstructions,
			xdev: config.xdev,
			setActiveToolNames: config.setActiveToolNames,
			baseSystemPrompt: this.agent.state.systemPrompt,
			skills: config.skills,
			skillWarnings: config.skillWarnings,
			skillsSettings: config.skillsSettings,
			skillsReloadable: config.skillsReloadable,
		});
		this.#disconnectOwnedMcpManager = config.disconnectOwnedMcpManager;
		const ttsrHost: TtsrCoordinatorHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			schedulePostPromptTask: (task, options) => this.#schedulePostPromptTask(task, options),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			promptGeneration: () => this.#promptGeneration,
		};
		this.#ttsr = new TtsrCoordinator(ttsrHost, config.ttsrManager);
		this.#obfuscator = config.obfuscator;
		const providerBoundaryHost: SessionProviderBoundaryHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			model: () => this.model,
			sessionId: () => this.sessionId,
			localProtocolOptions: () => this.#localProtocolOptions(),
			transformContext: (messages, signal) => this.#transformContext(messages, signal),
			convertToLlm: messages => this.#convertToLlm(messages),
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			obfuscator: this.#obfuscator,
		};
		this.#providerBoundary = new SessionProviderBoundary(providerBoundaryHost);
		const streamGuardsHost: StreamGuardsHost = {
			agent: this.agent,
			settings: this.settings,
			sessionManager: this.sessionManager,
			obfuscator: this.#obfuscator,
			model: () => this.model,
			isDisposed: () => this.#isDisposed,
			promptGeneration: () => this.#promptGeneration,
			localProtocolOptions: () => this.#localProtocolOptions(),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			schedulePostPromptTask: task => this.#schedulePostPromptTask(task),
			discardAssistantTurn: message => this.#recovery.discardAssistantTurn(message),
		};
		this.#streamingEditGuard = new StreamingEditGuard(streamGuardsHost);
		this.#loopGuards = new LoopGuards(streamGuardsHost);
		this.#agentId = config.agentId;
		this.#agentKind = config.agentKind ?? "main";
		this.#scoutAllowedBySpawnPolicy = config.scoutAllowedBySpawnPolicy ?? true;
		this.#providerSessionId = config.providerSessionId;
		this.#inheritedProviderPromptCacheKey =
			config.providerPromptCacheKeySource === "fork" ? this.agent.promptCacheKey : undefined;

		if (this.#asyncJobManager && this.#agentId) {
			const manager = this.#asyncJobManager;
			this.#unregisterAsyncDeliverySink = manager.registerDeliverySink(this.#agentId, (jobId, text, job) =>
				this.#deliverAsyncJobResult(manager, jobId, text, job),
			);
			this.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => entry.epoch !== this.#asyncDeliveryEpoch || manager.isDeliverySuppressed(entry.jobId),
				build: buildAsyncResultBatchMessage,
			});
		}
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#streamingEditGuard.preCache(event);
			this.#streamingEditGuard.maybeAbort(event);
			this.#loopGuards.onAssistantEvent(message, assistantMessageEvent);
		});

		this.agent.afterToolCall = ctx => this.#afterToolCall(ctx);

		this.agent.beforeToolCall = (ctx, signal) => this.#beforeToolCall(ctx, signal);
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncAgentSessionId();
		this.#todo.syncFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			getCurrentUsage: () => {
				const usage = this.getSessionStats().tokens;
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				};
			},
			emit: event => {
				if (event.type === "goal_updated") {
					this.#conductor.onGoalUpdated(event.goal);
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (mode === "none") {
					this.sessionManager.appendModeChange("none");
				} else if (state) {
					this.sessionManager.appendModeChange(mode, { goal: state.goal });
				}
			},
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
			completionAuthority: goal => this.#conductor.completionAuthority(goal),
		});
		this.#cancelExitRecorder = postmortem.register(`agent-session:${this.sessionManager.getSessionId()}`, reason => {
			this.#recordSessionExit(reason);
		});
		this.#cancelFatalRecoveryHint = postmortem.registerFatalRecoveryHint(() => {
			const sessionId = this.sessionManager.getSessionId();
			if (!sessionId || !this.sessionManager.getSessionFile()) return undefined;
			return {
				label: this.#agentId ?? (this.#agentKind === "main" ? "Main" : "Agent"),
				command: resumeCommand(sessionId),
			};
		});

		const advisorsHost: SessionAdvisorsHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			yieldQueue: this.yieldQueue,
			obfuscator: this.#obfuscator,
			providerSessionState: this.#providerSessionState,
			preferWebsockets: this.#preferWebsockets,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			isDisposed: () => this.#isDisposed,
			abortInProgress: () => this.#abortInProgress,
			allowAgentInitiatedTurns: () => this.#allowAcpAgentInitiatedTurns,
			clientBridge: () => this.#clientBridge,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
			extractQueuedAdvisorCards: () => this.#extractQueuedAdvisorCards(),
			dropPendingAdvisorCards: () => {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(message => !isAdvisorCard(message));
			},
			preserveAdvisorCard: card => this.#preserveAdvisorCard(card),
			hasPendingNextTurnMessages: () => this.#pendingNextTurnMessages.length > 0,
			convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
			effectiveServiceTier: model => this.#models.effectiveServiceTier(model),
			resolveContextPromotionTarget: (model, contextWindow, signal) =>
				this.#maintenance.resolveContextPromotionTarget(model, contextWindow, signal),
			resolveCompactionModelCandidates: (model, availableModels) =>
				this.#maintenance.resolveCompactionModelCandidates(model, availableModels),
			resolveRetryFallbackRole: (selector, model, roleHint) =>
				this.#recovery.resolveRetryFallbackRole(selector, model, roleHint),
			retryFallbackChainKeys: (selector, model, options) =>
				this.#recovery.retryFallbackChainKeys(selector, model, options),
			findRetryFallbackCandidates: (role, selector, model) =>
				this.#recovery.findRetryFallbackCandidates(role, selector, model),
			isRetryFallbackSelectorSuppressed: selector => this.#recovery.isRetryFallbackSelectorSuppressed(selector),
			noteRetryFallbackCooldown: (selector, retryAfterMs, errorMessage) =>
				this.#recovery.noteRetryFallbackCooldown(selector, retryAfterMs, errorMessage),
			createCodexCompactionContext: createMaintenanceCodexCompactionContext,
			sessionId: () => this.sessionId,
		};
		this.#advisors = new SessionAdvisors(advisorsHost, {
			enabled: this.settings.get("advisor.enabled"),
			tools: config.advisorTools,
			createEditTool: config.advisorCreateEditTool,
			getToolContext: config.advisorGetToolContext,
			mcpResources: config.advisorMcpResources,
			watchdogPrompt: config.advisorWatchdogPrompt,
			sharedInstructions: config.advisorSharedInstructions,
			contextPrompt: config.advisorContextPrompt,
			configs: config.advisorConfigs,
			streamFn: config.advisorStreamFn,
			transformProviderContext: config.transformProviderContext,
			initialCosts: config.initialAdvisorCosts,
		});

		this.#conductor = new SessionConductor(
			{
				...advisorsHost,
				goalRuntime: () => this.#goalRuntime,
				currentGoal: () => this.#goalModeState?.goal,
			},
			{
				enabled: this.settings.get("conductor.enabled"),
				toolsFactory: config.conductorToolsFactory,
				createEditTool: config.advisorCreateEditTool,
				getToolContext: config.advisorGetToolContext,
				mcpResources: config.advisorMcpResources,
				contextPrompt: config.advisorContextPrompt,
				streamFn: config.advisorStreamFn,
				transformProviderContext: config.transformProviderContext,
			},
		);

		const maintenanceHost: SessionMaintenanceHost = {
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
			extensionRunner: this.#extensionRunner,
			sideStreamFn: this.#sideStreamFn,
			providerSessionState: this.#providerSessionState,
			preferWebsockets: this.#preferWebsockets,
			model: () => this.model,
			thinkingLevel: () => this.thinkingLevel,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			promptGeneration: () => this.#promptGeneration,
			sessionId: () => this.sessionId,
			messages: () => this.messages,
			baseSystemPrompt: () => this.#tools.baseSystemPrompt,
			goalModeState: () => this.#goalModeState,
			nonMessageTokenSource: () => this,
			emitSessionEvent: (event, options) => this.#emitSessionEvent(event, options),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			schedulePostPromptTask: (task, options) => this.#schedulePostPromptTask(task, options),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
			scheduleCompactionContinuation: options => this.#scheduleCompactionContinuation(options),
			persistTurnMessagesForMidRunCompaction: context => this.#persistTurnMessagesForMidRunCompaction(context),
			findLastAssistantMessage: () => this.#findLastAssistantMessage(),
			disconnectFromAgent: () => this.#disconnectFromAgent(),
			reconnectToAgent: () => this.#reconnectToAgent(),
			drainStrandedQueuedMessages: () => this.#drainStrandedQueuedMessages(),
			buildDisplaySessionContext: () => this.buildDisplaySessionContext(),
			convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
			obfuscateTextForProvider: text => this.#obfuscateTextForProvider(text),
			obfuscatePreparationForProvider: preparation => this.#obfuscatePreparationForProvider(preparation),
			closeCodexProviderSessionsForHistoryRewrite: () => this.#closeCodexProviderSessionsForHistoryRewrite(),
			resetCodexProviderAfterCompaction: compaction => this.#resetCodexProviderAfterCompaction(compaction),
			syncTodoPhasesFromBranch: () => this.#todo.syncFromBranch(),
			resetAdvisorRuntimes: (reason?: string) => {
				this.#advisors.resetAllRuntimes(reason);
				this.#conductor.resetAllRuntimes(reason);
			},
			rebaseAfterCompaction: () => this.#stats.rebaseAfterCompaction(),
			recordAnchoredHistoryRewrite: tokensRemoved => this.#stats.recordAnchoredHistoryRewrite(tokensRemoved),
			getContextBreakdown: options => this.getContextBreakdown(options),
			getContextUsage: options => this.getContextUsage(options),
			dropImages: () => this.dropImages(),
			removeAssistantMessageFromActiveContext: message =>
				this.#recovery.removeAssistantMessageFromActiveContext(message),
			dropPersistedAssistantTurn: message => this.#recovery.dropPersistedAssistantTurn(message),
			runRecoveryCompactionWithRollback: (reason, message, options) =>
				this.#recovery.runRecoveryCompactionWithRollback(reason, message, options),
			parseRetryAfterMsFromError: errorMessage => this.#recovery.parseRetryAfterMsFromError(errorMessage),
			setModelTemporary: (model, thinkingLevel, options) => this.setModelTemporary(model, thinkingLevel, options),
			abort: options => this.abort(options),
		};
		this.#maintenance = new SessionMaintenance(maintenanceHost);

		this.#rehydrateCheckpointRewindState();

		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);

		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
		this.#unsubscribeModelRoles = onModelRolesChanged(() => {
			this.#advisors.onModelRolesChanged();
			this.#conductor.onModelRolesChanged();
		});

		this.#unsubscribeExtendedContext = onExtendedContextChanged(() => void this.#reapplyExtendedContextPolicy());
		this.#unsubscribeCodeMode = onCodeModeChanged(() => {
			void this.#tools.reconcileCodeMode().catch(error => {
				logger.warn("Code Mode reconcile after setting change failed", { error: String(error) });
			});
		});

		void this.#retryInactiveAdvisorAfterModelDiscovery();
	}

	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
	}

	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

	nextToolChoiceDirective(): ToolChoiceDirective | undefined {
		const hard = this.#nextHardToolChoice();
		if (hard !== undefined) return hard;
		const head = this.#toolChoiceQueue.peekPendingHead();
		if (head !== undefined) {
			return {
				soft: true,
				id: head.id,

				toolName: "write",
				satisfies: isPreviewResolutionToolCall,
				reminder: [buildResolveReminderMessage(head.sourceToolName)],
			};
		}
		return undefined;
	}

	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	readonly #sessionBeforeSwitchReconcilers = new Set<() => Promise<void>>();

	setSessionBeforeSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		if (reconciler) this.#sessionBeforeSwitchReconcilers.add(reconciler);
		else this.#sessionBeforeSwitchReconcilers.clear();
	}

	readonly #sessionSwitchReconcilers = new Set<() => Promise<void>>();

	setSessionSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		if (reconciler) this.#sessionSwitchReconcilers.add(reconciler);
		else this.#sessionSwitchReconcilers.clear();
	}

	async #beforeSessionSwitch(): Promise<void> {
		for (const reconcile of this.#sessionBeforeSwitchReconcilers) await reconcile();
	}

	async #afterSessionSwitch(): Promise<void> {
		for (const reconcile of this.#sessionSwitchReconcilers) await reconcile();
	}

	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	get preferWebsockets(): boolean | undefined {
		return this.#preferWebsockets;
	}

	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsr.manager;
	}

	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	get isTtsrAbortPending(): boolean {
		return this.#ttsr.abortPending;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = this.#asyncJobManager;
		if (!manager) return null;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	#cancelOwnAsyncJobs(reason?: unknown): void {
		if (!this.#agentId) return;
		const manager = this.#asyncJobManager;
		manager?.cancelAll({ ownerId: this.#agentId }, reason);
		manager?.evictCompletedJobs({ ownerId: this.#agentId });

		this.#asyncDeliveryEpoch += 1;
		this.yieldQueue.clear("async-result");
	}

	#hasPendingAsyncWake(): boolean {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		return (
			manager.getRunningJobs(ownerFilter).some(job => !manager.isDeliverySuppressed(job.id)) ||
			manager.hasPendingDeliveries(ownerFilter) ||
			this.yieldQueue.has(ASYNC_RESULT_MESSAGE_TYPE)
		);
	}

	hasPendingAsyncWork(): boolean {
		return this.#hasPendingAsyncWake();
	}

	async settleAsyncWork(): Promise<void> {
		const manager = this.#asyncJobManager;
		if (!manager || !this.#agentId) return;
		await manager.waitForOwnerJobs(this.#agentId, { excludeSuppressed: true });
		await manager.drainDeliveries({ filter: { ownerId: this.#agentId } });
		await this.waitForIdle();
	}

	async #deliverAsyncJobResult(manager: AsyncJobManager, jobId: string, text: string, job?: AsyncJob): Promise<void> {
		if (this.#isDisposed) return;
		if (manager.isDeliverySuppressed(jobId)) return;

		const epoch = this.#asyncDeliveryEpoch;
		const formatted = await this.#formatAsyncResultForFollowUp(text);
		if (this.#isDisposed) return;
		if (epoch !== this.#asyncDeliveryEpoch) return;
		if (manager.isDeliverySuppressed(jobId)) return;
		const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
		this.yieldQueue.enqueue<AsyncResultEntry>("async-result", { jobId, result: formatted, job, durationMs, epoch });
	}

	async #formatAsyncResultForFollowUp(result: string): Promise<string> {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}
		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await this.sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return preview;
	}

	#emit(event: AgentSessionEvent): void {
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;

				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	#emitRunState(state: "running" | "idle"): void {
		this.#liveHeartbeat?.setStreaming(state === "running");
		for (const listener of this.#runStateListeners) {
			try {
				listener(state);
			} catch (error) {
				logger.warn("AgentSession run-state listener threw", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#recordToolExecutionStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		const data: ToolExecutionStartData = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt: new Date().toISOString(),
		};

		const args = summarizeToolArguments(event.args);
		if (args) data.args = args;
		if (event.intent) data.intent = event.intent;
		this.sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, data);
	}

	#recordSessionExit(reason: postmortem.Reason | "dispose"): void {
		if (this.#exitRecorded) return;
		this.#exitRecorded = true;
		const pendingToolCalls = collectPendingToolCalls(this.sessionManager.getBranch());
		if (
			pendingToolCalls.length === 0 &&
			!this.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			return;
		}
		const kind: SessionExitData["kind"] =
			reason === "dispose" || reason === postmortem.Reason.MANUAL
				? "normal"
				: reason === postmortem.Reason.UNCAUGHT_EXCEPTION || reason === postmortem.Reason.UNHANDLED_REJECTION
					? "fatal"
					: reason === postmortem.Reason.EXIT
						? "process_exit"
						: "signal";
		const data: SessionExitData = {
			reason,
			kind,
			recordedAt: new Date().toISOString(),
		};
		if (pendingToolCalls.length > 0) data.pendingToolCalls = pendingToolCalls;
		try {
			this.sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, data);
			this.sessionManager.flushSync();

			const exitLog = pendingToolCalls.length > 0 || kind !== "normal" ? logger.warn : logger.debug;
			exitLog("Session exit recorded", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				kind,
				pendingToolCalls: pendingToolCalls.length,
			});
		} catch (error) {
			logger.error("Failed to record session exit", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	#subscriberEmitGate: Promise<void> = Promise.resolve();

	async #emitSessionEvent(event: AgentSessionEvent, options: { detachExtensions?: boolean } = {}): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}

		const previousGate = this.#subscriberEmitGate;
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
		this.#subscriberEmitGate = gate;
		try {
			const extensionEmit = this.#emitExtensionEvent(event);
			if (options.detachExtensions) {
				void extensionEmit.catch(error => {
					logger.warn("Detached session event extension emit failed", {
						type: event.type,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			} else {
				await extensionEmit;
			}
			await previousGate;

			if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
				this.#pendingAgentEndEmit = event;
				return;
			}
			this.#emit(event);
		} finally {
			releaseGate();
		}
	}

	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	#prunedTerminalRefusal: AssistantMessage | undefined = undefined;

	#inFlightEventHandlers = new Set<Promise<void>>();

	#handleAgentEvent = (event: AgentEvent): Promise<void> => {
		const processing = this.#dispatchAgentEvent(event);
		this.#inFlightEventHandlers.add(processing);
		void processing.finally(() => this.#inFlightEventHandlers.delete(processing)).catch(() => {});
		return processing;
	};

	async #drainInFlightEventHandlers(): Promise<void> {
		while (this.#inFlightEventHandlers.size > 0) {
			await Promise.allSettled([...this.#inFlightEventHandlers]);
		}
	}

	#dispatchAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "tool_execution_end" && this.#isTerminalYieldToolResult(event)) {
			const alreadyTerminated = this.#synchronouslyTerminatedYieldToolCallIds.delete(event.toolCallId);
			if (!alreadyTerminated) {
				this.#markTerminalYieldToolCall(event.toolCallId);
				this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			}
		}
		if (event.type !== "agent_end") {
			const processing = this.#processAgentEvent(event);
			if ((event.type === "message_start" || event.type === "message_end") && isAdvisorCard(event.message)) {
				this.#advisors.trackCardEvent(processing);
			}
			return processing;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#trackPostPromptTask(promise);
		try {
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	#createMessageEndPersistenceSlot(message: AgentMessage): MessageEndPersistenceSlot | undefined {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return undefined;
		const previous = this.#messageEndPersistenceTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		const clear = () => {
			if (this.#pendingMessageEndPersistence.get(key) === promise) {
				this.#pendingMessageEndPersistence.delete(key);
			}
		};
		this.#pendingMessageEndPersistence.set(key, promise);
		this.#messageEndPersistenceTail = promise.catch(() => {});
		return {
			promise,
			persist: async persistMessage => {
				await previous;
				try {
					persistMessage();
				} finally {
					resolve();
					clear();
				}
			},
			release: () => {
				resolve();
				clear();
			},
		};
	}

	async #waitForSessionMessagePersistence(message: AgentMessage): Promise<void> {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return;
		await this.#pendingMessageEndPersistence.get(key);
	}

	#indexPersistedMessageKeys(): Set<string> {
		return this.#ensurePersistedMessageKeys();
	}

	#persistedMessageKeysAnchor(): string {
		return `${this.sessionManager.getSessionFile() ?? ""}\u0000${this.sessionManager.getLeafId() ?? ""}`;
	}

	#ensurePersistedMessageKeys(): Set<string> {
		const anchor = this.#persistedMessageKeysAnchor();
		let cache = this.#persistedMessageKeys;
		if (cache === undefined || cache.anchor !== anchor) {
			cache = { anchor, keys: this.#buildPersistedMessageKeySet() };
			this.#persistedMessageKeys = cache;
		}
		return cache.keys;
	}

	#buildPersistedMessageKeySet(): Set<string> {
		const keys = new Set<string>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const key = sessionMessagePersistenceKey(entry.message);
			if (key !== undefined) keys.add(key);
		}
		return keys;
	}

	#sessionMessageAlreadyPersisted(message: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(message);
		if (key === undefined) return false;
		const keys = this.#ensurePersistedMessageKeys();
		if (!keys.has(key)) return false;
		const branch = this.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			if (sessionMessagePersistenceKey(entry.message) !== key) continue;
			if (sameMessageContent(entry.message, message)) return true;
		}
		return false;
	}

	#appendSessionMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const cache = this.#persistedMessageKeys;
		const wasFresh = cache !== undefined && cache.anchor === this.#persistedMessageKeysAnchor();
		const entryId = this.sessionManager.appendMessage(message);
		if (message.role === "assistant") {
			(message as PersistedAssistantMessage)[kPersistedSessionEntryId] = entryId;
		}
		const key = sessionMessagePersistenceKey(message);
		if (wasFresh && cache && key) {
			cache.keys.add(key);
			cache.anchor = this.#persistedMessageKeysAnchor();
		}
		return entryId;
	}

	#persistSessionMessageIfMissing(message: AgentMessage): void {
		if (
			message.role !== "user" &&
			message.role !== "developer" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "fileMention"
		) {
			return;
		}
		if (this.#sessionMessageAlreadyPersisted(message)) return;
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			if (this.#recovery.isClassifierRefusal(assistantMsg)) return;
			if (isEmptyErrorTurn(assistantMsg)) return;
			if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
				assistantMsg.contextSnapshot = {
					promptTokens: calculatePromptTokens(assistantMsg.usage),
					nonMessageTokens:
						this.#stats.pendingNonMessageTokens ?? computeNonMessageTokens(this, this.agent.tokenizer),
					compactionEpoch: this.#stats.compactionEpoch,
				};
			}
		}
		const skipPersistedRewindResult =
			message.role === "toolResult" &&
			semanticToolResult(message.toolName, message)?.toolName === "rewind" &&
			this.#rewoundToolResultIds.delete(message.toolCallId);
		if (!skipPersistedRewindResult) {
			this.#appendSessionMessage(message);
		}
	}

	#checkpointActiveReminderFor(
		message: AgentMessage,
	): CustomMessage<{ goal?: string; startedAt?: string }> | undefined {
		if (message.role !== "toolResult" || message.isError) return undefined;
		const semanticResult = semanticToolResult(message.toolName, message);
		if (semanticResult?.toolName !== "checkpoint") return undefined;
		const details = isRecord(semanticResult.details) ? semanticResult.details : undefined;
		const goal = details ? stringProperty(details, "goal") : undefined;
		const startedAt = details ? stringProperty(details, "startedAt") : undefined;
		return {
			role: "custom",
			customType: CHECKPOINT_ACTIVE_REMINDER_TYPE,
			content: prompt.render(checkpointActiveNoticeTemplate),
			display: false,
			details: { goal, startedAt },
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#persistMessageEnd(message: AgentMessage): void {
		if (message.role === "hookMessage" || message.role === "custom") {
			if (!isPrewalkPlanNudge(message)) {
				this.sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
					message.attribution ?? "agent",
				);
			}
			if (message.role === "custom" && message.customType === "ttsr-injection") {
				this.#ttsr.markInjectedFromDetails(message.details);
			}
			return;
		}
		this.#persistSessionMessageIfMissing(message);
	}

	#demoteInterruptedThinkingOnUserInterrupt(
		message: AssistantMessage,
	): CustomMessage<InterruptedThinkingDetails> | undefined {
		if (message.stopReason !== "aborted" || !isUserInterruptAbort(message)) return undefined;
		if (preferredDialect(this.agent.state.model?.id ?? message.model) === "anthropic") return undefined;
		const demoted = demoteInterruptedThinking(message);
		if (!demoted || demoted.reasoning.length < INTERRUPTED_THINKING_MIN_CHARS) return undefined;
		const interruptedAt = Date.now();
		return {
			role: "custom",
			customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
			content: prompt.render(interruptedThinkingTemplate, { reasoning: demoted.reasoning }),
			display: false,
			details: {
				interruptedAt,
				provider: message.provider,
				model: message.model,
				blockCount: demoted.blockCount,
			},
			attribution: "agent",
			timestamp: interruptedAt,
		};
	}

	async #persistTurnMessagesForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean> {
		if (!context) return true;
		const turnMessages = [context.message, ...context.toolResults];
		for (const message of turnMessages) {
			await this.#waitForSessionMessagePersistence(message);
		}

		const branchKeys = this.#indexPersistedMessageKeys();
		const turnKeys = turnMessages.map(sessionMessagePersistenceKey);
		const persistedKeys = new Set<string>();
		for (let index = 0; index < turnMessages.length; index++) {
			const key = turnKeys[index];
			if (key === undefined) continue;

			if (branchKeys.has(key)) {
				persistedKeys.add(key);
			}
		}
		const plan = planTurnPersistence(turnKeys, persistedKeys);
		if (plan.kind === "out-of-order") {
			const message = turnMessages[plan.messageIndex];
			logger.debug("Skipping mid-run compaction because turn persistence is out of order", {
				role: message.role,
				timestamp: message.timestamp,
			});
			return false;
		}
		for (const index of plan.toPersist) {
			this.#persistSessionMessageIfMissing(turnMessages[index]);
		}
		return true;
	}

	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "agent_start") {
			this.#prunedTerminalRefusal = undefined;
			this.#emitRunState("running");
		}

		if (event.type === "message_end" && event.message.role === "toolResult") {
			this.#todo.onToolResult(event.message.toolName, event.message.isError);
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#lastAssistantMessage = event.message;
		}
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted"
		) {
			const message = event.message as AssistantMessage;
			if (this.#pendingAbortErrorId) {
				message.errorId = this.#pendingAbortErrorId;
				this.#pendingAbortErrorId = undefined;
			}
		}

		const interruptedThinkingMessage =
			event.type === "message_end" && event.message.role === "assistant"
				? this.#demoteInterruptedThinkingOnUserInterrupt(event.message as AssistantMessage)
				: undefined;

		if (interruptedThinkingMessage) {
			this.agent.appendMessage(interruptedThinkingMessage);
		}

		const checkpointReminder =
			event.type === "message_end" && event.message.role === "toolResult"
				? this.#checkpointActiveReminderFor(event.message)
				: undefined;
		if (checkpointReminder) {
			this.#checkpointState = {
				checkpointMessageCount: this.agent.state.messages.length,
				checkpointEntryId: null,
				startedAt:
					(checkpointReminder.details && stringProperty(checkpointReminder.details, "startedAt")) ??
					new Date().toISOString(),
			};
			this.#pendingRewindReport = undefined;
			this.#lastCompletedRewind = undefined;
			this.agent.steer(checkpointReminder);
		}

		const messageEndPersistence =
			event.type === "message_end" ? this.#createMessageEndPersistenceSlot(event.message) : undefined;

		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = deobfuscateAssistantContent(obfuscator, message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}

		if (event.type === "tool_execution_start") {
			this.#recordToolExecutionStart(event);
		}

		if (event.type !== "agent_end") {
			try {
				await this.#emitSessionEvent(displayEvent);
			} catch (error) {
				if (event.type === "message_end") {
					const persistMessageEnd = () => this.#persistMessageEnd(event.message);
					try {
						if (messageEndPersistence) await messageEndPersistence.persist(persistMessageEnd);
						else persistMessageEnd();
					} catch (persistenceError) {
						logger.warn("Failed to persist message after session event emission failed", {
							error: String(persistenceError),
						});
					}
				}
				throw error;
			}
		}

		if (event.type === "turn_start") {
			this.#streamingEditGuard.reset();
			this.#ttsr.onTurnStart();
		}

		if (event.type === "turn_end") this.#ttsr.onTurnEnd();

		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end") {
			if (event.toolName === "goal") {
				await this.#goalRuntime.onGoalToolCompleted();
			} else {
				await this.#goalRuntime.onToolCompleted(event.toolName);
			}
		}

		if (await this.#ttsr.checkMessageUpdate(event)) return;

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			this.#streamingEditGuard.preCache(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#streamingEditGuard.maybeAbort(event);
		}

		if (event.type === "message_end") {
			const persistMessageEnd = () => this.#persistMessageEnd(event.message);
			if (messageEndPersistence) {
				await messageEndPersistence.persist(persistMessageEnd);
			} else {
				persistMessageEnd();
			}
			if (interruptedThinkingMessage) {
				this.sessionManager.appendCustomMessageEntry(
					interruptedThinkingMessage.customType,
					interruptedThinkingMessage.content,
					interruptedThinkingMessage.display,
					interruptedThinkingMessage.details,
					interruptedThinkingMessage.attribution,
				);
			}

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;

				if (assistantMsg.stopReason !== "error" && assistantMsg.duration !== undefined) {
					this.settings.getStorage()?.recordModelPerf(`${assistantMsg.provider}/${assistantMsg.model}`, {
						outputTokens: assistantMsg.usage.output,
						durationMs: assistantMsg.duration,
						ttftMs: assistantMsg.ttft,
					});
				}
				if (
					assistantMsg.disabledFeatures?.includes("priority") &&
					this.serviceTierByFamily.anthropic === "priority"
				) {
					this.setServiceTierFamily("anthropic", undefined);
					this.emitNotice(
						"warning",
						"Priority/fast mode rejected for this model; retried without it. Fast mode is now off.",
						"priority",
					);
				}
				this.#ttsr.onAssistantMessageEnd(assistantMsg);
				await this.#recovery.onAssistantSettledSuccessfully(assistantMsg);

				this.#modelRegistry.authStorage.recordObservedUsage({
					provider: assistantMsg.provider,
					model: assistantMsg.model,
					at: assistantMsg.timestamp,
					usage: {
						input: assistantMsg.usage.input,
						output: assistantMsg.usage.output,
						cacheRead: assistantMsg.usage.cacheRead,
						cacheWrite: assistantMsg.usage.cacheWrite,
					},
					costUsd: assistantMsg.usage.cost.total,
				});

				recordCredentialPin(
					this.#modelRegistry.authStorage,
					this.sessionManager,
					this.sessionId,
					assistantMsg.provider,
				);
			}
			if (event.message.role === "toolResult") {
				const { toolName, toolCallId, isError, content } = event.message;
				const details = isRecord(event.message.details) ? event.message.details : undefined;
				const semanticResult = semanticToolResult(toolName, event.message);
				const semanticDetails = isRecord(semanticResult?.details) ? semanticResult.details : undefined;

				const editedPath = details ? stringProperty(details, "path") : undefined;
				if (toolName === "edit" && editedPath) {
					this.#streamingEditGuard.invalidate(editedPath);
				}
				if (toolName === "todo" && !isError && details && this.#todo.onTodoResultDetails(details, toolCallId)) {
					this.#scheduleReplanTitleRefresh();
				}
				if (toolName === "todo" && isError) {
					const errorText = content.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
						"Fix the todo payload and call todo again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (semanticResult?.toolName === "checkpoint" && !isError) {
					const entries = this.sessionManager.getEntries();
					let checkpointEntryId: string | null = null;
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i];
						if (entry.type === "message" && entry.message === event.message) {
							checkpointEntryId = entry.id;
							break;
						}
					}
					if (this.#checkpointState) {
						this.#checkpointState.checkpointEntryId = checkpointEntryId;
					}
				}
				if (semanticResult?.toolName === "rewind" && !isError && this.#checkpointState) {
					const detailReport = semanticDetails ? (stringProperty(semanticDetails, "report")?.trim() ?? "") : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		if (event.type === "agent_end") {
			const settledMessages = event.messages;
			const activeMessages = this.agent.state.messages;

			const ttsrAbortPendingAtAgentEnd = this.#ttsr.abortPending;
			const emitAgentEndNotification = async (options?: { willContinue?: boolean }) => {
				this.#emitRunState("idle");

				await this.#emitSessionEvent({ ...event, isTerminal: !options?.willContinue });
				void this.#emitAgentEndNotification([...activeMessages], options).catch(err => {
					logger.error("Agent end extension notification failed", { err });
				});
			};
			const usage = this.getSessionStats().tokens;
			await this.#goalRuntime.onAgentEnd({
				currentUsage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				},
			});
			const fallbackAssistant = [...settledMessages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const msg = this.#lastAssistantMessage ?? fallbackAssistant;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				logger.debug("agent_end maintenance routing", {
					reason: "no-assistant-message",
					goalModeEnabled: this.#goalModeState?.enabled === true,
					goalStatus: this.#goalModeState?.goal.status,
				});
				await emitAgentEndNotification();
				return;
			}

			const yieldOnThisMessage = this.#assistantEndedWithSuccessfulYield(msg);
			const successfulYieldMessage = yieldOnThisMessage
				? msg
				: this.#findSuccessfulYieldAssistantMessage(settledMessages);

			const maintenanceRoute = (route: string, extra?: Record<string, unknown>) => {
				logger.debug("agent_end maintenance routing", {
					route,
					stopReason: msg.stopReason,
					provider: msg.provider,
					model: msg.model,
					contentBlocks: msg.content.length,
					hasToolCalls: msg.content.some(content => content.type === "toolCall"),
					hasText: msg.content.some(content => content.type === "text"),
					goalModeEnabled: this.#goalModeState?.enabled === true,
					goalStatus: this.#goalModeState?.goal.status,
					successfulYield: successfulYieldMessage !== undefined,
					...extra,
				});
			};
			maintenanceRoute("entered");

			logProviderTurnError(msg);

			if (msg.stopReason === "error" && msg.provider === "github-copilot") {
				const errorId = AIError.classifyMessage(msg);
				const isConcurrencyCap = AIError.parseRateLimitReason(msg.errorMessage ?? "") === "CONCURRENT_LIMIT";
				if (
					AIError.is(errorId, AIError.Flag.AuthFailed) &&
					!AIError.is(errorId, AIError.Flag.UsageLimit) &&
					!isConcurrencyCap
				) {
					await this.#modelRegistry.authStorage.remove("github-copilot");
				}
			}

			if (this.#maintenance.skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#maintenance.skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				maintenanceRoute("skip-post-turn-maintenance");
				await emitAgentEndNotification();
				return;
			}

			const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";

			if (successfulYieldMessage || this.#yieldTerminationPending) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				if (successfulYieldMessage && activeGoal) {
					maintenanceRoute(
						yieldOnThisMessage
							? "successful-yield-active-goal-checkCompaction"
							: "post-yield-trailing-stop-active-goal-checkCompaction",
					);
					const compactionTask = this.#maintenance.checkCompaction(successfulYieldMessage);
					this.#trackPostPromptTask(compactionTask);
					await compactionTask;
				} else if (successfulYieldMessage) {
					maintenanceRoute("successful-yield-no-active-goal");
				} else {
					maintenanceRoute("post-yield-trailing-stop-suppressed");
				}
				await emitAgentEndNotification();
				return;
			}
			this.#lastSuccessfulYieldToolCallId = undefined;

			const emptyOutputRecovery = await this.#recovery.handleEmptyAssistantStop(msg);
			if (emptyOutputRecovery === "continue") {
				maintenanceRoute("empty-stop-handled");
				await emitAgentEndNotification({ willContinue: true });
				return;
			}
			if (emptyOutputRecovery === "terminal") {
				maintenanceRoute("empty-stop-retry-cap");
			}

			await this.#recovery.recordUsageLimitOutcome(msg);

			let compactionResult = COMPACTION_CHECK_NONE;
			let checkedCompaction = false;
			if (activeGoal) {
				maintenanceRoute("active-goal-pre-empt-checkCompaction");
				const compactionTask = this.#maintenance.checkCompaction(msg);
				this.#trackPostPromptTask(compactionTask);
				compactionResult = await compactionTask;
				checkedCompaction = true;
				const compactionContinues = compactionResult.continuationScheduled;
				if (compactionContinues || compactionResult.automaticContinuationBlocked) {
					maintenanceRoute("active-goal-pre-empt-compaction-handled", {
						continuationScheduled: compactionResult.continuationScheduled,
						automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
					});
					this.#recovery.resolveRetry();
					await emitAgentEndNotification(
						compactionResult.continuationScheduled ? { willContinue: true } : undefined,
					);
					return;
				}
			}

			if (await this.#recovery.handleUnexpectedAssistantStop(msg)) {
				maintenanceRoute("unexpected-stop-handled");
				await emitAgentEndNotification({ willContinue: true });
				return;
			}

			const resolvedInterruptedToolTurn = this.#recovery.classifyResolvedInterruptedToolTurn(msg);
			if (this.#recovery.isRetryableReasonlessAbort(msg) || resolvedInterruptedToolTurn === "reasonless-abort") {
				const didRetry = await this.#recovery.handleRetryableError(
					msg,
					resolvedInterruptedToolTurn === "reasonless-abort"
						? { allowModelFallback: false, preserveFailedTurn: true }
						: { allowModelFallback: false },
				);
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}

			if (msg.stopReason === "aborted") {
				this.#recovery.resolveRetry();
				this.#resetSessionStopContinuationState();
				await emitAgentEndNotification(ttsrAbortPendingAtAgentEnd ? { willContinue: true } : undefined);
				return;
			}

			if (this.#recovery.isFireworksFastFallbackEligible(msg)) {
				const didRetry = await this.#recovery.handleRetryableError(msg, { fireworksFastFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}
			const resumeResolvedStreamStall = resolvedInterruptedToolTurn === "stream-stall";
			if (resumeResolvedStreamStall || this.#recovery.isRetryableError(msg)) {
				const didRetry = await this.#recovery.handleRetryableError(
					msg,
					resumeResolvedStreamStall ? { preserveFailedTurn: true } : undefined,
				);
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			} else if (this.#recovery.isHardErrorFallbackEligible(msg)) {
				const didRetry = await this.#recovery.handleRetryableError(msg, { hardErrorFallback: true });
				if (didRetry) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}

			if (this.#recovery.isClassifierRefusal(msg)) {
				this.#prunedTerminalRefusal = msg;
				this.#recovery.removeAssistantMessageFromActiveContext(msg);
			} else if (!AIError.isContextOverflow(msg, this.model?.contextWindow ?? 0)) {
				await this.#recovery.persistTerminalEmptyErrorTurn(msg);
			}
			this.#recovery.resolveRetry();

			if (!checkedCompaction) {
				maintenanceRoute("bottom-checkCompaction");
				const compactionTask = this.#maintenance.checkCompaction(msg);
				this.#trackPostPromptTask(compactionTask);
				compactionResult = await compactionTask;
			}
			await this.#recovery.onErrorSettledWithoutRetry(msg, compactionResult);

			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				await emitAgentEndNotification();
				return;
			}

			if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) {
				await emitAgentEndNotification(compactionResult.continuationScheduled ? { willContinue: true } : undefined);
				return;
			}
			if (msg.stopReason !== "error") {
				if (this.#enforceRewindBeforeYield()) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
				const todoContinuationScheduled = await this.#todo.checkCompletion(msg);
				if (todoContinuationScheduled) {
					await emitAgentEndNotification({ willContinue: true });
					return;
				}
			}

			if (this.#hasPendingAsyncWake()) {
				await emitAgentEndNotification({ willContinue: true });
				return;
			}
			const sessionStopWillContinue = await this.#emitSessionStopEvent(activeMessages, msg);
			await emitAgentEndNotification(sessionStopWillContinue ? { willContinue: true } : undefined);
		}
	};

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<unknown>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: (reason: PostPromptSkipReason) => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					if (signal.aborted) options?.onSkip?.("aborted");
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.("aborted");
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.("stale-generation");
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#skipAgentContinue(reason: AgentContinueSkipReason, options: ScheduledAgentContinueOptions | undefined): void {
		logger.debug("agent.continue skipped after scheduling", { reason });
		options?.onSkip?.(reason);
	}

	#scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void {
		this.#schedulePostPromptTask(
			async signal => {
				if (signal.aborted || this.#isDisposed || this.isCompacting) {
					this.#skipAgentContinue("session-unavailable", options);
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					this.#skipAgentContinue("should-continue-false", options);
					return;
				}
				this.#beginInFlight();
				try {
					const reverted = await this.#recovery.maybeRestoreRetryFallbackPrimary();
					if (signal.aborted || this.#isDisposed) {
						this.#skipAgentContinue("post-restore-unavailable", options);
						return;
					}

					if (reverted) {
						await this.#maintenance.runPrePromptCompactionIfNeeded([]);
						if (signal.aborted || this.#isDisposed) {
							this.#skipAgentContinue("post-restore-unavailable", options);
							return;
						}
					}
					if (this.settings.get("retry.usageAwareFallback")) {
						if (!(await this.#runQueuedUsageAwarePreflight(signal))) {
							this.#skipAgentContinue("session-unavailable", options);
							return;
						}
					}
					await this.agent.continue(signal);
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					options?.onError?.(error);
				} finally {
					this.#usagePreflightReadyForNextModelCall = false;
					this.#endInFlight();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: reason => this.#skipAgentContinue(reason, options),
			},
		);
	}

	#scheduleCompactionContinuation(options: {
		generation: number;
		autoContinue: boolean;
		terminalTextAnswer: boolean;
		suppressContinuation: boolean;
	}): boolean {
		if (options.suppressContinuation) return false;
		if (this.agent.hasQueuedMessages()) {
			this.#scheduleAgentContinue({
				delayMs: 100,
				generation: options.generation,
				shouldContinue: () => this.agent.hasQueuedMessages(),
			});
			return true;
		}
		if (!options.autoContinue) return false;
		const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
		if (options.terminalTextAnswer && !activeGoal) return false;
		return this.#scheduleAutoContinuePrompt(options.generation);
	}

	#scheduleAutoContinuePrompt(generation: number): boolean {
		const continuePrompt = async () => {
			const eagerNudges = this.#todo.buildPostCompactionEagerNudges();
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{
					skipPostPromptRecoveryWait: true,
					prependMessages: eagerNudges.length > 0 ? eagerNudges : undefined,
				},
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				if (this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
					return;
				}
				await continuePrompt();
			},
			{ generation },
		);
		return true;
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#ttsr.resolveResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}

	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			if (generation !== undefined && this.#promptGeneration !== generation) return;
			const retryPromise = this.#recovery.retryPromise;
			if (retryPromise) {
				await retryPromise;
				continue;
			}
			const ttsrResumeGate = this.#ttsr.resumeGate;
			if (ttsrResumeGate) {
				await ttsrResumeGate;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}

			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		if (
			this.#isTerminalYieldToolResult({
				toolName: ctx.toolCall.name,
				isError: ctx.isError,
				result: ctx.result,
			})
		) {
			this.#markTerminalYieldToolCall(ctx.toolCall.id);
			this.#synchronouslyTerminatedYieldToolCallIds.add(ctx.toolCall.id);
			this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		}
		return this.#ttsr.afterToolCall(ctx);
	}

	async #beforeToolCall(ctx: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
		const runner = this.#extensionRunner;
		if (!runner?.hasHandlers("tool_call")) return undefined;
		const metadata = ctx.toolCall.providerMetadata;
		const computer = metadata?.type === "computer" ? metadata : undefined;
		const eventArgs = computer
			? { actions: computer.actions, pendingSafetyChecks: computer.pendingSafetyChecks }
			: ctx.args;
		runner.markToolCallEmitted(ctx.toolCall.id, ctx.tool.name);
		const callResult = await runner.emitToolCall(
			{
				type: "tool_call",
				toolName: ctx.tool.name,
				toolCallId: ctx.toolCall.id,
				input: normalizeToolEventInput(ctx.tool.name, resolveToolEventInput(ctx.tool, eventArgs)),
			},
			signal,
		);
		if (callResult?.block) {
			return { block: true, reason: callResult.reason || "Tool execution was blocked by an extension" };
		}

		if (callResult?.input !== undefined && !computer) {
			return { args: callResult.input };
		}
		return undefined;
	}

	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#resetSessionStopContinuationState(): void {
		this.#sessionStopContinuationCount = 0;
		this.#sessionStopHookActive = false;
	}

	#clearPendingSessionStopContinuations(): void {
		if (!this.#pendingNextTurnMessages.some(message => message.customType === "session-stop-continuation")) {
			return;
		}
		this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(
			message => message.customType !== "session-stop-continuation",
		);
	}

	#sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
		if (!result) return undefined;
		const additionalContext =
			typeof result.additionalContext === "string" && result.additionalContext.length > 0
				? result.additionalContext
				: undefined;
		const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
		if (result.continue === true) {
			return additionalContext ?? reason;
		}
		if (result.decision === "block") {
			return reason ?? additionalContext;
		}
		return undefined;
	}

	async #emitAgentEndNotification(messages: AgentMessage[], options?: { willContinue?: boolean }): Promise<void> {
		await this.#extensionRunner?.emit({
			type: "agent_end",
			messages,
			willContinue: options?.willContinue,
		});
	}

	async #emitSessionStopEvent(
		messages: AgentMessage[],
		lastAssistantMessage = this.getLastAssistantMessage(),
	): Promise<boolean> {
		if (this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return false;
		}
		if (this.#agentKind === "sub" || !this.#extensionRunner?.hasHandlers("session_stop")) {
			return false;
		}
		const generation = this.#promptGeneration;
		const result = await this.#extensionRunner.emitSessionStop({
			messages,
			turn_id: Math.max(0, this.#turnIndex - 1),
			last_assistant_message: lastAssistantMessage,
			session_id: this.sessionId,
			session_file: this.sessionFile,
			stop_hook_active: this.#sessionStopHookActive,
			signal: this.#postPromptTasksAbortController.signal,
		});
		if (this.#promptGeneration !== generation || this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return false;
		}
		const additionalContext = this.#sessionStopContinuationContext(result);
		if (!additionalContext) {
			this.#resetSessionStopContinuationState();
			return false;
		}
		if (this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: this.sessionId,
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#resetSessionStopContinuationState();
			return false;
		}
		this.#sessionStopContinuationCount++;
		this.#sessionStopHookActive = true;
		this.#queueHiddenNextTurnMessage(
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: additionalContext,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			true,
		);
		return true;
	}

	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (!this.#extensionRunner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: cloneMessageEndNotification(event.message),
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				retryErrors: event.retryErrors,
			});
		} else if (event.type === "retry_fallback_applied") {
			await this.#extensionRunner.emit({
				type: "retry_fallback_applied",
				from: event.from,
				to: event.to,
				role: event.role,
			});
		} else if (event.type === "retry_fallback_succeeded") {
			await this.#extensionRunner.emit({
				type: "retry_fallback_succeeded",
				model: event.model,
				role: event.role,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await this.#extensionRunner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		}
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	subscribeRunState(listener: (state: "running" | "idle") => void): () => void {
		this.#runStateListeners.add(listener);
		return () => this.#runStateListeners.delete(listener);
	}

	registerSessionChangeCallback(callback: () => void): () => void {
		this.#sessionChangeCallbacks.add(callback);
		return () => this.#sessionChangeCallbacks.delete(callback);
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#commandMetadataChangedListeners.push(listener);
		return () => {
			const index = this.#commandMetadataChangedListeners.indexOf(listener);
			if (index !== -1) {
				this.#commandMetadataChangedListeners.splice(index, 1);
			}
		};
	}

	#notifyCommandMetadataChanged(): void {
		const listeners = [...this.#commandMetadataChangedListeners];
		for (const listener of listeners) {
			try {
				void listener();
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}

	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return;
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	#activeProviderSessionId(sessionId?: string): string {
		return this.#freshProviderSessionId ?? this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId();
	}

	#adoptInheritedProviderPromptCacheKey(): void {
		const key = this.sessionManager.getHeader()?.providerPromptCacheKey;
		if (!key) return;
		if (this.#inheritedProviderPromptCacheKey !== undefined || this.agent.promptCacheKey === undefined) {
			this.agent.promptCacheKey = key;
			this.#inheritedProviderPromptCacheKey = key;
		}
	}

	#clearInheritedProviderPromptCacheKey(): void {
		const key = this.#inheritedProviderPromptCacheKey;
		this.#inheritedProviderPromptCacheKey = undefined;
		if (key !== undefined && this.agent.promptCacheKey === key) {
			this.agent.promptCacheKey = undefined;
		}
	}

	#syncAgentSessionId(sessionId?: string, notifyChange = true): void {
		const currentSessionId = this.sessionManager.getSessionId();
		if (this.#observedSessionId === undefined) {
			this.#observedSessionId = currentSessionId;
		} else if (this.#observedSessionId !== currentSessionId) {
			this.#observedSessionId = currentSessionId;
			if (notifyChange) this.#notifySessionChangeCallbacks();
		}
		const sid = this.#activeProviderSessionId(sessionId);
		this.agent.sessionId = sid;
		this.agent.setMetadataResolver((provider: string) =>
			buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
		);

		if (!this.#freshProviderSessionId) {
			seedCredentialPins(this.#modelRegistry.authStorage, this.sessionManager, sid);
		}

		if (this.#advisors) this.#advisors.refreshProviderIdentity();
		if (this.#conductor) this.#conductor.refreshProviderIdentity();
	}

	#notifySessionChangeCallbacks(): void {
		for (const callback of [...this.#sessionChangeCallbacks]) {
			try {
				callback();
			} catch (error) {
				logger.warn("Session change callback failed", { error: String(error) });
			}
		}
	}

	async runAutolearnCapture(capture: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.#autolearnCaptureTask || this.#isDisposed) return;
		const controller = new AbortController();
		this.#autolearnCaptureAbortController = controller;
		const task = (async () => {
			try {
				await capture(controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) throw error;
			} finally {
				if (this.#autolearnCaptureAbortController === controller) {
					this.#autolearnCaptureAbortController = undefined;
				}
			}
		})();
		this.#autolearnCaptureTask = task;
		try {
			await task;
		} finally {
			if (this.#autolearnCaptureTask === task) this.#autolearnCaptureTask = undefined;
		}
	}

	#abortAutolearnCapture(): void {
		this.#autolearnCaptureAbortController?.abort();
	}

	async #drainAutolearnCapture(): Promise<void> {
		const task = this.#autolearnCaptureTask;
		if (!task) return;
		try {
			await withTimeout(task, 3_000, "Timed out draining auto-learn capture during dispose");
		} catch (error) {
			logger.warn("Auto-learn capture did not settle during dispose", { error: String(error) });
		}
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = path.resolve(sessionFile);
	}

	beginDispose(): void {
		this.#isDisposed = true;
		this.#liveHeartbeat?.dispose();
		this.#liveHeartbeat = undefined;
		this.#queuedMessageDrainBlocked = false;
		this.#usagePreflightReadyForNextModelCall = false;
		this.#detachUsageBeforeQueueDequeue?.();
		this.#detachUsageBeforeQueueDequeue = undefined;
		this.#detachUsageBeforeModelCall?.();
		this.#detachUsageBeforeModelCall = undefined;
		this.#titleGenerationAbortController.abort();
		this.#abortAutolearnCapture();
		this.#irc.flushPending();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#advisors.stopRuntime();
		this.#conductor.stopRuntime();
		this.#eval.beginDispose();
	}

	#disposeCall?: Promise<void>;
	dispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		if (!this.#disposeCall) this.#disposeCall = this.#doDispose(options);
		return this.#disposeCall;
	}

	async #disposeOwnedAsyncJobs(): Promise<void> {
		this.#unregisterAsyncDeliverySink?.();
		this.#unregisterAsyncDeliverySink = undefined;
		const manager = this.#ownedAsyncJobManager;

		this.#cancelOwnAsyncJobs(manager ? ASYNC_JOB_MANAGER_SHUTDOWN_REASON : undefined);
		if (!manager) return;

		try {
			const drained = await manager.dispose({ timeoutMs: 3_000 });
			const deliveryState = manager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
		} finally {
			if (AsyncJobManager.instance() === manager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
	}

	async #releaseOwnedBrowserTabs(ownerId: string | undefined): Promise<void> {
		if (!ownerId) return;
		try {
			const released = await withTimeout(
				releaseTabsForOwner(ownerId, { kill: true }),
				3_000,
				"Timed out releasing owned browser tabs during dispose",
			);
			if (released > 0) {
				logger.debug("Released owned browser tabs during dispose", { ownerId, released });
			}
		} catch (error) {
			logger.warn("Failed to release owned browser tabs during dispose", { error: String(error) });
		}
	}

	async #releaseOwnedComputerSessions(ownerId: string | undefined): Promise<void> {
		if (!ownerId) return;
		try {
			await withTimeout(
				releaseComputerSessionsForOwner(ownerId),
				3_000,
				"Timed out releasing native computer session during dispose",
			);
		} catch (error) {
			logger.warn("Failed to release native computer session during dispose", { error: String(error) });
		}
	}

	async #disconnectOwnedMcp(): Promise<void> {
		if (!this.#disconnectOwnedMcpManager) return;
		try {
			await withTimeout(
				this.#disconnectOwnedMcpManager(),
				3_000,
				"Timed out disconnecting owned MCP manager during dispose",
			);
		} catch (error) {
			logger.warn("Failed to disconnect owned MCP manager during dispose", { error: String(error) });
		}
	}

	async #doDispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		this.beginDispose();
		this.#recordSessionExit(options.reason ?? "dispose");
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
		this.#cancelFatalRecoveryHint?.();
		this.#cancelFatalRecoveryHint = undefined;
		try {
			await emitSessionShutdownEvent(this.#extensionRunner);
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}

		this.#fallbackExtensionTimers?.clearAll();
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		try {
			await withTimeout(
				postPromptDrain,
				POST_PROMPT_DRAIN_TIMEOUT_MS,
				"Timed out draining post-prompt tasks during dispose",
			);
		} catch (error) {
			logger.warn("Post-prompt tasks still draining at dispose deadline", { error: String(error) });
		}
		await this.#drainAutolearnCapture();
		const advisorRecorderClosed = this.#advisors.recorderClosed();
		const conductorRecorderClosed = this.#conductor.recorderClosed();
		const results = await Promise.allSettled([
			this.#disposeOwnedAsyncJobs(),
			this.#eval.disposeKernels(),
			this.#releaseOwnedBrowserTabs(this.sessionManager.getSessionId()),
			this.#releaseOwnedComputerSessions(this.#eval.getKernelOwnerId()),
			shutdownTinyTitleClient(),
			this.#disconnectOwnedMcp(),
			advisorRecorderClosed,
			conductorRecorderClosed,
		]);
		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn("Session dispose subsystem failed during parallel teardown", {
					error: String(result.reason),
				});
			}
		}

		this.#releasePowerAssertion();
		await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
		this.#movedFromEmptySessionFile = undefined;
		this.#closeAllProviderSessions("dispose");
		this.#maintenance.cancelSpeculation();
		this.#disconnectFromAgent();
		if (this.#unsubscribeAppendOnly) {
			this.#unsubscribeAppendOnly();
			this.#unsubscribeAppendOnly = undefined;
		}
		if (this.#unsubscribeModelRoles) {
			this.#unsubscribeModelRoles();
			this.#unsubscribeModelRoles = undefined;
		}
		if (this.#unsubscribeExtendedContext) {
			this.#unsubscribeExtendedContext();
			this.#unsubscribeExtendedContext = undefined;
		}
		if (this.#unsubscribeCodeMode) {
			this.#unsubscribeCodeMode();
			this.#unsubscribeCodeMode = undefined;
		}
		this.#eventListeners = [];
		this.#runStateListeners.clear();
		this.#sessionChangeCallbacks.clear();

		this.agent.setProviderResponseInterceptor(undefined);
		this.agent.setRawSseEventInterceptor(undefined);
		let drained = false;
		try {
			await withTimeout(
				(async () => {
					await this.agent.waitForIdle();
					await this.#drainInFlightEventHandlers();
				})(),
				options.drainTimeoutMs ?? POST_PROMPT_DRAIN_TIMEOUT_MS,
				"Timed out waiting for the active agent run to settle during dispose",
			);
			drained = true;
		} catch (error) {
			logger.warn("Active agent run still settling at dispose deadline", { error: String(error) });
		}

		this.sessionManager.seal();
		await this.sessionManager.close();

		if (!drained) {
			void (async () => {
				await this.agent.waitForIdle();
				await this.#drainInFlightEventHandlers();
			})().catch(error => logger.warn("Deferred dispose finalization failed", { error: String(error) }));
		}
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	async resetSessionContext(): Promise<ResetSessionContextResult | undefined> {
		if (this.isStreaming || this.isBashRunning || this.isEvalRunning) return undefined;
		const droppedCount = this.agent.state.messages.length;

		this.#promptGeneration++;
		await this.#cancelPostPromptTasks();
		this.#cancelOwnAsyncJobs();

		this.agent.reset();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.#resetSessionStopContinuationState();

		this.#clearCheckpointRuntimeState();
		this.#clearSessionScopedToolState();

		this.#closeAllProviderSessions("reset context");
		this.#freshProviderSessionId = Bun.randomUUIDv7();
		this.#syncAgentSessionId();

		this.#advisors.resetSessionState();
		this.#conductor.resetSessionState();

		this.sessionManager.appendResetBoundary();

		resetCapabilities();
		await this.refreshBaseSystemPrompt();

		return { droppedCount };
	}

	get state(): AgentState {
		return this.agent.state;
	}

	get model(): Model | undefined {
		return this.agent.state.model;
	}

	#maybeRefreshLazyLocalContext(response: ProviderResponseMetadata, model: Model | undefined): void | Promise<void> {
		if (!model || response.status < 200 || response.status >= 300) return;
		const key = `${model.provider}/${model.id}`;
		if (this.#lazyContextRefreshed.has(key)) return;
		if (!this.#modelRegistry.hasLazyRuntimeMetadata(model.provider)) return;
		this.#lazyContextRefreshed.add(key);
		return this.#refreshLazyLocalContext(model);
	}

	async #refreshLazyLocalContext(model: Model): Promise<void> {
		try {
			const refreshed = await this.#modelRegistry.refreshSelectedModelMetadata(model);
			const current = this.model;

			if (!current || !modelsAreEqual(current, refreshed) || refreshed.contextWindow === current.contextWindow) {
				return;
			}
			this.agent.setModel(refreshed);
		} catch (error) {
			logger.debug("Lazy local model context refresh failed", {
				provider: model.provider,
				model: model.id,
				error,
			});
		}
	}

	get servingModel(): ServingModel | undefined {
		return this.#recovery.servingModel;
	}

	setUsageFallbackConfirmer(confirmer: UsageFallbackConfirmer | undefined): void {
		this.#usageFallbackConfirmer = confirmer;
	}

	#allowQueuedMessageDrainRetry(): void {
		this.#queuedMessageDrainBlocked = false;
	}

	#reconcileQueuedMessageDrain(): void {
		if (!this.agent.hasQueuedMessages()) {
			this.#queuedMessageDrainBlocked = false;
		}
	}

	async #runQueuedUsageAwarePreflight(signal?: AbortSignal): Promise<boolean> {
		try {
			const allowed = await this.#runUsageAwarePreflight(signal);
			this.#usagePreflightReadyForNextModelCall = allowed;
			this.#usagePreflightReadyModel = allowed ? this.model : undefined;
			this.#queuedMessageDrainBlocked = !allowed && this.agent.hasQueuedMessages();
			return allowed;
		} catch (error) {
			this.#queuedMessageDrainBlocked = this.agent.hasQueuedMessages();
			throw error;
		}
	}

	async #runUsageAwarePreflightForNextModelCall(signal?: AbortSignal): Promise<boolean> {
		const allowed = await this.#runUsageAwarePreflight(signal);
		this.#usagePreflightReadyForNextModelCall = allowed;
		this.#usagePreflightReadyModel = allowed ? this.model : undefined;
		return allowed;
	}

	async #runUsageAwarePreflight(signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return false;
		const generation = this.#promptGeneration;

		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#usagePreflightAbortControllers.add(controller);
		try {
			while (true) {
				const model = this.model;
				try {
					const fallbackCommitted = await this.#recovery.maybeApplyUsageAwareFallback(
						controller.signal,
						this.#usageFallbackConfirmer,
					);
					if (fallbackCommitted) return true;
					if (controller.signal.aborted || this.#promptGeneration !== generation) return false;
					if (this.model === model || modelsAreEqual(this.model, model)) return true;
				} catch (error) {
					if (controller.signal.aborted || this.#promptGeneration !== generation) return false;
					if (this.model !== model && !modelsAreEqual(this.model, model)) continue;
					throw error;
				}
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.#usagePreflightAbortControllers.delete(controller);
		}
	}

	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#models.thinkingLevel;
	}

	configuredThinkingLevel(): ThinkingLevel | undefined {
		return this.#models.configuredThinkingLevel();
	}

	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#models.serviceTierByFamily;
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#advisors.waitForPendingCardEvents();
		await this.#waitForPostPromptRecovery();
	}

	prepareForHeadlessAdvisorDrain(): void {
		this.#advisors.prepareForHeadlessAdvisorDrain();
	}

	waitForAdvisorCatchup(timeoutMs: number): Promise<boolean> {
		return this.#advisors.waitForAdvisorCatchup(timeoutMs);
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#prunedTerminalRefusal ?? this.#findLastAssistantMessage();
	}

	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	setTextOutputCommitted(committed: boolean): void {
		this.#textOutputCommitted = committed;
	}

	get retryAttempt(): number {
		return this.#recovery.attempt;
	}

	getActiveToolNames(): string[] {
		return this.#tools.getActiveToolNames();
	}

	getEnabledToolNames(): string[] {
		return this.#tools.getEnabledToolNames();
	}

	getMountedXdevToolNames(): string[] {
		return this.#tools.getMountedXdevToolNames();
	}

	get hasEditTool(): boolean {
		return this.#tools.hasEditTool;
	}

	getToolByName(name: string): AgentTool | undefined {
		return this.#tools.getToolByName(name);
	}

	getToolForEvalBridge(name: string): AgentTool | undefined {
		return this.#tools.getToolForEvalBridge(name);
	}

	getEvalBridgeToolNames(): string[] {
		return this.#tools.getEvalBridgeToolNames();
	}

	getCodeModeDirectToolNames(): readonly string[] | undefined {
		return this.#tools.getCodeModeDirectToolNames();
	}

	hasBuiltInTool(name: string): boolean {
		return this.#tools.hasBuiltInTool(name);
	}

	setToolBuiltIn(name: string, builtIn: boolean): void {
		this.#tools.setToolBuiltIn(name, builtIn);
	}

	hasRpcHostTool(name: string): boolean {
		return this.#tools.hasRpcHostTool(name);
	}

	hasMCPManagerTool(name: string): boolean {
		return this.#tools.hasMCPManagerTool(name);
	}

	setMCPManagerTool(name: string, managerOwned: boolean): void {
		this.#tools.setMCPManagerTool(name, managerOwned);
	}

	getExtensionMCPTool(name: string): AgentTool | undefined {
		return this.#tools.getExtensionMCPTool(name);
	}

	setExtensionMCPTool(name: string, tool: AgentTool | undefined): void {
		this.#tools.setExtensionMCPTool(name, tool);
	}

	runToolRegistryMutation<T>(mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#tools.runToolRegistryMutation(mutation, signal);
	}

	getAllToolNames(): string[] {
		return this.#tools.getAllToolNames();
	}

	getAllToolInfos(): ToolInfo[] {
		return this.#tools.getAllToolInfos();
	}

	#resolveActiveEditMode(): EditMode {
		return this.#tools.resolveActiveEditMode();
	}

	#syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		return this.#tools.syncAfterModelChange(previousEditMode);
	}

	getSelectedMCPToolNames(): string[] {
		return this.#tools.getSelectedMCPToolNames();
	}

	#applyActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.#tools.applyActiveToolsByName(toolNames);
	}

	refreshSkills(): Promise<void> {
		return this.#tools.refreshSkills();
	}

	initializeCodeMode(): Promise<void> {
		const model = this.model;
		if (!model || !this.#tools.codeModeChangesBetween(undefined, model)) return Promise.resolve();
		return this.#tools.reconcileCodeMode();
	}

	get codeModeNamespacesInfo(): unknown {
		return this.#codeModeState.namespacesInfo;
	}

	setActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.#tools.setActiveToolsByName(toolNames);
	}

	setActiveToolPresentation(
		toolNames: string[],
		mountedToolNames: string[],
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		return this.#tools.setActiveToolPresentation(toolNames, mountedToolNames, forcePromptRefresh, signal);
	}

	setComputerToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#tools.setComputerToolEnabled(enabled);
	}

	setThinkToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#tools.setThinkToolEnabled(enabled);
	}

	setInspectMediaMode(mode: InspectMediaMode): Promise<boolean> {
		return this.#tools.setInspectMediaMode(mode);
	}

	inspectMediaState(): { mode: InspectMediaMode; active: boolean; model: string | undefined } {
		return this.#tools.inspectMediaState();
	}

	getInspectMediaModeOverride(): InspectMediaMode | undefined {
		return this.#inspectMediaModeOverride;
	}

	applyInspectMediaModeChange(): Promise<boolean> {
		return this.#tools.reconcileInspectMediaTool();
	}

	refreshBaseSystemPrompt(): Promise<void> {
		return this.#tools.refreshBaseSystemPrompt();
	}

	refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		return this.#tools.refreshMCPTools(mcpTools);
	}

	refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		return this.#tools.refreshRpcHostTools(rpcTools);
	}

	get isCompacting(): boolean {
		return this.#maintenance.isCompacting;
	}

	get compactionSpeculation(): "idle" | "running" | "armed" {
		return this.#maintenance.speculationState;
	}

	dropImages(): Promise<{ removed: number }> {
		return this.#maintenance.dropImages();
	}

	compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		return this.#maintenance.compact(customInstructions, options);
	}

	abortCompaction(reason?: unknown): void {
		void this.#maintenance.abortCompaction(reason);
	}

	async runIdleCompaction(): Promise<void> {
		await this.#maintenance.runIdleCompaction();
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.#maintenance.setAutoCompactionEnabled(enabled);
	}

	get autoCompactionEnabled(): boolean {
		return this.#maintenance.autoCompactionEnabled;
	}

	get hasPostPromptWork(): boolean {
		return this.#postPromptTasks.size > 0;
	}

	trackPostPromptTaskForTests(task: Promise<unknown>): void {
		if (!isBunTestRuntime()) throw new Error("trackPostPromptTaskForTests is test-only");
		this.#trackPostPromptTask(task);
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	getImageAttachments(): ImageAttachmentEntry[] {
		return this.#providerBoundary.getImageAttachments();
	}

	buildDisplaySessionContext(): SessionContext {
		return this.#providerBoundary.buildDisplaySessionContext();
	}

	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return this.#providerBoundary.buildTranscriptSessionContext(options);
	}

	#obfuscateTextForProvider(text: string | undefined): string | undefined {
		return this.#providerBoundary.obfuscateText(text);
	}

	#obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		return this.#providerBoundary.obfuscateCompactionPreparation(preparation);
	}

	#deobfuscateFromProvider(text: string): string {
		return this.#providerBoundary.deobfuscateText(text);
	}

	#deobfuscatedProviderTextReadyForDelta(text: string): string {
		return this.#providerBoundary.deobfuscateDelta(text);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		return this.#providerBoundary.convertToLlmForSideRequest(messages);
	}

	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		return await this.#providerBoundary.convertMessagesToLlm(messages, signal);
	}

	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		return this.#providerBoundary.prepareSimpleStreamOptions(options, provider);
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.#activeProviderSessionId();
	}
	getEvalSessionId(): string | null {
		return this.#eval.getSessionId();
	}
	getEvalKernelOwnerId(): string {
		return this.#eval.getKernelOwnerId();
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#models.scopedModels;
	}

	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.#models.setScopedModels(scopedModels);
	}

	getPrewalkState(): Prewalk | undefined {
		return this.#prewalk.state;
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
	}

	#clearCheckpointRuntimeState(): void {
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
		this.#lastCompletedRewind = undefined;
		this.#rewoundToolResultIds.clear();
	}

	#clearSessionScopedToolState(): void {
		this.agent.clearDeferredToolDirectives();
		this.#toolChoiceQueue.clear();
		this.#tools.resetAnnouncedMounts();
	}

	#rehydrateCheckpointRewindState(): void {
		this.#clearCheckpointRuntimeState();
		let completed: CompletedRewindState | undefined;
		let pending: { entryId: string; startedAt: string; messageCount: number } | undefined;
		let messageCount = 0;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "message") messageCount++;
			if (isSuccessfulCheckpointEntry(entry)) {
				completed = undefined;
				pending = {
					entryId: entry.id,
					startedAt: checkpointStartedAtFromEntry(entry) ?? entry.timestamp,
					messageCount,
				};
				continue;
			}
			const completedFromEntry = completedRewindFromEntry(entry);
			if (completedFromEntry) {
				completed = completedFromEntry;
				pending = undefined;
			}
		}
		if (pending) {
			this.#checkpointState = {
				checkpointEntryId: pending.entryId,
				startedAt: pending.startedAt,
				checkpointMessageCount: pending.messageCount,
			};
			return;
		}
		this.#lastCompletedRewind = completed;
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	getLastCompletedRewind(): CompletedRewindState | undefined {
		return this.#lastCompletedRewind;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (state) {
			this.#lastCompletedRewind = undefined;
		} else {
			this.#pendingRewindReport = undefined;
		}
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildGoalModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#models.resolveRoleModel(role);
	}

	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#models.resolveRoleModelWithThinking(role);
	}

	resolveTemporaryModelThinkingLevel(model: Model): ThinkingLevel | undefined {
		return this.#models.resolveTemporaryModelThinkingLevel(model);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	get slashCommands(): ReadonlyArray<FileSlashCommand> {
		return this.#slashCommands;
	}

	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	#isScoutAvailable(): boolean {
		const disabledAgents = this.settings.get("orchestrator.disabledAgents") as string[] | undefined;
		return this.#scoutAllowedBySpawnPolicy && !disabledAgents?.includes("scout");
	}

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		const todoContext = this.#buildGoalTodoContext();
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalModeContextPrompt, { goalContext: content, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#sanitizeGoalTodoText(text: string): string {
		return escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
	}

	#buildGoalTodoContext(): string | undefined {
		if (!this.settings.get("todo.enabled")) return undefined;
		const canCallTodoTool = this.getActiveToolNames().includes("todo");
		if (!canCallTodoTool) return undefined;
		const phases = this.getTodoPhases().filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return undefined;

		let total = 0;
		let closed = 0;
		let open = 0;
		const promptPhases = phases.map(phase => ({
			name: this.#sanitizeGoalTodoText(phase.name),
			tasks: phase.tasks.map(task => {
				total++;
				if (task.status === "completed" || task.status === "abandoned") {
					closed++;
				} else {
					open++;
				}
				return { content: this.#sanitizeGoalTodoText(task.content), status: task.status };
			}),
		}));

		return prompt.render(goalTodoContextPrompt, {
			canCallTodoTool,
			closed: String(closed),
			open: String(open),
			phases: promptPhases,
			total: String(total),
		});
	}

	#normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.model });
	}

	#buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		return this.#providerBoundary.buildImageDescriptionNotice(normalizedImages, signal);
	}

	#normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		return this.#providerBoundary.normalizeAgentMessageImages(message);
	}

	#magicKeywordEnabled(keyword: "ultrathink" | "workflow"): boolean {
		return this.settings.get("magicKeywords.enabled") && this.settings.get(`magicKeywords.${keyword}`);
	}

	#createMagicKeywordNotices(text: string): CustomMessage[] {
		const timestamp = Date.now();
		const turnBudget = parseTurnBudget(text);
		this.sessionManager.beginTurnBudget(turnBudget?.total ?? null, turnBudget?.hard ?? false);
		const keywordNotices: CustomMessage[] = [];
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "ultrathink-notice",
				content: ULTRATHINK_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("workflow") && containsWorkflow(text)) {
			const enabledToolNames = this.getEnabledToolNames();
			if (enabledToolNames.includes("orchestrate_spawn") && enabledToolNames.includes("eval")) {
				keywordNotices.push({
					role: "custom",
					customType: "workflow-notice",
					content: renderWorkflowNotice({
						scoutAvailable: this.#isScoutAvailable(),
					}),
					display: false,
					attribution: "user",
					timestamp,
				});
			}
		}
		return keywordNotices;
	}

	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		await this.#maintenance.manualCompactionCleanup;
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		const typedText = text;

		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return false;
			}

			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		const keywordNotices = options?.synthetic ? [] : this.#createMagicKeywordNotices(expandedText);

		if (options?.userInitiated ?? !options?.synthetic) {
			this.#advisors.autoResumeSuppressed = false;
		}

		if (this.isStreaming) {
			const streamingBehavior = options?.streamingBehavior;
			if (!streamingBehavior) throw new AgentBusyError();

			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, streamingBehavior);
			}
			if (streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, "followUp");
			} else {
				await this.#queueUserMessage(expandedText, options?.images, "steer");
			}
			return true;
		}

		const activeModel = this.agent.state.model;
		const externalThinkingToolChoice =
			!options?.synthetic &&
			this.settings.get("externalThinking") &&
			this.getEnabledToolNames().includes("think") &&
			supportsExternalThinking(activeModel)
				? buildNamedToolChoice("think", activeModel)
				: undefined;
		const eagerTodoPrelude = !options?.synthetic ? this.#todo.createEagerTodoPrelude(expandedText) : undefined;
		const normalizedImages = await this.#normalizeImagesForModel(options?.images);

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			userContent.push(...normalizedImages);
		}

		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		if (externalThinkingToolChoice) {
			this.#toolChoiceQueue.pushOnce(externalThinkingToolChoice, {
				label: "external-thinking",
				now: true,
			});
		}
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		const preludeMessages: AgentMessage[] = [];
		if (eagerTodoPrelude) {
			if (eagerTodoPrelude.toolChoice) {
				this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
					label: "eager-todo",
				});
			}
			preludeMessages.push(eagerTodoPrelude.message);
		}

		let dispatched = false;
		try {
			dispatched = await this.#promptWithMessage(message, expandedText, {
				...options,
				images: normalizedImages,
				prependMessages:
					preludeMessages.length > 0 || keywordNotices.length > 0 || imageDescriptionNotice
						? [...preludeMessages, ...keywordNotices, ...(imageDescriptionNotice ? [imageDescriptionNotice] : [])]
						: undefined,
			});
		} finally {
			this.#toolChoiceQueue.removeByLabel("eager-todo");
			this.#toolChoiceQueue.removeByLabel("external-thinking");
		}
		if (!dispatched && message.role === "user") {
			this.#promptDropped?.({ text: typedText, images: options?.images });
		}
		return true;
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & {
			queueChipText?: string;
			queueOnly?: boolean;
		},
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillName: string | undefined;
			let skillArgs = "";
			if (details && typeof details === "object") {
				if ("name" in details && typeof details.name === "string") skillName = details.name;
				if ("args" in details && typeof details.args === "string") skillArgs = details.args;
			}
			keywordNotices = this.#createMagicKeywordNotices(skillArgs);
			this.maybeStartTitleGeneration(
				skillPromptTitleInput({
					name: skillName,
					args: skillArgs,
					queueChipText: options?.queueChipText,
				}),
			);
		}

		if (options?.queueOnly) {
			const streamingBehavior = options?.streamingBehavior;
			if (!streamingBehavior) throw new AgentBusyError();

			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, streamingBehavior);
			}
			await this.#queueCustomMessage(message, streamingBehavior, options.queueChipText);
			return;
		}
		if (this.isStreaming) {
			const streamingBehavior = options?.streamingBehavior;
			if (!streamingBehavior) throw new AgentBusyError();

			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, streamingBehavior);
			}
			await this.#queueCustomMessage(message, streamingBehavior, options?.queueChipText);
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
		this.#beginInFlight();
		const generation = this.#promptGeneration;
		try {
			await this.#recovery.maybeRestoreRetryFallbackPrimary();
			if (!(await this.#runUsageAwarePreflightForNextModelCall())) return false;

			await this.#bash.flushPending();
			this.#eval.flushPending();
			this.#irc.flushPending();

			this.#todo.resetCycle();
			this.#resetPromptMaintenanceState();
			this.#recovery.setAcceptTerminalEmptyStop(options?.acceptTerminalEmptyStop === true);

			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				throw new Error(
					`No API key found for ${this.model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}

			const lastAssistant = this.#findLastAssistantMessage();
			if (
				lastAssistant &&
				!options?.skipCompactionCheck &&
				(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "length")
			) {
				await this.#maintenance.checkCompaction(lastAssistant, false, false);
			}

			const messages: AgentMessage[] = [];
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			if (this.#promptGeneration !== generation) {
				return false;
			}

			const xdevMountNoticeIndex = messages.length;
			messages.push(message);

			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
					snapshotStore: getFileSnapshotStore(this),
				});
				for (const fileMentionMessage of fileMentionMessages) {
					messages.push(await this.#normalizeAgentMessageImages(fileMentionMessage));
				}
			}

			if (this.#promptGeneration !== generation) return false;
			const beforeAgentStartSystemPrompt = this.#tools.baseSystemPrompt;

			let baseXdevCatalogDelivered = true;
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						const normalized = normalizeCustomMessagePayload(msg);
						const hasExplicitAttribution =
							msg !== null &&
							typeof msg === "object" &&
							!Array.isArray(msg) &&
							(msg.attribution === "user" || msg.attribution === "agent");
						messages.push(
							await this.#normalizeAgentMessageImages({
								role: "custom",
								customType: normalized.customType,
								content: normalized.content,
								display: normalized.display,
								details: normalized.details,
								attribution: hasExplicitAttribution
									? normalized.attribution
									: (promptAttribution ?? (message.role === "user" ? "user" : "agent")),
								timestamp: Date.now(),
							}),
						);
					}
				}

				if (result?.systemPrompt !== undefined) {
					baseXdevCatalogDelivered = false;
					this.#tools.setTurnSystemPromptOverride(result.systemPrompt);
				} else {
					this.#tools.clearTurnSystemPromptOverride();
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.#tools.clearTurnSystemPromptOverride();
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			if (this.#promptGeneration !== generation) {
				return false;
			}

			const xdevMountNotice = isUserQueuedMessage(message)
				? this.#tools.takePendingXdevMountNotice(baseXdevCatalogDelivered)
				: undefined;
			if (xdevMountNotice) {
				messages.splice(xdevMountNoticeIndex, 0, xdevMountNotice);
			}

			await this.#maintenance.runPrePromptCompactionIfNeeded(messages);
			if (this.#promptGeneration !== generation) {
				return false;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			const nonMessageTokens = computeNonMessageTokens(this, this.agent.tokenizer);
			const contextWindow = this.model?.contextWindow ?? 0;
			const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
			const promptTokens =
				breakdown?.usedTokens ??
				nonMessageTokens +
					this.agent.tokenizer.countMessages(this.messages) +
					this.agent.tokenizer.countMessages(messages);
			this.#stats.setPendingSnapshot({
				promptTokens,
				nonMessageTokens,
				cutoffCount: this.messages.length + messages.length,
			});
			try {
				await this.#recovery.promptAgentWithIdleRetry(messages, agentPromptOptions);
			} finally {
				this.#stats.setPendingSnapshot(undefined);
			}
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery(generation);
			}
			return true;
		} finally {
			this.#tools.clearTurnSystemPromptOverride();
			this.#usagePreflightReadyForNextModelCall = false;
			this.#endInFlight();
		}
	}

	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			mode: "print",
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			isProjectTrusted: () => true,

			model: this.model ?? undefined,
			models: createExtensionModelQuery(this.#modelRegistry, this.settings, () => this.model ?? undefined),
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void this.dispose().finally(() => process.exit(0));
			},
			getContextUsage: () => this.getContextUsage(),
			getAsyncJobSnapshot: () => this.getAsyncJobSnapshot(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
			setInterval: (callback, ms, ...args) => this.#fallbackTimers().setInterval(callback, ms, ...args),
			setTimeout: (callback, ms, ...args) => this.#fallbackTimers().setTimeout(callback, ms, ...args),
			clearTimer: timer => this.#fallbackTimers().clear(timer),
		};
	}

	#fallbackTimers(): ManagedTimers {
		this.#fallbackExtensionTimers ??= new ManagedTimers((event, error) =>
			logger.warn("Extension timer callback threw", { event, error }),
		);
		return this.#fallbackExtensionTimers;
	}

	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);

			return result ?? "";
		} catch (err) {
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return "";
		}
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, "steer");
	}

	async followUp(text: string, images?: ImageContent[], options?: FollowUpOptions): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText =
			options?.expandPromptTemplates === false ? text : expandPromptTemplate(text, [...this.#promptTemplates]);
		if (!options?.synthetic) {
			await this.#queueUserMessage(expandedText, images, "followUp");
			return;
		}

		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		this.#allowQueuedMessageDrainRetry();
		if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
		this.agent.followUp({
			role: "developer",
			content,
			attribution: options.attribution ?? "agent",
			timestamp: Date.now(),
		});
		this.#scheduleIdleQueueDrain();
	}

	async runModeExitTeardown(teardown: () => Promise<void>): Promise<void> {
		this.#modeExitDrainSuppressionDepth++;
		try {
			await teardown();
		} finally {
			this.#modeExitDrainSuppressionDepth--;
			if (this.#modeExitDrainSuppressionDepth === 0) {
				this.#scheduleIdleQueueDrain();
				this.#resumeStrandedIrcAsides();
			}
		}
	}

	async #queueUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		mode: "steer" | "followUp",
	): Promise<void> {
		this.#advisors.autoResumeSuppressed = false;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}

		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		this.#allowQueuedMessageDrainRetry();
		if (mode === "followUp") {
			if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
			this.agent.followUp({
				role: "user",
				content,
				attribution: "user",
				timestamp: Date.now(),
			});
		} else {
			if (imageDescriptionNotice) this.agent.steer(imageDescriptionNotice);
			this.agent.steer({
				role: "user",
				content,
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
		}
		this.#scheduleIdleQueueDrain();
	}

	#scheduleIdleQueueDrain(): void {
		this.#scheduleQueuedMessageDrain();
	}

	#scheduleQueuedMessageDrain(): void {
		if (
			this.#queuedMessageDrainScheduled ||
			this.#modeExitDrainSuppressionDepth > 0 ||
			this.#queuedMessageDrainBlocked ||
			!this.#canAutoContinueForFollowUp() ||
			!this.agent.hasQueuedMessages()
		) {
			return;
		}
		this.#queuedMessageDrainScheduled = true;
		this.#scheduleAgentContinue({
			shouldContinue: () => {
				this.#queuedMessageDrainScheduled = false;
				return (
					this.#modeExitDrainSuppressionDepth === 0 &&
					this.#canAutoContinueForFollowUp() &&
					this.agent.hasQueuedMessages()
				);
			},
			onSkip: () => {
				this.#queuedMessageDrainScheduled = false;
			},
			onError: () => {
				this.#queuedMessageDrainScheduled = false;
				this.#queuedMessageDrainBlocked = this.agent.hasQueuedMessages();
			},
		});
	}

	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;

		if (this.agent.peekSteeringQueue().length > 0) return true;

		if (this.#advisors.autoResumeSuppressed) return false;

		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	queueLaunchCompletion(notification: DaemonCompletionNotification): Promise<void> {
		if (this.#isDisposed) return Promise.reject(new Error("Session disposed before launch completion delivery"));
		const delivered = this.yieldQueue.enqueueWithReceipt<LaunchCompletionEntry>(
			LAUNCH_COMPLETION_MESSAGE_TYPE,
			notification,
		);
		this.yieldQueue.requestIdleFlush();
		return delivered;
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	async #promptAgentInitiatedMessage(
		message: CustomMessage,
		options?: { acceptTerminalEmptyStop?: boolean },
	): Promise<void> {
		this.#beginInFlight();
		try {
			if (!(await this.#runUsageAwarePreflightForNextModelCall())) return;
			const acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;
			if (acceptTerminalEmptyStop) {
				this.#resetPromptMaintenanceState();
			}
			this.#recovery.setAcceptTerminalEmptyStop(acceptTerminalEmptyStop);
			await this.agent.prompt(message);
			await this.#waitForPostPromptRecovery();
		} finally {
			this.#usagePreflightReadyForNextModelCall = false;
			this.#recovery.setAcceptTerminalEmptyStop(false);
			this.#endInFlight();
		}
	}

	async #queueCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		deliverAs: "steer" | "followUp",
		queueChipText?: string,
	): Promise<void> {
		const details =
			queueChipText !== undefined
				? ({
						...((message.details && typeof message.details === "object" ? message.details : {}) as Record<
							string,
							unknown
						>),
						__queueChipText: queueChipText,
					} as T)
				: message.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		this.#allowQueuedMessageDrainRetry();
		if (deliverAs === "followUp") {
			this.agent.followUp(normalizedAppMessage);
		} else {
			this.agent.steer(normalizedAppMessage);
		}
		this.#scheduleIdleQueueDrain();
	}

	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			queueChipText?: string;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
		const normalizedPayload = normalizeCustomMessagePayload<T>(message);
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? ({
						...((normalizedPayload.details && typeof normalizedPayload.details === "object"
							? normalizedPayload.details
							: {}) as Record<string, unknown>),
						__queueChipText: options.queueChipText,
					} as T)
				: normalizedPayload.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: normalizedPayload.customType,
			content: normalizedPayload.content,
			display: normalizedPayload.display,
			details,
			attribution: normalizedPayload.attribution,
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, options?.triggerTurn ?? false);
				return false;
			}
			this.#allowQueuedMessageDrainRetry();

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(normalizedAppMessage);
			} else {
				this.agent.steer(normalizedAppMessage);
			}
			this.#scheduleIdleQueueDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
					return false;
				}
				await this.#promptAgentInitiatedMessage(normalizedAppMessage, {
					acceptTerminalEmptyStop: options.acceptTerminalEmptyStop === true,
				});
				return true;
			}
			this.agent.appendMessage(normalizedAppMessage);
			this.sessionManager.appendCustomMessageEntry(
				normalizedAppMessage.customType,
				normalizedAppMessage.content,
				normalizedAppMessage.display,
				normalizedAppMessage.details,
				normalizedAppMessage.attribution,
			);
			return false;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
				return false;
			}
			await this.#promptAgentInitiatedMessage(normalizedAppMessage);
			return true;
		}

		this.agent.appendMessage(normalizedAppMessage);
		this.sessionManager.appendCustomMessageEntry(
			normalizedAppMessage.customType,
			normalizedAppMessage.content,
			normalizedAppMessage.display,
			normalizedAppMessage.details,
			normalizedAppMessage.attribution,
		);
		return false;
	}

	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, "steer");
			return;
		}

		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
			streamingBehavior: "steer",
		});
	}

	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		this.agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		this.#reconcileQueuedMessageDrain();
		return { steering, followUp };
	}

	get queuedMessageCount(): number {
		return (
			this.agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			this.agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#pendingNextTurnMessages.length
		);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: this.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};

		const removeWithCompanions = (queue: readonly AgentMessage[], userIndex: number): AgentMessage[] => {
			let start = userIndex;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
			const next = queue.slice();
			next.splice(start, userIndex - start + 1);
			return next;
		};
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			const removed = steering[fromSteer];
			this.agent.replaceQueues(removeWithCompanions(steering, fromSteer), followUp.slice());
			this.#reconcileQueuedMessageDrain();
			return toRestoredQueuedMessage(removed);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			const removed = followUp[fromFollowUp];
			this.agent.replaceQueues(steering.slice(), removeWithCompanions(followUp, fromFollowUp));
			this.#reconcileQueuedMessageDrain();
			return toRestoredQueuedMessage(removed);
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#tools.skillsSettings;
	}

	get skills(): readonly Skill[] {
		return this.#tools.skills;
	}

	get skillWarnings(): readonly SkillWarning[] {
		return this.#tools.skillWarnings;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#todo.phases;
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todo.setPhases(phases);
	}

	#buildReplanTitleContext(): string {
		return buildReplanTitleContext(this.agent.state.messages);
	}

	#scheduleReplanTitleRefresh(): void {
		if (this.#agentKind === "sub" && !isInteractiveHost()) return;
		if (this.#replanTitleRefreshInFlight) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const context = this.#buildReplanTitleContext();
		if (!context) return;
		const sessionId = this.sessionManager.getSessionId();
		const refresh = this.#refreshTitleAfterReplan(context, sessionId)
			.catch(err => {
				logger.warn("title-generator: replan refresh failed", {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				if (this.#replanTitleRefreshInFlight === refresh) {
					this.#replanTitleRefreshInFlight = undefined;
				}
			});
		this.#replanTitleRefreshInFlight = refresh;
	}

	maybeStartTitleGeneration(firstMessage: string, onStart?: () => void): void {
		const extensionCommandSpace = firstMessage.indexOf(" ");
		const isLocalExtensionCommand =
			firstMessage.startsWith("/") &&
			this.#extensionRunner?.getCommand(
				extensionCommandSpace === -1 ? firstMessage.slice(1) : firstMessage.slice(1, extensionCommandSpace),
			) !== undefined;
		const sessionId = this.sessionManager.getSessionId();
		if (
			isLocalExtensionCommand ||
			this.sessionName ||
			this.#titleGenerationInFlightFor === sessionId ||
			$env.PI_NO_TITLE ||
			isLowSignalTitleInput(firstMessage)
		) {
			return;
		}
		this.#titleGenerationInFlightFor = sessionId;
		try {
			(onStart ?? this.#titleGenerationStart)?.();
		} catch (error) {
			if (this.#titleGenerationInFlightFor === sessionId) {
				this.#titleGenerationInFlightFor = undefined;
			}
			throw error;
		}
		this.generateTitle(firstMessage)
			.then(async title => {
				if (this.sessionManager.getSessionId() !== sessionId) return;
				if (title && !this.sessionName) {
					await this.sessionManager.setSessionName(title, "auto");
				}
			})
			.catch(err => {
				logger.warn("title-generator: uncaught auto-title error", {
					sessionId: this.sessionId,
					reason: "uncaught-auto-title-error",
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				if (this.#titleGenerationInFlightFor === sessionId) {
					this.#titleGenerationInFlightFor = undefined;
				}
			});
	}

	generateTitle(firstMessage: string, customSystemPrompt?: string): Promise<string | null> {
		return generateSessionTitle(
			firstMessage,
			this.#modelRegistry,
			this.settings,
			this.sessionId,
			this.model,
			provider => this.agent.metadataForProvider(provider),
			customSystemPrompt ?? this.#titleSystemPrompt,
			this.#titleGenerationAbortController.signal,
		);
	}

	async #refreshTitleAfterReplan(context: string, sessionId: string): Promise<void> {
		const title = await this.generateTitle(context);
		if (!title) return;
		if (this.sessionManager.getSessionId() !== sessionId) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		await setSessionName.call(this.sessionManager, title, "auto", "replan");
	}

	get titleSystemPrompt(): string | undefined {
		return this.#titleSystemPrompt;
	}

	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#titleSystemPrompt = prompt;
	}

	setTitleGenerationStart(handler: (() => void) | undefined): void {
		this.#titleGenerationStart = handler;
	}

	setPromptDropped(handler: ((prompt: DroppedPrompt) => void) | undefined): void {
		this.#promptDropped = handler;
	}

	async abort(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;

		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisors.autoResumeSuppressed = true;

		const strandedAdvisorCards = userInterrupt ? this.#extractQueuedAdvisorCards() : [];

		this.#abortInProgress = true;
		try {
			this.#abortAutolearnCapture();
			for (const controller of this.#usagePreflightAbortControllers) controller.abort();
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			let manualCompactionCleanup: Promise<void> | undefined;
			if (options?.preserveCompaction) {
				this.#maintenance.abortAutomaticCompaction();
			} else {
				manualCompactionCleanup = this.#maintenance.abortCompaction(options?.reason);
			}
			this.abortBash();
			this.abortEval();
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();

			await manualCompactionCleanup;
			await this.#drainAutolearnCapture();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });

			this.#resetInFlight();
			this.#resetSessionStopContinuationState();
			this.#clearPendingSessionStopContinuations();

			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}

			const parkedAdvisorCards = this.#pendingNextTurnMessages.filter(isAdvisorCard);
			if (parkedAdvisorCards.length > 0) {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
			}
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#preserveAdvisorCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.#beforeSessionSwitch();
		this.#disconnectFromAgent();
		let advisorRecordersDetached = false;
		await this.abort();

		if (previousSessionFile) detachedSessionHolder.delete(previousSessionFile);
		this.#cancelOwnAsyncJobs();
		this.#closeAllProviderSessions("new session");
		await this.#bash.flushPending();
		const bashTransition = this.#bash.beginSessionTransition({ persistDetached: true });
		let sessionTransitioned = false;
		let sessionReconciled = false;
		try {
			advisorRecordersDetached = true;
			await this.#advisors.drainAndDetachRecorders();
			await this.#conductor.drainAndDetachRecorders();
			try {
				this.agent.reset();
				await this.sessionManager.flush();
				await this.sessionManager.newSession({
					...options,
					additionalDirectories: this.settings.get("workspace.additionalDirectories"),
				});
				this.#bash.markSessionTransition(bashTransition);

				this.#advisors.clearCost();
				this.#conductor.clearCost();
				sessionTransitioned = true;
			} finally {
				this.#bash.finishSessionTransition(bashTransition, sessionTransitioned);
			}

			this.#clearSessionScopedToolState();
			this.#clearCheckpointRuntimeState();
			this.setTodoPhases([]);
			this.#freshProviderSessionId = undefined;
			this.#clearInheritedProviderPromptCacheKey();
			this.#syncAgentSessionId();
			this.#pendingNextTurnMessages = [];
			this.#scheduledHiddenNextTurnGeneration = undefined;

			this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
			this.sessionManager.appendServiceTierChange(this.#models.serviceTierEntry());

			this.#todo.resetCycle();
			this.#advisors.resetSessionState();
			this.#conductor.resetSessionState();
			advisorRecordersDetached = false;
			this.#reconnectToAgent();
			sessionReconciled = true;
			await this.#afterSessionSwitch();

			resetCapabilities();
			await this.refreshBaseSystemPrompt();

			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "new",
					previousSessionFile,
				});
			}

			return true;
		} finally {
			if (!sessionReconciled) await this.#afterSessionSwitch();
			if (advisorRecordersDetached) {
				if (sessionTransitioned) {
					this.#advisors.resetSessionState();
					this.#conductor.resetSessionState();
				} else {
					this.#advisors.reattachRecorderFeeds();
					this.#conductor.reattachRecorderFeeds();
				}
			}
		}
	}

	setSessionName(name: string, source: "auto" | "user" = "auto", trigger?: SessionNameTrigger): Promise<boolean> {
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		return setSessionName.call(this.sessionManager, name, source, trigger);
	}

	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const previousSessionId = this.sessionManager.getSessionId();

		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.#beforeSessionSwitch();
		await this.#bash.flushPending();

		await this.sessionManager.flush();
		let advisorRecordersDetached = false;
		let sessionReconciled = false;
		try {
			advisorRecordersDetached = true;

			await this.#advisors.drainAndDetachRecorders();
			await this.#conductor.drainAndDetachRecorders();
			const bashTransition = this.#bash.beginSessionTransition();

			let forkResult: { oldSessionFile: string; newSessionFile: string } | undefined;
			try {
				forkResult = await this.sessionManager.fork();
			} catch (error) {
				this.#bash.finishSessionTransition(bashTransition, false);
				throw error;
			}
			if (!forkResult) {
				this.#bash.finishSessionTransition(bashTransition, false);
				sessionReconciled = true;
				await this.#afterSessionSwitch();
				return false;
			}
			this.#bash.markSessionTransition(bashTransition);
			this.#bash.finishSessionTransition(bashTransition, true);

			this.#recovery.reanchorServedAttribution(previousSessionId);

			await copySessionArtifacts(forkResult.oldSessionFile, forkResult.newSessionFile);

			this.#freshProviderSessionId = undefined;
			this.#adoptInheritedProviderPromptCacheKey();
			this.#syncAgentSessionId();
			this.#advisors.reattachRecorderFeeds();
			this.#conductor.reattachRecorderFeeds();
			advisorRecordersDetached = false;
			await this.#afterSessionSwitch();
			sessionReconciled = true;

			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "fork",
					previousSessionFile,
				});
			}

			return true;
		} finally {
			if (!sessionReconciled) await this.#afterSessionSwitch();
			if (advisorRecordersDetached) {
				this.#advisors.reattachRecorderFeeds();
				this.#conductor.reattachRecorderFeeds();
			}
		}
	}

	async moveSession(newCwd: string, targetSessionDir?: string): Promise<void> {
		await this.#beforeSessionSwitch();
		try {
			await this.sessionManager.moveTo(newCwd, targetSessionDir);
		} finally {
			await this.#afterSessionSwitch();
		}
	}

	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
		},
	): Promise<{ switched: boolean }> {
		return this.#models.setModel(model, role, options);
	}

	setModelTemporary(model: Model, thinkingLevel?: ThinkingLevel, options?: { ephemeral?: boolean }): Promise<void> {
		return this.#models.setModelTemporary(model, thinkingLevel, options);
	}

	cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this.#models.cycleModel(direction);
	}

	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		return this.#models.getRoleModelCycle(roleOrder);
	}

	applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		return this.#models.applyRoleModel(entry);
	}

	cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		return this.#models.cycleRoleModels(roleOrder, direction);
	}

	getAvailableModels(): Model[] {
		return this.#models.getAvailableModels();
	}

	setThinkingLevel(level: ThinkingLevel | undefined, persist: boolean = false): void {
		this.#models.setThinkingLevel(level, persist);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this.#models.cycleThinkingLevel();
	}

	isFastModeEnabled(): boolean {
		return this.#models.isFastModeEnabled();
	}

	isFastModeActive(): boolean {
		return this.#models.isFastModeActive();
	}

	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		this.#models.setServiceTierFamily(family, tier);
	}

	setFastMode(enabled: boolean): boolean {
		return this.#models.setFastMode(enabled);
	}

	toggleFastMode(): boolean {
		return this.#models.toggleFastMode();
	}

	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		return this.#models.getAvailableThinkingLevels();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	#isTerminalYieldToolResult(event: { toolName: string; isError?: boolean; result?: { details?: unknown } }): boolean {
		if (event.toolName !== "yield" || event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	}

	#markTerminalYieldToolCall(toolCallId: string): void {
		this.#lastSuccessfulYieldToolCallId = toolCallId;
		this.#yieldTerminationPending = true;
	}

	#assistantMessageHasSuccessfulYieldToolCall(assistantMessage: AssistantMessage, toolCallId: string): boolean {
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		return toolCallId ? this.#assistantMessageHasSuccessfulYieldToolCall(assistantMessage, toolCallId) : false;
	}

	#findSuccessfulYieldAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			if (this.#assistantMessageHasSuccessfulYieldToolCall(message, toolCallId)) return message;
		}
		return undefined;
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#extractRewindReport(messages: AgentMessage[]): string | undefined {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) return undefined;
		if (this.#pendingRewindReport) return this.#pendingRewindReport;
		for (let i = messages.length - 1; i >= checkpointState.checkpointMessageCount; i--) {
			const message = messages[i];
			if (message?.role !== "toolResult" || message.isError) continue;
			const semanticResult = semanticToolResult(message.toolName, message);
			if (semanticResult?.toolName !== "rewind") continue;
			const details = semanticResult.details;
			const detailReport =
				details && typeof details === "object" && "report" in details && typeof details.report === "string"
					? details.report.trim()
					: "";
			const textReport = message.content.find(part => part.type === "text")?.text.trim() ?? "";
			const report = detailReport || textReport;
			return report.length > 0 ? report : undefined;
		}
		return undefined;
	}

	async #applyRewind(report: string, activeMessages?: AgentMessage[]): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		this.#bash.withBranchTransition(() => {
			try {
				this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
					startedAt: checkpointState.startedAt,
				});
			} catch (error) {
				logger.warn("Rewind branch checkpoint missing, falling back to root", {
					error: error instanceof Error ? error.message : String(error),
				});
				this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
			}
		});

		const rewoundAt = new Date().toISOString();
		const details = { report, startedAt: checkpointState.startedAt, rewoundAt };
		this.sessionManager.appendCustomMessageEntry(
			"rewind-report",
			prompt.render(rewindReportTemplate, { report }),
			false,
			details,
			"agent",
		);
		this.#lastCompletedRewind = { report, startedAt: checkpointState.startedAt, rewoundAt };

		if (activeMessages) {
			for (const message of activeMessages) {
				if (message.role === "toolResult" && semanticToolResult(message.toolName, message)?.toolName === "rewind") {
					this.#rewoundToolResultIds.add(message.toolCallId);
				}
			}
		}
		const sessionContext = this.buildDisplaySessionContext();
		if (activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...sessionContext.messages);
		}
		this.agent.replaceMessages(activeMessages ?? sessionContext.messages);
		this.#advisors.resetSessionState({ preserveCost: true });
		this.#conductor.resetSessionState({ preserveCost: true });
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}

	async #reapplyExtendedContextPolicy(): Promise<void> {
		try {
			await this.#modelRegistry.reapplyModelPolicies();
			const currentModel = this.model;
			if (!currentModel || this.#isDisposed) return;
			const updated = this.#modelRegistry.find(currentModel.provider, currentModel.id);
			if (updated && updated.contextWindow !== currentModel.contextWindow) {
				await this.#setModelWithProviderSessionReset(updated);
			}
		} catch (error) {
			logger.warn("extended-context policy reapply failed", { error: String(error) });
		}
	}

	async #setModelWithProviderSessionReset(model: Model): Promise<void> {
		const currentModel = this.model;
		const isChanging = !currentModel || !modelsAreEqual(currentModel, model);
		const codeModeChanged = this.#tools.codeModeChangesBetween(currentModel, model);
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
			if (isChanging) {
				this.#clearInheritedProviderPromptCacheKey();
			}
		}
		this.agent.setModel(model);

		if (isChanging) {
			this.#emit({ type: "model_changed" });
		}

		this.#syncAppendOnlyContext(model);

		if (codeModeChanged || this.#tools.codeModeDirectWireMetadataChanged()) {
			try {
				await this.#tools.reconcileCodeMode();
			} catch (error) {
				logger.warn("Code Mode reconcile after model change failed", { error: String(error) });
			}
		}

		try {
			await this.#tools.reconcileInspectMediaAfterModelChange();
		} catch (error) {
			logger.warn("inspect_media reconcile after model change failed", { error: String(error) });
		}
		try {
			await this.#tools.reconcileThinkTool();
		} catch (error) {
			logger.warn("think tool reconcile after model change failed", { error: String(error) });
		}
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	#resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void {
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState: this.#providerSessionState,
			sessionId: this.sessionId,
			compaction,
		});
	}

	#resetCurrentResponsesProviderSession(reason: string): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-responses" && currentModel?.api !== "openai-codex-responses") {
			return;
		}

		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
		this.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Reset Responses provider session after stale replay error", {
			provider: currentModel.provider,
			model: currentModel.id,
			api: currentModel.api,
			reason,
		});
	}

	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext") ?? "auto";
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		let completionsPrefixToEvict: string | undefined;
		if (currentModel.api === "openai-completions") {
			const currentScope = `${currentModel.provider}:${currentModel.baseUrl ?? ""}`;
			const nextScope =
				nextModel.api === "openai-completions" ? `${nextModel.provider}:${nextModel.baseUrl ?? ""}` : undefined;
			if (currentScope !== nextScope) {
				completionsPrefixToEvict = `openai-completions:${currentModel.provider}:`;
			}
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}

		if (completionsPrefixToEvict !== undefined) {
			for (const [key, state] of this.#providerSessionState) {
				if (!key.startsWith(completionsPrefixToEvict)) continue;
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close provider session state during model switch", {
						providerKey: key,
						error: String(error),
					});
				}
				this.#providerSessionState.delete(key);
			}
		}
	}

	abortRetry(): void {
		this.#recovery.abortRetry();
	}

	get isRetrying(): boolean {
		return this.#recovery.isRetrying;
	}

	get autoRetryEnabled(): boolean {
		return this.#recovery.autoRetryEnabled;
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.#recovery.setAutoRetryEnabled(enabled);
	}

	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		return this.#bash.executeBash(command, onChunk, options);
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this.#bash.recordBashResult(command, result, options);
	}

	abortBash(): void {
		this.#bash.abort();
	}

	get isBashRunning(): boolean {
		return this.#bash.isRunning;
	}

	get hasPendingBashMessages(): boolean {
		return this.#bash.hasPendingMessages;
	}

	executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		return this.#eval.executePython(code, onChunk, options);
	}

	assertEvalExecutionAllowed(): void {
		this.#eval.assertExecutionAllowed();
	}

	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		return this.#eval.trackExecution(execution, abortController);
	}

	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		this.#eval.recordPythonResult(code, result, options);
	}

	abortEval(): void {
		this.#eval.abort();
	}

	get isEvalRunning(): boolean {
		return this.#eval.isRunning;
	}

	get hasPendingPythonMessages(): boolean {
		return this.#eval.hasPendingMessages;
	}

	drainPendingIrcInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		return this.#irc.drainInboxMessages(agentId, opts);
	}

	deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		return this.#irc.deliver(msg, opts);
	}

	setIrcWakeTurnObserver(
		observer: ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
	): void {
		this.#ircWakeTurnObserver = observer;
	}

	emitIrcRelayObservation(record: CustomMessage): void {
		this.#irc.emitRelayObservation(record);
	}

	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
		dedupeReply?: boolean;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const cacheSessionId = this.sessionId;
		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		const options = this.prepareSimpleStreamOptions(
			{
				apiKey: this.#modelRegistry.resolver(model, cacheSessionId),

				sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
				promptCacheKey: this.agent.promptCacheKey ?? this.agent.sessionId,
				preferWebsockets: this.#preferWebsockets,
				providerSessionState: this.#providerSessionState,
				reasoning: toReasoningEffort(this.thinkingLevel),
				disableReasoning: shouldDisableReasoning(this.thinkingLevel),
				hideThinkingSummary: this.agent.hideThinkingSummary,
				serviceTier: this.#models.effectiveServiceTier(model),
				signal: args.signal,
			},
			model.provider,
		);

		let providerReplyText = "";
		let emittedReplyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = await this.#sideStreamFn(model, obfuscateProviderContext(this.#obfuscator, context), options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				providerReplyText += event.delta;
				if (args.onTextDelta) {
					const readyText = this.#deobfuscatedProviderTextReadyForDelta(providerReplyText);
					if (readyText.length > emittedReplyText.length) {
						const delta = readyText.slice(emittedReplyText.length);
						emittedReplyText = readyText;
						args.onTextDelta(delta);
					}
				}
				continue;
			}
			if (event.type === "done") {
				const rawContent = Array.isArray(event.message.content) ? event.message.content : [];
				assistantMessage = this.#obfuscator?.hasSecrets()
					? { ...event.message, content: deobfuscateAssistantContent(this.#obfuscator, rawContent) }
					: { ...event.message, content: rawContent };
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		const replyText = this.#deobfuscateFromProvider(providerReplyText);
		if (args.onTextDelta && replyText.length > emittedReplyText.length) {
			args.onTextDelta(replyText.slice(emittedReplyText.length));
		}
		const sanitizedMessage: AssistantMessage = {
			...assistantMessage,
			content: assistantMessage.content.filter(block => block.type !== "toolCall"),
		};
		return {
			replyText: args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(replyText.trim()),
			assistantMessage: sanitizedMessage,
		};
	}

	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant" && Array.isArray(streaming.content)) {
			const preservedBlocks: AssistantMessage["content"] = [];

			for (const c of streaming.content) {
				if (c.type === "thinking") preservedBlocks.push(c);
			}
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				preservedBlocks.push({ type: "text", text: streamingText });
			}
			if (preservedBlocks.length > 0) {
				const normalized: AssistantMessage = {
					...streaming,
					content: preservedBlocks,
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "developer",
			content: [{ type: "text", text: sideChannelNoToolsReminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	#syncLiveHeartbeat(): void {
		const sessionFile = this.sessionManager.getSessionFile();
		if (!this.#liveHeartbeat) {
			this.#liveHeartbeat = createSessionLiveHeartbeat(sessionFile);
			return;
		}
		if (sessionFile) {
			this.#liveHeartbeat.retarget(sessionFile);
		} else {
			this.#liveHeartbeat.dispose();
			this.#liveHeartbeat = undefined;
		}
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;

		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort({ goalReason: "internal" });
		await this.#beforeSessionSwitch();

		await this.#bash.flushPending();

		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		const bashTransition = this.#bash.beginSessionTransition();

		const previousSessionContext = switchingToDifferentSession ? undefined : this.buildDisplaySessionContext();

		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.agent.peekSteeringQueue()];
		const previousFollowUpMessages = [...this.agent.peekFollowUpQueue()];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousQueuedMessageDrainBlocked = this.#queuedMessageDrainBlocked;
		const previousUsagePreflightReadyForNextModelCall = this.#usagePreflightReadyForNextModelCall;
		const previousUsagePreflightReadyModel = this.#usagePreflightReadyModel;
		const previousModel = this.model;
		const previousThinkingLevel = this.thinkingLevel;
		const previousServiceTierByFamily = this.serviceTierByFamily;
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#tools.baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousFreshProviderSessionId = this.#freshProviderSessionId;
		const previousInheritedProviderPromptCacheKey = this.#inheritedProviderPromptCacheKey;

		const previousCheckpointState = this.#checkpointState;
		const previousPendingRewindReport = this.#pendingRewindReport;
		const previousLastCompletedRewind = this.#lastCompletedRewind;
		const previousRewoundToolResultIds = new Set(this.#rewoundToolResultIds);

		this.agent.clearAllQueues();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.#queuedMessageDrainBlocked = false;
		this.#usagePreflightReadyForNextModelCall = false;
		this.#usagePreflightReadyModel = undefined;

		try {
			if (switchingToDifferentSession) {
				await this.#advisors.drainAndDetachRecorders();
				await this.#conductor.drainAndDetachRecorders();
			}
			await this.sessionManager.setSessionFile(sessionPath);
			this.#bash.markSessionTransition(bashTransition);
			if (switchingToDifferentSession) {
				this.#freshProviderSessionId = undefined;
				this.#clearInheritedProviderPromptCacheKey();
				this.#adoptInheritedProviderPromptCacheKey();
			}
			this.#syncAgentSessionId(undefined, false);

			let sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				previousSessionContext !== undefined &&
				didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			this.#rehydrateCheckpointRewindState();

			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#advisors.resetSessionState({ preserveCost: true });
			this.#conductor.resetSessionState({ preserveCost: true });
			this.#todo.syncFromBranch();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			const targetModelStrings = getRestorableSessionModels(
				sessionContext.models,
				this.sessionManager.getLastModelChangeRole(),
			);
			if (targetModelStrings.length > 0) {
				const availableModels = this.#modelRegistry.getAvailable();
				let match: Model | undefined;
				for (const targetModelStr of targetModelStrings) {
					const slashIdx = targetModelStr.indexOf("/");
					if (slashIdx <= 0) continue;
					const provider = targetModelStr.slice(0, slashIdx);
					const modelId = targetModelStr.slice(slashIdx + 1);
					match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) break;
				}
				if (match) {
					const currentModel = this.model;
					const shouldResetProviderState =
						switchingToDifferentSession ||
						(currentModel !== undefined &&
							(currentModel.provider !== match.provider ||
								currentModel.id !== match.id ||
								currentModel.api !== match.api));
					if (shouldResetProviderState) {
						await this.#setModelWithProviderSessionReset(match);
					} else {
						this.agent.setModel(match);
					}
				}
			}

			const model = this.model;
			if (model) {
				const interruptedTurnAbort = createInterruptedTurnAbortMessage(this.sessionManager.getBranch(), {
					api: model.api,
					provider: model.provider,
					model: model.id,
				});
				if (interruptedTurnAbort) {
					this.sessionManager.appendMessage(interruptedTurnAbort);
					sessionContext = this.buildDisplaySessionContext();
					this.agent.replaceMessages(sessionContext.messages);
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = parseThinkingLevel(this.settings.get("defaultThinkingLevel"));
			const configuredServiceTierByFamily = buildServiceTierByFamily(
				this.settings.get("tier.openai"),
				this.settings.get("tier.anthropic"),
				this.settings.get("tier.google"),
			);

			const restoredThinkingLevel = hasThinkingEntry
				? (sessionContext.thinkingLevel as ThinkingLevel | undefined)
				: defaultThinkingLevel;
			this.#models.restoreThinkingLevel(restoredThinkingLevel);
			this.#models.restoreServiceTiers(
				hasServiceTierEntry ? (sessionContext.serviceTier ?? {}) : configuredServiceTierByFamily,
			);

			if (switchingToDifferentSession) {
			}
			if (switchingToDifferentSession || didReloadConversationChange) {
				this.#clearSessionScopedToolState();
			}
			this.#reconnectToAgent();
			try {
				await this.#afterSessionSwitch();
			} catch (error) {
				logger.warn("Failed to reconcile session mode after switch", {
					targetSessionFile: sessionPath,
					error: String(error),
				});
			}

			try {
				await this.refreshBaseSystemPrompt();
			} catch (refreshErr) {
				logger.warn("Failed to refresh system prompt after session switch", {
					targetSessionFile: sessionPath,
					error: String(refreshErr),
				});
			}

			if (switchingToDifferentSession) {
				this.#advisors.restoreCost(await loadAdvisorTranscriptCosts(this.sessionFile));
				this.#conductor.clearCost();
			}
			this.#bash.finishSessionTransition(bashTransition, true);
			if (previousSessionState.sessionId !== this.sessionManager.getSessionId()) {
				this.#notifySessionChangeCallbacks();
			}
			this.#syncLiveHeartbeat();
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.#freshProviderSessionId = previousFreshProviderSessionId;
			this.#syncAgentSessionId(previousSessionState.sessionId, false);
			this.agent.setTools(previousTools);
			this.#tools.setBaseSystemPrompt(previousBaseSystemPrompt);
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.agent.replaceQueues(previousSteeringMessages, previousFollowUpMessages);
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			this.#queuedMessageDrainBlocked = previousQueuedMessageDrainBlocked;
			this.#usagePreflightReadyForNextModelCall = previousUsagePreflightReadyForNextModelCall;
			this.#usagePreflightReadyModel = previousUsagePreflightReadyModel;
			this.#inheritedProviderPromptCacheKey = previousInheritedProviderPromptCacheKey;
			this.#checkpointState = previousCheckpointState;
			this.#pendingRewindReport = previousPendingRewindReport;
			this.#lastCompletedRewind = previousLastCompletedRewind;
			this.#rewoundToolResultIds = previousRewoundToolResultIds;

			let modelRolledBack = false;
			if (previousModel) {
				const rolledBackModel = this.model;
				this.agent.setModel(previousModel);
				modelRolledBack = !modelsAreEqual(rolledBackModel, previousModel);
			}
			this.#models.restoreThinkingLevel(previousThinkingLevel);
			this.#models.restoreServiceTiers(previousServiceTierByFamily);
			if (modelRolledBack) {
				this.#emit({ type: "model_changed" });
			}
			this.#todo.syncFromBranch();
			this.#advisors.resetAllRuntimes();
			this.#conductor.resetAllRuntimes();
			this.#advisors.reattachRecorderFeeds();
			this.#conductor.reattachRecorderFeeds();
			this.#reconnectToAgent();
			try {
				await this.#afterSessionSwitch();
			} catch (reconcileError) {
				logger.warn("Failed to reconcile session mode after switch rollback", {
					targetSessionFile: sessionPath,
					error: String(reconcileError),
				});
			}
			this.#bash.finishSessionTransition(bashTransition, false);
			throw error;
		}
	}

	async branch(entryId: string): Promise<{
		selectedText: string;
		selectedImages: ImageContent[];
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);
		const selectedImages = this.#extractUserMessageImages(selectedEntry.message.content);

		let skipConversationRestore = false;

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, selectedImages, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.#queuedMessageDrainBlocked = false;
		this.#usagePreflightReadyForNextModelCall = false;

		await this.#bash.flushPending();

		await this.sessionManager.flush();
		const bashTransition = this.#bash.beginSessionTransition();
		this.#cancelOwnAsyncJobs();
		this.#abortAutolearnCapture();
		await this.#drainAutolearnCapture();

		let sessionTransitioned = false;
		let advisorRecordersDetached = false;
		try {
			advisorRecordersDetached = true;
			await this.#advisors.drainAndDetachRecorders();
			await this.#conductor.drainAndDetachRecorders();
			try {
				if (!selectedEntry.parentId) {
					const title = this.sessionManager.getSessionName();
					const titleSource = this.sessionManager.titleSource;
					await this.sessionManager.newSession({ parentSession: previousSessionFile });
					if (title) await this.sessionManager.setSessionName(title, titleSource);
				} else {
					this.sessionManager.createBranchedSession(selectedEntry.parentId);
				}
				this.#bash.markSessionTransition(bashTransition);
				this.#advisors.clearCost();
				this.#conductor.clearCost();
				sessionTransitioned = true;
			} finally {
				this.#bash.finishSessionTransition(bashTransition, sessionTransitioned);
			}

			await Promise.resolve();
			this.#clearSessionScopedToolState();
			this.#rehydrateCheckpointRewindState();
			this.#todo.syncFromBranch();
			this.#freshProviderSessionId = undefined;
			this.#clearInheritedProviderPromptCacheKey();
			this.#syncAgentSessionId();

			const sessionContext = this.buildDisplaySessionContext();

			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_branch",
					previousSessionFile,
				});
			}

			if (!skipConversationRestore) {
				this.agent.replaceMessages(sessionContext.messages);
				this.#advisors.resetSessionState();
				this.#conductor.resetSessionState();
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			this.#advisors.reattachRecorderFeeds();
			this.#conductor.reattachRecorderFeeds();
			advisorRecordersDetached = false;
			return { selectedText, selectedImages, cancelled: false };
		} finally {
			if (advisorRecordersDetached) {
				if (sessionTransitioned) {
					this.#advisors.resetSessionState();
					this.#conductor.resetSessionState();
				} else {
					this.#advisors.reattachRecorderFeeds();
					this.#conductor.reattachRecorderFeeds();
				}
			}
		}
	}

	async branchFromSideQuestion(
		question: string,
		assistantMessage: AssistantMessage,
		leafId: string,
		sessionId: string,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const previousSessionFile = this.sessionFile;
		if (!this.sessionManager.getSessionFile()) {
			throw new Error("Cannot branch /side: session is not persisted");
		}

		if (!leafId || this.sessionManager.getSessionId() !== sessionId || this.sessionManager.getLeafId() !== leafId) {
			throw new Error("Cannot branch /side: session changed since /side started");
		}

		if (this.isStreaming || this.isBashRunning || this.isEvalRunning || this.isCompacting || this.isRetrying) {
			throw new Error("Cannot branch /side while session maintenance or user work is still running");
		}

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId: leafId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { cancelled: true, sessionFile: previousSessionFile };
			}
		}

		if (this.sessionManager.getSessionId() !== sessionId || this.sessionManager.getLeafId() !== leafId) {
			throw new Error("Cannot branch /side: session changed since /side started");
		}

		await withTimeout(
			this.#cancelPostPromptTasks(),
			POST_PROMPT_DRAIN_TIMEOUT_MS,
			"Timed out draining post-prompt tasks before /side branch",
		);
		if (this.isStreaming || this.isBashRunning || this.isEvalRunning || this.isCompacting || this.isRetrying) {
			throw new Error("Cannot branch /side while session maintenance or user work is still running");
		}

		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.agent.replaceQueues([], []);
		this.#queuedMessageDrainBlocked = false;
		this.#usagePreflightReadyForNextModelCall = false;
		await this.#bash.flushPending();
		await this.sessionManager.flush();
		const bashTransition = this.#bash.beginSessionTransition();
		this.#cancelOwnAsyncJobs();
		this.#abortAutolearnCapture();
		await this.#drainAutolearnCapture();

		let sessionTransitioned = false;
		let advisorRecordersDetached = false;
		try {
			advisorRecordersDetached = true;
			await this.#advisors.drainAndDetachRecorders();
			await this.#conductor.drainAndDetachRecorders();
			try {
				if (this.sessionManager.getSessionId() !== sessionId || this.sessionManager.getLeafId() !== leafId) {
					throw new Error("Cannot branch /side: session changed since /side started");
				}
				this.sessionManager.createBranchedSession(leafId);
				this.#bash.markSessionTransition(bashTransition);
				this.#advisors.clearCost();
				this.#conductor.clearCost();
				sessionTransitioned = true;
			} finally {
				this.#bash.finishSessionTransition(bashTransition, sessionTransitioned);
			}

			this.#clearSessionScopedToolState();

			this.#rehydrateCheckpointRewindState();
			this.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: question }],
				timestamp: Date.now(),
			});
			this.sessionManager.appendMessage(sanitizeAssistantForReparentedHistory(assistantMessage));
			this.#todo.syncFromBranch();
			this.#freshProviderSessionId = undefined;
			this.#syncAgentSessionId();

			const sessionContext = this.buildDisplaySessionContext();

			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_branch",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#advisors.resetSessionState();
			this.#conductor.resetSessionState();
			this.#closeCodexProviderSessionsForHistoryRewrite();
			advisorRecordersDetached = false;

			return { cancelled: false, sessionFile: this.sessionFile };
		} finally {
			if (advisorRecordersDetached) {
				if (sessionTransitioned) {
					this.#advisors.resetSessionState();
					this.#conductor.resetSessionState();
				} else {
					this.#advisors.reattachRecorderFeeds();
					this.#conductor.reattachRecorderFeeds();
				}
			}
		}
	}

	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;

			allowAskReopen?: boolean;

			reanswerAskResult?: AgentToolResult<AskToolDetails>;
		} = {},
	): Promise<{
		editorText?: string;

		editorImages?: ImageContent[];
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;

		sessionContext?: SessionContext;

		reopenAsk?: { toolCallId: string; questions: AskToolInput["questions"] };

		askReanswerCommitted?: boolean;
	}> {
		await this.#bash.flushPending();
		const oldLeafId = this.sessionManager.getLeafId();

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const targetIsAskResult =
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask";

		if (targetId === oldLeafId && !(options.allowAskReopen && targetIsAskResult)) {
			return { cancelled: false };
		}

		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		if (
			options.allowAskReopen &&
			!options.reanswerAskResult &&
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask"
		) {
			const toolCallId = targetEntry.message.toolCallId;
			const questions = this.#recoverAskReanswerQuestions(targetEntry.parentId, toolCallId);
			if (questions) {
				return { cancelled: false, reopenAsk: { toolCallId, questions } };
			}
		}

		const summaryAnchorId =
			options.reanswerAskResult !== undefined &&
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask" &&
			targetEntry.parentId !== null
				? targetEntry.parentId
				: targetId;
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			summaryAnchorId,
		);

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: this.#modelRegistry.resolver(model, this.sessionId),
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: this.#obfuscateTextForProvider(options.customInstructions),
				reserveTokens: branchSummarySettings.reserveTokens,
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),

				completeImpl: async (requestModel, requestContext, requestOptions) => {
					const stream = await this.#sideStreamFn(requestModel, requestContext, requestOptions);
					return stream.result();
				},
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		let newLeafId: string | null;
		let editorText: string | undefined;
		let editorImages: ImageContent[] | undefined;

		let isAskReanswerCompletion = false;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
			const targetImages = this.#extractUserMessageImages(targetEntry.message.content);
			if (targetImages.length > 0) editorImages = targetImages;
		} else if (targetEntry.type === "custom_message" && targetEntry.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else if (
			targetEntry.type === "message" &&
			targetEntry.message.role === "toolResult" &&
			targetEntry.message.toolName === "ask" &&
			options.reanswerAskResult
		) {
			const reanswer = options.reanswerAskResult;
			const toolResultMessage: ToolResultMessage = {
				role: "toolResult",
				toolCallId: targetEntry.message.toolCallId,
				toolName: "ask",
				content: reanswer.content,
				details: reanswer.details,
				isError: reanswer.isError === true,
				timestamp: Date.now(),
			};
			newLeafId = this.sessionManager.appendMessageToBranch(toolResultMessage, targetEntry.parentId);
			isAskReanswerCompletion = true;
		} else {
			newLeafId = targetId;
		}

		const bashTransition = this.#bash.beginSessionTransition();
		let summaryEntry: BranchSummaryEntry | undefined;
		let branchTransitioned = false;
		try {
			if (summaryText) {
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
			} else if (newLeafId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(newLeafId);
			}
			this.#bash.markSessionTransition(bashTransition);
			branchTransitioned = true;
		} finally {
			this.#bash.finishSessionTransition(bashTransition, branchTransitioned);
		}

		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		this.agent.replaceMessages(displayContext.messages);
		this.#rehydrateCheckpointRewindState();
		this.#advisors.resetSessionState({ preserveCost: true });
		this.#conductor.resetSessionState({ preserveCost: true });
		this.#todo.syncFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return {
				editorText,
				editorImages,
				cancelled: false,
				summaryEntry,
				sessionContext: rawContext,
				askReanswerCommitted: isAskReanswerCompletion,
			};
		}
		return {
			editorText,
			editorImages,
			cancelled: false,
			summaryEntry,
			sessionContext: stateContext,
			askReanswerCommitted: isAskReanswerCompletion,
		};
	}

	resumeAfterAskReanswer(): void {
		this.#scheduleAgentContinue();
	}

	#recoverAskReanswerQuestions(parentId: string | null, toolCallId: string): AskToolInput["questions"] | undefined {
		let current = parentId;
		while (current !== null) {
			const entry = this.sessionManager.getEntry(current);
			if (!entry) return undefined;
			if (entry.type === "message") {
				if (entry.message.role === "assistant") {
					const toolCall = entry.message.content.find(
						(block): block is AgentToolCall => block.type === "toolCall" && block.id === toolCallId,
					);
					if (!toolCall) return undefined;
					if (toolCall.name !== "ask") return undefined;
					const args = this.#obfuscator?.hasSecrets()
						? deobfuscateToolArguments(this.#obfuscator, toolCall.arguments)
						: toolCall.arguments;
					return recoverAskQuestions(args);
				}
				if (entry.message.role === "user") return undefined;
			}
			current = entry.parentId;
		}
		return undefined;
	}

	buildAskReanswerContext(uiContext: ExtensionUIContext): AgentToolContext {
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
			settings: this.settings,
			ui: uiContext,
			hasUI: true,
		};
	}

	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	#extractUserMessageImages(content: UserMessage["content"]): ImageContent[] {
		if (!Array.isArray(content)) return [];
		return content.filter((c): c is ImageContent => c.type === "image");
	}

	getSessionStats(): SessionStats {
		return this.#stats.getSessionStats();
	}

	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		return this.#stats.getContextBreakdown(options);
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		return this.#stats.getContextUsage(options);
	}

	get contextUsageRevision(): number {
		return this.#stats.revision;
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		const reports = await authStorage.fetchUsageReports({
			baseUrlResolver: provider => {
				if (provider === "google-antigravity") {
					const mode = this.settings.get("providers.antigravityEndpoint");
					if (mode === "sandbox") {
						return "https://daily-cloudcode-pa.sandbox.googleapis.com";
					} else if (mode === "production") {
						return "https://daily-cloudcode-pa.googleapis.com";
					}
				}
				return this.#modelRegistry.getProviderBaseUrl?.(provider);
			},
			signal,
		});

		if (reports) this.#maybeScheduleCodexResetSweep(reports);
		return reports;
	}

	getUsageReportingModelSelectors(reports: readonly UsageReport[]): string[] {
		const modelsByProvider = new Map<string, Model[]>();
		for (const model of this.#modelRegistry.getAvailable()) {
			const models = modelsByProvider.get(model.provider) ?? [];
			models.push(model);
			modelsByProvider.set(model.provider, models);
		}
		const selectors = new Set<string>();
		for (const [provider, models] of modelsByProvider) {
			const modelIds = this.#modelRegistry.authStorage.getUsageReportingModelIds(
				provider,
				models.map(model => model.id),
				reports,
			);
			for (const modelId of modelIds) selectors.add(`${provider}/${modelId}`);
		}
		return [...selectors].sort((left, right) => left.localeCompare(right));
	}

	async listCurrentProviderOAuthAccounts(): Promise<SessionOAuthAccountList | undefined> {
		const provider = this.model?.provider;
		if (!provider) return undefined;
		const authStorage = this.#modelRegistry.authStorage;
		await authStorage.reload();
		return {
			provider,
			accounts: authStorage.listOAuthAccounts(provider, this.sessionId),
		};
	}

	pinCurrentProviderOAuthAccount(credentialId: number): boolean {
		const provider = this.model?.provider;
		if (!provider || this.isStreaming) return false;
		return this.#modelRegistry.authStorage.pinSessionOAuthAccount(provider, this.sessionId, credentialId);
	}

	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#modelRegistry.authStorage.redeemResetCredit({
			target,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#modelRegistry.authStorage.listResetCredits({
			sessionId: this.sessionId,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	async #confirmCodexAutoRedeem(
		actions: CodexResetAction[],
		coordinator: CodexAutoRedeemCoordinator,
	): Promise<boolean> {
		const first = actions[0];
		if (!first) return false;
		const runner = this.#extensionRunner;
		if (!runner?.hasUI()) {
			if (!coordinator.notifiedKeys.has(first.attemptKey)) {
				coordinator.notifiedKeys.add(first.attemptKey);
				this.emitNotice(
					"warning",
					"Saved Codex resets are eligible to spend, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.",
					"codex-auto-reset",
				);
			}
			return false;
		}

		const lines = actions.map(action =>
			action.reason === "blocked-account"
				? `${action.label} is blocked by the Codex ${(action.blockedWindows ?? []).join(" + ") || "usage"} limit for about ${formatDuration(action.remainingMs ?? 0)}.`
				: `${action.label}: a saved reset expires in ${formatDuration(action.expiresInMs ?? 0)} (${action.salvageWindow ?? "weekly"} window ${Math.round((action.salvageUsedFraction ?? action.weeklyUsedFraction ?? 0) * 100)}% used).`,
		);
		const question =
			actions.length === 1
				? `Spend a saved Codex rate-limit reset?\n${lines[0]}`
				: `Spend ${actions.length} saved Codex rate-limit resets?\n${lines.join("\n")}`;
		try {
			const choice = await runner.getUIContext().select(question, [
				{
					label: "Yes",
					description: "Redeem now and remember yes for future eligible Codex resets.",
				},
				{
					label: "No",
					description: "Do not auto-redeem saved Codex resets.",
				},
			]);
			if (choice === "Yes") {
				this.settings.set("codexResets.autoRedeem", "yes");
				return true;
			}
			if (choice === "No") {
				this.settings.set("codexResets.autoRedeem", "no");
			}
		} catch (error) {
			logger.warn("codex-auto-reset prompt failed", { error: String(error) });
		}
		return false;
	}

	#planCodexResets(
		trigger: CodexResetTrigger,
		reports: UsageReport[] | null,
		identity: OAuthAccountIdentity | undefined,
		coordinator: CodexAutoRedeemCoordinator,
		activeBlockUnblockAtMs?: number,
	): CodexResetPlan {
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;
		const plan = planCodexResetRedemptions({
			nowMs: Date.now(),
			trigger,
			provider: model?.provider ?? "",
			modelId: model?.id ?? "",
			settings: {
				enabled: shouldEvaluateCodexAutoRedeem(cfg.autoRedeem),
				minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
				keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
				salvageHorizonMs: Math.max(0, cfg.salvageHorizonHours) * 3_600_000,
			},
			identity,
			reports,
			attemptedKeys: coordinator.attemptedKeys,
			deferredUntilByKey: coordinator.deferredUntilByKey,
			lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
			activeBlockUnblockAtMs,
		});
		if (plan.skipped.length > 0) {
			logger.debug("codex-auto-reset: plan", { trigger, actions: plan.actions.length, skipped: plan.skipped });
		}
		return plan;
	}

	async #executeCodexResetActions(
		actions: CodexResetAction[],
		coordinator: CodexAutoRedeemCoordinator,
	): Promise<number> {
		const authStorage = this.#modelRegistry.authStorage;
		let redeemed = 0;
		for (const action of actions) {
			if (coordinator.attemptedKeys.has(action.attemptKey)) continue;

			coordinator.attemptedKeys.add(action.attemptKey);
			coordinator.lastAttemptAtByAccount.set(action.accountKey, Date.now());
			let outcome: ResetCreditRedeemOutcome;
			try {
				outcome = await authStorage.redeemResetCredit({
					target: action.target,
					baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),

					signal: AbortSignal.timeout(15_000),
				});
			} catch (error) {
				coordinator.attemptedKeys.delete(action.attemptKey);
				coordinator.deferredUntilByKey.set(action.attemptKey, Date.now() + REDEEM_RETRY_DEFER_MS);
				logger.warn("codex-auto-reset: redeem threw, deferred", {
					account: action.accountKey,
					error: String(error),
				});
				continue;
			}
			if (!isTerminalRedeemOutcome(outcome.code)) {
				coordinator.attemptedKeys.delete(action.attemptKey);
				coordinator.deferredUntilByKey.set(action.attemptKey, Date.now() + REDEEM_RETRY_DEFER_MS);
			}
			switch (outcome.code) {
				case "reset": {
					redeemed++;
					const left =
						action.availableCount === undefined ? undefined : ` (${Math.max(0, action.availableCount - 1)} left)`;
					const detail =
						action.reason === "expiring-credit"
							? `it was set to expire in ${formatDuration(action.expiresInMs ?? 0)}`
							: "retrying now";
					this.emitNotice(
						"info",
						`Auto-redeemed a saved Codex rate-limit reset for ${action.label}${left ?? ""}; ${detail}.`,
						"codex-auto-reset",
					);
					break;
				}
				case "already_redeemed":
					this.emitNotice(
						"warning",
						`A saved Codex reset for ${action.label} was already redeemed elsewhere.`,
						"codex-auto-reset",
					);
					break;
				case "no_credit":
					logger.debug("codex-auto-reset: no_credit (snapshot/live mismatch)", { account: action.accountKey });
					break;
				case "nothing_to_reset":
					if (action.reason === "blocked-account") {
						this.emitNotice(
							"warning",
							`Codex reset for ${action.label} reported nothing to reset; will retry later.`,
							"codex-auto-reset",
						);
					} else {
						logger.debug("codex-auto-reset: nothing_to_reset deferred", { account: action.accountKey });
					}
					break;
				default:
					if (action.reason === "blocked-account") {
						this.emitNotice(
							"warning",
							`Codex auto-redeem for ${action.label} failed (${outcome.code}); will retry later.`,
							"codex-auto-reset",
						);
					} else {
						logger.warn("codex-auto-reset: consume failed, deferred", {
							account: action.accountKey,
							code: outcome.code,
						});
					}
					break;
			}
		}

		if (redeemed > 0) void this.fetchUsageReports();
		return redeemed;
	}

	async #maybeAutoRedeemCodexReset(activeBlockUnblockAtMs?: number): Promise<boolean> {
		const coordinator = this.#codexResetCoordinator;
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;

		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = this.#modelRegistry.authStorage;

		const identity = authStorage.getOAuthAccountIdentity("openai-codex", this.sessionId);
		const accountKey = (identity?.accountId ?? identity?.email)?.trim().toLowerCase();
		if (!accountKey) return false;
		const existing = coordinator.inFlightByAccount.get(accountKey);
		if (existing) return existing;

		const run = (async (): Promise<boolean> => {
			await authStorage.invalidateUsageCache("openai-codex");
			const reports = await this.fetchUsageReports();

			let effectiveReports = reports;
			try {
				const statuses = await this.listResetCredits(AbortSignal.timeout(10_000));
				effectiveReports = overlayLiveResetCredits(reports, statuses);
			} catch (error) {
				logger.debug("codex-auto-reset: live credit listing failed; keeping report counts", {
					error: String(error),
				});
			}
			const plan = this.#planCodexResets("blocked", effectiveReports, identity, coordinator, activeBlockUnblockAtMs);
			if (plan.actions.length === 0) return false;
			if (
				shouldPromptCodexAutoRedeem(cfg.autoRedeem) &&
				!(await this.#confirmCodexAutoRedeem(plan.actions, coordinator))
			) {
				return false;
			}
			return (await this.#executeCodexResetActions(plan.actions, coordinator)) > 0;
		})()
			.catch(error => {
				logger.warn("codex-auto-reset: blocked pass failed", { account: accountKey, error: String(error) });
				return false;
			})
			.finally(() => coordinator.inFlightByAccount.delete(accountKey));
		coordinator.inFlightByAccount.set(accountKey, run);
		return run;
	}

	#maybeScheduleCodexResetSweep(reports: UsageReport[]): void {
		const coordinator = this.#codexResetCoordinator;
		const cfg = this.settings.getGroup("codexResets");
		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || cfg.salvageHorizonHours <= 0) return;

		if (coordinator.sweepInFlight || coordinator.inFlightByAccount.size > 0) return;
		const now = Date.now();
		if (now - coordinator.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
		if (!reports.some(r => r.provider === "openai-codex" && (r.resetCredits?.credits?.length ?? 0) > 0)) return;
		coordinator.sweepInFlight = true;
		coordinator.lastSweepAt = now;
		coordinator.sweepPromise = (async () => {
			const identity = this.#modelRegistry.authStorage.getOAuthAccountIdentity("openai-codex", this.sessionId);
			const plan = this.#planCodexResets("sweep", reports, identity, coordinator);
			if (plan.actions.length === 0) return;
			if (
				shouldPromptCodexAutoRedeem(cfg.autoRedeem) &&
				!(await this.#confirmCodexAutoRedeem(plan.actions, coordinator))
			) {
				return;
			}
			await this.#executeCodexResetActions(plan.actions, coordinator);
		})()
			.catch(error => logger.warn("codex-reset sweep failed", { error: String(error) }))
			.finally(() => {
				coordinator.sweepInFlight = false;
			});
	}

	getLastAssistantText(): string | undefined {
		const lastAssistant = this.#getLastCopyCandidateAssistantMessage();
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#getLastCopyCandidateAssistantMessage() !== undefined;
	}

	#getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;

			const assistantMessage = message as AssistantMessage;

			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}

	setAdvisorEnabled(enabled: boolean): boolean {
		return this.#advisors.setAdvisorEnabled(enabled);
	}

	async #retryInactiveAdvisorAfterModelDiscovery(): Promise<void> {
		if (this.#isDisposed || !this.#advisors.hasInactiveNoModelAdvisor()) return;
		await this.#modelRegistry.awaitBackgroundRefresh();
		if (this.#isDisposed) return;
		if (this.#advisors.retryAfterModelDiscovery()) this.#emit({ type: "model_changed" });
	}

	toggleAdvisorEnabled(): boolean {
		return this.#advisors.toggleAdvisorEnabled();
	}

	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		return this.#advisors.applyAdvisorConfigs(advisors, sharedInstructions);
	}

	setAdvisorContextPrompt(contextPrompt: string | undefined): void {
		this.#advisors.setContextPrompt(contextPrompt);
	}

	isAdvisorEnabled(): boolean {
		return this.#advisors.isAdvisorEnabled();
	}

	isAdvisorActive(): boolean {
		return this.#advisors.isAdvisorActive();
	}

	getAdvisorAvailableToolNames(): string[] {
		return this.#advisors.getAdvisorAvailableToolNames();
	}

	setConductorEnabled(enabled: boolean): boolean {
		return this.#conductor.setEnabled(enabled);
	}

	toggleConductorEnabled(): boolean {
		return this.#conductor.toggleEnabled();
	}

	isConductorEnabled(): boolean {
		return this.#conductor.isEnabled();
	}

	getConductorStats(): ConductorStats {
		return this.#conductor.getStats();
	}

	getConductorCost(): number {
		return this.#conductor.getCost();
	}

	formatConductorStatus(): string {
		return this.#conductor.formatStatus();
	}

	getAdvisorAgent(): Agent | undefined {
		return this.#advisors.getAdvisorAgent();
	}

	getAdvisorStatusOverview(): { configured: boolean; advisors: { name: string; status: AdvisorRuntimeStatus }[] } {
		return this.#advisors.getAdvisorStatusOverview();
	}

	getAdvisorCost(): number {
		return this.#advisors.getAdvisorCost();
	}

	isAdvisorUsingSubscription(): boolean {
		return this.#advisors.isUsingSubscription();
	}

	getAdvisorStats(): AdvisorStats {
		return this.#advisors.getAdvisorStats();
	}

	formatAdvisorStatus(): string {
		return this.#advisors.formatAdvisorStatus();
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
