import {
	bareModelId,
	isAnthropicAdaptiveGenAtLeast,
	isFableOrMythos,
	parseAnthropicModel,
	parseGlmModel,
	parseKnownModel,
	parseOpenAIModel,
	semverGte,
} from "./classify";

function memo<T>(fn: (modelId: string) => T): (modelId: string) => T {
	const cache = new Map<string, T>();
	return (modelId: string) => {
		if (cache.has(modelId)) {
			return cache.get(modelId) as T;
		}
		const result = fn(modelId);
		cache.set(modelId, result);
		return result;
	};
}

export const isKimiModelId = memo((modelId: string): boolean => {
	return modelId.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(modelId);
});

export const isKimiK26ModelId = memo((modelId: string): boolean => {
	return /(^|\/)kimi-k2(?:\.6|p6)(?:[-:]|$)/i.test(modelId);
});

export const isKimiK3ModelId = memo((modelId: string): boolean => {
	return /(^|\/)kimi-k3(?:\.\d+)?(?:[-.:_]|$)/i.test(modelId);
});

export const isClaudeModelId = memo((modelId: string): boolean => {
	return /(^|[/.])claude[-.]/i.test(modelId);
});

export const isAnthropicNamespacedModelId = memo((modelId: string): boolean => {
	return /(^|\/)anthropic\//i.test(modelId);
});

export const isQwenModelId = memo((modelId: string): boolean => {
	return modelId.toLowerCase().includes("qwen");
});

export const isQwen38PlusTemplateEffortModelId = memo((modelId: string): boolean => {
	const match = /qwen[-_ ]?(\d+)\.(\d+)(?![\dbB])/i.exec(modelId);
	if (!match) return false;
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major < 3 || (major === 3 && minor < 8)) return false;
	return !/^-max(?:$|[-.:])/i.test(modelId.slice(match.index + match[0].length));
});

export const isGemmaModelId = memo((modelId: string): boolean => {
	return /(^|\/)gemma[-.]?\d/i.test(modelId);
});

export const isDeepseekModelIdOrName = memo((value: string): boolean => {
	return value.toLowerCase().includes("deepseek");
});

export const isDeepseekV4FlashModelId = memo((modelId: string): boolean => {
	return bareModelId(modelId).toLowerCase().includes("deepseek-v4-flash");
});

export const isMimoModelIdOrName = memo((value: string): boolean => {
	return value.toLowerCase().includes("mimo");
});

export const isStep37FlashModelId = memo((modelId: string): boolean => {
	return modelId.toLowerCase().includes("step-3.7-flash");
});

export const isGeminiModelId = memo((modelId: string): boolean => {
	return /(^|\/)gemini[-.]?/i.test(modelId);
});

export const isGrokModelId = memo((modelId: string): boolean => {
	return /(?:^|[./_-])grok(?:[-.]|$)/i.test(modelId);
});

const GROK_EFFORT_CAPABLE_PREFIXES = [
	"grok-3-mini",
	"grok-4.20-multi-agent",
	"grok-4.3",
	"grok-4.5",
	"grok-4.6",
] as const;

export const isGrokReasoningEffortCapable = memo((modelId: string): boolean => {
	const bare = bareModelId(modelId).trim().toLowerCase();
	if (!bare) return false;
	return GROK_EFFORT_CAPABLE_PREFIXES.some(prefix => bare.startsWith(prefix));
});

export const isGrokMultiAgentModelId = memo((modelId: string): boolean => {
	return bareModelId(modelId).trim().toLowerCase().startsWith("grok-4.20-multi-agent");
});

export const isGrokXHighEffortCapable = memo((modelId: string): boolean => {
	if (isGrokMultiAgentModelId(modelId)) return true;
	return bareModelId(modelId).trim().toLowerCase().startsWith("grok-4.6");
});

export const isMinimaxM2FamilyModelId = memo((modelId: string): boolean => {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;

	return /(?:^|[/.-])m2\d*(?:[.-]\d+)?(?:[-.:_]|$)/i.test(lower);
});

export const isMinimaxM3FamilyModelId = memo((modelId: string): boolean => {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;
	return /(?:^|[/._-])(?:minimax[/._-])?m3(?:[-.:_]|$)/i.test(lower);
});

export const isOpenAIGptOssModelId = memo((modelId: string): boolean => {
	return /(^|\/)gpt-oss[-:]/i.test(modelId);
});

export const isMuseSparkModelId = memo((modelId: string): boolean => {
	return /(^|\/)muse-spark(?:[-.]|$)/i.test(modelId);
});

export const isOpenAIModelId = memo((modelId: string): boolean => {
	return (
		/(^|\/)(?:gpt|chatgpt|codex)[-.]/i.test(modelId) ||
		/(^|\/)o[134](?:[-.]|$)/i.test(modelId) ||
		modelId.toLowerCase().includes("openai/")
	);
});

const isOpenAIWireGen54Plus = memo((modelId: string): boolean => {
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "5.4");
});

export const supportsAllTurnsReasoningContext = isOpenAIWireGen54Plus;

export const supportsCodexReasoningSummary = isOpenAIWireGen54Plus;

const isOpenAIWireGen5Plus = memo((modelId: string): boolean => {
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "5");
});

const O_SERIES_REASONING_RE = /(^|\/)o[134](?:[-.]|$)/i;

export const isOpenAISamplingRestrictedModelId = memo((modelId: string): boolean => {
	const bare = bareModelId(modelId);
	return isOpenAIWireGen5Plus(modelId) || O_SERIES_REASONING_RE.test(bare);
});

export const isReasoningGlmModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant === "flash") {
		return semverGte(glm.version, "5.3");
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "4.5");
});

export const isGlm52ReasoningEffortModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "5.2");
});

export const isGlm53ReasoningEffortModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo" && glm.variant !== "flash") {
		return false;
	}
	return semverGte(glm.version, "5.3");
});

export const isGlmVisionModelId = memo((modelId: string): boolean => {
	return parseGlmModel(bareModelId(modelId))?.vision === true;
});

export const modelFamilyToken = memo((modelId: string): string => {
	const parsed = parseKnownModel(modelId);
	if (parsed.family !== "unknown") return parsed.family;
	if (isClaudeModelId(modelId) || isAnthropicNamespacedModelId(modelId)) return "anthropic";
	if (isGeminiModelId(modelId)) return "gemini";
	if (isGrokModelId(modelId)) return "grok";
	if (isDeepseekModelIdOrName(modelId)) return "deepseek";
	if (isOpenAIModelId(modelId)) return "openai";
	if (isKimiModelId(modelId)) return "kimi";
	if (isQwenModelId(modelId)) return "qwen";
	if (isMinimaxM2FamilyModelId(modelId) || isMinimaxM3FamilyModelId(modelId)) return "minimax";
	if (isOpenAIGptOssModelId(modelId)) return "gpt-oss";
	if (isMimoModelIdOrName(modelId)) return "mimo";
	if (isGemmaModelId(modelId)) return "gemma";
	if (parseGlmModel(bareModelId(modelId))) return "glm";
	return "";
});

export const anthropicModelSupportsThinking = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && semverGte(parsed.version, "3.7");
});

export const supportsAdaptiveThinkingDisplay = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.7");
});

export const hasOpus47ApiRestrictions = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.7");
});

export const supportsMidConversationSystemMessages = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.8");
});

export const supportsHashlineEdits = memo((modelId: string): boolean => {
	return !(
		isKimiModelId(modelId) ||
		isMimoModelIdOrName(modelId) ||
		isDeepseekV4FlashModelId(modelId) ||
		isStep37FlashModelId(modelId)
	);
});

export const isAnthropicFableOrMythosModel = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isFableOrMythos(parsed.kind);
});

export interface ThinkingVariantToken {
	index: number;
	length: number;
}

const THINKING_VARIANT_TOKEN_RE = /-(?:thinking|reasoner|reasoning)(?=$|[^a-z0-9])/gi;

export function findThinkingVariantToken(modelId: string): ThinkingVariantToken | undefined {
	THINKING_VARIANT_TOKEN_RE.lastIndex = 0;
	let match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	while (match !== null) {
		const preceding = /([a-z0-9]+)$/i.exec(modelId.slice(0, match.index))?.[1]?.toLowerCase();
		if (preceding !== "non" && preceding !== "no") {
			return { index: match.index, length: match[0].length };
		}
		match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	}
	return undefined;
}

export const stripThinkingVariantToken = memo((modelId: string): string | undefined => {
	const token = findThinkingVariantToken(modelId);
	if (!token) return undefined;
	const stripped = modelId.slice(0, token.index) + modelId.slice(token.index + token.length);
	return stripped.length > 0 ? stripped : undefined;
});
