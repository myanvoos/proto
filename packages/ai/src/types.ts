export * from "@oh-my-pi/pi-catalog/effort";
export * from "@oh-my-pi/pi-catalog/types";

import type { Type } from "@oh-my-pi/omptype";
import type {
	DeleteArgs,
	DeleteResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	PiBashExecArgs,
	PiBashExecResult,
	PiEditExecArgs,
	PiEditExecResult,
	PiFindExecArgs,
	PiFindExecResult,
	PiGrepExecArgs,
	PiGrepExecResult,
	PiLsExecArgs,
	PiLsExecResult,
	PiReadExecArgs,
	PiReadExecResult,
	PiWriteExecArgs,
	PiWriteExecResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isOpenAIModelId } from "@oh-my-pi/pi-catalog/identity/family";
import type { Api, FetchImpl, KnownApi, Model, Provider, ThinkingBudgets, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ApiKey } from "./auth-retry";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { FallbackParam, StopDetails } from "./providers/anthropic-wire";
import type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import type { GitLabDuoWorkflowOptions } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import type { kStreamingPartialJson } from "./utils/block-symbols";
import type { AssistantMessageEventStream } from "./utils/event-stream";

export type { StopDetails } from "./providers/anthropic-wire";
export type { AssistantMessageEventStream } from "./utils/event-stream";

export const OPENAI_MAX_OUTPUT_TOKENS = 64000;

export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"bedrock-converse-stream": BedrockOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	openrouter: OpenAIResponsesOptions | OpenAICompletionsOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"google-vertex": GoogleVertexOptions;
	"ollama-chat": OllamaChatOptions;
	"cursor-agent": CursorOptions;
	"gitlab-duo-agent": GitLabDuoWorkflowOptions;
	"devin-agent": DevinOptions;
}

type _CheckExhaustive =
	ApiOptionsMap extends Record<KnownApi, StreamOptions>
		? Record<KnownApi, StreamOptions> extends ApiOptionsMap
			? true
			: ["ApiOptionsMap is missing some KnownApi values", Exclude<KnownApi, keyof ApiOptionsMap>]
		: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
true satisfies _CheckExhaustive;
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);

export interface TokenTaskBudget {
	type: "tokens";
	total: number;
	remaining?: number;
}

export type MessageAttribution = "user" | "agent";

export type NativeToolMarker = { type: "computer" };

export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string }
	| { type: "computer" };

export type CacheRetention = "none" | "short" | "long";

export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

export type ServiceTierFamily = "openai" | "anthropic" | "google";

export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;

type ServiceTierModel = Pick<Model, "provider" | "api" | "id">;

function isOpenAIServiceTierApi(api: Api | undefined): boolean {
	return api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses";
}

function excludesInferredOpenAIServiceTier(provider: Provider | undefined): boolean {
	return provider === "fireworks" || provider === "github-copilot";
}

function isOpenAIServiceTierModel(model: ServiceTierModel): boolean {
	return (
		!excludesInferredOpenAIServiceTier(model.provider) &&
		isOpenAIServiceTierApi(model.api) &&
		isOpenAIModelId(model.id)
	);
}

export function serviceTierFamily(model: ServiceTierModel): ServiceTierFamily | undefined {
	const provider = model.provider;
	if (provider === "openrouter") {
		const id = model.id.toLowerCase();
		if (id.startsWith("anthropic/")) return "anthropic";
		if (id.startsWith("google/")) return "google";
		if (id.startsWith("openai/")) return "openai";
		return undefined;
	}
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (model.api === "anthropic-messages") return "anthropic";
	if (provider === "google" || provider === "google-vertex") return "google";
	if (isOpenAIServiceTierModel(model)) return "openai";
	return undefined;
}

export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): ServiceTier | undefined {
	if (!tiers) return undefined;
	const family = serviceTierFamily(model);
	return family ? tiers[family] : undefined;
}

export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	target: Provider | ServiceTierModel | undefined,
): boolean {
	if (!serviceTier || serviceTier === "auto") return false;
	const provider = typeof target === "string" ? target : target?.provider;
	if (provider === "openai" || provider === "openai-codex") return true;
	if (provider === "openrouter") {
		return serviceTier === "flex" || serviceTier === "scale" || serviceTier === "priority";
	}
	if (typeof target !== "string" && target && isOpenAIServiceTierModel(target)) return true;
	if (provider === "google") {
		return serviceTier === "flex" || serviceTier === "priority";
	}

	if (provider === "google-vertex" || provider === "fireworks") {
		return serviceTier === "priority";
	}
	return false;
}

export function realizesPriorityServiceTier(
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): boolean {
	if (serviceTier !== "priority") return false;
	if (model.provider === "anthropic") return true;
	if (model.provider === "openrouter") {
		const family = serviceTierFamily(model);
		return family === "openai" || family === "google";
	}
	if (model.api === "anthropic-messages") return false;
	return shouldSendServiceTier(serviceTier, model);
}

export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): number {
	if (!realizesPriorityServiceTier(serviceTier, model)) return 0;
	const provider = model.provider;
	return provider === "openai" ||
		provider === "openai-codex" ||
		provider === "anthropic" ||
		provider === "google" ||
		provider === "google-vertex"
		? 1
		: 0;
}

export function coerceServiceTierByFamily(value: unknown): ServiceTierByFamily | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: ServiceTierByFamily = {};
		for (const family of ["openai", "anthropic", "google"] as const) {
			const tier = src[family];
			if (tier === "auto" || tier === "default" || tier === "flex" || tier === "scale" || tier === "priority") {
				out[family] = tier;
			}
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	switch (value) {
		case "priority":
			return { openai: "priority", anthropic: "priority", google: "priority" };
		case "openai-only":
			return { openai: "priority" };
		case "claude-only":
			return { anthropic: "priority" };
		case "auto":
			return { openai: "auto" };
		case "default":
			return { openai: "default" };
		case "flex":
			return { openai: "flex" };
		case "scale":
			return { openai: "scale" };
		default:
			return undefined;
	}
}

export interface ProviderSessionState {
	close(): void;
}

export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
	metadata?: Record<string, unknown>;
}

export interface RawSseEvent {
	event: string | null;
	data: string;
	raw: string[];
}

export interface CodexCompactionContext {
	operationId: string;
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

export interface CodexCompactionMetadata {
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

export interface CodexCompactionRequestContext extends CodexCompactionMetadata {
	operationId: string;
}

export interface OpenAIPromptCacheOptions {
	mode: "implicit" | "explicit";

	ttl?: "30m";

	breakpoint?: "latest-stable-message" | "none";
}
export type OpenAIResponseInclude =
	| "file_search_call.results"
	| "web_search_call.results"
	| "web_search_call.action.sources"
	| "message.input_image.image_url"
	| "computer_call_output.output.image_url"
	| "code_interpreter_call.outputs"
	| "reasoning.encrypted_content"
	| "message.output_text.logprobs";

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;

	stopSequences?: string[];

	frequencyPenalty?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	cacheRetention?: CacheRetention;

	anthropicCacheRefresh?: boolean;

	anthropicCacheRefreshRequest?: boolean;

	headers?: Record<string, string>;

	initiatorOverride?: MessageAttribution;

	maxRetryDelayMs?: number;

	metadata?: Record<string, unknown>;

	providerOptions?: Readonly<Record<string, unknown>>;

	include?: OpenAIResponseInclude[];

	loopGuard?: {
		enabled?: boolean;
		checkAssistantContent?: boolean;
	};

	taskBudget?: TokenTaskBudget;

	sessionId?: string;

	promptCacheKey?: string;

	promptCache?: OpenAIPromptCacheOptions;

	statefulResponses?: boolean;

	forceReasoningOff?: boolean;

	providerSessionState?: Map<string, ProviderSessionState>;

	codexCompaction?: CodexCompactionRequestContext;

	toolNamespacesInfo?: unknown;

	maxInFlightRequests?: Record<string, number>;

	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;

	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>) => void | Promise<void>;

	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;

	streamFirstEventTimeoutMs?: number;

	streamIdleTimeoutMs?: number;

	codexSseMaxAttempts?: number;

	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;

	acceptEmptyResponse?: boolean;

	fetch?: FetchImpl;

	cwd?: string;

	execHandlers?: CursorExecHandlers;
}

export interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
	apiKey?: ApiKey;
	reasoning?: Effort;

	disableReasoning?: boolean;

	hideThinkingSummary?: boolean;

	textVerbosity?: "low" | "medium" | "high";

	thinkingBudgets?: ThinkingBudgets;

	cursorExecHandlers?: CursorExecHandlers;

	cursorOnToolResult?: CursorToolResultHandler;

	toolChoice?: ToolChoice;

	serviceTier?: ServiceTier;

	kimiApiFormat?: "openai" | "anthropic";

	syntheticApiFormat?: "openai" | "anthropic";

	preferWebsockets?: boolean;

	openrouterVariant?: string;

	cachedContent?: string;

	antigravityEndpointMode?: "auto" | "production" | "sandbox";

	fallbacks?: FallbackParam[];
}

export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	itemId?: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

export interface AnthropicServerToolContent {
	type: "anthropicServerTool";
	block:
		| {
				type: "server_tool_use";
				id: string;
				name: "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25";
				input?: Record<string, unknown> | null;
				[key: string]: unknown;
		  }
		| {
				type: "web_search_tool_result" | "tool_search_tool_result";
				tool_use_id: string;
				content: unknown;
				[key: string]: unknown;
		  };
}

export interface ProviderFileReference {
	provider: "openai" | "anthropic" | "google";
	id?: string;
	uri?: string;
	expiresAt?: number;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;

	detail?: "auto" | "low" | "high" | "original";

	providerFile?: ProviderFileReference;

	url?: string;
}

export interface AudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

export interface VideoContent {
	type: "video";
	data: string;
	mimeType: string;
}

export type ComputerAction =
	| {
			type: "click";
			button: "left" | "right" | "wheel" | "back" | "forward";
			x: number;
			y: number;
			keys?: string[] | null;
	  }
	| { type: "double_click"; x: number; y: number; keys: string[] | null }
	| { type: "drag"; path: Array<{ x: number; y: number }>; keys?: string[] | null }
	| { type: "keypress"; keys: string[] }
	| { type: "move"; x: number; y: number; keys?: string[] | null }
	| { type: "screenshot" }
	| { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number; keys?: string[] | null }
	| { type: "type"; text: string }
	| { type: "wait" };

export interface ComputerSafetyCheck {
	id: string;
	code?: string | null;
	message?: string | null;
}

export interface ComputerToolCallMetadata {
	type: "computer";
	providerItemId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}

export type ToolCallProviderMetadata = ComputerToolCallMetadata;

export type ComputerScreenshotRef =
	| { type: "computer_screenshot"; image_url: string; file_id?: never }
	| { type: "computer_screenshot"; file_id: string; image_url?: never };

export interface ComputerToolResultMetadata {
	type: "computer";
	screenshot: ComputerScreenshotRef;
	acknowledgedSafetyChecks: ComputerSafetyCheck[];
}

export type ToolResultProviderMetadata = ComputerToolResultMetadata;

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string;
	intent?: string;

	rawBlock?: string;

	customWireName?: string;

	providerMetadata?: ToolCallProviderMetadata;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

export type ProviderPayload = OpenAIResponsesHistoryPayload;

export type UserContent = TextContent | ImageContent | AudioContent | VideoContent;

export interface UserMessage {
	role: "user";
	content: string | UserContent[];

	synthetic?: boolean;

	steering?: boolean;

	attribution?: MessageAttribution;

	providerPayload?: ProviderPayload;
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | UserContent[];

	attribution?: MessageAttribution;

	providerPayload?: ProviderPayload;
	timestamp: number;
}

export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

export type AssistantRetryRecovery =
	| {
			kind: "auto-retry";
			status: "recovered";
			attempt: number;
			recoveredAt: string;
			recovery: AssistantRetryRecoveryKind;
			note: string;
			supersededBy?: {
				timestamp: number;
				responseId?: string;
				provider: string;
				model: string;
			};
	  }
	| {
			kind: "auto-retry";
			status: "superseded";
			attempt: number;
			recovery: AssistantRetryRecoveryKind;
			note: string;
	  };

export interface ContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;

	historyRewriteTokensRemoved?: number;

	compactionEpoch?: number;
	lastMessageTimestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (
		| TextContent
		| ThinkingContent
		| RedactedThinkingContent
		| AnthropicFallbackContent
		| AnthropicServerToolContent
		| ImageContent
		| ToolCall
	)[];
	api: Api;
	provider: Provider;
	model: string;
	contextSnapshot?: ContextSnapshot;
	retryRecovery?: AssistantRetryRecovery;
	responseId?: string;

	upstreamProvider?: string;
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;

	errorClassificationMessage?: string;

	toolCallAbortMessages?: Record<string, string>;

	errorStatus?: number;

	errorId?: number;

	disabledFeatures?: string[];

	providerPayload?: ProviderPayload;
	timestamp: number;
	duration?: number;
	ttft?: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError: boolean;

	attribution?: MessageAttribution;

	prunedAt?: number;

	providerMetadata?: ToolResultProviderMetadata;

	useless?: boolean;
	timestamp: number;
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

export interface CursorExecPairing {
	toolCallId: string;
	toolName: string;
}

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;

	approvalOnly?: boolean;
}

export interface CursorTodoSnapshotItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

export interface CursorTodoSnapshot {
	todos: CursorTodoSnapshotItem[];

	merged: boolean;
}

export type CursorTodoSyncHandler = (
	snapshot: CursorTodoSnapshot | null,
	toolCallId: string,
	error: string | null,
) => ToolResultMessage;

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

export interface CursorPiCall<TArgs> {
	args: TArgs;
	toolCallId: string;
}

export interface CursorMcpResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;

	server: string;
}

export interface CursorMcpResourceContent {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	text?: string;
	blob?: Uint8Array;

	downloadPath?: string;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;

	mcpApprovalPreflight?: (call: CursorMcpCall) => Promise<boolean>;

	piRead?: (call: CursorPiCall<PiReadExecArgs>) => Promise<CursorExecHandlerResult<PiReadExecResult>>;
	piBash?: (call: CursorPiCall<PiBashExecArgs>) => Promise<CursorExecHandlerResult<PiBashExecResult>>;
	piEdit?: (call: CursorPiCall<PiEditExecArgs>) => Promise<CursorExecHandlerResult<PiEditExecResult>>;
	piWrite?: (call: CursorPiCall<PiWriteExecArgs>) => Promise<CursorExecHandlerResult<PiWriteExecResult>>;
	piGrep?: (call: CursorPiCall<PiGrepExecArgs>) => Promise<CursorExecHandlerResult<PiGrepExecResult>>;
	piFind?: (call: CursorPiCall<PiFindExecArgs>) => Promise<CursorExecHandlerResult<PiFindExecResult>>;
	piLs?: (call: CursorPiCall<PiLsExecArgs>) => Promise<CursorExecHandlerResult<PiLsExecResult>>;

	listMcpResources?: (args: { server?: string }) => Promise<CursorMcpResource[]>;

	readMcpResource?: (args: {
		server: string;
		uri: string;

		downloadPath?: string;
	}) => Promise<CursorMcpResourceContent | null>;

	todoSync?: CursorTodoSyncHandler;
	onToolResult?: CursorToolResultHandler;
}

export type TJsonSchema = Record<string, unknown>;

export type TSchema = Type | TJsonSchema;

export type Static<S> = S extends Type ? S["infer"] : S extends { static: infer T } ? T : unknown;

export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	bad: TArgs;
	good: TArgs;
}
export interface ToolNoteExample {
	caption: string;
	note?: string;
}
export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;

	strict?: boolean;

	customFormat?: { syntax: "lark" | "regex"; definition: string };

	customWireName?: string;

	native?: NativeToolMarker;

	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
