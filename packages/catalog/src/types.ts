import type { Effort } from "./effort";

export type { FetchImpl } from "@oh-my-pi/pi-utils";
export type { KnownProvider } from "./provider-models/descriptors";

export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "openrouter"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "ollama-chat"
	| "cursor-agent"
	| "gitlab-duo-agent"
	| "devin-agent";
export type Api = KnownApi | (string & {});

export type ThinkingControlMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort";

export interface ThinkingConfig {
	mode: ThinkingControlMode;

	efforts: readonly Effort[];

	defaultLevel?: Effort;

	effortMap?: Partial<Record<Effort, string>>;

	supportsDisplay?: boolean;

	effortRouting?: Readonly<Partial<Record<Effort | "off", string>>>;

	effortBudgets?: Readonly<Partial<Record<Effort, number>>>;

	suppressWhenOff?: boolean;

	requiresEffort?: boolean;
}

export type Provider = string;

export type ThinkingBudgets = { [key in Effort]?: number };

export interface Usage {
	input: number;

	output: number;

	cacheRead: number;

	cacheWrite: number;

	totalTokens: number;

	contextTokens?: number;

	orchestration?: {
		input?: number;

		cacheRead?: number;

		output?: number;
	};

	premiumRequests?: number;

	reasoningTokens?: number;

	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};

	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type OpenAIReasoningFormat = "openai" | "openrouter" | "zai" | "kimi" | "qwen" | "qwen-chat-template";

export type OpenAIReasoningDisableMode =
	| "omit"
	| "lowest-effort"
	| "none-effort"
	| "openrouter-enabled-false"
	| "venice-disable-thinking"
	| "zai-thinking-disabled"
	| "qwen-enable-thinking-false"
	| "qwen-template-false";

export type OpenAIStreamMarkupHealingPattern = "kimi" | "dsml" | "qwen" | "thinking";

export interface OpenAICompat {
	supportsStore?: boolean;

	supportsDeveloperRole?: boolean;

	supportsMultipleSystemMessages?: boolean;

	supportsReasoningEffort?: boolean;

	reasoningEffortMap?: Partial<Record<Effort, string>>;

	supportsUsageInStreaming?: boolean;

	maxTokensField?: "max_completion_tokens" | "max_tokens";

	requiresToolResultName?: boolean;

	requiresAssistantAfterToolResult?: boolean;

	requiresThinkingAsText?: boolean;

	requiresMistralToolIds?: boolean;

	thinkingFormat?: OpenAIReasoningFormat;

	kimiApiFormat?: "openai" | "anthropic";

	reasoningDisableMode?: OpenAIReasoningDisableMode;

	omitReasoningEffort?: boolean;

	includeEncryptedReasoning?: boolean;

	filterReasoningHistory?: boolean;

	thinkingKeep?: "all" | false;

	reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";

	requiresReasoningContentForToolCalls?: boolean;

	requiresReasoningContentForAllAssistantTurns?: boolean;

	allowsSyntheticReasoningContentForToolCalls?: boolean;

	replayReasoningContent?: boolean;

	qwenPreserveThinking?: boolean;

	qwenTemplateReasoningEffort?: boolean;

	requiresAssistantContentForToolCalls?: boolean;

	supportsToolChoice?: boolean;

	supportsForcedToolChoice?: boolean;

	supportsNamedToolChoice?: boolean;

	disableReasoningOnForcedToolChoice?: boolean;

	disableReasoningOnToolChoice?: boolean;

	openRouterRouting?: OpenRouterRouting;

	vercelGatewayRouting?: VercelGatewayRouting;

	extraBody?: Record<string, unknown>;

	promptCacheSessionHeader?: "x-grok-conv-id";

	cacheControlFormat?: "anthropic" | undefined;

	supportsPromptCacheBreakpoints?: boolean;

	promptCacheBreakpointTtl?: "30m";

	supportsStrictMode?: boolean;

	toolSchemaFlavor?: "moonshot-mfjs" | "grammar" | "none";

	streamFirstEventTimeoutMs?: number;

	streamIdleTimeoutMs?: number;

	supportsLongPromptCacheRetention?: boolean;

	toolStrictMode?: "all_strict" | "none";

	supportsReasoningParams?: boolean;

	supportsSamplingParams?: boolean;

	supportsPenaltyAndStopParams?: boolean;

	alwaysSendMaxTokens?: boolean;

	strictResponsesPairing?: boolean;

	supportsImageDetailOriginal?: boolean;

	reasoningDeltasMayBeCumulative?: boolean;

	stripDeepseekSpecialTokens?: boolean;

	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;

	emptyLengthFinishIsContextError?: boolean;

	usesOpenAIToolCallIdLimit?: boolean;

	whenThinking?: Partial<Omit<OpenAICompat, "whenThinking">>;
}

export interface AnthropicCompat {
	streamIdleTimeoutMs?: number;

	disableStrictTools?: boolean;

	disableAdaptiveThinking?: boolean;

	supportsEagerToolInputStreaming?: boolean;

	supportsLongCacheRetention?: boolean;

	supportsMidConversationSystem?: boolean;

	supportsForcedToolChoice?: boolean;

	supportsSamplingParams?: boolean;

	requiresToolResultId?: boolean;

	allowAnthropicHeaderOverrides?: boolean;

	replayUnsignedThinking?: boolean;

	requiresThinkingEnabled?: boolean;

	escapeBuiltinToolNames?: boolean;

	signingEndpoint?: boolean;
}

export interface BedrockCompat {
	promptCacheMode?: "none" | "automatic" | "explicit";

	supportsLongPromptCacheRetention?: boolean;

	promptCacheMinimumTokens?: number;

	promptCacheMaximumCheckpoints?: number;

	streamIdleTimeoutMs?: number;
}

export interface ResolvedBedrockCompat {
	promptCacheMode: NonNullable<BedrockCompat["promptCacheMode"]>;
	supportsLongPromptCacheRetention: boolean;
	promptCacheMinimumTokens: number;
	promptCacheMaximumCheckpoints: number;

	streamIdleTimeoutMs?: number;
}

export interface OpenRouterRouting {
	only?: string[];

	order?: string[];
}

export interface VercelGatewayRouting {
	only?: string[];

	order?: string[];

	caching?: "auto";

	cacheAnchorItems?: number;

	cacheTtl?: "5m" | "1h";
}

type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

export interface ResolvedOpenAISharedCompat {
	supportsDeveloperRole: boolean;
	supportsStrictMode: boolean;
	supportsReasoningEffort: boolean;
	reasoningEffortMap: Partial<Record<Effort, string>>;
	supportsReasoningParams: boolean;
	supportsSamplingParams: boolean;
	supportsPenaltyAndStopParams: boolean;
	thinkingFormat: OpenAIReasoningFormat;

	kimiApiFormat?: OpenAICompat["kimiApiFormat"];
	reasoningDisableMode: OpenAIReasoningDisableMode;
	omitReasoningEffort: boolean;
	includeEncryptedReasoning: boolean;
	filterReasoningHistory: boolean;
	disableReasoningOnForcedToolChoice: boolean;
	disableReasoningOnToolChoice: boolean;
	supportsToolChoice: boolean;
	supportsForcedToolChoice: boolean;
	supportsNamedToolChoice: boolean;
	reasoningContentField?: OpenAICompat["reasoningContentField"];
	requiresReasoningContentForToolCalls: boolean;
	requiresReasoningContentForAllAssistantTurns: boolean;
	allowsSyntheticReasoningContentForToolCalls: boolean;
	replayReasoningContent: boolean;
	qwenPreserveThinking: boolean;
	qwenTemplateReasoningEffort: boolean;
	requiresThinkingAsText: boolean;
	requiresMistralToolIds: boolean;
	requiresToolResultName: boolean;
	requiresAssistantAfterToolResult: boolean;
	requiresAssistantContentForToolCalls: boolean;
	stripDeepseekSpecialTokens: boolean;
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;

	streamFirstEventTimeoutMs?: number;
	reasoningDeltasMayBeCumulative: boolean;
	emptyLengthFinishIsContextError: boolean;
	usesOpenAIToolCallIdLimit: boolean;
	promptCacheSessionHeader?: OpenAICompat["promptCacheSessionHeader"];

	supportsPromptCacheBreakpoints?: boolean;

	promptCacheBreakpointTtl?: "30m";

	isOpenRouterHost: boolean;

	alwaysSendMaxTokens: boolean;
	openRouterRouting?: OpenAICompat["openRouterRouting"];

	wireModelIdMode: "raw" | "firepass" | "fireworks" | "openrouter";

	toolSchemaFlavor?: OpenAICompat["toolSchemaFlavor"];
}

export type ResolvedOpenAICompat = ResolvedOpenAISharedCompat &
	Required<
		Omit<
			OpenAICompat,
			| "supportsDeveloperRole"
			| "supportsReasoningEffort"
			| "reasoningEffortMap"
			| "supportsReasoningParams"
			| "supportsSamplingParams"
			| "supportsPenaltyAndStopParams"
			| "thinkingFormat"
			| "kimiApiFormat"
			| "reasoningDisableMode"
			| "omitReasoningEffort"
			| "includeEncryptedReasoning"
			| "filterReasoningHistory"
			| "disableReasoningOnForcedToolChoice"
			| "disableReasoningOnToolChoice"
			| "supportsToolChoice"
			| "supportsForcedToolChoice"
			| "supportsNamedToolChoice"
			| "reasoningContentField"
			| "requiresReasoningContentForToolCalls"
			| "requiresReasoningContentForAllAssistantTurns"
			| "allowsSyntheticReasoningContentForToolCalls"
			| "replayReasoningContent"
			| "qwenPreserveThinking"
			| "qwenTemplateReasoningEffort"
			| "requiresThinkingAsText"
			| "requiresMistralToolIds"
			| "requiresToolResultName"
			| "requiresAssistantAfterToolResult"
			| "requiresAssistantContentForToolCalls"
			| "stripDeepseekSpecialTokens"
			| "streamMarkupHealingPattern"
			| "reasoningDeltasMayBeCumulative"
			| "emptyLengthFinishIsContextError"
			| "usesOpenAIToolCallIdLimit"
			| "promptCacheSessionHeader"
			| "supportsPromptCacheBreakpoints"
			| "promptCacheBreakpointTtl"
			| "openRouterRouting"
			| "isOpenRouterHost"
			| "supportsStrictMode"
			| "supportsLongPromptCacheRetention"
			| "alwaysSendMaxTokens"
			| "wireModelIdMode"
			| "vercelGatewayRouting"
			| "extraBody"
			| "toolStrictMode"
			| "toolSchemaFlavor"
			| "streamFirstEventTimeoutMs"
			| "streamIdleTimeoutMs"
			| "cacheControlFormat"
			| "thinkingKeep"
			| "strictResponsesPairing"
			| "supportsImageDetailOriginal"
			| "whenThinking"
		>
	> & {
		vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
		extraBody?: OpenAICompat["extraBody"];
		cacheControlFormat?: OpenAICompat["cacheControlFormat"];
		thinkingKeep?: OpenAICompat["thinkingKeep"];
		streamIdleTimeoutMs?: number;
		toolStrictMode: ResolvedToolStrictMode;

		isVercelGatewayHost: boolean;
		dropThinkingWhenReasoningEffort: boolean;

		whenThinking?: ResolvedOpenAICompat;
	};

export interface ResolvedOpenAIResponsesCompat extends ResolvedOpenAISharedCompat {
	supportsLongPromptCacheRetention: boolean;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	supportsObfuscationOptOut: boolean;

	supportsReasoningSummary: boolean;
	streamIdleTimeoutMs?: number;
	vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];

	isVercelGatewayHost: boolean;
}

export type ResolvedOpenRouterCompat = ResolvedOpenAICompat & ResolvedOpenAIResponsesCompat;

export type ResolvedAnthropicCompat = Required<Omit<AnthropicCompat, "streamIdleTimeoutMs">> & {
	streamIdleTimeoutMs?: number;

	officialEndpoint: boolean;
};

export interface DevinCompat {
	trustExplicitThinkingOnly?: boolean;
}

export type ResolvedDevinCompat = Required<DevinCompat>;

export type CompatConfigOf<TApi extends Api> = TApi extends
	| "openai-completions"
	| "openrouter"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	? OpenAICompat
	: TApi extends "anthropic-messages"
		? AnthropicCompat
		: TApi extends "bedrock-converse-stream"
			? BedrockCompat
			: TApi extends "devin-agent"
				? DevinCompat
				: undefined;

export type CompatOf<TApi extends Api> = TApi extends "openrouter"
	? ResolvedOpenRouterCompat
	: TApi extends "openai-completions"
		? ResolvedOpenAICompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? ResolvedOpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? ResolvedAnthropicCompat
				: TApi extends "bedrock-converse-stream"
					? ResolvedBedrockCompat
					: TApi extends "devin-agent"
						? ResolvedDevinCompat
						: undefined;

export interface RemoteCompactionConfig<TApi extends Api = Api> {
	enabled?: boolean;

	api?: TApi;

	endpoint?: string;

	v2StreamingEnabled?: boolean;

	v2Endpoint?: string;

	streamingEndpoint?: string;

	model?: string;
}

export interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface LongContextTokenCost extends TokenCost {
	inputThreshold: number;
}

export interface ModelCost extends TokenCost {
	longContext?: LongContextTokenCost;
}

export type ModelTokenizer =
	| "claude-v3"
	| "claude-v47"
	| "claude-v5"
	| "claude-v5-sonnet"
	| "qwen3"
	| "deepseek-v3"
	| "kimi-k2"
	| "glm5";

export interface Model<TApi extends Api = Api> {
	id: string;

	requiresGlyphTokenization?: boolean;

	requestModelId?: string;

	reasoningMode?: "pro";
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;

	tokenizer?: ModelTokenizer;
	input: ("text" | "image")[];

	imageInputDecoder?: "stb";

	supportsTools?: boolean;

	supportsComputerUse?: boolean;

	supportsComputerUseConfig?: boolean;

	gitlabDuoWorkflowRootNamespaceId?: string;

	cursorMaxMode?: boolean;
	cost: ModelCost;

	premiumMultiplier?: number;
	contextWindow: number | null;
	maxTokens: number | null;

	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;

	transport?: "pi-native";

	preferWebsockets?: boolean;

	useResponsesLite?: boolean;

	toolMode?: "code_mode_only";

	contextPromotionTarget?: string;

	compactionModel?: string;

	remoteCompaction?: RemoteCompactionConfig<TApi>;

	priority?: number;

	thinking?: ThinkingConfig;

	compat: CompatOf<TApi>;

	compatConfig?: CompatConfigOf<TApi>;

	applyPatchToolType?: "freeform" | "function";

	isOAuth?: boolean;
}

export interface ModelSpec<TApi extends Api = Api>
	extends Omit<Model<TApi>, "compat" | "compatConfig" | "requiresGlyphTokenization" | "supportsComputerUseConfig"> {
	compat?: CompatConfigOf<TApi>;
}
