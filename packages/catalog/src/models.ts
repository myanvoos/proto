import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, TokenCost, Usage } from "./types";

const modelRegistry = new Map<string, Map<string, Model<Api>>>();

function getProviderModels(provider: string): Map<string, Model<Api>> | undefined {
	const cachedModels = modelRegistry.get(provider);
	if (cachedModels !== undefined) return cachedModels;
	if (!Object.hasOwn(MODELS, provider)) return undefined;

	const providerModels = new Map<string, Model<Api>>();
	const rawModels = MODELS[provider as keyof typeof MODELS];
	for (const id in rawModels) {
		providerModels.set(id, rawModels[id as keyof typeof rawModels] as unknown as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
	return providerModels;
}

export type GeneratedProvider = keyof typeof MODELS;

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getProviderModels(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	return Object.keys(MODELS) as KnownProvider[];
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
