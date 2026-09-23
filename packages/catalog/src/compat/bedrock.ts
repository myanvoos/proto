import { bareModelId, parseKnownModel } from "../identity/classify";
import { supportsAdaptiveThinkingDisplay } from "../identity/family";
import type { ModelSpec, ResolvedBedrockCompat } from "../types";
import { applyCompatOverrides } from "./apply";

const NO_EXPLICIT_CHECKPOINTS: ResolvedBedrockCompat = {
	promptCacheMode: "none",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 0,
	promptCacheMaximumCheckpoints: 0,
};
const EXPLICIT_CHECKPOINTS_1024_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 1024,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_1024_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 1024,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_2048_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 2048,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_4096_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 4096,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_4096_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 4096,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_512_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 512,
	promptCacheMaximumCheckpoints: 4,
};

function detectedBedrockCompat(modelId: string): ResolvedBedrockCompat {
	const id = modelId.toLowerCase();

	if (
		id === "amazon.nova-lite-v1:0" ||
		id === "us.amazon.nova-lite-v1:0" ||
		id === "amazon.nova-micro-v1:0" ||
		id === "us.amazon.nova-micro-v1:0" ||
		id === "amazon.nova-pro-v1:0" ||
		id === "us.amazon.nova-pro-v1:0" ||
		id === "amazon.nova-premier-v1:0" ||
		id === "us.amazon.nova-premier-v1:0" ||
		id === "amazon.nova-2-lite-v1:0" ||
		id === "us.amazon.nova-2-lite-v1:0" ||
		id === "eu.amazon.nova-2-lite-v1:0" ||
		id === "jp.amazon.nova-2-lite-v1:0" ||
		id === "global.amazon.nova-2-lite-v1:0"
	) {
		return EXPLICIT_CHECKPOINTS_1024_5M;
	}

	if (
		id.includes("anthropic.claude-opus-4-5") ||
		id.includes("anthropic.claude-sonnet-4-5") ||
		id.includes("anthropic.claude-haiku-4-5") ||
		id.includes("anthropic.claude-opus-4-7") ||
		id.includes("anthropic.claude-opus-4-8") ||
		id.includes("anthropic.claude-sonnet-5")
	) {
		return EXPLICIT_CHECKPOINTS_4096_1H;
	}
	if (id.includes("anthropic.claude-opus-5")) {
		return EXPLICIT_CHECKPOINTS_512_1H;
	}
	if (id.includes("anthropic.claude-opus-4-6")) {
		return EXPLICIT_CHECKPOINTS_4096_5M;
	}
	if (id.includes("anthropic.claude-3-5-haiku")) {
		return EXPLICIT_CHECKPOINTS_2048_5M;
	}
	if (id.includes("anthropic.claude-fable-5")) {
		return EXPLICIT_CHECKPOINTS_1024_1H;
	}

	if (
		id.includes("anthropic.claude-opus-4-1") ||
		id.includes("anthropic.claude-opus-4-20250514") ||
		id.includes("anthropic.claude-sonnet-4-20250514") ||
		id.includes("anthropic.claude-sonnet-4-6") ||
		id.includes("anthropic.claude-3-7-sonnet") ||
		id.includes("anthropic.claude-3-5-sonnet-20241022-v2")
	) {
		return EXPLICIT_CHECKPOINTS_1024_5M;
	}

	return NO_EXPLICIT_CHECKPOINTS;
}

// Vendors whose Converse models accept image blocks nested in `toolResult` content. OpenAI-schema
// models reject them; hoisting into sibling user blocks is accepted by every Converse model measured,
// so it is the default for everything else, including opaque application-inference-profile ARNs.
const NESTED_TOOL_RESULT_IMAGE_VENDORS: Record<string, true> = {
	amazon: true,
	anthropic: true,
	deepseek: true,
	minimax: true,
	mistral: true,
	qwen: true,
};

function requiresToolResultImageHoisting(modelId: string): boolean {
	const family = parseKnownModel(modelId).family;
	if (family !== "unknown") return family === "openai";
	const bare = bareModelId(modelId).toLowerCase();
	const segments = bare.split(".");
	if (segments.length < 2) return true;
	// `[geo.]vendor.model`: the vendor is the first segment, or the second behind a geo prefix.
	const vendors = segments.length > 2 ? segments.slice(0, 2) : segments.slice(0, 1);
	if (vendors.includes("openai")) return !bare.includes("gpt-oss");
	return !vendors.some(vendor => NESTED_TOOL_RESULT_IMAGE_VENDORS[vendor] === true);
}

const BEDROCK_REASONING_STREAM_IDLE_TIMEOUT_MS = 600_000;

const BEDROCK_ADAPTIVE_THINKING_STREAM_IDLE_TIMEOUT_MS = 900_000;

export function buildBedrockCompat(spec: ModelSpec<"bedrock-converse-stream">): ResolvedBedrockCompat {
	const compat = { ...detectedBedrockCompat(spec.id) };
	if (requiresToolResultImageHoisting(spec.id)) compat.requiresToolResultImageHoisting = true;
	compat.streamIdleTimeoutMs = spec.reasoning
		? supportsAdaptiveThinkingDisplay(spec.id)
			? BEDROCK_ADAPTIVE_THINKING_STREAM_IDLE_TIMEOUT_MS
			: BEDROCK_REASONING_STREAM_IDLE_TIMEOUT_MS
		: undefined;
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
