import { loadProviderModels } from "./models-lazy";
import { GENERATED_PROVIDERS } from "./models-providers";
import type { Api, KnownProvider, Model, TokenCost, Usage } from "./types";

const modelRegistry = new Map<string, Map<string, Model<Api>>>();

// Identical compat/cost payloads repeat across thousands of bundled models
// (96% of compat objects are duplicates); interning collapses them so a fully
// materialized catalog shares one object per distinct payload.
const compatCache = new Map<string, object>();
const costCache = new Map<string, object>();

function internShared<T extends object>(cache: Map<string, T>, value: T, key: string): T {
	const existing = cache.get(key);
	if (existing !== undefined) return existing;
	cache.set(key, value);
	return value;
}

function getProviderModels(provider: string): Map<string, Model<Api>> | undefined {
	const cachedModels = modelRegistry.get(provider);
	if (cachedModels !== undefined) return cachedModels;
	if (!GENERATED_PROVIDERS.includes(provider as (typeof GENERATED_PROVIDERS)[number])) return undefined;
	const rawModels = loadProviderModels(provider);
	if (!rawModels) return undefined;

	const providerModels = new Map<string, Model<Api>>();
	for (const id in rawModels) {
		const model = rawModels[id as keyof typeof rawModels] as unknown as Model<Api>;
		if (model.compat !== undefined) {
			model.compat = internShared(
				compatCache,
				model.compat as object,
				JSON.stringify(model.compat),
			) as typeof model.compat;
		}
		if (model.cost !== undefined) {
			model.cost = internShared(costCache, model.cost as object, JSON.stringify(model.cost)) as typeof model.cost;
		}
		providerModels.set(id, model);
	}
	modelRegistry.set(provider, providerModels);
	return providerModels;
}

export type GeneratedProvider = (typeof GENERATED_PROVIDERS)[number];

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getProviderModels(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	return [...GENERATED_PROVIDERS] as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getProviderModels(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}
function resolveTokenCost(cost: Model["cost"], promptInputTokens: number): TokenCost {
	const longContext = cost.longContext;
	if (!longContext) return cost;
	return promptInputTokens > longContext.inputThreshold ? longContext : cost;
}

export function calculateUncachedInputCost(cost: Model["cost"], promptInputTokens: number): number {
	const rates = resolveTokenCost(cost, promptInputTokens);
	return (rates.input / 1_000_000) * promptInputTokens;
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const orchestration = usage.orchestration;
	const promptInputTokens =
		usage.input + usage.cacheRead + usage.cacheWrite + (orchestration?.input ?? 0) + (orchestration?.cacheRead ?? 0);
	const rates = resolveTokenCost(model.cost, promptInputTokens);
	usage.cost.input = (rates.input / 1000000) * (usage.input + (orchestration?.input ?? 0));
	usage.cost.output = (rates.output / 1000000) * (usage.output + (orchestration?.output ?? 0));
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * (usage.cacheRead + (orchestration?.cacheRead ?? 0));
	usage.cost.cacheWrite = cacheWriteCost(rates, usage);
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

function cacheWriteCost(rates: TokenCost, usage: Usage): number {
	const rate5m = rates.cacheWrite / 1000000;
	const cttl = usage.cttl;
	if (!cttl) return rate5m * usage.cacheWrite;
	const fiveMinute = cttl.ephemeral5m ?? 0;
	const oneHour = cttl.ephemeral1h ?? 0;
	const residual = Math.max(0, usage.cacheWrite - fiveMinute - oneHour);
	return rate5m * (fiveMinute + residual) + ((rates.input * 2) / 1000000) * oneHour;
}

export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
