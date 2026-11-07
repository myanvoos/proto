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

	prefixBinding?: boolean;

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

	credits?: {
		cost?: number;

		committedCost?: number;

		acuCost?: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type OpenAIReasoningFormat =
	| "openai"
	| "openrouter"
	| "zai"
	| "kimi"
	| "qwen"
	| "qwen-chat-template"
	| "chat-template";

export type OpenAIReasoningDisableMode =
	| "omit"
	| "lowest-effort"
	| "none-effort"
	| "openrouter-enabled-false"
	| "cline-enabled-false"
	| "venice-disable-thinking"
	| "zai-thinking-disabled"
	| "qwen-enable-thinking-false"
	| "qwen-template-false"
	| "chat-template-thinking-false";

export type OpenAIStreamMarkupHealingPattern = "kimi" | "dsml" | "qwen" | "thinking";

export interface OpenAICompat {
	/** Do not infer a reasoning dial when discovery explicitly advertises none. */
	trustExplicitThinkingOnly?: boolean;

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

	disableReasoningWithTools?: boolean;

	openRouterRouting?: OpenRouterRouting;

	vercelGatewayRouting?: VercelGatewayRouting;

	// Per-model override of the provider-detected wire id transform; ClinePass free-tier ids arrive pre-namespaced.
	wireModelIdMode?: "raw" | "cline-pass" | "firepass" | "fireworks" | "openrouter";

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

	supportsReasoningSummary?: boolean;

	/** Per-model stored-response chaining; call options/environment keep precedence. */
	statefulResponses?: boolean;

	supportsSamplingParams?: boolean;

	supportsPenaltyAndStopParams?: boolean;

	alwaysSendMaxTokens?: boolean;

	strictResponsesPairing?: boolean;

	supportsImageDetailOriginal?: boolean;

	/** `configuration_update` items change effort mid-conversation (default: `gpt-6-astra` only); `false` for proxies that 400 on the item. */
	supportsConfigurationUpdate?: boolean;

	reasoningDeltasMayBeCumulative?: boolean;

	stripDeepseekSpecialTokens?: boolean;

	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;

	emptyLengthFinishIsContextError?: boolean;

	usesOpenAIToolCallIdLimit?: boolean;

	clampOutputToModelMax?: boolean;

	stripImageInput?: boolean;

	whenThinking?: Partial<Omit<OpenAICompat, "whenThinking">>;
}

export interface AnthropicCompat {
	/** Explicit native off form for adaptive models that support it. */
	disabledThinking?: "disabled";
	maxImageDimension?: number;
	maxImagePayloadBytes?: number;

	streamIdleTimeoutMs?: number;

	disableStrictTools?: boolean;

	disableAdaptiveThinking?: boolean;

	supportsEagerToolInputStreaming?: boolean;

	supportsLongCacheRetention?: boolean;

	supportsMidConversationSystem?: boolean;

	supportsTurnScopedSystem?: boolean;

	supportsMidConversationToolChanges?: boolean;

	supportsPerMessageEffort?: boolean;

	supportsThinkingBindingControls?: boolean;

	supportsContextManagement?: boolean;

	supportsServerCompaction?: boolean;

	firstPartyProvider?: boolean;

	supportsForcedToolChoice?: boolean;

	supportsSamplingParams?: boolean;

	requiresToolResultId?: boolean;

	allowAnthropicHeaderOverrides?: boolean;

	replayUnsignedThinking?: boolean;

	/** Pad thinking-less assistant turns only for explicitly configured strict replay validators. */
	requiresThinkingPresence?: boolean;

	requiresThinkingEnabled?: boolean;

	escapeBuiltinToolNames?: boolean;

	signingEndpoint?: boolean;
}

export interface BedrockCompat {
	/** Explicit native off form for adaptive models that support it. */
	disabledThinking?: "disabled";
	supportsThinkingBindingControls?: boolean;
	promptCacheMode?: "none" | "automatic" | "explicit";

	supportsLongPromptCacheRetention?: boolean;

	promptCacheMinimumTokens?: number;

	promptCacheMaximumCheckpoints?: number;

	streamIdleTimeoutMs?: number;

	/** Whether a forced `toolChoice` (`any`/`tool`) is accepted; when false the request downgrades it to `auto`. */
	supportsForcedToolChoice?: boolean;
}

export interface ResolvedBedrockCompat {
	disabledThinking?: "disabled";
	supportsThinkingBindingControls: boolean;
	promptCacheMode: NonNullable<BedrockCompat["promptCacheMode"]>;
	supportsLongPromptCacheRetention: boolean;
	promptCacheMinimumTokens: number;
	promptCacheMaximumCheckpoints: number;
	supportsForcedToolChoice: boolean;

	streamIdleTimeoutMs?: number;

	/** Send tool-result images as sibling user blocks instead of nesting them in `toolResult` content. */
	requiresToolResultImageHoisting?: boolean;
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
	trustExplicitThinkingOnly: boolean;

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
	disableReasoningWithTools?: boolean;
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

	clampOutputToModelMax: boolean;
	openRouterRouting?: OpenAICompat["openRouterRouting"];

	wireModelIdMode: "raw" | "cline-pass" | "firepass" | "fireworks" | "openrouter";

	toolSchemaFlavor?: OpenAICompat["toolSchemaFlavor"];
}

export type ResolvedOpenAICompat = ResolvedOpenAISharedCompat &
	Required<
		Omit<
			OpenAICompat,
			| "trustExplicitThinkingOnly"
			| "supportsDeveloperRole"
			| "supportsReasoningEffort"
			| "reasoningEffortMap"
			| "supportsReasoningParams"
			| "supportsReasoningSummary"
			| "statefulResponses"
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
			| "disableReasoningWithTools"
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
			| "clampOutputToModelMax"
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
			| "supportsConfigurationUpdate"
			| "stripImageInput"
			| "whenThinking"
		>
	> & {
		stripImageInput?: boolean;
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
	statefulResponses?: boolean;
	/** `configuration_update` input items may change reasoning effort mid-conversation (GPT-6 Astra only; others 400). */
	supportsConfigurationUpdate: boolean;
	streamIdleTimeoutMs?: number;
	vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];

	isVercelGatewayHost: boolean;
}

export type ResolvedOpenRouterCompat = ResolvedOpenAICompat & ResolvedOpenAIResponsesCompat;

export type ResolvedAnthropicCompat = Required<Omit<AnthropicCompat, "streamIdleTimeoutMs" | "disabledThinking">> & {
	disabledThinking?: "disabled";
	streamIdleTimeoutMs?: number;

	officialEndpoint: boolean;
};

export interface DevinCompat {
	trustExplicitThinkingOnly?: boolean;

	modelRouter?: boolean;

	supportsParallelToolCalls?: boolean;
}

export type ResolvedDevinCompat = Required<DevinCompat>;

/** Ollama chat history compatibility resolved by the catalog. */
export interface OllamaCompat {
	/** Omit assistant thinking when the deployment rejects it in history. */
	stripThinkingHistory?: boolean;
}

export type ResolvedOllamaCompat = Required<OllamaCompat>;

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
				: TApi extends "ollama-chat"
					? OllamaCompat
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
						: TApi extends "ollama-chat"
							? ResolvedOllamaCompat
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
	/** The tier also applies at exactly `inputThreshold` prompt tokens (xAI's 200K boundary). */
	inputThresholdInclusive?: boolean;
}

/** Recurring UTC peak interval; weekdays use Sunday = 0, and the end minute is exclusive. */
export interface PeakPricingWindow {
	weekdays: readonly number[];
	startMinute: number;
	endMinute: number;
}

/** Complete replacement rate card effective from a Unix-millisecond timestamp. */
export interface EffectiveTokenCost extends TokenCost {
	effectiveFrom: number;
	longContext?: LongContextTokenCost;
}

/** Scheduled discounts applied after selecting the effective rate card and context tier. */
export interface TimeBasedCost {
	offPeakMultiplier: number;
	peakWindows: readonly PeakPricingWindow[];
	effectiveRates?: readonly EffectiveTokenCost[];
}

export interface ModelCost extends TokenCost {
	longContext?: LongContextTokenCost;
	timeBased?: TimeBasedCost;
}

export type ModelTokenizer =
	| "cl100k"
	| "claude-v3"
	| "claude-v47"
	| "claude-v5"
	| "claude-v5-sonnet"
	| "qwen3"
	| "deepseek-v3"
	| "kimi-k2"
	| "glm5";

export interface AntigravityModelWireProfile {
	modelEnum?: string;
	maxOutputTokens?: number;
	thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
	thinkingBudget?: number;
}

export interface Model<TApi extends Api = Api> {
	id: string;

	requiresGlyphTokenization?: boolean;

	requestModelId?: string;

	antigravityWireProfiles?: Readonly<Record<string, AntigravityModelWireProfile>>;

	reasoningMode?: "pro";
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;

	tokenizer?: ModelTokenizer;
	input: ("text" | "image" | "audio" | "video")[];

	imageInputDecoder?: "stb";

	/** Configured maximum images per request for custom endpoints. */
	imageCountBudget?: number;

	/** False when the host sends tool schemas outside the model-visible prompt. */
	toolSchemasInContext?: boolean;

	/** Account startup selection advertised by provider discovery. */
	isProviderDefault?: boolean;

	supportsTools?: boolean;

	supportsComputerUse?: boolean;

	supportsComputerUseConfig?: boolean;

	/** Host continues a trailing assistant message verbatim (Ollama), so callers may commit an output prefix. */
	supportsAssistantPrefill?: boolean;

	gitlabDuoWorkflowRootNamespaceId?: string;

	cursorMaxMode?: boolean;
	/** Per-wire-id Cursor `max_mode` markers of the members a collapsed row routes to. */
	cursorMaxModeRoutes?: Readonly<Record<string, boolean>>;
	cost: ModelCost;

	premiumMultiplier?: number;
	contextWindow: number | null;
	/** Larger prompt window applied when extended context is enabled. */
	maxContextWindow?: number;
	maxTokens: number | null;

	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	/**
	 * Materializes config-backed headers (e.g. `!command` values) right before a request. Catalog reads never call it;
	 * transports receive a cloned model with plain resolved `headers` and no hook.
	 */
	resolveHeaders?: (signal?: AbortSignal) => Promise<Record<string, string> | undefined>;

	transport?: "pi-native";

	preferWebsockets?: boolean;

	useResponsesLite?: boolean;

	toolMode?: "code_mode_only";
	/**
	 * Service-tier ids the provider advertises for this model (Codex discovery
	 * `service_tiers[].id`, e.g. `priority`, `ultrafast`). Absent when the
	 * provider publishes no per-model tier list.
	 */
	serviceTiers?: readonly string[];

	/** Published token-cost multiplier for optional processing tiers. */
	serviceTierCost?: Readonly<Partial<Record<"flex" | "priority" | "ultrafast", number>>>;
	/** Preferred model to switch to when context promotion is triggered (model id or provider/id). */
	contextPromotionTarget?: string;

	compactionModel?: string;

	remoteCompaction?: RemoteCompactionConfig<TApi>;

	priority?: number;

	description?: string;

	isNew?: boolean;

	isBeta?: boolean;

	isRecommended?: boolean;

	thinking?: ThinkingConfig;
	/** Intelligence score delivered by the model catalog. */
	int?: number | null;
	/** Catalog-estimated output speed in tokens per second. */
	tps?: number | null;

	compat: CompatOf<TApi>;

	compatConfig?: CompatConfigOf<TApi>;

	applyPatchToolType?: "freeform" | "function";

	isOAuth?: boolean;

	/** Amazon Bedrock Guardrail id or ARN attached to every Converse request for this model. */
	guardrailIdentifier?: string;

	guardrailVersion?: string;

	guardrailTrace?: "enabled" | "disabled" | "enabled_full";

	/** Amazon Bedrock invocation-log tags attached to every Converse request for this model. */
	requestMetadata?: Record<string, string>;
}

export interface ModelSpec<TApi extends Api = Api>
	extends Omit<
		Model<TApi>,
		"compat" | "compatConfig" | "requiresGlyphTokenization" | "supportsComputerUseConfig" | "supportsAssistantPrefill"
	> {
	compat?: CompatConfigOf<TApi>;
}
