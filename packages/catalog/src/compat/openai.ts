import { isFireworksFastModelId } from "../fireworks-model-id";
import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import { bareModelId, parseOpenAIModel, semverGte } from "../identity/classify";
import {
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGlm52ReasoningEffortModelId,
	isGrokReasoningEffortCapable,
	isGrokXHighEffortCapable,
	isKimiK3ModelId,
	isKimiK26ModelId,
	isKimiModelId,
	isMimoModelIdOrName,
	isOpenAISamplingRestrictedModelId,
	isQwen38PlusTemplateEffortModelId,
	isQwenModelId,
} from "../identity/family";
import type {
	ModelSpec,
	OpenAICompat,
	OpenAIStreamMarkupHealingPattern,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	ResolvedOpenRouterCompat,
} from "../types";
import { applyCompatOverrides } from "./apply";

const GLM_CODING_PLAN_MODEL_PATTERN = /(^|\/)glm-5(?:[.-]|$)/i;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;

const DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;

const KIMI_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;

const KIMI_K27_CODE_MODEL_PATTERN = /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i;

function matchesKimiK27CodeFamily(spec: ModelSpec<"openai-completions">): boolean {
	if (KIMI_K27_CODE_MODEL_PATTERN.test(spec.id)) return true;
	return spec.id === "kimi-for-coding" && /k2\.?7 code/i.test(spec.name ?? "");
}

const XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000;

const ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;

const LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const MINIMAX_PROVIDER_OR_ID_PATTERN = /minimax/i;
const DSML_HEALING_PROVIDERS = new Set([
	"ollama",
	"ollama-cloud",
	"nvidia",
	"deepseek",
	"fireworks",
	"nanogpt",
	"opencode-go",
	"openrouter",
]);

function resolveReasoningDisableMode(
	thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"],
): ResolvedOpenAISharedCompat["reasoningDisableMode"] {
	switch (thinkingFormat) {
		case "openrouter":
			return "openrouter-enabled-false";
		case "zai":
		case "kimi":
			return "zai-thinking-disabled";
		case "qwen":
			return "qwen-enable-thinking-false";
		case "qwen-chat-template":
			return "qwen-template-false";
		default:
			return "lowest-effort";
	}
}

function detectStreamMarkupHealingPattern(
	provider: string,
	modelId: string,
	baseUrl: string,
): OpenAIStreamMarkupHealingPattern | undefined {
	if (provider === "kimi-code" || provider === "moonshot" || /kimi[-/_.]?k2/i.test(modelId)) {
		return "kimi";
	}
	if (isDeepseekModelIdOrName(modelId) && DSML_HEALING_PROVIDERS.has(provider)) {
		return "dsml";
	}
	if (isOfficialOpenAIEndpoint(provider, baseUrl)) return undefined;
	return "thinking";
}

function isOfficialOpenAIEndpoint(provider: string, baseUrl: string): boolean {
	if (provider !== "openai") return false;
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

function supportsOfficialOpenAIPromptCacheBreakpoints(provider: string, modelId: string, baseUrl: string): boolean {
	if (!isOfficialOpenAIEndpoint(provider, baseUrl)) return false;
	const model = parseOpenAIModel(bareModelId(modelId));
	return model !== null && semverGte(model.version, "5.6");
}

const OPENCODE_WHEN_THINKING: NonNullable<OpenAICompat["whenThinking"]> = {
	requiresReasoningContentForToolCalls: true,
	allowsSyntheticReasoningContentForToolCalls: false,
	reasoningContentField: "reasoning_content",
};

const KIMI_K3_REASONING_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
	medium: "high",
	xhigh: "max",
	max: "max",
};

const MIMO_REASONING_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
	xhigh: "high",
};

const XAI_RESPONSES_MINIMAL_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
};

const XAI_RESPONSES_CLAMPED_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
	xhigh: "high",
	max: "high",
};

export function xaiResponsesReasoningEffortMap(modelId: string): NonNullable<OpenAICompat["reasoningEffortMap"]> {
	return isGrokXHighEffortCapable(modelId) ? XAI_RESPONSES_MINIMAL_EFFORT_MAP : XAI_RESPONSES_CLAMPED_EFFORT_MAP;
}

function mergeModelReasoningEffortMap(
	compat: ResolvedOpenAISharedCompat,
	modelId: string,
	isMimoReasoningEffortModel: boolean,
): void {
	let detected: NonNullable<OpenAICompat["reasoningEffortMap"]>;
	if (isKimiK3ModelId(modelId)) {
		detected = KIMI_K3_REASONING_EFFORT_MAP;
	} else if (isMimoReasoningEffortModel) {
		detected = MIMO_REASONING_EFFORT_MAP;
	} else {
		return;
	}
	compat.reasoningEffortMap = { ...detected, ...compat.reasoningEffortMap };
}

function detectStrictModeSupport(provider: string, baseUrl: string): boolean {
	if (
		provider === "openai" ||
		provider === "openrouter" ||
		provider === "cerebras" ||
		provider === "together" ||
		provider === "github-copilot" ||
		provider === "zenmux"
	) {
		return true;
	}
	return (
		hostMatchesUrl(baseUrl, "openai") ||
		hostMatchesUrl(baseUrl, "azureOpenAI") ||
		hostMatchesUrl(baseUrl, "cerebras") ||
		hostMatchesUrl(baseUrl, "together") ||
		hostMatchesUrl(baseUrl, "openrouter") ||
		hostMatchesUrl(baseUrl, "deepseekFamily")
	);
}

const LOCAL_OPENAI_COMPAT_PROVIDERS = new Set(["llama.cpp", "lm-studio", "vllm", "ollama"]);

const STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS: Record<string, true> = {
	"llama.cpp": true,
	"lm-studio": true,
};

const PROXY_OPENAI_COMPAT_PROVIDERS = new Set(["litellm"]);

function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	if (/^10\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	if (hostname.endsWith(".local")) return true;
	return false;
}

export function buildOpenAICompat(spec: ModelSpec<"openai-completions">): ResolvedOpenAICompat {
	const provider = spec.provider;
	const baseUrl = spec.baseUrl;
	const hostModel = { provider, baseUrl };

	const isCerebras = modelMatchesHost(hostModel, "cerebras");
	const isZai = modelMatchesHost(hostModel, "zai");
	const isZhipu = modelMatchesHost(hostModel, "zhipu");
	const supportsZaiReasoningEffort = (isZai || isZhipu) && isGlm52ReasoningEffortModelId(spec.id);
	const isKilo = modelMatchesHost(hostModel, "kilo");
	const isKimiModel = isKimiModelId(spec.id);
	const isMoonshotNative = modelMatchesHost(hostModel, "moonshotNative");
	const isMoonshotKimi = isKimiModel && isMoonshotNative;

	const isKimiK3 = isKimiK3ModelId(spec.id);
	const isMoonshotKimiK3 = isMoonshotKimi && isKimiK3;
	const requiresEnabledThinking = isMoonshotKimi && matchesKimiK27CodeFamily(spec);
	const usesMoonshotKimiPreservedThinking = isMoonshotKimi && isKimiK26ModelId(spec.id);
	const isAnthropicModel =
		modelMatchesHost(hostModel, "anthropic") || isClaudeModelId(spec.id) || isAnthropicNamespacedModelId(spec.id);
	const isAlibaba = modelMatchesHost(hostModel, "alibabaDashscope");
	const isNvidiaNim = modelMatchesHost(hostModel, "nvidia");
	const isVenice = modelMatchesHost(hostModel, "venice");
	const isQwen = isQwenModelId(spec.id);

	const lowerId = spec.id.toLowerCase();
	const lowerName = (spec.name ?? "").toLowerCase();
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isXiaomiMimo = isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));
	const isMimoReasoningEffortModel =
		!isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));

	const isOpenCodeDeepseekAlias =
		provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	const isDeepseekFamily =
		modelMatchesHost(hostModel, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(spec.name ?? "") ||
		isOpenCodeDeepseekAlias;
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	const isDeepseekReasoning = isDeepseekFamily && Boolean(spec.reasoning);
	const isDirectDeepseekReasoning = isDirectDeepseekApi && isDeepseekReasoning;
	const isGrok = modelMatchesHost(hostModel, "xai");
	const isMistral = modelMatchesHost(hostModel, "mistral");
	const isOpenCodeHost = modelMatchesHost(hostModel, "opencode");

	const isGoogleAistudioOpenAI = hostMatchesUrl(baseUrl, "googleAistudio");
	const isNonStandard =
		isCerebras ||
		isGrok ||
		isMistral ||
		isGoogleAistudioOpenAI ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "deepseekFamily") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isAlibaba ||
		isZai ||
		isZhipu ||
		isKilo ||
		isQwen ||
		isXiaomiHost ||
		isMoonshotNative ||
		isOpenCodeHost;
	const isOpenCodeProvider = provider === "opencode-go" || provider === "opencode-zen";
	const isLocalOpenAICompatBackend =
		!PROXY_OPENAI_COMPAT_PROVIDERS.has(provider) &&
		(LOCAL_OPENAI_COMPAT_PROVIDERS.has(provider) || hasLocalLoopbackBaseUrl(baseUrl));

	const isLocalServingBackend = isLocalOpenAICompatBackend || hasLocalLoopbackBaseUrl(baseUrl);

	const useMaxTokens =
		isMistral ||
		isMoonshotNative ||
		isZai ||
		isZhipu ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isDirectDeepseekApi;

	const supportsPromptCacheBreakpoints = supportsOfficialOpenAIPromptCacheBreakpoints(provider, spec.id, baseUrl);

	const isOpenAIHost = modelMatchesHost(hostModel, "openai");
	const isAzureHost = modelMatchesHost(hostModel, "azureOpenAI");
	const isOpenRouter = modelMatchesHost(hostModel, "openrouter");
	const isVercelGateway = modelMatchesHost(hostModel, "vercelAIGateway");
	const isTogether = modelMatchesHost(hostModel, "together");
	const isFireworks = hostMatchesUrl(baseUrl, "fireworks");
	const isGroqHost = modelMatchesHost(hostModel, "groq");
	const isCopilotHost = provider === "github-copilot";
	const isZenmuxHost = provider === "zenmux";

	const isMiniMaxHost = modelMatchesHost(hostModel, "minimax");
	const isQwenPortal = modelMatchesHost(hostModel, "qwenPortal");
	const supportsMultipleSystemMessagesDefault =
		!isMiniMaxHost &&
		!isAlibaba &&
		!isQwenPortal &&
		!isQwen &&
		(isOpenAIHost ||
			isAzureHost ||
			isOpenRouter ||
			isCerebras ||
			isTogether ||
			isFireworks ||
			isGroqHost ||
			isDeepseekFamily ||
			isMistral ||
			isGrok ||
			isZai ||
			isZhipu ||
			isCopilotHost ||
			isZenmuxHost);

	const streamIdleTimeoutMs =
		GLM_CODING_PLAN_MODEL_PATTERN.test(spec.id) && (isZai || isZhipu || isOpenCodeHost)
			? GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
			: provider === "alibaba-coding-plan"
				? ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
				: isXiaomiMimo
					? XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS
					: spec.reasoning &&
							(isKimiK26ModelId(spec.id) ||
								isMoonshotKimiK3 ||
								(isMoonshotKimi && matchesKimiK27CodeFamily(spec)))
						? KIMI_REASONING_STREAM_IDLE_TIMEOUT_MS
						: spec.reasoning && isDirectDeepseekApi
							? DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS
							: isLocalServingBackend
								? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
								: undefined;

	const isFireworksFastRouter = provider === "fireworks" && isFireworksFastModelId(spec.id);
	const wireModelIdMode: ResolvedOpenAISharedCompat["wireModelIdMode"] =
		provider === "firepass" || isFireworksFastRouter
			? "firepass"
			: provider === "fireworks"
				? "fireworks"
				: isOpenRouter
					? "openrouter"
					: "raw";
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] =
		(isMoonshotKimi && !isMoonshotKimiK3) || isZai || isZhipu || isXiaomiMimo
			? "zai"
			: isOpenRouter
				? "openrouter"
				: isQwen && (isNvidiaNim || provider === "vllm")
					? "qwen-chat-template"
					: isQwen && (isFireworks || isVenice)
						? "openai"
						: isAlibaba || isQwen
							? "qwen"
							: "openai";

	const compat: ResolvedOpenAICompat = {
		supportsStore: !isNonStandard,

		supportsDeveloperRole: isOpenAIHost || isAzureHost,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesDefault,
		supportsReasoningEffort: !isGrok && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort),

		supportsReasoningParams: provider !== "github-copilot",

		supportsSamplingParams: !isOpenAISamplingRestrictedModelId(spec.id),

		supportsPenaltyAndStopParams: !(isGrok && Boolean(spec.reasoning)),
		reasoningEffortMap: {},
		supportsUsageInStreaming: !isCerebras,

		alwaysSendMaxTokens: isKimiModel,

		disableReasoningOnForcedToolChoice: (isKimiModel && !isMoonshotKimiK3) || isAnthropicModel,
		disableReasoningOnToolChoice: isDeepseekFamily && Boolean(spec.reasoning) && !isOpenRouter,
		supportsToolChoice: !isDirectDeepseekReasoning,

		supportsForcedToolChoice: !requiresEnabledThinking && !(isOpenCodeHost && isDeepseekReasoning),
		supportsNamedToolChoice: STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS[provider] !== true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: isMistral,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,

		thinkingFormat,
		kimiApiFormat: undefined,
		reasoningDisableMode: isVenice ? "venice-disable-thinking" : resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: isOpenRouter && isAnthropicModel,
		thinkingKeep: usesMoonshotKimiPreservedThinking ? "all" : undefined,
		reasoningContentField: "reasoning_content",

		requiresReasoningContentForToolCalls:
			(isKimiModel && !isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(spec.reasoning)) ||
			isXiaomiMimo ||
			(isOpenRouter && Boolean(spec.reasoning)),
		requiresReasoningContentForAllAssistantTurns:
			((isDeepseekFamily && Boolean(spec.reasoning)) || isXiaomiMimo) && !isOpenRouter,

		allowsSyntheticReasoningContentForToolCalls: (!isDeepseekFamily || !spec.reasoning) && !isXiaomiMimo,

		replayReasoningContent: isLocalOpenAICompatBackend,

		qwenPreserveThinking:
			(thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") && isLocalOpenAICompatBackend,

		qwenTemplateReasoningEffort:
			(thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") &&
			isLocalOpenAICompatBackend &&
			provider !== "ollama" &&
			isQwen38PlusTemplateEffortModelId(spec.id),
		requiresAssistantContentForToolCalls: isKimiModel || isDirectDeepseekReasoning,
		cacheControlFormat: isOpenRouter && spec.id.startsWith("anthropic/") ? "anthropic" : undefined,
		supportsPromptCacheBreakpoints,
		promptCacheBreakpointTtl: supportsPromptCacheBreakpoints ? "30m" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		wireModelIdMode,
		isVercelGatewayHost: isVercelGateway,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",

		toolSchemaFlavor:
			isMoonshotNative || isKimiModel ? "moonshot-mfjs" : isLocalOpenAICompatBackend ? "grammar" : undefined,
		streamFirstEventTimeoutMs: isLocalServingBackend ? 0 : undefined,
		streamIdleTimeoutMs,
		stripDeepseekSpecialTokens:
			isDeepseekModelIdOrName(spec.id) && (provider === "nvidia" || provider === "deepseek"),
		streamMarkupHealingPattern: detectStreamMarkupHealingPattern(provider, spec.id, baseUrl),
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(provider) || MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.id),
		emptyLengthFinishIsContextError: provider === "ollama",
		usesOpenAIToolCallIdLimit: provider === "openai",
		promptCacheSessionHeader: isGrok ? "x-grok-conv-id" : undefined,
		dropThinkingWhenReasoningEffort: provider === "fireworks",
	};

	applyCompatOverrides(compat, spec.compat);
	const deepseekThinking = compat.extraBody?.thinking;
	if (
		isDirectDeepseekReasoning &&
		typeof deepseekThinking === "object" &&
		deepseekThinking !== null &&
		"type" in deepseekThinking &&
		deepseekThinking.type === "enabled"
	) {
		const extraBody = { ...compat.extraBody };
		delete extraBody.thinking;
		compat.extraBody = Object.keys(extraBody).length > 0 ? extraBody : undefined;
	}
	if (spec.compat?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = requiresEnabledThinking
			? "omit"
			: isDirectDeepseekReasoning
				? "zai-thinking-disabled"
				: isVenice
					? "venice-disable-thinking"
					: resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (spec.compat?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}
	mergeModelReasoningEffortMap(compat, spec.id, isMimoReasoningEffortModel);

	const whenThinkingPolicy =
		spec.compat?.whenThinking ??
		(isDirectDeepseekReasoning
			? { extraBody: { ...compat.extraBody, thinking: { type: "enabled" } } }
			: isOpenCodeProvider && spec.reasoning
				? OPENCODE_WHEN_THINKING
				: undefined);
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat };
		applyCompatOverrides(variant, whenThinkingPolicy);
		if (whenThinkingPolicy.reasoningDisableMode === undefined) {
			variant.reasoningDisableMode = isVenice
				? "venice-disable-thinking"
				: resolveReasoningDisableMode(variant.thinkingFormat);
		}
		if (whenThinkingPolicy.omitReasoningEffort === undefined && !variant.supportsReasoningEffort) {
			variant.omitReasoningEffort = true;
		}
		mergeModelReasoningEffortMap(variant, spec.id, isMimoReasoningEffortModel);
		compat.whenThinking = variant;
	}

	return compat;
}

interface OpenAIResponsesSpecLike {
	id?: string;
	provider: string;
	name: string;
	baseUrl: string;
	reasoning?: boolean;
	compat?: OpenAICompat;
}

export function buildOpenAIResponsesCompat(spec: OpenAIResponsesSpecLike): ResolvedOpenAIResponsesCompat {
	const baseUrl = spec.baseUrl ?? "";
	const isAzure = modelMatchesHost({ provider: spec.provider, baseUrl }, "azureOpenAI");
	const isOpenRouter = modelMatchesHost({ provider: spec.provider, baseUrl }, "openrouter");
	const isOpenAIUrl = hostMatchesUrl(baseUrl, "openai");
	const isVercelGateway = modelMatchesHost({ provider: spec.provider, baseUrl }, "vercelAIGateway");
	const id = spec.id ?? "";
	const supportsPromptCacheBreakpoints = supportsOfficialOpenAIPromptCacheBreakpoints(spec.provider, id, baseUrl);
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] = isOpenRouter ? "openrouter" : "openai";
	const isKimiModel = id ? isKimiModelId(id) : false;
	const isAnthropicModel = id ? isClaudeModelId(id) || isAnthropicNamespacedModelId(id) : false;
	const isDeepseekFamily = id ? isDeepseekModelIdOrName(id) || isDeepseekModelIdOrName(spec.name) : false;
	const reasoningCapable = Boolean(spec.reasoning);

	const isLocalServingBackend =
		(!PROXY_OPENAI_COMPAT_PROVIDERS.has(spec.provider) && LOCAL_OPENAI_COMPAT_PROVIDERS.has(spec.provider)) ||
		hasLocalLoopbackBaseUrl(baseUrl);
	const isXaiHost = modelMatchesHost({ provider: spec.provider, baseUrl }, "xai");

	const compat: ResolvedOpenAIResponsesCompat = {
		supportsDeveloperRole: isAzure || isOpenAIUrl || hostMatchesUrl(baseUrl, "githubCopilot"),
		supportsStrictMode: isAzure || detectStrictModeSupport(spec.provider, baseUrl),

		supportsReasoningEffort: !isXaiHost || isGrokReasoningEffortCapable(id),
		supportsLongPromptCacheRetention: isOpenAIUrl,
		supportsPromptCacheBreakpoints,
		promptCacheBreakpointTtl: supportsPromptCacheBreakpoints ? "30m" : undefined,

		strictResponsesPairing: isAzure || spec.provider === "github-copilot",

		supportsImageDetailOriginal:
			!isXaiHost && !modelMatchesHost({ provider: spec.provider, baseUrl }, "githubCopilot"),

		supportsReasoningSummary: !isXaiHost,
		reasoningEffortMap: isXaiHost ? { ...xaiResponsesReasoningEffortMap(id) } : {},
		supportsReasoningParams: true,

		supportsSamplingParams: !isOpenAISamplingRestrictedModelId(id),

		supportsPenaltyAndStopParams: !isXaiHost,
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,

		includeEncryptedReasoning: true,
		filterReasoningHistory: isOpenRouter && isAnthropicModel,
		disableReasoningOnForcedToolChoice: isKimiModel,
		disableReasoningOnToolChoice: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		supportsToolChoice: true,
		supportsForcedToolChoice: spec.provider !== "opencode-go" && spec.provider !== "opencode-zen",
		supportsNamedToolChoice: STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS[spec.provider] !== true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls:
			(isKimiModel || (isDeepseekFamily && reasoningCapable) || (isOpenRouter && reasoningCapable)) &&
			reasoningCapable,
		requiresReasoningContentForAllAssistantTurns: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseekFamily || !reasoningCapable,

		replayReasoningContent: false,

		qwenPreserveThinking: false,
		qwenTemplateReasoningEffort: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresAssistantContentForToolCalls: isKimiModel,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		isVercelGatewayHost: isVercelGateway,
		wireModelIdMode: isOpenRouter ? "openrouter" : "raw",

		toolSchemaFlavor: isKimiModel ? "moonshot-mfjs" : undefined,
		alwaysSendMaxTokens: spec.id ? isKimiModelId(spec.id) : false,
		supportsObfuscationOptOut: isOpenAIUrl || spec.provider === "openai",
		stripDeepseekSpecialTokens:
			Boolean(id) && isDeepseekModelIdOrName(id) && (spec.provider === "nvidia" || spec.provider === "deepseek"),
		streamMarkupHealingPattern: id ? detectStreamMarkupHealingPattern(spec.provider, id, baseUrl) : undefined,
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.provider) || (id ? MINIMAX_PROVIDER_OR_ID_PATTERN.test(id) : false),
		emptyLengthFinishIsContextError: spec.provider === "ollama",
		usesOpenAIToolCallIdLimit: spec.provider === "openai",
		promptCacheSessionHeader: isXaiHost ? "x-grok-conv-id" : undefined,
		streamFirstEventTimeoutMs: isLocalServingBackend ? 0 : spec.compat?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: isLocalServingBackend
			? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
			: spec.compat?.streamIdleTimeoutMs,
	};
	applyCompatOverrides(compat, spec.compat);
	if (isXaiHost) {
		const canonical = xaiResponsesReasoningEffortMap(id);
		compat.reasoningEffortMap = { ...compat.reasoningEffortMap, ...canonical };

		for (const key of ["xhigh", "max"] as const) {
			if (!(key in canonical)) {
				delete compat.reasoningEffortMap[key];
			}
		}
	}
	if (spec.compat?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (spec.compat?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}

	if (
		spec.provider === "xai-oauth" &&
		isGrokReasoningEffortCapable(id) &&
		spec.compat?.supportsReasoningEffort !== false
	) {
		compat.supportsReasoningEffort = true;
		compat.omitReasoningEffort = false;
	}
	return compat;
}

type ResponsesOnlyCompat = Omit<ResolvedOpenAIResponsesCompat, keyof ResolvedOpenAISharedCompat>;

function pickResponsesOnly(compat: ResolvedOpenAIResponsesCompat): ResponsesOnlyCompat {
	return {
		supportsLongPromptCacheRetention: compat.supportsLongPromptCacheRetention,
		strictResponsesPairing: compat.strictResponsesPairing,
		supportsImageDetailOriginal: compat.supportsImageDetailOriginal,
		supportsObfuscationOptOut: compat.supportsObfuscationOptOut,
		supportsReasoningSummary: compat.supportsReasoningSummary,
		isVercelGatewayHost: compat.isVercelGatewayHost,
	} satisfies ResponsesOnlyCompat;
}

export function buildOpenRouterCompat(spec: ModelSpec<"openrouter">): ResolvedOpenRouterCompat {
	const chat = buildOpenAICompat({
		...spec,
		api: "openai-completions",
	} as ModelSpec<"openai-completions">);
	const responses = buildOpenAIResponsesCompat(spec);
	return { ...chat, ...pickResponsesOnly(responses) } as ResolvedOpenRouterCompat;
}
