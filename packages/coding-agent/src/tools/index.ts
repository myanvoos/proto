import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { AgentOptions, AgentTelemetryConfig, AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async/job-manager";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import { GoalTool } from "../goals/tools/goal-tool";
import type { LocalProtocolOptions } from "../internal-urls";
import type { DaemonCompletionNotification } from "../launch/protocol";
import { LspTool } from "../lsp";
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
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { canSpawnAtDepth, type StructuredSubagentSchemaMode } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import { type InspectImageMode, isInspectImageToolActive } from "../utils/inspect-image-mode";
import { WebSearchTool } from "../web/search";
import type { WorkspaceTree } from "../workspace-tree";
import { AskTool } from "./ask";
import { BrowserTool } from "./browser";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames } from "./builtin-names";
import { type CheckpointState, CheckpointTool, type CompletedRewindState, RewindTool } from "./checkpoint";
import { ComputerTool } from "./computer";
import { resolveEvalBackends } from "./eval-backends";
import { FleetTool, isIrcEnabled } from "./fleet";
import { GithubTool } from "./gh";
import { InspectImageTool } from "./inspect-image";
import { KernelTool } from "./kernel";
import { ManageSkillTool } from "./manage-skill";
import {
	OrchestrateKillTool,
	OrchestrateListTool,
	OrchestrateSendTool,
	OrchestrateSpawnTool,
	OrchestrateWaitTool,
} from "./orchestrate";
import { wrapToolWithMetaNotice } from "./output-meta";
import { ReadTool } from "./read";
import { supportsExternalThinking, ThinkTool } from "./think";
import { type TodoPhase, TodoTool } from "./todo";
import { isMountableUnderXdev, type XdevState } from "./xdev";
import { YieldTool } from "./yield";

export * from "../edit";
export * from "../goals";
export * from "../lsp";
export * from "../session/streaming-output";
export * from "../task";
export * from "../web/search";
export * from "./ask";
export * from "./bash";
export * from "./browser";
export * from "./checkpoint";
export * from "./computer";
export * from "./computer/supervisor";
export * from "./essential-tools";
export * from "./eval";
export * from "./eval-backends";
export * from "./file-write-fallback";
export * from "./fleet";
export * from "./gh";
export * from "./image-gen";
export * from "./inspect-image";
export * from "./kernel";
export * from "./manage-skill";
export * from "./orchestrate";
export * from "./read";
export * from "./report-tool-issue";
export * from "./resolve";
export * from "./think";
export * from "./todo";
export * from "./write";
export * from "./xdev";
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

export interface DeferredDiagnosticsEntry {
	path: string;

	summary: string;

	messages: string[];

	errored: boolean;

	isStale(): boolean;
}

export interface ToolSession {
	cwd: string;

	additionalDirectories?: string[];

	hasUI: boolean;

	canPromptUser?: boolean;

	isDisposed?: () => boolean;

	fetch?: FetchImpl;

	getApiKey?: AgentOptions["getApiKey"];

	skipPythonPreflight?: boolean;

	contextFiles?: ContextFileEntry[];

	workspaceTree?: WorkspaceTree;

	skills?: readonly Skill[];

	refreshSkills?: () => Promise<void>;

	promptTemplates?: PromptTemplate[];

	rules?: Rule[];

	extensionPaths?: string[];

	customToolPaths?: ToolPathWithSource[];

	enableLsp?: boolean;

	lspReadOnly?: boolean;

	enableIrc?: boolean;

	enableMCP?: boolean;

	hasEditTool?: boolean;

	eventBus?: EventBus;

	outputSchema?: unknown;

	outputSchemaMode?: StructuredSubagentSchemaMode;

	requireYieldTool?: boolean;

	prewalkArmed?: boolean;

	restrictToolNames?: boolean;

	taskDepth?: number;

	getEvalSessionId?: () => string | null;

	getSessionFile: () => string | null;

	sessionManager?: Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "flush" | "getBranch" | "getEntries">;

	getEvalKernelOwnerId?: () => string | null;

	assertEvalExecutionAllowed?: () => void;

	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;

	getSessionId?: () => string | null;

	getAgentId?: () => string | null;

	getToolByName?: (name: string) => AgentTool | undefined;

	getToolForEvalBridge?: (name: string) => AgentTool | undefined;

	getToolContext?: () => AgentToolContext | undefined;

	getEvalBridgeToolNames?: () => readonly string[];

	getCodeModeDirectToolNames?: () => readonly string[] | undefined;

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

	getInspectImageModeOverride?: () => InspectImageMode | undefined;

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

	getTodoPhases?: () => TodoPhase[];

	setTodoPhases?: (phases: TodoPhase[]) => void;

	getToolChoiceQueue?(): ToolChoiceQueue;

	buildToolChoice?(toolName: string): ToolChoice | undefined;

	steer?(message: { customType: string; content: string; details?: unknown }): void;

	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;

	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;

	clearPendingInvokers?(): void;

	getCheckpointState?: () => CheckpointState | undefined;

	setCheckpointState?: (state: CheckpointState | null) => void;

	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	fileSnapshotStore?: InMemorySnapshotStore;

	conflictHistory?: import("./conflict-detect").ConflictHistory;

	diagnosticsLedger?: import("../lsp/diagnostics-ledger").DiagnosticsLedger;

	noopLoopGuard?: import("../edit/hashline/noop-loop-guard").NoopLoopGuard;

	queueDeferredMessage?(message: CustomMessage): void;

	queueLaunchCompletion?(notification: DaemonCompletionNotification): Promise<void>;

	registerDisposeCallback?(callback: () => void): (() => void) | void;

	registerSessionChangeCallback?(callback: () => void): (() => void) | void;

	queueDeferredDiagnostics?(entry: DeferredDiagnosticsEntry): void;

	bumpFileMutationVersion?(path: string): number;

	getFileMutationVersion?(path: string): number;

	getTelemetry?: () => AgentTelemetryConfig | undefined;

	getImageAttachments?: () => ImageAttachmentEntry[];
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const DISABLED_TOOL_NAMES: Record<string, true> = {
	read: true,
	edit: true,
	write: true,
	bash: true,
	eval: true,
};

export const BUILTIN_TOOLS: Record<
	Exclude<BuiltinToolName, "read" | "edit" | "write" | "bash" | "eval">,
	ToolFactory
> = {
	ask: AskTool.createIf,
	kernel: KernelTool.createIf,
	github: GithubTool.createIf,
	lsp: LspTool.createIf,
	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	computer: s => new ComputerTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	orchestrate_spawn: OrchestrateSpawnTool.create,
	orchestrate_send: s => new OrchestrateSendTool(s),
	orchestrate_wait: s => new OrchestrateWaitTool(s),
	orchestrate_kill: s => new OrchestrateKillTool(s),
	orchestrate_list: s => new OrchestrateListTool(s),
	fleet: s => new FleetTool(s),
	todo: s => new TodoTool(s),
	web_search: s => new WebSearchTool(s),
	manage_skill: ManageSkillTool.createIf,
};

export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	think: () => new ThinkTool(),
	yield: s => new YieldTool(s),
	goal: s => new GoalTool(s),
};

export type ToolName = BuiltinToolName;

export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const restrictToolNames = session.restrictToolNames === true;
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools = restrictToolNames
		? normalizeToolNames(toolNames ?? [])
		: toolNames && toolNames.length > 0
			? normalizeToolNames(toolNames)
			: undefined;
	const goalEnabled = session.settings.get("goal.enabled");
	const goalModeActive = !restrictToolNames && goalEnabled && session.getGoalModeState?.()?.enabled === true;
	const externalThinkingActive =
		session.settings.get("externalThinking") && supportsExternalThinking(session.getActiveModel?.());
	if (goalModeActive && requestedTools && !requestedTools.includes("goal")) {
		requestedTools.push("goal");
	}
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const skipEvalPreflight = session.skipPythonPreflight === true;

	let pythonAvailable = true;
	const kernelRequested = requestedTools === undefined || requestedTools.includes("kernel");
	if (!skipEvalPreflight && allowPython && kernelRequested) {
		const availability = await logger.time(
			"createTools:pythonCheck",
			checkPythonKernelAvailability,
			session.cwd,
			session.settings.get("python.interpreter")?.trim() || undefined,
		);
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable", { reason: availability.reason });
		}
	}

	const effectivePythonAllowed = allowPython && pythonAvailable;

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
		if (name === "goal") {
			if (!goalEnabled || restrictToolNames) return false;
			const goalState = session.getGoalModeState?.();
			return goalState === undefined || goalState.enabled === true || goalState.goal.status === "dropped";
		}
		if (name === "lsp") return enableLsp && session.settings.get("lsp.enabled");
		if (name === "kernel") return effectivePythonAllowed;
		if (name === "todo")
			return (!includeYield || session.prewalkArmed === true) && session.settings.get("todo.enabled");
		if (name === "github") return session.settings.get("github.enabled");
		if (name === "inspect_image") return isInspectImageToolActive(session);
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
		if (name === "fleet") {
			return (
				!restrictToolNames && session.enableIrc !== false && isIrcEnabled(session.settings, session.taskDepth ?? 0)
			);
		}
		if (name === "manage_skill")
			return (
				session.settings.get("autolearn.enabled") &&
				((session.taskDepth ?? 0) === 0 || requestedTools !== undefined)
			);
		if (name.startsWith("orchestrate_")) {
			const depth = session.taskDepth ?? 0;
			if (depth === 0) return true;
			return (
				resolveSpawnPolicy(session.getSessionSpawns()).enabled &&
				canSpawnAtDepth(session.settings.get("orchestrator.maxRecursionDepth") ?? 2, depth)
			);
		}
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
					...(goalModeActive ? ([["goal", HIDDEN_TOOLS.goal]] as const) : []),
				];

	const activeToolNames = new Set([...baseEntries.map(([name]) => name), "read"]);
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.time(`createTools:${name}`, factory as ToolFactory, session);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	let tools = baseResults.filter((r): r is Tool => r !== null);
	const toolRegistry = session.toolRegistry ?? new Map<string, Tool>();
	session.toolRegistry = toolRegistry;
	const builtInNames = new Set(tools.map(tool => tool.name));
	for (const tool of tools) toolRegistry.set(tool.name, tool);
	const readTool = await logger.time("createTools:read-bridge", (s: ToolSession) => new ReadTool(s), session);
	if (readTool) {
		const wrappedRead = wrapToolWithMetaNotice(readTool);
		toolRegistry.set(wrappedRead.name, wrappedRead);
		builtInNames.add(wrappedRead.name);
	}

	const xdevEnabled =
		!restrictToolNames && session.settings.get("tools.xdev") && tools.some(tool => tool.name === "write");
	const mountBuiltinTools = requestedTools === undefined;
	if (xdevEnabled) {
		const mountedNames = new Set<string>();
		const kept: Tool[] = [];
		for (const tool of tools) {
			const mountable = mountBuiltinTools && isMountableUnderXdev(tool) && tool.name in BUILTIN_TOOLS;
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
