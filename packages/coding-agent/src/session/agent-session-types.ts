import type {
	Agent,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	StreamFn,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	Effort,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	OAuthAccountSummary,
	ServiceTierByFamily,
	SimpleStreamOptions,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import type { postmortem } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { CursorMcpResourceAdapter } from "../cursor";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { XdevState } from "../tools/xdev";
import type { CodexAutoRedeemCoordinator } from "./codex-auto-reset";
import type { SessionManager } from "./session-manager";

export interface AgentSessionDisposeOptions {
	drainTimeoutMs?: number;

	reason?: postmortem.Reason;
}

export type CommandMetadataChangedListener = () => void | Promise<void>;

export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export interface Prewalk {
	target: Model;
	thinkingLevel?: ThinkingLevel;
}

export interface UsageFallbackConfirmation {
	from: string;
	to: string;
	remainingPercent: number | undefined;
}

export type UsageFallbackConfirmer = (confirmation: UsageFallbackConfirmation, signal: AbortSignal) => Promise<boolean>;

export interface InitialRetryFallbackState {
	role: string;

	originalSelector: string;

	originalThinkingLevel: ThinkingLevel | undefined;

	pinned?: boolean;
}

export interface AgentSessionConfig {
	agent: Agent;

	codeModeState?: { namespacesInfo?: unknown };
	sessionManager: SessionManager;
	settings: Settings;

	scoutAllowedBySpawnPolicy?: boolean;

	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	thinkingLevel?: ThinkingLevel;

	thinkingLevelCeiling?: Effort;

	initialRetryFallback?: InitialRetryFallbackState;

	prewalk?: Prewalk;

	serviceTierByFamily?: ServiceTierByFamily;

	promptTemplates?: PromptTemplate[];

	slashCommands?: FileSlashCommand[];

	extensionRunner?: ExtensionRunner;

	skills?: Skill[];

	skillWarnings?: SkillWarning[];

	skillsReloadable?: boolean;

	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;

	createComputerTool?: () => Promise<AgentTool | null>;

	createThinkTool?: () => Promise<AgentTool | null>;

	createInspectMediaTool?: () => Promise<AgentTool | null>;

	modelRegistry: ModelRegistry;

	toolRegistry?: Map<string, AgentTool>;

	builtInToolNames?: Iterable<string>;

	mcpManagerToolNames?: Iterable<string>;

	setActiveToolNames?: (names: Iterable<string>) => void;

	ensureWriteRegistered?: () => Promise<boolean>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;

	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	sideStreamFn?: StreamFn;

	advisorStreamFn?: StreamFn;

	initialAdvisorCosts?: ReadonlyMap<string, number>;

	preferWebsockets?: boolean;

	codexResetCoordinator?: CodexAutoRedeemCoordinator;

	onPayload?: SimpleStreamOptions["onPayload"];

	onResponse?: SimpleStreamOptions["onResponse"];

	onSseEvent?: SimpleStreamOptions["onSseEvent"];

	rawSseDebugBuffer?: RawSseDebugBuffer;

	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	rebuildSystemPrompt?: (
		toolNames: string[],
		tools: Map<string, AgentTool>,
	) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>;

	getXdevToolEntries?: () => Array<{ name: string; summary: string }>;

	xdev?: XdevState;

	presentationPinnedToolNames?: ReadonlySet<string>;

	requiredToolNames?: ReadonlySet<string>;

	getMcpServerInstructions?: () => Map<string, string> | undefined;

	ttsrManager?: TtsrManager;

	obfuscator?: SecretObfuscator;

	parentEvalSessionId?: string;

	evalKernelOwnerId?: string;

	ownedAsyncJobManager?: AsyncJobManager;

	asyncJobManager?: AsyncJobManager;

	agentId?: string;

	agentKind?: "main" | "sub";

	providerSessionId?: string;

	providerPromptCacheKeySource?: "explicit" | "fork";

	advisorTools?: AgentTool[];

	advisorCreateEditTool?(): AgentTool | undefined;
	advisorGetToolContext?: () => AgentToolContext | undefined;

	advisorMcpResources?: CursorMcpResourceAdapter;

	advisorWatchdogPrompt?: string;

	advisorSharedInstructions?: string;

	advisorContextPrompt?: string;

	advisorConfigs?: AdvisorConfig[];

	disconnectOwnedMcpManager?: () => Promise<void>;

	titleSystemPrompt?: string;
}

export interface PromptOptions {
	expandPromptTemplates?: boolean;

	images?: ImageContent[];

	streamingBehavior?: "steer" | "followUp";

	toolChoice?: ToolChoice;

	synthetic?: boolean;

	userInitiated?: boolean;

	attribution?: MessageAttribution;

	skipCompactionCheck?: boolean;
}

export interface DroppedPrompt {
	text: string;

	images?: ImageContent[];
}

export interface FollowUpOptions {
	synthetic?: boolean;

	expandPromptTemplates?: boolean;

	attribution?: MessageAttribution;
}

export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;

	isScoped: boolean;
}

export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}

export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

export interface SessionOAuthAccountList {
	provider: string;
	accounts: OAuthAccountSummary[];
}

export interface ResetSessionContextResult {
	droppedCount: number;
}

export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };
