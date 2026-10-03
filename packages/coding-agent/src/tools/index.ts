import type {
	AgentOptions,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	StreamFn,
} from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async/job-manager";
import type { Rule } from "../capability/rule";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { PreparedExtension } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import type { LocalProtocolOptions } from "../internal-urls";
import type { DaemonCompletionNotification } from "../launch/protocol";
import type { MCPManager } from "../mcp";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { CustomMessage } from "../session/messages";
import type { UsageStatistics } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import type { AgentOutputManager } from "../task/output-manager";
import type { StructuredSubagentSchemaMode } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import { setExcludedSearchProviders, setSearchProviderOrder } from "../web/search/provider";
import { isSearchProviderId } from "../web/search/types";
import type { WorkspaceTree } from "../workspace-tree";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames } from "./builtin-names";
import type { ChecklistPhase } from "./checklist";
import type { CheckpointState, CompletedRewindState } from "./checkpoint";
import { ContextTool } from "./context";
import { RecallTool } from "./recall";
import { isMountableUnderXdev, type XdevState } from "./xdev";
import { YieldTool } from "./yield";

export type * from "../goals";
export type * from "../session/streaming-output";
export type * from "../web/search";
export type * from "./ask";
export type * from "./bash";
export type * from "./browser";
export * from "./builtin-names";
export type * from "./checklist";
export type * from "./checkpoint";
export type * from "./computer";
export type * from "./computer/supervisor";
export type * from "./context";
export * from "./essential-tools";
export type * from "./eval-backends";
export type * from "./fleet";
export type * from "./image-gen";
export type * from "./jobs";
export type * from "./manage-skill";
export type * from "./read";
export type * from "./recall";
export type * from "./report-tool-issue";
export type * from "./resolve";
export type * from "./think";
export type * from "./xdev";
export * from "./yield";

export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;

	sourcePath: string;
};

export interface ToolSession {
	cwd: string;

	additionalDirectories?: string[];

	hasUI: boolean;

	canPromptUser?: boolean;

	isDisposed?: () => boolean;

	fetch?: FetchImpl;

	streamFn?: StreamFn;

	customTools?: CustomTool[];

	getApiKey?: AgentOptions["getApiKey"];
	/** Session whose stored credential affinities seed spawned child sessions. */
	getCredentialSourceSessionId?: () => string | undefined;

	contextFiles?: ContextFileEntry[];

	workspaceTree?: WorkspaceTree;

	skills?: readonly Skill[];

	refreshSkills?: () => Promise<void>;

	promptTemplates?: PromptTemplate[];

	rules?: Rule[];

	/** Extension factories this session imported, for child sessions to rebind. */
	preparedExtensions?: PreparedExtension[];

	customToolPaths?: ToolPathWithSource[];

	enableIrc?: boolean;

	enableMCP?: boolean;

	eventBus?: EventBus;

	outputSchema?: unknown;

	outputSchemaMode?: StructuredSubagentSchemaMode;

	requireYieldTool?: boolean;

	prewalkArmed?: boolean;

	restrictToolNames?: boolean;

	taskDepth?: number;

	getEvalSessionId?: () => string | null;

	getSessionFile: () => string | null;

	sessionManager?: Pick<
		SessionManager,
		| "appendCustomEntry"
		| "ensureOnDisk"
		| "flush"
		| "getBranch"
		| "getEntries"
		| "getCustomEntries"
		| "iterateCustomEntries"
		| "getEntry"
		| "getSubagentUsage"
		| "recordSubagentUsage"
	>;

	getEvalKernelOwnerId?: () => string | null;

	assertEvalExecutionAllowed?: () => void;

	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;

	getSessionId?: () => string | null;

	getAgentId?: () => string | null;

	getAgentFleetRoot?: () => string | undefined;

	/** Stable session-scoped owner key for async jobs and completion delivery. */
	getAsyncJobOwnerId?: () => string | null;
	getToolByName?: (name: string) => AgentTool | undefined;

	getToolForEvalBridge?: (name: string) => AgentTool | undefined;

	getToolContext?: () => AgentToolContext | undefined;

	getEvalBridgeToolNames?: () => readonly string[];

	isToolActive?: (name: string) => boolean;

	setActiveToolNames?: (names: Iterable<string>) => void;

	toolRegistry?: Map<string, Tool>;

	xdev?: XdevState;

	agentRegistry?: AgentRegistry;

	agentLifecycle?: () => AgentLifecycleManager;

	getArtifactsDir?: () => string | null;

	getArtifactManager?: () => ArtifactManager | null;

	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;

	getSessionSpawns: () => string | null;

	getModelString?: () => string | undefined;

	getActiveModelString?: () => string | undefined;

	getActiveModel?: () => Model | undefined;

	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;

	authStorage?: import("../session/auth-storage").AuthStorage;

	modelRegistry?: import("../config/model-registry").ModelRegistry;

	agentOutputManager?: AgentOutputManager;

	asyncJobManager?: AsyncJobManager;

	mcpManager?: MCPManager;

	localProtocolOptions?: LocalProtocolOptions;

	settings: Settings;

	getGoalModeState?: () => GoalModeState | undefined;

	getGoalRuntime?: () => GoalRuntime | undefined;

	getUsageStatistics?: () => UsageStatistics;

	getTurnBudget?: () => { total: number | null; spent: number; hard: boolean };

	recordEvalSubagentUsage?: (output: number) => void;

	getClientBridge?: () => ClientBridge | undefined;

	getChecklistPhases?: () => ChecklistPhase[];

	setChecklistPhases?: (phases: ChecklistPhase[]) => void;

	getToolChoiceQueue?(): ToolChoiceQueue;

	buildToolChoice?(toolName: string): ToolChoice | undefined;

	steer?(message: { customType: string; content: string; details?: unknown }): void;

	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;

	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;

	clearPendingInvokers?(): void;

	getCheckpointState?: () => CheckpointState | undefined;

	/** Report text a data-less terminal yield resolves to: its own turn's prose or the prose turn right before it. */
	getYieldReportText?: (toolCallId: string) => string | undefined;

	setCheckpointState?: (state: CheckpointState | null) => void;

	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	conflictHistory?: import("./conflict-detect").ConflictHistory;

	queueDeferredMessage?(message: CustomMessage): void;

	queueLaunchCompletion?(notification: DaemonCompletionNotification): Promise<void>;

	registerDisposeCallback?(callback: () => void): (() => void) | void;

	registerSessionChangeCallback?(callback: () => void): (() => void) | void;

	bumpFileMutationVersion?(path: string): number;

	getFileMutationVersion?(path: string): number;

	getTelemetry?: () => AgentTelemetryConfig | undefined;

	getImageAttachments?: () => ImageAttachmentEntry[];
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const DISABLED_TOOL_NAMES: Record<string, true> = {
	read: true,
};

export { isMountableUnderXdev } from "./xdev";

export function supportsExternalThinking(model: Model | null | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	const requiresThinking =
		model.api === "anthropic-messages" &&
		compat !== undefined &&
		"requiresThinkingEnabled" in compat &&
		compat.requiresThinkingEnabled === true;
	if (model.reasoning && (requiresThinking || (model.thinking?.requiresEffort && !model.thinking.suppressWhenOff))) {
		return false;
	}
	if (
		model.reasoning &&
		compat !== undefined &&
		(("omitReasoningEffort" in compat && compat.omitReasoningEffort === true) ||
			("supportsReasoningEffort" in compat && compat.supportsReasoningEffort === false))
	) {
		return false;
	}
	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return !model.reasoning || model.thinking?.mode === "budget" || model.thinking?.suppressWhenOff === true;
	}
	return (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "anthropic-messages"
	);
}

export const USER_CHECKLIST_EDIT_CUSTOM_TYPE = "user_checklist_edit";

interface ProviderGlobalSettings {
	get(path: "providers.webSearchOrder" | "providers.webSearchExclude" | "providers.imageOrder"): unknown;
}

let configuredImageProviderOrder: readonly string[] = [];
let applyLoadedImageProviderOrder: ((providers: readonly string[]) => void) | undefined;

export function setImageProviderOrder(providers: readonly string[]): void {
	configuredImageProviderOrder = [...providers];
	applyLoadedImageProviderOrder?.(configuredImageProviderOrder);
}

export function applyProviderGlobalsFromSettings(settings: ProviderGlobalSettings): void {
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
	}

	const orderedWebSearchProviders = settings.get("providers.webSearchOrder");
	if (Array.isArray(orderedWebSearchProviders)) {
		setSearchProviderOrder(orderedWebSearchProviders.filter(isSearchProviderId));
	}

	const orderedImageProviders = settings.get("providers.imageOrder");
	if (Array.isArray(orderedImageProviders)) {
		setImageProviderOrder(orderedImageProviders.filter((entry): entry is string => typeof entry === "string"));
	}
}

export { isSearchProviderId, setExcludedSearchProviders, setSearchProviderOrder };

// Runtime-registry exception: static imports here would put every optional tool implementation on the boot path.
export const BUILTIN_TOOLS: Record<Exclude<BuiltinToolName, "read">, ToolFactory> = {
	context: s => new ContextTool(s),
	recall: s => new RecallTool(s),
	bash: async s => new (await import("./bash")).BashTool(s),
	ask: async s => (await import("./ask")).AskTool.createIf(s),
	browser: async s => new (await import("./browser")).BrowserTool(s),
	computer: async s => new (await import("./computer")).ComputerTool(s),
	checkpoint: async s => (await import("./checkpoint")).CheckpointTool.createIf(s),
	rewind: async s => (await import("./checkpoint")).RewindTool.createIf(s),
	jobs: async s => new (await import("./jobs")).JobsTool(s),
	fleet: async s => (await import("./fleet")).FleetTool.create(s),
	checklist: async s => new (await import("./checklist")).ChecklistTool(s),
	web_search: async s => new (await import("../web/search")).WebSearchTool(s),
	manage_skill: async s => (await import("./manage-skill")).ManageSkillTool.createIf(s),
};

export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	think: async () => new (await import("./think")).ThinkTool(),
	yield: s => new YieldTool(s),
	goal: async s => new (await import("../goals/tools/goal-tool")).GoalTool(s),
};

export async function getImageGenTools(modelRegistry?: ModelRegistry, activeModel?: Model): Promise<CustomTool[]> {
	const module = await import("./image-gen");
	applyLoadedImageProviderOrder = module.setImageProviderOrder;
	applyLoadedImageProviderOrder(configuredImageProviderOrder);
	return module.getImageGenTools(modelRegistry, activeModel);
}

export async function getImageGenToolsWithRegistry(
	modelRegistry: ModelRegistry,
	activeModel?: Model,
): Promise<CustomTool[]> {
	const module = await import("./image-gen");
	applyLoadedImageProviderOrder = module.setImageProviderOrder;
	applyLoadedImageProviderOrder(configuredImageProviderOrder);
	return module.getImageGenToolsWithRegistry(modelRegistry, activeModel);
}

export async function getSearchTools(): Promise<CustomTool[]> {
	return (await import("../web/search")).getSearchTools();
}

export async function releaseComputerSessionsForOwner(ownerId: string | undefined): Promise<void> {
	await (await import("./computer/supervisor")).releaseComputerSessionsForOwner(ownerId);
}

export type ToolName = BuiltinToolName;

export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const restrictToolNames = session.restrictToolNames === true;
	const includeYield = session.requireYieldTool === true;
	const requestedTools = restrictToolNames
		? normalizeToolNames(toolNames ?? [])
		: toolNames
			? normalizeToolNames(toolNames)
			: undefined;
	const goalEnabled = session.settings.get("goal.enabled");
	const goalModeActive = !restrictToolNames && goalEnabled && session.getGoalModeState?.()?.enabled === true;
	const externalThinkingActive =
		session.settings.get("externalThinking") && supportsExternalThinking(session.getActiveModel?.());
	if (goalModeActive && requestedTools && !requestedTools.includes("goal")) {
		requestedTools.push("goal");
	}
	if (requestedTools && session.settings.get("checkpoint.enabled")) {
		if (requestedTools.includes("checkpoint") && !requestedTools.includes("rewind")) {
			requestedTools.push("rewind");
		} else if (requestedTools.includes("rewind") && !requestedTools.includes("checkpoint")) {
			requestedTools.push("checkpoint");
		}
	}
	if (requestedTools && !restrictToolNames) {
		if (goalModeActive && !requestedTools.includes("goal")) {
			requestedTools.push("goal");
		}
		if (externalThinkingActive && !requestedTools.includes("think")) {
			requestedTools.push("think");
		}

		if (session.settings.get("autolearn.enabled") && (session.taskDepth ?? 0) === 0) {
			if (!requestedTools.includes("manage_skill")) requestedTools.push("manage_skill");
		}
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name in DISABLED_TOOL_NAMES) return false;
		if (name === "bash") return session.settings.get("bash.enabled");
		if (name === "goal") {
			if (!goalEnabled || restrictToolNames) return false;
			const goalState = session.getGoalModeState?.();
			return goalState === undefined || goalState.enabled === true || goalState.goal.status === "dropped";
		}
		if (name === "checklist")
			return (!includeYield || session.prewalkArmed === true) && session.settings.get("checklist.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "think") return externalThinkingActive;
		if (name === "ask") return session.settings.get("ask.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "computer") return session.settings.get("computer.enabled");
		if (name === "checkpoint" || name === "rewind")
			return (
				session.settings.get("checkpoint.enabled") &&
				((session.taskDepth ?? 0) === 0 || requestedTools !== undefined)
			);
		// Domain devices authorize each operation; messaging policy must not disable worker control.
		if (name === "fleet" || name === "jobs") return true;
		if (name === "manage_skill")
			return (
				session.settings.get("autolearn.enabled") &&
				((session.taskDepth ?? 0) === 0 || requestedTools !== undefined)
			);
		return true;
	};
	if (includeYield && requestedTools && !requestedTools.includes("yield")) {
		requestedTools.push("yield");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.map(name => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS)
						.filter(([name]) => isToolAllowed(name))
						.map(([name, factory]) => [name, factory] as const),
					...(externalThinkingActive ? ([["think", HIDDEN_TOOLS.think]] as const) : []),
					...(includeYield ? ([["yield", HIDDEN_TOOLS.yield]] as const) : []),
					...(isToolAllowed("goal") ? ([["goal", HIDDEN_TOOLS.goal]] as const) : []),
				];

	const activeToolNames = new Set([...baseEntries.map(([name]) => name), "read"]);
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	const [baseResults, readTool, { wrapToolWithMetaNotice }] = await Promise.all([
		Promise.all(
			baseEntries.map(([name, factory]) => logger.time(`createTools:${name}`, factory as ToolFactory, session)),
		),
		logger.time(
			"createTools:read-bridge",
			async (s: ToolSession) => new (await import("./read")).ReadTool(s),
			session,
		),
		import("./output-meta"),
	]);
	let tools = baseResults
		.filter((result): result is Tool => result !== null)
		.map(tool => wrapToolWithMetaNotice(tool));
	const toolRegistry = session.toolRegistry ?? new Map<string, Tool>();
	session.toolRegistry = toolRegistry;
	const builtInNames = new Set(tools.map(tool => tool.name));
	for (const tool of tools) toolRegistry.set(tool.name, tool);
	if (readTool) {
		const wrappedRead = wrapToolWithMetaNotice(readTool);
		toolRegistry.set(wrappedRead.name, wrappedRead);
		builtInNames.add(wrappedRead.name);
		tools.push(wrappedRead);
	}

	const xdevEnabled =
		!restrictToolNames && session.settings.get("tools.xdev") && tools.some(tool => tool.name === "bash");
	const mountBuiltinTools = requestedTools === undefined;
	if (xdevEnabled) {
		const mountedNames = new Set<string>();
		const kept: Tool[] = [];
		for (const tool of tools) {
			const mountable = mountBuiltinTools && isMountableUnderXdev(tool) && !(tool.name in HIDDEN_TOOLS);
			if (mountable) mountedNames.add(tool.name);
			else kept.push(tool);
		}
		session.xdev = {
			tools: toolRegistry,
			mountedNames,
			builtInNames,
			isActive: name => session.isToolActive?.(name) === true,
		};
		tools = kept;
	}

	if (xdevEnabled) {
		const finalActiveNames = new Set(tools.map(tool => tool.name));
		if (session.setActiveToolNames) session.setActiveToolNames(finalActiveNames);
		else session.isToolActive = name => finalActiveNames.has(name);
	}

	return tools;
}
