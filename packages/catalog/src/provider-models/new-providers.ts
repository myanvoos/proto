import { fetchOpenAICompatibleModels, type OpenAICompatibleModelRecord } from "../discovery/openai-compatible";
import { Effort, THINKING_EFFORTS } from "../effort";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, ModelSpec, OpenAICompat, TokenCost } from "../types";
import { isRecord, toNumber, toPositiveNumber } from "../utils";
import type { ModelManagerConfig } from "./descriptor-types";

export const CORALBRICKS_BASE_URL = "https://inference.coralbricks.ai/v1";

export const CORALBRICKS_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "glm-5.3-fast",
		name: "GLM 5.3",
		api: "openai-completions",
		provider: "coralbricks",
		baseUrl: "https://inference.coralbricks.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 1.12,
			output: 4.4,
			cacheRead: 0.0,
			cacheWrite: 1.68,
		},
		contextWindow: 1048576,
		maxTokens: 131072,
	},
	{
		id: "deepseek-v4.1-flash-fast",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "coralbricks",
		baseUrl: "https://inference.coralbricks.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.3,
			output: 1.2,
			cacheRead: 0.0,
			cacheWrite: 0.09,
		},
		contextWindow: 1048576,
		maxTokens: 131072,
	},
];

export const SAMBANOVA_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		api: "openai-completions",
		provider: "sambanova",
		baseUrl: "https://api.sambanova.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.22,
			output: 0.59,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 131072,
		maxTokens: null,
	},
];

export const INCEPTION_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "mercury-3",
		name: "Mercury 3",
		api: "openai-completions",
		provider: "inception",
		baseUrl: "https://api.inceptionlabs.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.1,
			output: 0.35,
			cacheRead: 0.01,
			cacheWrite: 0.0,
		},
		contextWindow: 1000000,
		maxTokens: 131072,
	},
	{
		id: "mercury-2.5",
		name: "Mercury 2.5",
		api: "openai-completions",
		provider: "inception",
		baseUrl: "https://api.inceptionlabs.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.2,
			output: 0.75,
			cacheRead: 0.02,
			cacheWrite: 0.0,
		},
		contextWindow: 260000,
		maxTokens: 65536,
	},
	{
		id: "mercury-2",
		name: "Mercury 2",
		api: "openai-completions",
		provider: "inception",
		baseUrl: "https://api.inceptionlabs.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.25,
			output: 0.75,
			cacheRead: 0.025,
			cacheWrite: 0.0,
		},
		contextWindow: 128000,
		maxTokens: 50000,
	},
];

export const SCALEWAY_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "glm-5.3",
		name: "GLM 5.3",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 2.02,
			output: 6.18,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 16000,
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 2.02,
			output: 6.18,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 16000,
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.67,
			output: 2.02,
			cacheRead: 0.13,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 32000,
	},
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.45,
			output: 0.9,
			cacheRead: 0.09,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 32000,
	},
	{
		id: "qwen3.8-27b",
		name: "Qwen3.8 27B",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.67,
			output: 3.71,
			cacheRead: 0.13,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 32000,
	},
	{
		id: "qwen3.6-35b-a3b",
		name: "Qwen3.6 35B A3B",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.28,
			output: 1.69,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 32000,
	},
	{
		id: "qwen3.5-397b-a17b",
		name: "Qwen3.5 397B A17B",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.67,
			output: 4.04,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 250000,
		maxTokens: 16000,
	},
	{
		id: "qwen3-235b-a22b-instruct-2507",
		name: "Qwen3 235B A22B Instruct 2507",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0.84,
			output: 2.53,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 250000,
		maxTokens: 16000,
	},
	{
		id: "gemma-4-26b-a4b-it",
		name: "Gemma 4 26B A4B IT",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.28,
			output: 0.56,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 256000,
		maxTokens: 32000,
	},
	{
		id: "mistral-medium-3.5-128b",
		name: "Mistral Medium 3.5 128B",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 1.69,
			output: 8.43,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 180000,
		maxTokens: 16000,
	},
	{
		id: "mistral-small-3.2-24b-instruct-2506",
		name: "Mistral Small 3.2 24B Instruct 2506",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: 0.17,
			output: 0.39,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 128000,
		maxTokens: 32000,
	},
	{
		id: "llama-3.3-70b-instruct",
		name: "Llama 3.3 70B Instruct",
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 1.01,
			output: 1.01,
			cacheRead: 0.0,
			cacheWrite: 0.0,
		},
		contextWindow: 100000,
		maxTokens: 16000,
	},
];

const LOW_HIGH_MAX = [Effort.Low, Effort.High, Effort.Max] as const;
const LOW_MEDIUM_HIGH = [Effort.Low, Effort.Medium, Effort.High] as const;

/** Reviewed deployment contracts, shared by runtime resolution and catalog generation. */
export function applyNewProviderPolicy<TApi extends Api>(source: ModelSpec<TApi>): ModelSpec<TApi> {
	if (source.api !== "openai-completions") return source;
	const model = { ...source } as ModelSpec<"openai-completions">;
	const compat: OpenAICompat = { ...model.compat };
	const id = model.id.toLowerCase();
	switch (model.provider) {
		case "coralbricks":
			Object.assign(compat, {
				supportsDeveloperRole: false,
				supportsStore: false,
				maxTokensField: "max_tokens",
				thinkingFormat: "openai",
			});
			// Live capability metadata is authoritative, including an empty ladder.
			if (!compat.trustExplicitThinkingOnly && ["glm-5.3-fast", "deepseek-v4.1-flash-fast"].includes(id)) {
				model.reasoning = true;
				model.thinking ??= {
					mode: "effort",
					efforts: LOW_HIGH_MAX,
					defaultLevel: id.startsWith("glm") ? Effort.Max : Effort.High,
					requiresEffort: id.startsWith("glm"),
				};
				compat.reasoningDisableMode ??= id.startsWith("glm") ? "lowest-effort" : "none-effort";
			}
			break;
		case "sambanova": {
			compat.thinkingFormat = "openai";
			compat.replayReasoningContent = true;
			const gemma = /gemma[-_.]?([4-9]|[1-9]\d)(?:[-_.]|$)/.test(id);
			const template = gemma || /deepseek[-_.]?v3\.[1-9]/.test(id);
			if (template || /gpt[-_]?oss|minimax[-_.]?m3(?:[.-]|$)/.test(id)) {
				model.reasoning = true;
				model.thinking = {
					mode: "effort",
					efforts: template ? [Effort.High] : LOW_MEDIUM_HIGH,
					requiresEffort: false,
				};
			}
			if (template) {
				compat.thinkingFormat = "qwen-chat-template";
				compat.reasoningDisableMode = "qwen-template-false";
			}
			if (gemma) model.input = ["text", "image"];
			break;
		}
		case "inception":
			Object.assign(compat, {
				supportsDeveloperRole: false,
				supportsStore: false,
				maxTokensField: "max_completion_tokens",
				clampOutputToModelMax: true,
			});
			if (["mercury-2", "mercury-2.5", "mercury-3"].includes(id)) {
				model.reasoning = true;
				model.thinking = {
					mode: "effort",
					efforts: [Effort.Minimal, ...LOW_MEDIUM_HIGH],
					defaultLevel: id === "mercury-3" ? Effort.Low : Effort.Medium,
					requiresEffort: false,
					effortMap: { minimal: "instant" },
				};
				Object.assign(compat, {
					thinkingFormat: "openai",
					supportsReasoningEffort: true,
					reasoningEffortMap: { minimal: "instant" },
					reasoningDisableMode: "lowest-effort",
				});
			}
			if (id === "mercury-3") {
				compat.streamFirstEventTimeoutMs = 600_000;
				// The launch tariff is a fallback only: a published paid card wins.
				if (Object.values(model.cost).every(rate => rate === 0))
					model.cost = { input: 0.1, output: 0.35, cacheRead: 0.01, cacheWrite: 0 };
			}
			break;
		case "modular":
			compat.thinkingFormat = "openrouter";
			compat.reasoningDisableMode = "openrouter-enabled-false";
			if (id === "minimaxai/minimax-m3.1-flash") {
				model.reasoning = true;
				model.thinking = {
					mode: "effort",
					efforts: [...LOW_MEDIUM_HIGH, Effort.XHigh, Effort.Max],
					requiresEffort: true,
				};
			} else if (["minimax/minimax-m3", "google/gemma-4-31b-it"].includes(id)) {
				model.reasoning = true;
				model.thinking = { mode: "effort", efforts: [Effort.High], requiresEffort: false };
				compat.whenThinking = {
					...compat.whenThinking,
					extraBody: { ...compat.whenThinking?.extraBody, reasoning: { enabled: true } },
				};
			}
			break;
		case "scaleway": {
			// Gateway dialect, not the lineage's native Qwen/GLM dialect.
			compat.thinkingFormat = "openai";
			compat.reasoningDisableMode = "none-effort";
			const efforts =
				id === "glm-5.3" || ["deepseek-v4.1-flash", "deepseek-v4-flash-0731"].includes(id)
					? LOW_HIGH_MAX
					: id === "glm-5.2"
						? [Effort.High, Effort.Max]
						: id === "qwen3.8-27b"
							? [Effort.Low, Effort.Medium, Effort.XHigh]
							: ["qwen3.6-35b-a3b", "qwen3.5-397b-a17b", "gemma-4-26b-a4b-it"].includes(id)
								? LOW_MEDIUM_HIGH
								: id === "mistral-medium-3.5-128b"
									? [Effort.High]
									: undefined;
			if (efforts) {
				model.reasoning = true;
				model.thinking = {
					mode: "effort",
					efforts,
					requiresEffort: false,
					...(id.startsWith("glm")
						? { defaultLevel: Effort.Max }
						: id.startsWith("mistral")
							? { defaultLevel: Effort.High }
							: {}),
				};
			}
			break;
		}
		default:
			return source;
	}
	model.compat = compat;
	return model as ModelSpec<TApi>;
}

function nonnegativeRate(value: unknown, fallback: number, multiplier = 1): number {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed >= 0
		? multiplier === 1
			? parsed
			: Math.round(parsed * multiplier * 1e6) / 1e6
		: fallback;
}

function perTokenCost(pricing: Record<string, unknown>, fallback: TokenCost): TokenCost {
	return {
		input: nonnegativeRate(pricing.prompt, fallback.input, 1e6),
		output: nonnegativeRate(pricing.completion, fallback.output, 1e6),
		cacheRead: nonnegativeRate(pricing.input_cache_read ?? pricing.input_cache_reads, fallback.cacheRead, 1e6),
		cacheWrite: nonnegativeRate(pricing.input_cache_write ?? pricing.input_cache_writes, fallback.cacheWrite, 1e6),
	};
}

type ChatSpec = ModelSpec<"openai-completions">;
type CatalogMapper = (entry: OpenAICompatibleModelRecord, model: ChatSpec) => ChatSpec | null;

function providerOptions(
	providerId: string,
	seeds: readonly ChatSpec[],
	config: ModelManagerConfig | undefined,
	mapModel: CatalogMapper,
): ModelManagerOptions<"openai-completions"> {
	const baseUrl = config?.baseUrl ?? seeds[0].baseUrl;
	const references = new Map(seeds.map(model => [model.id, applyNewProviderPolicy(model)]));
	return {
		providerId,
		staticModels: [...references.values()].map(model => ({ ...model, baseUrl })),
		dynamicModelsAuthoritative: true,
		...(config?.apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey: config.apiKey,
					fetch: config.fetch,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapModel(entry, {
							...defaults,
							...reference,
							id: defaults.id,
							api: defaults.api,
							provider: defaults.provider,
							baseUrl: defaults.baseUrl,
						});
						return model ? applyNewProviderPolicy(model) : null;
					},
				}),
		}),
	};
}

export function coralbricksModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return {
		...providerOptions("coralbricks", CORALBRICKS_STATIC_MODELS, config, (entry, model) => {
			if (entry.supports_chat === false) return null;
			const pricing = isRecord(entry.pricing) ? entry.pricing : {};
			const controls = isRecord(entry.reasoning) ? entry.reasoning : undefined;
			const hasFlag = typeof entry.supports_reasoning === "boolean";
			const reasoning = hasFlag ? entry.supports_reasoning === true : model.reasoning;
			let thinking = reasoning ? model.thinking : undefined;
			const compat = { ...model.compat };
			const wireEfforts = controls?.supported_efforts;
			if (reasoning && controls && Array.isArray(wireEfforts)) {
				const efforts = THINKING_EFFORTS.filter(effort => wireEfforts.includes(effort));
				const defaultLevel = efforts.find(effort => effort === controls.default_effort);
				thinking = efforts.length
					? {
							mode: "effort",
							efforts,
							...(defaultLevel && { defaultLevel }),
							...(typeof controls.mandatory === "boolean" && { requiresEffort: controls.mandatory }),
						}
					: undefined;
			}
			if (hasFlag || Array.isArray(controls?.supported_efforts)) compat.trustExplicitThinkingOnly = true;
			if (reasoning && controls) {
				if (controls.mandatory === true || controls.disable === null) compat.reasoningDisableMode = "lowest-effort";
				else if (isRecord(controls.disable) && controls.disable.reasoning_effort === "none")
					compat.reasoningDisableMode = "none-effort";
			}
			return {
				...model,
				reasoning,
				thinking,
				compat,
				input:
					entry.supports_image_input === true
						? ["text", "image"]
						: entry.supports_image_input === false
							? ["text"]
							: model.input,
				...(typeof entry.supports_tools === "boolean" && { supportsTools: entry.supports_tools }),
				cost: {
					input: nonnegativeRate(pricing.input_per_m, model.cost.input),
					output: nonnegativeRate(pricing.output_per_m, model.cost.output),
					cacheRead: nonnegativeRate(pricing.cached_input_per_m, model.cost.cacheRead),
					cacheWrite: nonnegativeRate(pricing.cache_write_per_m, model.cost.cacheWrite),
				},
				contextWindow: toPositiveNumber(entry.context_length, model.contextWindow),
			};
		}),
		dynamicInputAuthoritative: true,
		dynamicReasoningAuthoritative: true,
	};
}

export function sambanovaModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return providerOptions("sambanova", SAMBANOVA_STATIC_MODELS, config, (entry, model) => {
		if (/embedding|whisper|audio|e5-mistral|clip/i.test(model.id)) return null;
		return {
			...model,
			cost: isRecord(entry.pricing) ? perTokenCost(entry.pricing, model.cost) : model.cost,
			contextWindow: toPositiveNumber(entry.context_length, model.contextWindow),
			maxTokens: toPositiveNumber(entry.max_completion_tokens, model.maxTokens),
		};
	});
}

export function inceptionModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return providerOptions("inception", INCEPTION_STATIC_MODELS, config, (entry, model) => {
		if (!Array.isArray(entry.supported_endpoints) || !entry.supported_endpoints.includes("chat.completions"))
			return null;
		return {
			...model,
			input: Array.isArray(entry.input_modalities)
				? entry.input_modalities.includes("image")
					? ["text", "image"]
					: ["text"]
				: model.input,
			cost: isRecord(entry.pricing)
				? perTokenCost(entry.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
				: model.cost,
			contextWindow: toPositiveNumber(entry.context_length, model.contextWindow),
			maxTokens: toPositiveNumber(entry.max_output_length, model.maxTokens),
			...(Array.isArray(entry.supported_features) && { supportsTools: entry.supported_features.includes("tools") }),
		};
	});
}

export function scalewayModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return providerOptions("scaleway", SCALEWAY_STATIC_MODELS, config, (_entry, model) =>
		/^(?:whisper-|qwen3-embedding-|bge-|lightonocr-)|^gpt-oss-120b$/i.test(model.id) ? null : model,
	);
}
