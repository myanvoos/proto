import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	CredentialDisabledEvent,
	Effort,
	Message,
	Model,
	ModelUsageHealth,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { FALLBACK_DIALECT, preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	$env,
	$flag,
	getAgentDir,
	getModelDbPath,
	getProjectDir,
	INTENT_FIELD,
	logger,
	postmortem,
	prompt,
	Snowflake,
} from "@oh-my-pi/pi-utils";
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
	loadAdvisorTranscriptCosts,
} from "./advisor";
import { AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { isAuthenticated, kNoAuth, ModelRegistry } from "./config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { applyProviderGlobalsFromSettings } from "./config/provider-globals";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers, type CursorMcpResourceAdapter } from "./cursor";
import { createBridgeEditTool } from "./cursor-bridge-tools";
import "./discovery";
import { createImageUrlServiceFromSettings } from "./blob-broker/service";
import { wrapStreamFnWithBlobUrlFallback } from "./blob-broker/stream-fallback";
import { initializeWithSettings } from "./discovery";
import { withOmpExtensionRootScope } from "./discovery/proto-extension-roots";
import { disposeVmContextsByOwner } from "./eval/js/context-manager";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	EXTENSION_HANDLER_TIMEOUT_MS,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type RegisteredTool,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import {
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import {
	deduplicateMCPToolsByName,
	discoverAndLoadMCPTools,
	getMCPToolOriginKey,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { type OrchestratorParent, OrchestratorRuntime } from "./orchestrator/runtime";
import mcpXdevGuidanceTemplate from "./prompts/system/mcp-xdev-guidance.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	buildSecretObfuscator,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "./secrets";
import { AgentSession, type InitialRetryFallbackState, type Prewalk } from "./session/agent-session";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { withDateCwdReminder } from "./session/date-cwd-reminder";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import {
	type CustomMessage,
	convertToLlm,
	replaceLlmImagesWithText,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import { clampProviderContextImages } from "./session/provider-image-budget";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "./session/retry-fallback-chains";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { collectMountedMCPToolRoutes, projectMountedMCPXdevGuidance } from "./session/session-tools";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	loadProjectContextFiles as loadContextFilesInternal,
	projectSystemPromptToolMetadata,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import { isScoutSpawnable } from "./task/spawn-policy";
import type { StructuredSubagentSchemaMode } from "./task/types";
import {
	parseThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	DISABLED_TOOL_NAMES,
	defaultLoadModeForToolName,
	EditTool,
	EvalTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isMountableUnderXdev,
	listXdevTools,
	ORCHESTRATE_TOOL_NAMES,
	ReadTool,
	releaseComputerSessionsForOwner,
	resolveMountedXdevExecutable,
	supportsExternalThinking,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	xdevDocsAll,
	xdevEntries,
} from "./tools";
import { isMCPToolName, normalizeToolNames } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import { isIrcEnabled } from "./tools/fleet";
import { getImageGenTools } from "./tools/image-gen";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { isAutoQaEnabled } from "./tools/report-tool-issue";
import { queueResolveHandler } from "./tools/resolve";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "./tools/todo";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { normalizeProviderContextImagesForModel } from "./utils/image-loading";
import { formatLocalCalendarDate } from "./utils/local-date";
import { normalizePromptPath } from "./utils/prompt-path";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

function collectPendingMCPToolNames(explicitToolNames: readonly string[] | undefined): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

export interface CreateAgentSessionOptions {
	cwd?: string;

	additionalDirectories?: string[];

	agentDir?: string;

	spawns?: string;

	authStorage?: AuthStorage;

	modelRegistry?: ModelRegistry;

	getApiKey?: AgentOptions["getApiKey"];

	model?: Model;

	modelPattern?: string | string[];

	modelPatternAuthFallback?: string;

	modelPatternFallbackRole?: string;

	modelPatternDefaultFallbackChain?: string[];

	thinkingLevel?: ThinkingLevel;

	thinkingLevelCeiling?: Effort;

	openAIServiceTier?: ServiceTier | null;

	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	prewalk?: Prewalk;

	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);

	customSystemPrompt?: string;

	appendSystemPrompt?: string;

	titleSystemPrompt?: string;

	providerSessionId?: string;

	providerPromptCacheKey?: string;

	providerPromptCacheKeySource?: "explicit" | "fork";

	deadline?: number;

	customTools?: (CustomTool | ToolDefinition)[];

	extensions?: ExtensionFactory[];

	additionalExtensionPaths?: string[];

	disableExtensionDiscovery?: boolean;

	preloadedExtensions?: LoadExtensionsResult;

	preloadedExtensionPaths?: string[];

	preloadedCustomToolPaths?: ToolPathWithSource[];

	eventBus?: EventBus;

	skills?: Skill[];

	rules?: Rule[];

	contextFiles?: Array<{ path: string; content: string }>;

	workspaceTree?: WorkspaceTree;

	promptTemplates?: PromptTemplate[];

	slashCommands?: FileSlashCommand[];

	enableMCP?: boolean;

	mcpManager?: MCPManager;

	enableIrc?: boolean;

	skipPythonPreflight?: boolean;

	toolNames?: string[];

	restrictToolNames?: boolean;

	allowRestrictedCustomTools?: boolean;

	outputSchema?: unknown;

	outputSchemaMode?: StructuredSubagentSchemaMode;

	requireYieldTool?: boolean;

	taskDepth?: number;

	agentId?: string;

	agentDisplayName?: string;

	agentRegistry?: AgentRegistry;

	expectedAgentRef?: AgentRef | null;

	parentTaskPrefix?: string;

	parentAgentId?: string;

	parentEvalSessionId?: string;

	sessionManager?: SessionManager;

	localProtocolOptions?: LocalProtocolOptions;

	settings?: Settings;

	settingsManager?: Settings | Promise<Settings>;

	hasUI?: boolean;

	interactivePrompts?: boolean;

	deferUsageReserveConfirmation?: boolean;

	telemetry?: AgentTelemetryConfig;

	onFirstChatDispatch?: () => void;
}

export interface CreateAgentSessionResult {
	session: AgentSession;

	extensionsResult: LoadExtensionsResult;

	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	mcpManager?: MCPManager;

	modelFallbackMessage?: string;

	eventBus: EventBus;
}

export type DialectFormat = "auto" | "native" | Dialect;

export function resolveDialect(
	format: DialectFormat,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): Dialect | undefined {
	if (format === "native") return undefined;
	if (format === "auto") {
		if (model?.supportsTools !== false) return undefined;
		if (!model.id) return "glm";
		const preferred = preferredDialect(model.id);
		return preferred === FALLBACK_DIALECT ? "glm" : preferred;
	}
	return format;
}

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";

export { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

export {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	HIDDEN_TOOLS,
	ReadTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

export async function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	return discoverAuthStorageFromConfig(agentDir);
}

export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	const configuredPaths = options.disableExtensionDiscovery
		? (options.additionalExtensionPaths ?? [])
		: [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = options.disableExtensionDiscovery
		? undefined
		: (settings.get("disabledExtensions") ?? []);
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, {
		ambient: !options.disableExtensionDiscovery,
	});
}

export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return result;
}

export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}

export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
	disabledExtensions?: string[],
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		disabledExtensions,
	});
}

export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
}

export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolNames = options.tools?.map(tool => tool.name);
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	const promptTools = toolMap
		? projectSystemPromptToolMetadata(
				toolMap,
				options.inlineToolDescriptors ? { mode: "full" } : { mode: "compact", toolNames: toolNames ?? [] },
			)
		: undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		toolNames,
		tools: promptTools,
	});
}

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	return !(tool as any).__isToolDefinition;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__ompLegacyBuiltinTool" in tool && tool.__ompLegacyBuiltinTool === true;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let evalCleanupRegistered = false;

function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

export function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		defaultInactive: tool.hidden === true,
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		deferrable: tool.deferrable,

		strict: tool.strict,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);

					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	const uniqueTools = deduplicateMCPToolsByName(tools);
	return api => {
		for (const tool of uniqueTools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of uniqueTools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					retryErrors: event.retryErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

interface AutoLearnCaptureRunnerOptions {
	sourceAgent: Agent;
	captureTools: AgentTool[];
	createAgent: (options: AgentOptions) => Agent;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	createSessionId?: () => string;
}

export function createAutoLearnCaptureRunner(
	options: AutoLearnCaptureRunnerOptions,
): (content: string, signal?: AbortSignal) => Promise<void> {
	return async (content, signal) => {
		if (options.captureTools.length === 0 || signal?.aborted) return;
		const captureModel = options.sourceAgent.state.model;
		if (!captureModel) return;

		const captureSessionId = options.createSessionId?.() ?? Bun.randomUUIDv7();
		const captureProviderSessionState = new Map<string, ProviderSessionState>();
		const captureMessages = options.sourceAgent.state.messages.map((message): AgentMessage => {
			if (message.role === "assistant") {
				return { ...message, responseId: undefined, providerPayload: undefined };
			}
			if (message.role === "user" || message.role === "developer") {
				return { ...message, providerPayload: undefined };
			}
			return message;
		});
		const captureAgent = options.createAgent({
			initialState: {
				systemPrompt: [...options.sourceAgent.state.systemPrompt],
				model: captureModel,
				thinkingLevel: options.sourceAgent.state.thinkingLevel,
				disableReasoning: options.sourceAgent.state.disableReasoning,
				tools: options.captureTools,
				messages: captureMessages,
			},
			sessionId: captureSessionId,
			promptCacheKey: captureSessionId,
			providerSessionState: captureProviderSessionState,
			getApiKey: requestModel => options.sourceAgent.getApiKey?.(requestModel),
			onPayload: options.onPayload,
			onResponse: options.onResponse,
		});
		captureAgent.setMetadataResolver(provider => options.sourceAgent.metadataForProvider(provider));
		const captureMessage: CustomMessage = {
			role: "custom",
			customType: "autolearn-nudge",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		const abortCapture = () => captureAgent.abort(signal?.reason);
		signal?.addEventListener("abort", abortCapture, { once: true });
		try {
			if (signal?.aborted) {
				abortCapture();
				return;
			}
			await captureAgent.prompt(captureMessage);
		} catch (error) {
			if (!signal?.aborted) throw error;
		} finally {
			signal?.removeEventListener("abort", abortCapture);
			for (const [providerKey, state] of captureProviderSessionState) {
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close auto-learn capture provider state", {
						providerKey,
						error: String(error),
					});
				}
			}
			captureProviderSessionState.clear();
		}
	};
}

export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const rootMode = options.disableExtensionDiscovery ? "explicit-only" : "merge";
	return await withOmpExtensionRootScope(options.additionalExtensionPaths ?? [], rootMode, () =>
		createAgentSessionScoped(options),
	);
}

async function createAgentSessionScoped(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);

	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(
			options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)),
			path.join(agentDir, "models.yml"),
			{
				settings,
				cacheDbPath: getModelDbPath(agentDir),
			},
		);

	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}

	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled: (() => void) | undefined = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			void credentialDisabledTarget.emitCredentialDisabled(event);
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});
	await modelRegistry.hydrateCredentialScopedModelCaches();
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}

	const STARTUP_SCAN_DEADLINE_MS = 5000;
	const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
	const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
		? Promise.resolve(options.workspaceTree)
		: includeWorkspaceTree
			? logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }))
			: Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] });
	workspaceTreePromise.catch(() => {});

	const contextFilesPromise = options.contextFiles
		? Promise.resolve(options.contextFiles)
		: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir);
	contextFilesPromise.catch(() => {});
	const resolveRepoContext = async (repoCwd: string) => {
		try {
			return await resolveActiveRepoContext(repoCwd);
		} catch (err) {
			logger.debug("Failed to resolve active repo context", { err: String(err) });
			return null;
		}
	};
	const activeRepoContextPromise = logger.time("resolveActiveRepoContext", resolveRepoContext, cwd);
	activeRepoContextPromise.catch(() => {});
	const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
	watchdogFilesPromise.catch(() => {});
	const advisorConfigsPromise = logger.time("discoverAdvisorConfigs", () => discoverAdvisorConfigs(cwd, agentDir));
	advisorConfigsPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				})
			: undefined;
	discoveredSkillsPromise?.catch(() => {});

	applyProviderGlobalsFromSettings(settings);

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const configuredDirs = options.additionalDirectories
		? options.additionalDirectories
		: settings.get("workspace.additionalDirectories");
	if (configuredDirs.length > 0) {
		const existing = sessionManager.getAdditionalDirectories();
		const merged = [...new Set([...existing, ...configuredDirs])];
		await sessionManager.setAdditionalDirectories(merged);
	}
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const forkCacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined ||
		options.toolNames !== undefined ||
		options.customTools !== undefined;
	const inheritedPromptCacheKey = forkCacheShapeChanged
		? undefined
		: sessionManager.getHeader()?.providerPromptCacheKey;
	const providerPromptCacheKey = options.providerPromptCacheKey ?? inheritedPromptCacheKey;
	const providerPromptCacheKeySource =
		options.providerPromptCacheKey !== undefined
			? (options.providerPromptCacheKeySource ?? "explicit")
			: providerPromptCacheKey !== undefined
				? "fork"
				: undefined;

	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

	const obfuscator: SecretObfuscator | undefined = settings.get("secrets.enabled")
		? await buildSecretObfuscator(cwd, agentDir, options.agentDir)
		: undefined;
	const secretsEnabled = obfuscator?.hasSecrets() === true;

	let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const interruptedTurnAbort = createInterruptedTurnAbortMessage(existingBranch);
	if (interruptedTurnAbort) {
		sessionManager.appendMessage(interruptedTurnAbort);
		existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
	}
	let existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const deferredModelPatterns = Array.isArray(options.modelPattern)
		? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
		: options.modelPattern?.trim()
			? [options.modelPattern.trim()]
			: [];
	const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const allowedModels = await logger.time("resolveAllowedModels", () =>
		resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	let initialRetryFallback: InitialRetryFallbackState | undefined;

	const sessionModelStrings =
		!hasExplicitModel && hasExistingSession
			? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
			: [];
	let restoredSessionModelIndex = -1;
	let restoredSessionThinkingLevel: ThinkingLevel | undefined;
	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) {
					failedSessionModel ??= sessionModelStr;
					continue;
				}

				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					break;
				}
				failedSessionModel ??= sessionModelStr;
			}
			if (failedSessionModel) {
				modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			model = settingsDefaultModel;
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	const pickInitialThinkingLevel = (selectedModel: Model | undefined): ThinkingLevel | undefined => {
		let level = options.thinkingLevel;
		if (level === undefined && hasExistingSession && hasThinkingEntry) {
			level =
				parseThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel);
		}
		if (level === undefined && !hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
			level = restoredSessionThinkingLevel;
		}
		if (level === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
			level = defaultRoleSpec.thinkingLevel;
		}
		if (level === undefined && selectedModel?.thinking?.defaultLevel !== undefined) {
			level = selectedModel.thinking.defaultLevel;
		}
		if (level === undefined) {
			level = parseThinkingLevel(settings.get("defaultThinkingLevel"));
		}
		return level;
	};

	let thinkingLevel = pickInitialThinkingLevel(model);
	let effectiveThinkingLevel: ThinkingLevel | undefined = thinkingLevel;
	if (model) {
		const resolvedModel = model;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
		);

		preconnectModelHost(model.baseUrl);
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = await logger.time(
		"discoverTtsrRules",
		async () => {
			const { TtsrManager } = await import("./export/ttsr");
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
			const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
				builtinRules: ttsrSettings.builtinRules,
				disabledRules: ttsrSettings.disabledRules,
			});
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
		},
	);

	const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
		let timedOut = false;
		const result = await Promise.race([
			work,
			Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
				timedOut = true;
				return undefined;
			}),
		]);
		if (timedOut) {
			logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
				name,
				timeoutMs: STARTUP_SCAN_DEADLINE_MS,
				cwd,
			});
		}
		return result;
	};
	const [initialContextFiles, resolvedWorkspaceTree, watchdogFiles, initialActiveRepoContext, discoveredAdvisors] =
		await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
			watchdogFilesPromise,
			activeRepoContextPromise,
			advisorConfigsPromise,
		]);
	let contextFiles = initialContextFiles;

	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	const restrictToolNames = options.restrictToolNames === true;
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));

	const asyncJobManager =
		!options.parentTaskPrefix && !AsyncJobManager.instance()
			? new AsyncJobManager({ maxRunningJobs: asyncMaxJobs })
			: undefined;

	const scopedAsyncJobManager = asyncJobManager ?? AsyncJobManager.instance();

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName =
		options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
	const agentKind = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? ("sub" as const) : ("main" as const);
	let registeredAgentRef: AgentRef | undefined;

	const unregisterUnlessParked = (): void => {
		const ref = registeredAgentRef;
		if (!ref || agentRegistry.get(resolvedAgentId) !== ref) return;
		if (ref.status === "parked" || (ref.status === "aborted" && !ref.session)) return;
		if (AgentLifecycleManager.global().isParking(resolvedAgentId, ref)) return;
		agentRegistry.unregister(resolvedAgentId, ref);
	};
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};

		const fileMutationVersions = new Map<string, number>();
		const disposeCallbacks = new Set<() => void>();
		const activeToolNames = new Set<string>();
		const toolRegistry = new Map<string, Tool & Pick<ToolDefinition, "defaultInactive">>();
		const setActiveToolNames = (names: Iterable<string>): void => {
			activeToolNames.clear();
			for (const name of names) {
				activeToolNames.add(name);
			}
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			isToolActive: name => activeToolNames.has(name),
			setActiveToolNames,
			toolRegistry,
			hasUI: options.hasUI ?? false,
			canPromptUser: options.interactivePrompts ?? options.hasUI ?? false,
			getApiKey: options.getApiKey,
			get additionalDirectories() {
				return sessionManager.getAdditionalDirectories();
			},
			enableIrc: restrictToolNames ? false : options.enableIrc,
			restrictToolNames,
			get hasEditTool() {
				const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
				return restrictToolNames
					? requestedToolNames?.includes("edit") === true
					: !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			get skills() {
				return session?.skills ?? skills;
			},
			refreshSkills: () => session.refreshSkills(),
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			requireYieldTool: options.requireYieldTool,
			prewalkArmed: options.prewalk !== undefined,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			sessionManager,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () =>
				session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			isDisposed: () => session?.isDisposed ?? false,
			getAgentId: () => resolvedAgentId,
			getToolByName: name => session?.getToolByName(name),
			getToolForEvalBridge: name => session?.getToolForEvalBridge(name),
			getEvalBridgeToolNames: () => session?.getEvalBridgeToolNames() ?? [],
			getCodeModeDirectToolNames: () => session?.getCodeModeDirectToolNames(),
			agentRegistry,

			agentLifecycle: options.agentRegistry ? undefined : () => AgentLifecycleManager.global(),
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveModel: () => agent?.state.model ?? model,
			getInspectMediaModeOverride: () => session?.getInspectMediaModeOverride(),
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
			recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
			getClientBridge: () => session?.clientBridge,
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			registerDisposeCallback: callback => {
				disposeCallbacks.add(callback);
				return () => disposeCallbacks.delete(callback);
			},
			registerSessionChangeCallback: callback => session?.registerSessionChangeCallback(callback),
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,

			asyncJobManager: scopedAsyncJobManager,
		};

		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);

			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
			if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
		}
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions && !options.parentTaskPrefix) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		const effectiveToolNames =
			!restrictToolNames && agentKind === "main" && options.toolNames
				? [...new Set([...options.toolNames, ...ORCHESTRATE_TOOL_NAMES])]
				: options.toolNames;

		await logger.time("createAllTools", createTools, toolSession, effectiveToolNames);

		const enableMCP = !restrictToolNames && (options.enableMCP ?? true);
		let mcpManager: MCPManager | undefined = enableMCP ? options.mcpManager : undefined;
		toolSession.mcpManager = mcpManager;
		toolSession.enableMCP = enableMCP;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const customTools: CustomTool[] = [];
		const initialMcpManagerTools: CustomTool[] = [];
		let startDeferredMCPDiscovery: ((liveSession: AgentSession) => void) | undefined;
		const startupQuiet = settings.get("startup.quiet");
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,

			filterExa: true,

			filterBrowser: settings.get("browser.enabled") ?? false,
		};
		if (enableMCP && !mcpManager) {
			if (deferMCPDiscoveryForUI) {
				const cacheStorage = settings.getStorage();
				mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}

				const deferredMCPManager = mcpManager;
				startDeferredMCPDiscovery = liveSession => {
					void (async () => {
						try {
							const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
								deferredMCPManager.discoverAndConnect(mcpDiscoverOptions),
							);

							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);

							await liveSession.refreshMCPTools(mcpResult.tools);
						} catch (error) {
							logger.error("MCP tool load failed", {
								path: ".mcp.json",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					})();
				};
			} else {
				const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
					...mcpDiscoverOptions,
					cacheStorage: settings.getStorage(),
					authStorage,
				});
				mcpManager = mcpResult.manager;
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				for (const { path, error } of mcpResult.errors) {
					logger.error("MCP tool load failed", { path, error });
				}

				const loadedMcpTools = mcpResult.tools.map(loaded => loaded.tool);
				customTools.push(...loadedMcpTools);
				initialMcpManagerTools.push(...loadedMcpTools);
			}
		}

		if (mcpManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		const builtInToolNames = [...toolRegistry.keys()];
		let customToolPaths: ToolPathWithSource[] = [];
		const inlineExtensions: ExtensionFactory[] = [];
		if (!restrictToolNames) {
			const imageGenRequested = !options.toolNames || options.toolNames.includes("generate_image");
			if (settings.get("generate_image.enabled") && imageGenRequested) {
				const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
				if (imageGenTools.length > 0) {
					customTools.push(...(imageGenTools as unknown as CustomTool[]));
				}
			}

			if (options.toolNames?.includes("web_search")) {
				customTools.push(...getSearchTools());
			}

			customToolPaths =
				options.preloadedCustomToolPaths ??
				(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd)));
			const customToolsLoadResult = await logger.time("loadCustomTools", () =>
				loadCustomTools(customToolPaths, cwd, builtInToolNames, action => queueResolveHandler(toolSession, action)),
			);
			for (const { path, error } of customToolsLoadResult.errors) {
				logger.error("Custom tool load failed", { path, error });
			}
			if (customToolsLoadResult.tools.length > 0) {
				customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
			}

			inlineExtensions.push(...(options.extensions ?? []));
			if (customTools.length > 0) {
				inlineExtensions.push(createCustomToolsExtension(customTools));
			}
		}

		toolSession.customToolPaths = customToolPaths;

		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		if (restrictToolNames) {
			extensionPaths = [];
			extensionsResult = await loadExtensions([], cwd, eventBus);
		} else if (options.preloadedExtensions) {
			extensionsResult = {
				...options.preloadedExtensions,
				extensions: [...options.preloadedExtensions.extensions],
			};

			extensionPaths = extensionsResult.extensions
				.map(ext => ext.resolvedPath)
				.filter(p => !p.startsWith("<inline"));
		} else if (options.preloadedExtensionPaths) {
			extensionPaths = options.preloadedExtensionPaths;
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else {
			extensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(options, cwd, settings),
			);
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}

		toolSession.extensionPaths = extensionPaths;

		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const loaded = await loadExtensionFromFactory(
					factory,
					cwd,
					eventBus,
					extensionsResult.runtime,
					`<inline-${i}>`,
				);
				extensionsResult.extensions.push(loaded);
			}
		}

		if (!restrictToolNames) {
			const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
			modelRegistry.syncExtensionSources(activeExtensionSources);
			for (const sourceId of new Set(activeExtensionSources)) {
				modelRegistry.clearSourceRegistrations(sourceId);
			}
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}

		await modelRegistry.refreshRuntimeProviders("offline");

		const runtimeDiscoveryPromise = modelRegistry.refreshRuntimeProviders().catch(error => {
			logger.warn("runtime provider discovery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && sessionRetryLimit > 0) {
			for (let i = 0; i < sessionRetryLimit; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) continue;
				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					modelFallbackMessage = undefined;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;

					thinkingLevel = pickInitialThinkingLevel(restoredModel);
					effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
						resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
					);
					preconnectModelHost(restoredModel.baseUrl);
					break;
				}
			}
		}

		if (!model && deferredModelPatterns.length > 0) {
			await logger.time("resolveModelDiscoveryDeferredRetry", () => runtimeDiscoveryPromise);
			const matchPreferences = getModelMatchPreferences(settings);
			const runtimeResolved = deferredModelPatterns.some(pattern =>
				pattern.split(",").some(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return false;
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});

					return Boolean(resolved.model);
				}),
			);
			if (!runtimeResolved && modelRegistry.getDiscoverableProviders().length > 0) {
				await logger.time("resolveModelDiscoveryFallbackNonRuntime", () =>
					modelRegistry.refresh("online-if-uncached"),
				);
			}
			const allModels = modelRegistry.getAll();
			const availableModels = modelRegistry.getAvailable();
			const expandedModelPatterns = deferredModelPatterns.flatMap(pattern =>
				pattern.split(",").flatMap(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return [];
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					if (resolved.configuredPatterns && resolved.configuredPatterns.length > 0) {
						const primaryPatterns: Array<{
							pattern: string;
							retryFallback: InitialRetryFallbackState | undefined;
						}> = resolved.configuredPatterns.map(pattern => ({
							pattern,
							retryFallback: undefined,
						}));
						if (!resolved.configuredRole || !settings.get("retry.modelFallback")) {
							return primaryPatterns;
						}
						const fallbackContext: RetryFallbackResolutionContext = {
							chains: expandDefaultRetryFallbackChains(settings.get("retry.fallbackChains"), [
								...Object.keys(settings.getModelRoles()),
								resolved.configuredRole,
							]),
							getModelRole: role => settings.getModelRole(role),
							modelLookup: modelRegistry,
						};
						const originalSelector = resolved.configuredPatterns[0];
						const availableOriginal = parseModelPattern(originalSelector, availableModels, matchPreferences);
						const originalModel =
							availableOriginal.model ?? parseModelPattern(originalSelector, allModels, matchPreferences).model;
						const chainKey = resolveRetryFallbackChainKey(
							fallbackContext,
							originalSelector,
							originalModel,
							resolved.configuredRole,
						);
						if (!chainKey) return primaryPatterns;
						const parsedOriginal = parseModelString(originalSelector, {
							allowMaxSuffix: true,
							isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
						});
						const retryFallback: InitialRetryFallbackState = {
							role: chainKey,
							originalSelector,
							originalThinkingLevel: parsedOriginal?.thinkingLevel,
						};
						return [
							...primaryPatterns,
							...findRetryFallbackCandidates(fallbackContext, chainKey, originalSelector, originalModel, {
								allowMissingPrimary: true,
							}).map(candidate => ({ pattern: candidate.raw, retryFallback })),
						];
					}
					if (resolved.model) {
						return [
							{
								pattern: formatModelSelectorValue(
									resolved.selector ?? formatModelStringWithRouting(resolved.model),
									resolved.thinkingLevel,
								),
								retryFallback: undefined,
							},
						];
					}
					return resolveConfiguredModelPatterns([trimmedSelector], settings).map(pattern => ({
						pattern,
						retryFallback: undefined,
					}));
				}),
			);
			const resolutionModels = expandedModelPatterns.some(
				({ pattern }) => parseModelPattern(pattern, availableModels, matchPreferences).model,
			)
				? availableModels
				: allModels;
			let usageFallbackTriggered = false;
			for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
				const { pattern, retryFallback } = expandedModelPatterns[patternIndex];
				const primary = parseModelPattern(pattern, resolutionModels, matchPreferences);
				if (!primary.model || (retryFallback && !hasModelAuth(primary.model))) continue;
				let hasUsageFallbackCandidate = false;
				for (
					let candidateIndex = patternIndex + 1;
					candidateIndex < expandedModelPatterns.length;
					candidateIndex += 1
				) {
					const candidate = parseModelPattern(
						expandedModelPatterns[candidateIndex].pattern,
						resolutionModels,
						matchPreferences,
					);
					if (candidate.model && hasModelAuth(candidate.model)) {
						hasUsageFallbackCandidate = true;
						break;
					}
				}
				const usageReservePolicy = settings.get("retry.usageReservePolicy");
				const modelFallbackEnabled = settings.get("retry.modelFallback");
				if (
					((modelFallbackEnabled && (hasUsageFallbackCandidate || usageFallbackTriggered)) ||
						usageReservePolicy === "fail-closed") &&
					settings.get("retry.usageAwareFallback")
				) {
					let usageHealth: ModelUsageHealth | undefined;
					try {
						usageHealth = await modelRegistry.authStorage.getModelUsageHealth(primary.model.provider, {
							modelId: primary.model.id,
							baseUrl: primary.model.baseUrl,
							reserveFraction: settings.get("retry.usageReservePct") / 100,
						});
					} catch (error) {
						logger.debug("Usage-aware model preflight failed open", {
							provider: primary.model.provider,
							model: primary.model.id,
							error: String(error),
						});
					}
					if (usageHealth?.state === "depleted") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage depleted for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (modelFallbackEnabled) {
							usageFallbackTriggered = true;
							continue;
						}
					}
					if (usageHealth?.state === "reserve") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage reserve reached for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (
							modelFallbackEnabled &&
							(usageReservePolicy === "auto" || (!options.hasUI && !options.deferUsageReserveConfirmation))
						) {
							usageFallbackTriggered = true;
							continue;
						}
					}
				}
				let selectedModel = primary.model;
				let selectedThinkingLevel = primary.thinkingLevel;
				let selectedExplicitThinkingLevel = primary.explicitThinkingLevel;

				if (retryFallback && !selectedExplicitThinkingLevel && retryFallback.originalThinkingLevel !== undefined) {
					selectedThinkingLevel = retryFallback.originalThinkingLevel;
					selectedExplicitThinkingLevel = true;
				}
				let authFallbackUsed = false;
				if (options.modelPatternAuthFallback) {
					const primaryKey = await modelRegistry.getApiKey(primary.model);
					if (primaryKey !== kNoAuth && !isAuthenticated(primaryKey)) {
						const fallback = parseModelPattern(
							options.modelPatternAuthFallback,
							resolutionModels,
							matchPreferences,
						);
						if (fallback.model) {
							const fallbackKey = await modelRegistry.getApiKey(fallback.model);
							if (isAuthenticated(fallbackKey)) {
								selectedModel = fallback.model;
								selectedThinkingLevel = fallback.thinkingLevel;
								selectedExplicitThinkingLevel = fallback.explicitThinkingLevel;
								authFallbackUsed = true;
							}
						}
					}
				}
				if (!authFallbackUsed && options.modelPatternFallbackRole) {
					const primarySelector = formatModelSelectorValue(
						formatModelStringWithRouting(primary.model),
						primary.thinkingLevel,
					);
					const seenSelectors = new Set<string>([primarySelector]);
					const fallbackSelectors: string[] = [];
					for (const fallbackEntry of expandedModelPatterns.slice(patternIndex + 1)) {
						const fallback = parseModelPattern(fallbackEntry.pattern, resolutionModels, matchPreferences);
						if (!fallback.model) continue;
						const fallbackSelector = formatModelSelectorValue(
							formatModelStringWithRouting(fallback.model),
							fallback.thinkingLevel,
						);
						if (seenSelectors.has(fallbackSelector)) continue;
						seenSelectors.add(fallbackSelector);
						fallbackSelectors.push(fallbackSelector);
					}
					if (fallbackSelectors.length === 0) {
						for (const selector of options.modelPatternDefaultFallbackChain ?? []) {
							if (typeof selector !== "string" || seenSelectors.has(selector)) continue;
							seenSelectors.add(selector);
							fallbackSelectors.push(selector);
						}
					}
					if (fallbackSelectors.length > 0) {
						const modelRoles: Record<string, string> = {};
						const existingRoles = settings.getModelRoles();
						for (const role in existingRoles) {
							const selector = existingRoles[role];
							if (selector) {
								modelRoles[role] = selector;
							}
						}
						modelRoles[options.modelPatternFallbackRole] = primarySelector;
						settings.override("modelRoles", modelRoles);
						const fallbackChains: Record<string, string[]> = {
							[options.modelPatternFallbackRole]: fallbackSelectors,
						};
						const existingFallbackChains = settings.get("retry.fallbackChains");
						for (const role in existingFallbackChains) {
							if (role !== options.modelPatternFallbackRole) {
								fallbackChains[role] = existingFallbackChains[role];
							}
						}
						settings.override("retry.fallbackChains", fallbackChains);
					}
				}
				model = selectedModel;
				initialRetryFallback =
					retryFallback && usageFallbackTriggered ? { ...retryFallback, pinned: true } : retryFallback;
				modelFallbackMessage = undefined;
				if (selectedExplicitThinkingLevel) {
					restoredSessionThinkingLevel = selectedThinkingLevel;
				}
				thinkingLevel = pickInitialThinkingLevel(selectedModel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					resolveThinkingLevelForModel(selectedModel, effectiveThinkingLevel),
				);
				preconnectModelHost(selectedModel.baseUrl);
				break;
			}
			if (!model) {
				const requested =
					deferredModelPatterns.length === 1
						? `"${deferredModelPatterns[0]}"`
						: `one of ${deferredModelPatterns.map(pattern => `"${pattern}"`).join(", ")}`;
				modelFallbackMessage = `Model ${requested} not found`;
			}
		}

		if (!model && deferredModelPatterns.length === 0) {
			const tryResolveDefaultRole = async (): Promise<boolean> => {
				if (hasExplicitModel) return false;

				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
				});
				if (!reResolvedRoleSpec.model) return false;
				defaultRoleSpec = reResolvedRoleSpec;
				const resolvedDefaultModel = reResolvedRoleSpec.model;
				model = resolvedDefaultModel;
				modelFallbackMessage = undefined;

				thinkingLevel = pickInitialThinkingLevel(resolvedDefaultModel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					resolveThinkingLevelForModel(resolvedDefaultModel, effectiveThinkingLevel),
				);
				preconnectModelHost(resolvedDefaultModel.baseUrl);
				return true;
			};

			await tryResolveDefaultRole();

			if (!model) {
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));

				const defaultRoleConfigured = Boolean(settings.getModelRole("default"));
				if (
					!hasExplicitModel &&
					(defaultRoleConfigured || !pick) &&
					modelRegistry.getDiscoverableProviders().length > 0
				) {
					await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
					if (!(await tryResolveDefaultRole()) && !model) {
						const refreshedCandidates = await resolveAllowedModels(
							modelRegistry,
							settings,
							modelMatchPreferences,
						);
						pick = pickDefaultAvailableModel(refreshedCandidates.filter(hasModelAuth));
					}
				}

				if (!model && pick) {
					model = pick;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = settings.get("enabledModels");
				modelFallbackMessage =
					patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
						: "No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
			}
		}

		if (model) {
			const selectedModel = model;
			const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
				modelRegistry.refreshSelectedModelMetadata(selectedModel),
			);
			if (refreshedModel !== selectedModel) {
				model = refreshedModel;
				thinkingLevel = pickInitialThinkingLevel(refreshedModel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
				);
			}
		}

		if (model) {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () =>
					deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
				);
			}
		}

		const customCommandsResult: CustomCommandsLoadResult =
			options.disableExtensionDiscovery || restrictToolNames
				? { commands: [], errors: [] }
				: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery && !restrictToolNames) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			settings,
			localProtocolOptions,
			() => (hasSession ? session.getAsyncJobSnapshot() : null),
		);

		credentialDisabledTarget = extensionRunner;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			void extensionRunner.emitCredentialDisabled(event);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort({ reason: USER_INTERRUPT_LABEL });
			},
			settings,
			localProtocolOptions,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);
		toolSession.getToolContext = () => toolContextStore.getContext();
		const setSessionActiveToolNames = (names: Iterable<string>): void => {
			const snapshot = Array.from(names);
			setActiveToolNames(snapshot);
			toolContextStore.setToolNames(snapshot);
		};

		const nativeToolsByName = new Map<string, Tool>(toolSession.xdev?.tools ?? undefined);

		const registeredTools = restrictToolNames ? [] : extensionRunner.getAllRegisteredTools();
		const initialRegisteredTools = new WeakSet(registeredTools);
		const sdkCustomTools =
			restrictToolNames && options.allowRestrictedCustomTools !== true
				? []
				: (options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? []);
		const sdkCustomToolNames = new Set(sdkCustomTools.map(tool => tool.name));
		const allCustomTools = [
			...registeredTools,
			...sdkCustomTools.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>" };
			}),
		];

		const wrappedExtensionTools: Tool[] = deduplicateMCPToolsByName(
			wrapRegisteredTools(allCustomTools, extensionRunner).map(wrapToolWithMetaNotice),
		);
		const initialMcpManagerToolNames = new Set<string>();
		for (const tool of wrappedExtensionTools) {
			const originKey = getMCPToolOriginKey(tool);
			const matchesManagerOrigin =
				originKey !== undefined &&
				initialMcpManagerTools.some(
					managerTool => managerTool.name === tool.name && getMCPToolOriginKey(managerTool) === originKey,
				);
			if (matchesManagerOrigin) initialMcpManagerToolNames.add(tool.name);
		}

		const builtInRegistryToolNames = toolSession.xdev?.builtInNames ?? new Set(toolRegistry.keys());

		for (const [name, tool] of toolRegistry) {
			nativeToolsByName.set(name, tool);
		}
		if (!restrictToolNames && !toolRegistry.has("goal") && settings.get("goal.enabled")) {
			const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
			if (goalTool) {
				const wrapped = wrapToolWithMetaNotice(goalTool);
				toolRegistry.set(goalTool.name, wrapped);
				builtInRegistryToolNames.add(goalTool.name);
				nativeToolsByName.set(goalTool.name, wrapped);
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.delete(tool.name);
		}

		extensionRunner.setNativeToolResolver(name => {
			const tool = nativeToolsByName.get(name);
			return tool ? { tool, makeContext: () => toolContextStore.getContext() } : undefined;
		});
		if (deferMCPDiscoveryForUI && mcpManager) {
			for (const name of collectPendingMCPToolNames(options.toolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
					initialMcpManagerToolNames.add(name);
				}
			}
		}

		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}

		const editWasGranted = toolRegistry.has("edit");

		let cursorBridgeEditTool: AgentTool | undefined;
		const getCursorBridgeEditTool = (): AgentTool | undefined => {
			if (!editWasGranted) return undefined;
			cursorBridgeEditTool ??= createBridgeEditTool(toolSession, extensionRunner);
			return cursorBridgeEditTool;
		};

		const cursorCanMutateFiles = editWasGranted || toolRegistry.has("write");

		const ensureWriteRegistered = (): Promise<boolean> => {
			if ("write" in DISABLED_TOOL_NAMES) return Promise.resolve(false);
			return Promise.resolve(toolRegistry.has("write") && builtInRegistryToolNames.has("write"));
		};

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;

		const resolveDeviceTool = (name: string): AgentTool | undefined => {
			const state = toolSession.xdev;
			if (!state) return undefined;
			return resolveMountedXdevExecutable(state, name);
		};

		const cursorMcpResources: CursorMcpResourceAdapter | undefined = mcpManager && {
			serverNames: () => mcpManager.getConnectedServers(),
			getServerResources: async name => {
				await mcpManager.ensureServerResources(name);
				return mcpManager.getServerResources(name);
			},
			readServerResource: (name, uri) => mcpManager.readServerResource(name, uri),
		};
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,

			getCwd: () => sessionManager.getCwd(),
			tools: toolRegistry,
			getExecutableTool: resolveDeviceTool,

			getEditReplaceTool: getCursorBridgeEditTool,
			getToolContext: () => toolContextStore.getContext(),
			mcpResources: cursorMcpResources,
			emitEvent: event => cursorEventEmitter?.(event),
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			persistTodoPhases: phases => sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),

			allowDirectFileMutation: cursorCanMutateFiles,
		});

		const inlineToolDescriptors = shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), model?.id);
		const intentField = $flag("PI_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
		const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			rebuildOptions?: { directToolNames?: readonly string[] },
		): Promise<BuildSystemPromptResult> => {
			const promptCwd = sessionManager.getCwd();
			const activeRepoContext = hasSession
				? await logger.time("resolveActiveRepoContext", resolveRepoContext, promptCwd)
				: initialActiveRepoContext;
			if (hasSession && options.contextFiles === undefined) {
				contextFiles = await logger.time("discoverContextFiles", discoverContextFiles, promptCwd, agentDir, [
					...(settings.get("disabledExtensions") ?? []),
				]);
				toolSession.contextFiles = contextFiles;
				session.setAdvisorContextPrompt(formatAdvisorContextPrompt(contextFiles));
			}

			const serverInstructions = mcpManager?.getServerInstructions();

			const autoLearnInstructions = restrictToolNames
				? undefined
				: buildAutoLearnInstructions({ manageSkill: builtInToolNames.includes("manage_skill") });
			const appendParts: string[] = [];
			if (autoLearnInstructions) appendParts.push(autoLearnInstructions);
			const projection = projectMountedMCPXdevGuidance(
				collectMountedMCPToolRoutes(toolSession.xdev ? listXdevTools(toolSession.xdev) : []),
			);
			if (projection.mappings.length > 0 || projection.hasOmittedMappings) {
				appendParts.push(
					prompt
						.render(mcpXdevGuidanceTemplate, {
							tools: projection.mappings.map(mapping => ({
								mcpToolName: mapping.label,
								path: mapping.path,
							})),
							hasOmittedTools: projection.hasOmittedMappings,
						})
						.trim(),
				);
			}
			if (serverInstructions && serverInstructions.size > 0) {
				appendParts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					appendParts.push(`### ${srvName}\n${truncated}`);
				}
			}
			let appendPrompt: string | undefined = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

			const nativeTools = resolveDialect(settings.get("tools.format"), agent?.state.model ?? model) === undefined;
			const promptTools = projectSystemPromptToolMetadata(
				tools,
				nativeTools && !inlineToolDescriptors ? { mode: "compact", toolNames } : { mode: "full" },
			);
			if (options.appendSystemPrompt) {
				appendPrompt = appendPrompt
					? `${appendPrompt}\n\n${options.appendSystemPrompt}`
					: options.appendSystemPrompt;
			}
			const defaultPrompt = await buildSystemPromptInternal({
				cwd: promptCwd,
				additionalWorkspaceRoots: sessionManager.getAdditionalDirectories(),
				xdevTools: toolSession.xdev ? xdevEntries(toolSession.xdev) : [],
				xdevDocs: toolSession.xdev
					? xdevDocsAll(toolSession.xdev, settings.get("tools.xdevDocs"), settings.get("tools.xdevInlineDevices"))
					: "",
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: session?.skills ?? skills,
				contextFiles,
				tools: promptTools,
				toolNames,
				directToolNames: rebuildOptions?.directToolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				inlineToolDescriptors,
				nativeTools,
				intentField,
				orchestratorMaxConcurrency: settings.get("orchestrator.maxConcurrency"),
				scoutAvailable: isScoutSpawnable(
					settings.get("orchestrator.disabledAgents") as string[] | undefined,
					options.spawns ?? "*",
				),
				fleetEnabled: !restrictToolNames && isIrcEnabled(settings, options.taskDepth ?? 0),
				autoQaEnabled: !restrictToolNames && isAutoQaEnabled(settings),
				secretsEnabled,
				workspaceTree: workspaceTreePromise,
				includeWorkspaceTree,
				model: getActiveModelString(),
				includeModelInPrompt: settings.get("includeModelInPrompt"),
				personality: agentKind === "sub" ? "none" : settings.get("personality"),
				renderMermaid: settings.get("tui.renderMermaid"),
				activeRepoContext,
			});

			if (options.systemPrompt === undefined) {
				return defaultPrompt;
			}
			const customPrompt =
				typeof options.systemPrompt === "function"
					? options.systemPrompt(defaultPrompt.systemPrompt)
					: options.systemPrompt;
			return {
				systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			};
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys()).filter(name => !(name in DISABLED_TOOL_NAMES));
		const explicitlyRequestedToolNames = effectiveToolNames ? normalizeToolNames(effectiveToolNames) : undefined;

		if (
			options.requireYieldTool === true &&
			explicitlyRequestedToolNames &&
			!explicitlyRequestedToolNames.includes("yield")
		) {
			explicitlyRequestedToolNames.push("yield");
		}

		if (!restrictToolNames && explicitlyRequestedToolNames) {
			for (const name of ["manage_skill", "learn"]) {
				if (builtInToolNames.includes(name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}

		if (explicitlyRequestedToolNames) {
			if (builtInToolNames.includes("checkpoint") && !explicitlyRequestedToolNames.includes("rewind")) {
				explicitlyRequestedToolNames.push("rewind");
			} else if (builtInToolNames.includes("rewind") && !explicitlyRequestedToolNames.includes("checkpoint")) {
				explicitlyRequestedToolNames.push("checkpoint");
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const defaultInactiveToolNames = new Set(
			toolNamesFromRegistry.filter(name => {
				const tool = toolRegistry.get(name);
				return tool?.defaultInactive === true || tool?.hidden === true;
			}),
		);
		const requestedActiveToolNames = normalizedRequested.filter(name => name !== "goal");
		const explicitlyRequestedToolNameSet = explicitlyRequestedToolNames
			? new Set(explicitlyRequestedToolNames)
			: undefined;
		const xdevReadAvailable =
			builtInRegistryToolNames.has("read") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("read"));
		const xdevWriteAvailable =
			builtInRegistryToolNames.has("write") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("write"));
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		let initialToolNames = [...initialRequestedActiveToolNames];

		const alwaysInclude: string[] = restrictToolNames
			? []
			: [...sdkCustomTools.map(t => t.name), ...registeredTools.map(t => t.definition.name)].filter(
					name => !defaultInactiveToolNames.has(name),
				);
		for (const name of alwaysInclude) {
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		const registrationInput = {
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running" as const,
		};
		registeredAgentRef =
			options.expectedAgentRef === undefined
				? agentRegistry.register(registrationInput)
				: agentRegistry.registerIfAvailable(registrationInput, options.expectedAgentRef);
		if (!registeredAgentRef && options.expectedAgentRef === null) {
			const stale = agentRegistry.get(resolvedAgentId);
			const lifecycle = AgentLifecycleManager.global();
			if (stale && lifecycle.manages(agentRegistry) && (await lifecycle.reclaimDeadCorpse(resolvedAgentId, stale))) {
				registeredAgentRef = agentRegistry.registerIfAvailable(registrationInput, null);
			}
		}
		if (!registeredAgentRef) {
			throw new Error(`Agent "${resolvedAgentId}" is already owned by another session generation.`);
		}

		hasRegistered = options.expectedAgentRef === undefined || options.expectedAgentRef === null;

		if (toolSession.xdev) {
			const topLevelToolNames: string[] = [];
			const mountedNames: string[] = [];
			for (const name of initialToolNames) {
				const tool = toolRegistry.get(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				if (tool && xdevReadAvailable && xdevWriteAvailable && !explicitlyRequested && isMountableUnderXdev(tool))
					mountedNames.push(name);
				else topLevelToolNames.push(name);
			}
			toolSession.xdev.mountedNames.clear();
			for (const name of mountedNames) toolSession.xdev.mountedNames.add(name);
			initialToolNames = topLevelToolNames;
			if (mountedNames.length > 0 && !initialToolNames.includes("write")) initialToolNames.push("write");
		}

		setSessionActiveToolNames(initialToolNames);
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (settings.get("images.blockImages")) {
				return replaceLlmImagesWithText(converted, "Image reading is disabled.");
			}
			const activeModel = agent?.state.model ?? model;
			if (activeModel && !activeModel.input.includes("image")) {
				return replaceLlmImagesWithText(
					converted,
					"[image omitted: the active model does not support image input]",
				);
			}
			return converted;
		};

		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = filterProviderReplayMessages(convertToLlmWithBlockImages(messages));
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};

		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages);
			return wrapSteeringForModel(withContext);
		};

		const blobBroker = createImageUrlServiceFromSettings(settings, sessionManager.getCwd(), model =>
			modelRegistry.getApiKey(model, providerSessionId),
		);
		blobBroker?.prewarm();
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
			transformed = clampProviderContextImages(transformed, transformModel);
			transformed = await normalizeProviderContextImagesForModel(transformed, transformModel);
			if (blobBroker) transformed = await blobBroker.decorateContext(transformed, transformModel);

			return withDateCwdReminder(
				transformed,
				formatLocalCalendarDate(),
				normalizePromptPath(sessionManager.getCwd()),
			);
		};
		const onPayload = async (payload: unknown, model?: Model) => {
			return await extensionRunner.emitBeforeProviderRequest(payload, model);
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);
		const autoLearnCaptureTools = initialTools.filter(tool => tool.name === "manage_skill" || tool.name === "learn");

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const configuredServiceTierByFamily = hasServiceTierEntry
			? (existingSession.serviceTier ?? {})
			: buildServiceTierByFamily(
					settings.get("tier.openai"),
					settings.get("tier.anthropic"),
					settings.get("tier.google"),
				);
		const initialServiceTierByFamily = { ...configuredServiceTierByFamily };
		if (options.openAIServiceTier === null) {
			delete initialServiceTierByFamily.openai;
		} else if (options.openAIServiceTier !== undefined) {
			initialServiceTierByFamily.openai = options.openAIServiceTier;
		}

		let notifyFirstChatDispatch = options.onFirstChatDispatch;

		const settingsAwareStreamFn = wrapStreamFnWithBlobUrlFallback(
			wrapStreamFnWithProviderConcurrency(settings, createSettingsAwareStreamFn(settings)),
			blobBroker,
		);
		const codeModeState: { namespacesInfo?: unknown } = {};
		const transformToolCallArguments = (args: Record<string, unknown>): Record<string, unknown> => {
			let result = args;
			const maxTimeout = settings.get("tools.maxTimeout");
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = deobfuscateToolArguments(obfuscator, result);
			}
			return result;
		};
		const kimiApiFormatSetting = settings.get("providers.kimiApiFormat");
		const kimiApiFormat = kimiApiFormatSetting === "auto" ? undefined : kimiApiFormatSetting;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,

			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			hideThinkingSummary: settings.get("omitThinking"),
			kimiApiFormat,
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: options.getApiKey ?? (requestModel => modelRegistry.resolver(requestModel, agent.sessionId)),
			streamFn: (streamModel, context, streamOptions) => {
				if (notifyFirstChatDispatch) {
					const cb = notifyFirstChatDispatch;
					notifyFirstChatDispatch = undefined;
					try {
						cb();
					} catch (err) {
						logger.warn("onFirstChatDispatch hook threw", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				const externalThinking =
					settings.get("externalThinking") &&
					agent.state.tools.some(tool => tool.name === "think") &&
					supportsExternalThinking(streamModel);
				return settingsAwareStreamFn(streamModel, context, {
					...streamOptions,
					anthropicCacheRefresh: true,
					forceReasoningOff: externalThinking || streamOptions?.forceReasoningOff,
					...(codeModeState.namespacesInfo === undefined
						? {}
						: { toolNamespacesInfo: codeModeState.namespacesInfo }),
				});
			},
			cursorExecHandlers,
			getCursorTools: () => (toolSession.xdev ? listXdevTools(toolSession.xdev) : []),
			transformToolCallArguments,
			resolveFallbackTool: resolveDeviceTool,
			intentTracing: !!intentField,
			dialect: resolveDialect(settings.get("tools.format"), model),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => session?.nextToolChoiceDirective(),
			onToolChoiceUnavailable: () => session?.toolChoiceQueue.reject("unavailable"),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
			if (options.openAIServiceTier !== undefined) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		} else {
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			sessionManager.appendThinkingLevelChange(effectiveThinkingLevel);
			if (options.openAIServiceTier !== undefined || Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		}

		const advisorToolSession: ToolSession = {
			...toolSession,
			get cwd() {
				return sessionManager.getCwd();
			},
			hasEditTool: true,
			requireYieldTool: false,
			getSessionId: () => {
				const id = sessionManager.getSessionId?.();
				return id ? `${id}-advisor` : null;
			},
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			getAgentId: () => "advisor",

			xdev: undefined,
			isToolActive: name => name !== "inspect_media" && toolSession.isToolActive?.(name) === true,
		};
		const advisorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
		for (const name in BUILTIN_TOOLS) {
			advisorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession));
		}
		const built = await Promise.all(advisorToolBuilds);

		const advisorTools: Tool[] = built
			.filter((tool): tool is Tool => tool != null)
			.map(tool => new ExtensionToolWrapper(wrapToolWithMetaNotice(tool), extensionRunner) as Tool);

		// Deferred on purpose: the conductor's isolated ToolSession and tool pool are built the first time a
		// completion claim actually needs verifying, so a session with `conductor.enabled` off pays nothing.
		let conductorToolsPromise: Promise<Tool[]> | undefined;
		const buildConductorTools = (): Promise<Tool[]> => {
			conductorToolsPromise ??= (async () => {
				const conductorToolSession: ToolSession = {
					...toolSession,
					get cwd() {
						return sessionManager.getCwd();
					},
					hasEditTool: true,
					requireYieldTool: false,
					getSessionId: () => {
						const id = sessionManager.getSessionId?.();
						return id ? `${id}-conductor` : null;
					},
					queueLaunchCompletion: notification =>
						session?.queueLaunchCompletion(notification) ??
						Promise.reject(new Error("Session unavailable for launch completion delivery")),
					getAgentId: () => "conductor",

					xdev: undefined,
					isToolActive: name => name !== "inspect_media" && toolSession.isToolActive?.(name) === true,
				};
				const conductorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
				for (const name in BUILTIN_TOOLS) {
					conductorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](conductorToolSession));
				}
				const conductorBuilt = await Promise.all(conductorToolBuilds);
				return conductorBuilt
					.filter((tool): tool is Tool => tool != null)
					.map(tool => new ExtensionToolWrapper(wrapToolWithMetaNotice(tool), extensionRunner) as Tool);
			})();
			return conductorToolsPromise;
		};

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (initialActiveRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(initialActiveRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;

		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);

		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;

		const initialAdvisorCosts = await loadAdvisorTranscriptCosts(sessionManager.getSessionFile());
		session = new AgentSession({
			codeModeState,
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorConfigs: discoveredAdvisors.advisors,
			conductorToolsFactory: buildConductorTools,
			agent,
			thinkingLevel: effectiveThinkingLevel,
			thinkingLevelCeiling: options.thinkingLevelCeiling,
			initialRetryFallback,
			prewalk: options.prewalk,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			initialAdvisorCosts,
			settings,
			scoutAllowedBySpawnPolicy: isScoutSpawnable(undefined, options.spawns ?? "*"),
			evalKernelOwnerId,

			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsReloadable: options.skills === undefined,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			toolRegistry,
			createComputerTool: restrictToolNames
				? undefined
				: async () => (await BUILTIN_TOOLS.computer(toolSession)) ?? null,
			createThinkTool: async () => (await HIDDEN_TOOLS.think(toolSession)) ?? null,
			createInspectMediaTool: restrictToolNames
				? undefined
				: async () => (await BUILTIN_TOOLS.inspect_media(toolSession)) ?? null,
			builtInToolNames: builtInRegistryToolNames,
			mcpManagerToolNames: initialMcpManagerToolNames,
			transformContext,
			transformProviderContext,
			onPayload,
			onResponse,
			sideStreamFn: settingsAwareStreamFn,
			advisorStreamFn: settingsAwareStreamFn,
			preferWebsockets: preferOpenAICodexWebsockets,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			getXdevToolEntries: () => (toolSession.xdev ? xdevEntries(toolSession.xdev) : []),
			xdev: toolSession.xdev,
			presentationPinnedToolNames: explicitlyRequestedToolNameSet,
			requiredToolNames: !restrictToolNames && agentKind === "main" ? new Set(ORCHESTRATE_TOOL_NAMES) : undefined,
			setActiveToolNames: setSessionActiveToolNames,
			ensureWriteRegistered,
			getMcpServerInstructions: mcpManager
				? () => {
						const raw = mcpManager.getServerInstructions();
						if (!raw || raw.size === 0) return raw;
						const out = new Map<string, string>();
						for (const [name, text] of raw) {
							out.set(
								name,
								text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
							);
						}
						return out;
					}
				: undefined,
			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentKind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource,
			parentEvalSessionId: options.parentEvalSessionId,
			advisorTools,

			advisorCreateEditTool: () => createBridgeEditTool(advisorToolSession, extensionRunner),

			advisorGetToolContext: () => toolContextStore.getContext(),

			advisorMcpResources: cursorMcpResources,
			titleSystemPrompt: options.titleSystemPrompt,
		});
		hasSession = true;
		if (agentKind === "main") {
			const orchestratorParent = (): OrchestratorParent => ({
				cwd: sessionManager.getCwd(),
				getAgentId: () => resolvedAgentId,
				getSessionId: () => sessionManager.getSessionId(),
				getSessionFile: () => sessionManager.getSessionFile() ?? null,
				sessionManager,
				asyncJobManager: scopedAsyncJobManager,
				settings,
				getActiveModelString,
			});
			session.setSessionBeforeSwitchReconciler(async () => {
				const runtime = OrchestratorRuntime.global();
				const parent = orchestratorParent();
				await runtime.suspendScope(runtime.ownerScope(parent), scopedAsyncJobManager);
			});
			session.setSessionSwitchReconciler(async () => {
				await OrchestratorRuntime.global().rehydrate(orchestratorParent());
			});
		}

		const scheduledToolRegistrations = new WeakMap<RegisteredTool, Promise<void>>();
		const scheduleToolRegistration = (registered: RegisteredTool, signal?: AbortSignal): Promise<void> => {
			const scheduled = scheduledToolRegistrations.get(registered);
			if (scheduled) return scheduled;
			const activationSignal = signal ?? AbortSignal.timeout(EXTENSION_HANDLER_TIMEOUT_MS);

			const [wrapped] = wrapRegisteredTools([registered], extensionRunner);
			if (!wrapped) return Promise.resolve();
			const name = registered.definition.name;
			const liveTool = new ExtensionToolWrapper(wrapToolWithMetaNotice(wrapped), extensionRunner);

			const isEffectiveRegistrant = extensionRunner.getRegisteredTool(name) === registered;
			const activation = session.runToolRegistryMutation(async () => {
				activationSignal.throwIfAborted();
				const existingTool = toolRegistry.get(name);
				const previousExtensionMcpTool = session.getExtensionMCPTool(name);
				const wasMcpManagerTool = session.hasMCPManagerTool(name);
				if (existingTool) {
					if (session.hasRpcHostTool(name) || sdkCustomToolNames.has(name)) return;

					const competingTools = deduplicateMCPToolsByName([liveTool, existingTool]);
					if (competingTools.length === 1) {
						if (competingTools[0] !== liveTool) return;
					} else if (!isEffectiveRegistrant) {
						return;
					}
				} else if (!isEffectiveRegistrant) {
					return;
				}

				const enabled = session.getEnabledToolNames();
				const alreadyEnabled = enabled.includes(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				const mounted = session.getMountedXdevToolNames();
				const wasBuiltIn = builtInRegistryToolNames.has(name);
				toolRegistry.set(name, liveTool);
				builtInRegistryToolNames.delete(name);
				session.setToolBuiltIn(name, false);
				session.setExtensionMCPTool(name, liveTool);
				try {
					if ((registered.definition.defaultInactive || registered.definition.hidden) && !explicitlyRequested) {
						if (!alreadyEnabled) return;
						await session.setActiveToolPresentation(
							enabled.filter(enabledName => enabledName !== name),
							mounted.filter(mountedName => mountedName !== name),
							existingTool !== undefined,
							activationSignal,
						);
						return;
					}

					if (existingTool && !alreadyEnabled) return;
					const shouldMount =
						!explicitlyRequested &&
						toolSession.xdev !== undefined &&
						builtInRegistryToolNames.has("read") &&
						builtInRegistryToolNames.has("write") &&
						enabled.includes("read") &&
						enabled.includes("write") &&
						isMountableUnderXdev(liveTool);
					const nextMounted = shouldMount
						? mounted.includes(name)
							? mounted
							: [...mounted, name]
						: mounted.filter(mountedName => mountedName !== name);
					await session.setActiveToolPresentation(
						alreadyEnabled ? enabled : [...enabled, name],
						nextMounted,
						existingTool !== undefined,
						activationSignal,
					);
				} catch (error) {
					if (existingTool) {
						toolRegistry.set(name, existingTool);
					} else {
						toolRegistry.delete(name);
					}
					if (wasBuiltIn) builtInRegistryToolNames.add(name);
					session.setToolBuiltIn(name, wasBuiltIn);
					session.setExtensionMCPTool(name, previousExtensionMcpTool);
					session.setMCPManagerTool(name, wasMcpManagerTool);
					throw error;
				}
			}, activationSignal);
			scheduledToolRegistrations.set(registered, activation);
			return activation;
		};
		if (!restrictToolNames) {
			const unsubscribeToolRegistrations = extensionRunner.onToolRegistered(scheduleToolRegistration);
			disposeCallbacks.add(unsubscribeToolRegistrations);

			for (const registered of extensionRunner.getAllRegisteredTools()) {
				if (!initialRegisteredTools.has(registered)) {
					await scheduleToolRegistration(registered);
				}
			}
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		if (
			!registeredAgentRef ||
			!agentRegistry.attachSession(
				resolvedAgentId,
				session,
				sessionManager.getSessionFile() ?? null,
				registeredAgentRef,
			) ||
			!agentRegistry.setStatus(resolvedAgentId, "running", registeredAgentRef)
		) {
			throw new Error(`Agent "${resolvedAgentId}" was replaced during session initialization.`);
		}
		hasRegistered = true;
		if (agentKind === "main") {
			await OrchestratorRuntime.global().rehydrate({
				cwd: sessionManager.getCwd(),
				getAgentId: () => resolvedAgentId,
				getSessionId: () => sessionManager.getSessionId(),
				getSessionFile: () => sessionManager.getSessionFile() ?? null,
				sessionManager,
				asyncJobManager: scopedAsyncJobManager,
				settings,
				getActiveModelString,
			});
		}

		let unsubscribeMcpNotifications: (() => void) | undefined;
		let unregisterMcpPostmortem: (() => void) | undefined;

		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					session.beginDispose();
					if (agentKind === "main") {
						const orchestrator = OrchestratorRuntime.global();
						const parentSession = {
							getAgentId: () => resolvedAgentId,
							getSessionId: () => sessionManager.getSessionId(),
							getSessionFile: () => sessionManager.getSessionFile() ?? null,
							sessionManager,
							asyncJobManager: scopedAsyncJobManager,
							settings,
							getActiveModelString,
						};
						await orchestrator.suspendScope(orchestrator.ownerScope(parentSession), scopedAsyncJobManager);
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose();
				} finally {
					unregisterUnlessParked();
					unsubscribeCredentialDisabled?.();
					unsubscribeMcpNotifications?.();
					unregisterMcpPostmortem?.();
					for (const callback of disposeCallbacks) callback();
					disposeCallbacks.clear();

					unsubscribeMcpNotifications = undefined;
					unregisterMcpPostmortem = undefined;
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			const codexModel = model as Model<"openai-codex-responses">;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = options.getApiKey
							? await resolveApiKeyOnce(await options.getApiKey(codexModel))
							: await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		const runAutoLearnCapture = createAutoLearnCaptureRunner({
			sourceAgent: agent,
			captureTools: autoLearnCaptureTools,
			onPayload,
			onResponse,
			createAgent: captureOptions => {
				const captureModel = captureOptions.initialState?.model;
				const captureSessionId = captureOptions.sessionId;
				if (!captureModel || !captureSessionId) throw new Error("Auto-learn capture identity is incomplete");
				return new Agent({
					...captureOptions,
					cwd: sessionManager.getCwd(),
					cwdResolver: () => sessionManager.getCwd(),
					convertToLlm: convertToLlmFinal,
					transformContext: async messages => wrapSteeringForModel(messages),
					transformProviderContext: async (context, transformModel) => {
						let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
						transformed = clampProviderContextImages(transformed, transformModel);
						transformed = await normalizeProviderContextImagesForModel(transformed, transformModel);
						if (blobBroker) transformed = await blobBroker.decorateContext(transformed, transformModel);
						return withDateCwdReminder(
							transformed,
							formatLocalCalendarDate(),
							normalizePromptPath(sessionManager.getCwd()),
						);
					},
					thinkingBudgets: agent.thinkingBudgets,
					temperature: agent.temperature,
					topP: agent.topP,
					topK: agent.topK,
					minP: agent.minP,
					presencePenalty: agent.presencePenalty,
					repetitionPenalty: agent.repetitionPenalty,
					serviceTierResolver: agent.serviceTierResolver,
					hideThinkingSummary: agent.hideThinkingSummary,
					maxRetryDelayMs: agent.maxRetryDelayMs,
					kimiApiFormat,
					preferWebsockets: preferOpenAICodexWebsockets,
					getToolContext: toolCall => toolContextStore.getContext(toolCall),
					streamFn: settingsAwareStreamFn,
					transformToolCallArguments,
					resolveFallbackTool: resolveDeviceTool,
					intentTracing: !!intentField,
					dialect: resolveDialect(settings.get("tools.format"), captureModel),
					abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
					appendOnlyContext: shouldEnableAppendOnlyContext(
						settings.get("provider.appendOnlyContext"),
						captureModel,
					)
						? new AppendOnlyContextManager()
						: undefined,
				});
			},
		});

		if (!restrictToolNames && settings.get("autolearn.enabled") && taskDepth === 0) {
			new AutoLearnController({
				session,
				settings,
				capture: content => session.runAutolearnCapture(signal => runAutoLearnCapture(content, signal)),
			});
		}

		if (mcpManager && !options.mcpManager) {
			mcpManager.setOnToolsChanged(async tools => {
				try {
					await session.refreshMCPTools(tools);
				} catch (error) {
					logger.warn("MCP tool refresh failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});

			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);

						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		if (mcpManager) {
			unsubscribeMcpNotifications = mcpManager.addNotificationListener((server, method, params) => {
				void extensionRunner.emitMcpNotification({ server, method, params });
			});

			unregisterMcpPostmortem = postmortem.register("mcp-notification-listener-cleanup", () =>
				unsubscribeMcpNotifications?.(),
			);
		}

		startDeferredMCPDiscovery?.(session);

		try {
			await session.initializeCodeMode();
		} catch (error) {
			logger.warn("Code Mode initialization at session startup failed", { error: String(error) });
		}

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			eventBus,
		};
	} catch (error) {
		unsubscribeCredentialDisabled?.();
		try {
			if (hasSession) {
				await session.dispose();
				if (hasRegistered) unregisterUnlessParked();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				await releaseComputerSessionsForOwner(evalKernelOwnerId);
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeVmContextsByOwner(evalKernelOwnerId);
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}

function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {}
}
