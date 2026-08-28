import type {
	ApiKey,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	ImageContent,
	Message,
	Model,
	ServiceTier,
	SimpleStreamOptions,
	Static,
	streamSimple,
	TextContent,
	Tool,
	ToolCallProviderMetadata,
	ToolChoice,
	ToolResultMessage,
	ToolResultProviderMetadata,
	TSchema,
} from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import type { HarmonyAuditEvent } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import type { AppendOnlyContextManager } from "./append-only-context";
import type { AgentRunCoverage, AgentRunSummary } from "./run-collector";
import type { AgentTelemetryConfig } from "./telemetry";

export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export const ASIDE_MESSAGE_COMMIT = Symbol("aside-message-commit");

export const ASIDE_MESSAGE_DISCARD = Symbol("aside-message-discard");

export type CommittableAsideMessage = AgentMessage & {
	[ASIDE_MESSAGE_COMMIT]?: () => void;
	[ASIDE_MESSAGE_DISCARD]?: (error: Error) => void;
};

export type AsideMessage = CommittableAsideMessage | (() => CommittableAsideMessage | null);

export interface AgentTurnEndContext {
	message: AgentMessage;

	toolResults: ToolResultMessage[];

	willContinue: boolean;
}

export interface AgentPreModelCallStop {
	stop: true;

	reason?: string;
}

export type AgentPreModelCallResult = AgentPreModelCallStop | undefined;

export type AgentBeforeModelCall = (
	context: Context,
	signal?: AbortSignal,
) => AgentPreModelCallResult | void | Promise<AgentPreModelCallResult | void>;

export interface SoftToolRequirement {
	soft: true;

	id: string;

	toolName: string;

	satisfies?(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean;

	reminder: AgentMessage[];
}

export type ToolChoiceDirective = ToolChoice | SoftToolRequirement;

export interface SoftToolRequirementState {
	id?: string;
	forcedToolChoice?: ToolChoice;
	escalations: number;
}

export function isSoftToolRequirement(directive: ToolChoiceDirective | undefined): directive is SoftToolRequirement {
	return typeof directive === "object" && directive !== null && (directive as SoftToolRequirement).soft === true;
}

export type SteeringInterruptSource = "user" | "agent" | "system" | "unknown";

export interface SteeringQueueState {
	queued: boolean;

	source?: SteeringInterruptSource;
}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	interruptMode?: "immediate" | "wait";

	sessionId?: string;

	deadline?: number;

	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;

	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

	getSteeringMessages?: (signal?: AbortSignal) => Promise<AgentMessage[]>;

	hasSteeringMessages?: () => boolean | SteeringQueueState | Promise<boolean | SteeringQueueState>;

	waitForSteeringMessages?: (signal?: AbortSignal) => Promise<void>;

	hasIrcInterrupts?: () => boolean | Promise<boolean>;

	getFollowUpMessages?: (signal?: AbortSignal) => Promise<AgentMessage[]>;

	getAsideMessages?: () => Promise<AsideMessage[]>;

	onBeforeYield?: () => Promise<void> | void;

	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	syncContextBeforeModelCall?: (context: AgentContext, signal?: AbortSignal) => void | Promise<void>;

	beforeModelCall?: AgentBeforeModelCall;

	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;

	resolveFallbackTool?: (name: string) => AgentTool<any> | undefined;

	intentTracing?: boolean;

	pruneToolDescriptions?: boolean;

	dialect?: Dialect;

	abortOnFabricatedToolResult?: boolean;

	appendOnlyContext?: AppendOnlyContextManager;

	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;

	getToolChoice?: () => ToolChoiceDirective | undefined;

	softToolRequirementState?: SoftToolRequirementState;

	onToolChoiceRejected?: () => void;

	getReasoning?: () => Effort | undefined;

	getModel?: () => Model;

	getDisableReasoning?: () => boolean | undefined;

	getServiceTier?: (model: Model) => ServiceTier | undefined;

	getCwd?: () => string | undefined;

	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

	onTurnEnd?: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;

	transformAssistantMessage?: (message: AssistantMessage, signal?: AbortSignal) => Promise<void> | void;

	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;

	telemetry?: AgentTelemetryConfig;
}

export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;

	providerMetadata?: ToolCallProviderMetadata;

	steeringSignal?: AbortSignal;
}

export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	args?: Record<string, unknown>;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];

	details?: unknown;

	providerMetadata?: ToolResultProviderMetadata;

	isError?: boolean;

	useless?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;

	toolCall: AgentToolCall;

	tool: AgentTool<any>;

	args: Record<string, unknown>;

	context: AgentContext;
}

export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;

	toolCall: AgentToolCall;

	args: Record<string, unknown>;

	result: AgentToolResult<any>;

	isError: boolean;

	context: AgentContext;
}

export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentState {
	systemPrompt: string[];
	model: Model;
	thinkingLevel?: Effort;
	disableReasoning?: boolean;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T = any, _TInput = unknown> {
	content: (TextContent | ImageContent)[];

	details?: T;

	isError?: boolean;

	providerMetadata?: ToolResultProviderMetadata;

	useless?: boolean;
}

export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;

export interface RenderResultOptions {
	expanded: boolean;

	isPartial: boolean;

	spinnerFrame?: number;
}

export type ToolLoadMode = "essential" | "discoverable";

export interface AgentToolContext {}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
	extends Tool<TParameters> {
	label: string;

	hidden?: boolean;

	deferrable?: boolean;

	loadMode?: ToolLoadMode;

	summary?: string;

	concurrency?: "shared" | "exclusive" | ((args: Partial<Static<TParameters>>) => "shared" | "exclusive");

	lenientArgValidation?: boolean;

	interruptible?: boolean | ((args: Partial<Static<TParameters>>) => boolean);

	intent?: "omit" | "optional" | "require" | ((args: Partial<Static<TParameters>>) => string | undefined);

	matcherDigest?: (args: unknown) => string | undefined;

	matcherPaths?: (args: unknown) => readonly string[] | undefined;

	matcherEntries?: (args: unknown) => readonly { path: string; digest: string }[] | undefined;

	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
	) => unknown;
}

export interface AgentContext {
	systemPrompt: string[];
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

export type AgentEvent =
	| { type: "agent_start" }
	| {
			type: "agent_end";
			messages: AgentMessage[];

			telemetry?: AgentRunSummary;
			coverage?: AgentRunCoverage;
	  }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError?: boolean };
