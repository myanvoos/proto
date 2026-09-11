import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { buildAnthropicCompat } from "./compat/anthropic";
import { buildBedrockCompat } from "./compat/bedrock";
import { buildDevinCompat } from "./compat/devin";
import { buildOpenAICompat, buildOpenAIResponsesCompat, buildOpenRouterCompat } from "./compat/openai";
import { bareModelId, parseOpenAIModel, semverGte } from "./identity/classify";
import { isClaudeModelId } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import { resolveModelTokenizer } from "./model-tokenizer";
import type { Api, CompatOf, Model, ModelSpec, ThinkingConfig } from "./types";
import { cleanModelName } from "./utils";

function isDirectOpenAIResponsesEndpoint(spec: ModelSpec<Api>): boolean {
	if (spec.api === "openai-responses") {
		if (spec.provider !== "openai") return false;
		if (!spec.baseUrl) return true;
		try {
			const url = new URL(spec.baseUrl);
			return url.protocol === "https:" && url.hostname === "api.openai.com";
		} catch {
			return false;
		}
	}
	if (spec.api !== "azure-openai-responses" || (spec.provider !== "azure" && spec.provider !== "azure-openai")) {
		return false;
	}
	if (!spec.baseUrl) return true;
	try {
		const url = new URL(spec.baseUrl);
		return (
			url.protocol === "https:" &&
			(url.hostname.endsWith(".openai.azure.com") || url.hostname === "models.inference.ai.azure.com")
		);
	} catch {
		return false;
	}
}

function explicitComputerUseConfig(spec: ModelSpec<Api>): boolean | undefined {
	return "supportsComputerUseConfig" in spec
		? (spec as Model<Api>).supportsComputerUseConfig
		: spec.supportsComputerUse;
}

function supportsOpenAIGAComputerUse(spec: ModelSpec<Api>, explicitSupport: boolean | undefined): boolean {
	if (explicitSupport !== undefined) return explicitSupport;
	if (!isDirectOpenAIResponsesEndpoint(spec)) return false;
	const parsed = parseOpenAIModel(bareModelId(spec.requestModelId ?? spec.id));
	return parsed !== null && semverGte(parsed.version, "5.4");
}

export function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	const builtCompat = buildCompat(spec) as CompatOf<TApi>;
	const compatKey = JSON.stringify(builtCompat);
	const internedCompat = compatInternCache.get(compatKey);
	const compat = (internedCompat ?? builtCompat) as CompatOf<TApi>;
	if (internedCompat === undefined) compatInternCache.set(compatKey, builtCompat);
	const builtThinking = resolveModelThinking(spec, compat);
	const thinkingKey = builtThinking === undefined ? "undefined" : JSON.stringify(builtThinking);
	const internedThinking = thinkingInternCache.get(thinkingKey);
	const thinking = internedThinking === undefined ? builtThinking : internedThinking;
	if (internedThinking === undefined) thinkingInternCache.set(thinkingKey, builtThinking);
	const supportsComputerUseConfig = explicitComputerUseConfig(spec);
	return {
		...spec,
		baseUrl: internString(spec.baseUrl),
		name: cleanModelName(spec.name),
		requiresGlyphTokenization: isClaudeModelId(spec.id),
		tokenizer: spec.tokenizer ?? resolveModelTokenizer(spec.requestModelId ?? spec.id),
		thinking,
		supportsComputerUse: supportsOpenAIGAComputerUse(spec, supportsComputerUseConfig),
		supportsComputerUseConfig,
		compat,
		compatConfig: spec.compat,
	} as Model<TApi>;
}

// Compat payloads repeat across thousands of bundled models (96% are duplicates
// when materialized); interning by serialized shape collapses them to one shared
// object per distinct payload. Keep the pools bounded because extension-provided
// model specs can otherwise supply an unbounded stream of unique values.
const MAX_INTERN_CACHE_ENTRIES = 2_048;
const compatInternCache = new LRUCache<string, CompatOf<Api>>({ max: MAX_INTERN_CACHE_ENTRIES });
const thinkingInternCache = new LRUCache<string, ThinkingConfig | undefined>({ max: MAX_INTERN_CACHE_ENTRIES });
const stringPool = new LRUCache<string, string>({ max: MAX_INTERN_CACHE_ENTRIES });

function internString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const existing = stringPool.get(value);
	if (existing !== undefined) return existing;
	stringPool.set(value, value);
	return value;
}

export function buildCompat(spec: ModelSpec<Api>): CompatOf<Api> {
	switch (spec.api) {
		case "openrouter":
			return buildOpenRouterCompat(spec as ModelSpec<"openrouter">);
		case "openai-completions":
			return buildOpenAICompat(spec as ModelSpec<"openai-completions">);
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return buildOpenAIResponsesCompat(spec as ModelSpec<"openai-responses">);
		case "anthropic-messages":
			return buildAnthropicCompat(spec as ModelSpec<"anthropic-messages">);
		case "bedrock-converse-stream":
			return buildBedrockCompat(spec as ModelSpec<"bedrock-converse-stream">);
		case "devin-agent":
			return buildDevinCompat(spec as ModelSpec<"devin-agent">);
		default:
			return undefined;
	}
}
