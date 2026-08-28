import { Effort, THINKING_EFFORTS } from "./effort";
import { modelMatchesHost } from "./hosts";
import {
	type AnthropicModel,
	bareModelId,
	type GeminiModel,
	isAnthropicAdaptiveGenAtLeast,
	type OpenAIModel,
	type ParsedModel,
	parseAnthropicModel,
	parseKnownModel,
	parseOpenAIModel,
	semverEqual,
	semverGte,
} from "./identity/classify";
import {
	findThinkingVariantToken,
	isDeepseekModelIdOrName,
	isDeepseekV4FlashModelId,
	isGlm52ReasoningEffortModelId,
	isGlm53ReasoningEffortModelId,
	isGrokXHighEffortCapable,
	isKimiK3ModelId,
	isMimoModelIdOrName,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	isOpenAIGptOssModelId,
	isQwenModelId,
	supportsAdaptiveThinkingDisplay,
} from "./identity/family";
import type {
	Api,
	CompatOf,
	Model,
	ModelSpec,
	ResolvedDevinCompat,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ThinkingConfig,
} from "./types";

type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;

const DEFAULT_REASONING_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const DEFAULT_REASONING_EFFORTS_WITH_XHIGH: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
];
const GEMINI_3_PRO_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];
const GEMINI_3_FLASH_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GPT_5_2_PLUS_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
const GPT_5_1_CODEX_MINI_EFFORTS: readonly Effort[] = [Effort.Medium, Effort.High];
const LOW_MEDIUM_HIGH_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High];

const LOW_HIGH_MAX_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High, Effort.Max];

const HIGH_MAX_REASONING_EFFORTS: readonly Effort[] = [Effort.High, Effort.Max];

const HIGH_ONLY_REASONING_EFFORTS: readonly Effort[] = [Effort.High];

const QWEN38_TEMPLATE_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.XHigh];

const FIVE_TIER_EFFORTS_LOW_TO_MAX: readonly Effort[] = [
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

const FOUR_TIER_EFFORTS_LOW_TO_MAX: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];

const DEFAULT_REASONING_EFFORTS_WITH_MAX: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.Max,
];

const OLLAMA_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];
type EffortMap = Partial<Record<Effort, string>>;

const GROQ_QWEN3_32B_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "default",
	[Effort.Low]: "default",
	[Effort.Medium]: "default",
	[Effort.High]: "default",
	[Effort.XHigh]: "default",
};
const FIREWORKS_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "none",
};
const MIMO_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "low",
	[Effort.XHigh]: "high",
};

const MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Low]: "adaptive",
	[Effort.Medium]: "adaptive",
	[Effort.High]: "adaptive",
};

export function resolveModelThinking<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): ThinkingConfig | undefined {
	if (!spec.reasoning) return undefined;
	if (omitsWireReasoningEffort(spec.api, compat)) return undefined;
	if (spec.thinking && Array.isArray(spec.thinking.efforts) && spec.thinking.efforts.length > 0) {
		return fillThinkingWireDefaults(spec, compat, spec.thinking);
	}

	if ((compat as ResolvedDevinCompat | undefined)?.trustExplicitThinkingOnly === true) return undefined;

	return deriveThinking(spec, compat);
}

function fillThinkingWireDefaults<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const normalizedEfforts = getModelDefinedEfforts(spec, compat) ?? thinking.efforts;
	const effortsChanged = !sameEffortList(normalizedEfforts, thinking.efforts);
	const effortMap =
		thinking.effortMap === undefined || effortsChanged
			? inferEffortMap(spec, compat, thinking.mode, normalizedEfforts)
			: undefined;
	const shouldReplaceEffortMap = thinking.effortMap === undefined ? effortMap !== undefined : effortsChanged;
	const needsDisplay =
		thinking.supportsDisplay === undefined &&
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id);
	const needsRequiresEffort =
		thinking.requiresEffort === undefined &&
		(impliesMandatoryReasoning(parsed, spec.id) ||
			isQwenTemplateReasoningEffortCompat(compat) ||
			isOpenCodeGatewayOxAlphaModel(spec));
	const needsDefaultLevel =
		thinking.defaultLevel === undefined && (isKimiK3ModelId(spec.id) || isGlm53ReasoningEffortModelId(spec.id));
	if (!effortsChanged && !shouldReplaceEffortMap && !needsDisplay && !needsRequiresEffort && !needsDefaultLevel) {
		return thinking;
	}
	const filled: ThinkingConfig = { ...thinking };
	if (effortsChanged) {
		filled.efforts = normalizedEfforts;
	}
	if (shouldReplaceEffortMap) {
		if (effortMap === undefined) {
			delete filled.effortMap;
		} else {
			filled.effortMap = effortMap;
		}
	}
	if (needsDisplay) {
		filled.supportsDisplay = true;
	}
	if (needsDefaultLevel) {
		filled.defaultLevel = Effort.Max;
	}
	if (needsRequiresEffort) {
		filled.requiresEffort = true;
	}
	return filled;
}

export function deriveThinking<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const efforts = inferSupportedEfforts(parsed, spec, compat);
	if (efforts.length === 0) {
		throw new Error(`Model ${spec.provider}/${spec.id} resolved to an empty thinking range`);
	}
	const config: ThinkingConfig = {
		mode: inferThinkingControlMode(spec, parsed),
		efforts,
	};
	if (isKimiK3ModelId(spec.id) || isGlm53ReasoningEffortModelId(spec.id)) {
		config.defaultLevel = Effort.Max;
	}
	const effortMap = inferEffortMap(spec, compat, config.mode, config.efforts);
	if (effortMap !== undefined) {
		config.effortMap = effortMap;
	}
	if (
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id)
	) {
		config.supportsDisplay = true;
	}
	if (
		impliesMandatoryReasoning(parsed, spec.id) ||
		isQwenTemplateReasoningEffortCompat(compat) ||
		isOpenCodeGatewayOxAlphaModel(spec)
	) {
		config.requiresEffort = true;
	}
	return config;
}

function omitsWireReasoningEffort(api: Api, compat: CompatOf<Api>): boolean {
	if (api !== "openai-responses" && api !== "openai-codex-responses" && api !== "azure-openai-responses") {
		return false;
	}
	return (compat as ResolvedOpenAIResponsesCompat | undefined)?.supportsReasoningEffort === false;
}

function inferEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
	efforts: readonly Effort[],
): EffortMap | undefined {
	const detected = inferDetectedEffortMap(spec, compat, mode);
	const configured = readCompatEffortMap(compat);
	const merged =
		detected === undefined ? configured : configured === undefined ? detected : { ...detected, ...configured };
	return merged === undefined ? undefined : filterEffortMapToSupportedEfforts(merged, efforts);
}

function filterEffortMapToSupportedEfforts(map: EffortMap, efforts: readonly Effort[]): EffortMap | undefined {
	let filtered: EffortMap | undefined;
	for (const effort of efforts) {
		const mapped = map[effort];
		if (mapped === undefined) continue;
		if (filtered === undefined) filtered = {};
		filtered[effort] = mapped;
	}
	return filtered;
}

function sameEffortList(left: readonly Effort[], right: readonly Effort[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isOpenAICompatReasoningApi(api: Api): boolean {
	return api === "openai-completions" || api === "openrouter";
}

function isGpt56PlusWireEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	switch (spec.api) {
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
		case "openai-completions":
		case "openrouter":
			break;
		default:
			return false;
	}
	const parsed = parseOpenAIModel(bareModelId(spec.id));
	return parsed !== null && semverGte(parsed.version, "5.6");
}

function getModelDefinedEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] | undefined {
	if (isGlm53ReasoningEffortModelId(spec.id)) {
		return LOW_HIGH_MAX_REASONING_EFFORTS;
	}
	if (isGlm52ReasoningEffortModelId(spec.id)) {
		if (isOpenRouterThinkingFormat(compat)) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		if (
			isZaiThinkingFormat(compat) ||
			isAnthropicMessagesGlm52ReasoningEffortModel(spec) ||
			isOllamaCloudGlm52ReasoningEffortModel(spec) ||
			spec.provider === "baseten"
		) {
			return HIGH_MAX_REASONING_EFFORTS;
		}
		if (isOpenAICompatReasoningApi(spec.api)) {
			return DEFAULT_REASONING_EFFORTS_WITH_MAX;
		}
	}
	if (isKimiK3ModelId(spec.id)) {
		return LOW_HIGH_MAX_REASONING_EFFORTS;
	}
	if (isOpenCodeGatewayOxAlphaModel(spec)) {
		return LOW_HIGH_MAX_REASONING_EFFORTS;
	}
	if (isSakanaFuguReasoningModel(spec)) {
		return HIGH_MAX_REASONING_EFFORTS;
	}
	if (isGpt56PlusWireEffortModel(spec)) {
		return FIVE_TIER_EFFORTS_LOW_TO_MAX;
	}
	const anthropicAdaptive = getAnthropicAdaptiveEfforts(spec);
	if (anthropicAdaptive !== undefined) {
		return anthropicAdaptive;
	}

	if (spec.provider === "firepass") {
		return FIVE_TIER_EFFORTS_LOW_TO_MAX;
	}

	if (spec.provider === "ollama") {
		return OLLAMA_REASONING_EFFORTS;
	}

	if (isOpenAICompatReasoningApi(spec.api) && isQwenTemplateReasoningEffortCompat(compat)) {
		return QWEN38_TEMPLATE_REASONING_EFFORTS;
	}
	if (
		(isOpenAICompatReasoningApi(spec.api) ||
			spec.api === "openai-responses" ||
			(spec.api === "ollama-chat" && spec.provider === "ollama-cloud")) &&
		isDeepseekReasoningModel(spec)
	) {
		if (isDeepseekV4FlashModelId(spec.id)) {
			return LOW_HIGH_MAX_REASONING_EFFORTS;
		}
		if (bareModelId(spec.id).toLowerCase().includes("deepseek-v4")) {
			if (!isOpenRouterThinkingFormat(compat)) {
				return LOW_HIGH_MAX_REASONING_EFFORTS;
			}
			return bareModelId(spec.id).toLowerCase() === "deepseek-v4-pro-0813"
				? LOW_HIGH_MAX_REASONING_EFFORTS
				: HIGH_ONLY_REASONING_EFFORTS;
		}
		return isOpenRouterThinkingFormat(compat) ? HIGH_ONLY_REASONING_EFFORTS : HIGH_MAX_REASONING_EFFORTS;
	}
	if (spec.provider === "baseten" && isOpenAIGptOssModelId(spec.id)) {
		return HIGH_MAX_REASONING_EFFORTS;
	}

	if (modelMatchesHost({ provider: spec.provider, baseUrl: spec.baseUrl ?? "" }, "xai")) {
		return isGrokXHighEffortCapable(spec.id) ? DEFAULT_REASONING_EFFORTS_WITH_XHIGH : DEFAULT_REASONING_EFFORTS;
	}
	return isOpenAICompatReasoningApi(spec.api) &&
		(isMinimaxM2FamilyModelId(spec.id) ||
			isOpenAIGptOssModelId(spec.id) ||
			isOpenAICompatMimoReasoningEffortModel(spec, compat))
		? LOW_MEDIUM_HIGH_REASONING_EFFORTS
		: undefined;
}

function getAnthropicAdaptiveEfforts<TApi extends Api>(spec: ModelSpec<TApi>): readonly Effort[] | undefined {
	const parsed = parseAnthropicModel(bareModelId(spec.id));
	if (!parsed || !isAnthropicAdaptiveGenAtLeast(parsed, "4.6")) return undefined;
	if (spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") {
		return anthropicModelHasRealXHighEffort(spec, parsed)
			? FIVE_TIER_EFFORTS_LOW_TO_MAX
			: FOUR_TIER_EFFORTS_LOW_TO_MAX;
	}
	if (isOpenRouterAnthropicAdaptiveReasoningModel(parsed, spec)) {
		return isAnthropicAdaptiveGenAtLeast(parsed, "4.7") ? FIVE_TIER_EFFORTS_LOW_TO_MAX : FOUR_TIER_EFFORTS_LOW_TO_MAX;
	}
	return undefined;
}

function isOllamaCloudGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "ollama-chat" && spec.provider === "ollama-cloud" && isGlm52ReasoningEffortModelId(spec.id);
}

function isAnthropicMessagesGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return (
		spec.api === "anthropic-messages" &&
		(spec.provider === "umans" || spec.provider === "zai") &&
		isGlm52ReasoningEffortModelId(spec.id)
	);
}

function isMinimaxReasoningModelOnAnthropicEndpoint<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "anthropic-messages" && (isMinimaxM2FamilyModelId(spec.id) || isMinimaxM3FamilyModelId(spec.id));
}

function isOpenAICompatMimoReasoningEffortModel<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): boolean {
	if (!isOpenAICompatReasoningApi(spec.api)) return false;
	if (!isMimoModelIdOrName(spec.id) && !isMimoModelIdOrName(spec.name ?? "")) return false;
	const resolved = compat as ResolvedOpenAICompat | undefined;
	return (
		(resolved?.thinkingFormat === "openai" || resolved?.thinkingFormat === "openrouter") &&
		resolved.supportsReasoningEffort
	);
}

function readCompatEffortMap(compat: CompatOf<Api>): EffortMap | undefined {
	if (compat === undefined || !("reasoningEffortMap" in compat)) {
		return undefined;
	}
	const map = compat.reasoningEffortMap;
	return map && Object.keys(map).length > 0 ? map : undefined;
}

function isOpenRouterThinkingFormat(compat: CompatOf<Api>): boolean {
	return compat !== undefined && "thinkingFormat" in compat && compat.thinkingFormat === "openrouter";
}

function isZaiThinkingFormat(compat: CompatOf<Api>): boolean {
	return compat !== undefined && "thinkingFormat" in compat && compat.thinkingFormat === "zai";
}

function isQwenTemplateReasoningEffortCompat(compat: CompatOf<Api>): boolean {
	return (
		compat !== undefined && "qwenTemplateReasoningEffort" in compat && compat.qwenTemplateReasoningEffort === true
	);
}

function inferDetectedEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
): EffortMap | undefined {
	if (mode === "anthropic-adaptive") {
		if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
			return MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP;
		}

		return undefined;
	}
	if (!isOpenAICompatReasoningApi(spec.api)) {
		return undefined;
	}
	if (spec.provider === "groq" && spec.id === "qwen/qwen3-32b") {
		return GROQ_QWEN3_32B_REASONING_EFFORT_MAP;
	}
	if (isOpenAICompatMimoReasoningEffortModel(spec, compat)) {
		return MIMO_REASONING_EFFORT_MAP;
	}

	if (modelMatchesHost(spec, "fireworks")) {
		return FIREWORKS_REASONING_EFFORT_MAP;
	}
	return undefined;
}

function isSakanaFuguReasoningModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.provider === "sakana" && /^fugu(?:$|-)/i.test(spec.id);
}

function isOpenCodeGatewayOxAlphaModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return (
		(spec.provider === "opencode-go" || spec.provider === "opencode-zen") &&
		/(?:^|\/)ox-alpha(?:-|$)/i.test(bareModelId(spec.id))
	);
}

function isDeepseekReasoningModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	if (!spec.reasoning) return false;
	const lowerId = spec.id.toLowerCase();
	const lowerName = (spec.name ?? "").toLowerCase();
	const isOpenCodeDeepseekAlias =
		spec.provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	return (
		modelMatchesHost(spec, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(spec.name ?? "") ||
		isOpenCodeDeepseekAlias
	);
}

function inferSupportedEfforts<TApi extends Api>(
	parsedModel: ParsedModel,
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] {
	const modelDefinedEfforts = getModelDefinedEfforts(spec, compat);
	if (modelDefinedEfforts !== undefined) {
		return modelDefinedEfforts;
	}
	switch (parsedModel.family) {
		case "openai":
			return inferOpenAISupportedEfforts(parsedModel);
		case "gemini":
			return inferGeminiSupportedEfforts(parsedModel);
		case "anthropic":
			return inferAnthropicSupportedEfforts(parsedModel, spec, compat);
		case "unknown":
			return inferFallbackEfforts(spec, compat);
	}
}

function inferOpenAISupportedEfforts(model: OpenAIModel): readonly Effort[] {
	if (model.variant === "codex-mini" && semverEqual(model.version, "5.1")) {
		return GPT_5_1_CODEX_MINI_EFFORTS;
	}

	if (semverGte(model.version, "5.6")) {
		return FIVE_TIER_EFFORTS_LOW_TO_MAX;
	}
	if (semverGte(model.version, "5.2")) {
		return GPT_5_2_PLUS_EFFORTS;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function inferGeminiSupportedEfforts(model: GeminiModel): readonly Effort[] {
	if (!semverGte(model.version, "3.0")) {
		return DEFAULT_REASONING_EFFORTS;
	}
	return model.kind === "pro" ? GEMINI_3_PRO_EFFORTS : GEMINI_3_FLASH_EFFORTS;
}

const OPENAI_O_SERIES_RE = /^o[134](?:$|[-:.])/i;

function impliesMandatoryReasoning(parsed: ParsedModel, modelId: string): boolean {
	if (parsed.family === "gemini") {
		if (semverGte(parsed.version, "3.0")) return true;
		if (parsed.kind === "pro" && semverGte(parsed.version, "2.5")) return true;
	}
	if (isKimiK3ModelId(modelId)) return true;

	if (isGlm53ReasoningEffortModelId(modelId)) return true;
	if (isMinimaxM2FamilyModelId(modelId)) return true;
	if (OPENAI_O_SERIES_RE.test(bareModelId(modelId))) return true;
	return findThinkingVariantToken(modelId) !== undefined;
}

function inferAnthropicSupportedEfforts<TApi extends Api>(
	parsedModel: AnthropicModel,
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] {
	if (spec.api === "anthropic-messages" && semverGte(parsedModel.version, "4.6")) {
		return LOW_MEDIUM_HIGH_REASONING_EFFORTS;
	}

	if (spec.api === "bedrock-converse-stream" && semverGte(parsedModel.version, "4.6")) {
		return DEFAULT_REASONING_EFFORTS;
	}
	return inferFallbackEfforts(spec, compat);
}

function inferFallbackEfforts<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): readonly Effort[] {
	const modelDefinedEfforts = getModelDefinedEfforts(spec, compat);
	if (modelDefinedEfforts !== undefined) return modelDefinedEfforts;
	if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
		return LOW_MEDIUM_HIGH_REASONING_EFFORTS;
	}
	if (spec.api === "anthropic-messages") {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	if (spec.name.includes("deepseek-v4")) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	if (spec.api === "bedrock-converse-stream") {
		return DEFAULT_REASONING_EFFORTS;
	}
	if (isOpenAICompatReasoningApi(spec.api)) {
		const resolved = compat as ResolvedOpenAICompat;
		if (
			resolved.thinkingFormat === "openai" &&
			modelMatchesHost({ provider: spec.provider, baseUrl: spec.baseUrl ?? "" }, "venice") &&
			isQwenModelId(spec.id)
		) {
			return DEFAULT_REASONING_EFFORTS;
		}
		if (resolved.thinkingFormat === "openai" && resolved.supportsReasoningEffort) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		return DEFAULT_REASONING_EFFORTS;
	}

	if (
		spec.api === "openai-responses" ||
		spec.api === "openai-codex-responses" ||
		spec.api === "azure-openai-responses"
	) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function inferThinkingControlMode<TApi extends Api>(
	spec: ModelSpec<TApi>,
	parsedModel: ParsedModel,
): ThinkingConfig["mode"] {
	switch (spec.api) {
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return parsedModel.family === "gemini" &&
				semverGte(parsedModel.version, "3.0") &&
				parsedModel.version.major === 3
				? "google-level"
				: "budget";

		case "anthropic-messages":
			if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
				return "anthropic-adaptive";
			}
			if (isAnthropicMessagesGlm52ReasoningEffortModel(spec)) {
				return "anthropic-budget-effort";
			}
			if (parsedModel.family === "anthropic") {
				if (semverGte(parsedModel.version, "4.6")) {
					return "anthropic-adaptive";
				}

				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		case "bedrock-converse-stream":
			if (parsedModel.family === "anthropic") {
				if (isAnthropicAdaptiveGenAtLeast(parsedModel, "4.6")) {
					return "anthropic-adaptive";
				}

				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		default:
			return "effort";
	}
}

function isOpenRouterAnthropicAdaptiveReasoningModel<TApi extends Api>(
	parsedModel: AnthropicModel,
	spec: ModelSpec<TApi>,
): boolean {
	if (!isOpenAICompatReasoningApi(spec.api)) return false;
	if (!modelMatchesHost(spec, "openrouter")) return false;
	return isAnthropicAdaptiveGenAtLeast(parsedModel, "4.6");
}

function anthropicModelHasRealXHighEffort<TApi extends Api>(spec: ModelSpec<TApi>, parsedModel: ParsedModel): boolean {
	if (spec.api !== "anthropic-messages") return false;
	if (parsedModel.family !== "anthropic") return false;
	return isAnthropicAdaptiveGenAtLeast(parsedModel, "4.7");
}

export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

export function mapEffortToGoogleThinkingLevel<TApi extends Api>(
	effort: Effort,
	model?: ApiModel<TApi>,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	if (effort === Effort.Minimal) {
		const routing = model?.thinking?.effortRouting;
		if (routing?.[Effort.Minimal] && routing[Effort.Minimal] === routing[Effort.Low]) {
			return "LOW";
		}
		return "MINIMAL";
	}
	switch (effort) {
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return "HIGH";
	}
}

export function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" {
	const supported = requireSupportedEffort(model, effort);
	return (model.thinking?.effortMap?.[supported] ?? supported) as
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "adaptive";
}

export function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	for (const effort of THINKING_EFFORTS) {
		if (efforts.includes(effort)) return effort;
	}
	return efforts[0];
}
