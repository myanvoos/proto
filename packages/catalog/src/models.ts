import { loadProviderModels } from "./models-lazy";
import { GENERATED_PROVIDERS } from "./models-providers";
import type {
	Api,
	EffectiveTokenCost,
	KnownProvider,
	Model,
	ModelCost,
	TimeBasedCost,
	TokenCost,
	Usage,
} from "./types";

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

function resolveTokenCost(cost: ModelCost, promptInputTokens: number, timestamp: number | undefined): TokenCost {
	let rates: ModelCost | EffectiveTokenCost = cost;
	let effectiveFrom = -Infinity;
	if (timestamp !== undefined && cost.timeBased?.effectiveRates) {
		for (const candidate of cost.timeBased.effectiveRates) {
			if (candidate.effectiveFrom <= timestamp && candidate.effectiveFrom > effectiveFrom) {
				rates = candidate;
				effectiveFrom = candidate.effectiveFrom;
			}
		}
	}
	const longContext = rates.longContext;
	if (!longContext) return rates;
	const reachesThreshold =
		promptInputTokens > longContext.inputThreshold ||
		(longContext.inputThresholdInclusive === true && promptInputTokens === longContext.inputThreshold);
	return reachesThreshold ? longContext : rates;
}

function isPeakPricingPeriod(schedule: TimeBasedCost, timestamp: number): boolean {
	// The Unix epoch was a Thursday; arithmetic keeps this UTC-only without allocating a Date.
	const day = Math.floor(timestamp / 86_400_000);
	const weekday = (((day + 4) % 7) + 7) % 7;
	const minute = Math.floor((timestamp - day * 86_400_000) / 60_000);
	for (const window of schedule.peakWindows) {
		if (minute >= window.startMinute && minute < window.endMinute && window.weekdays.includes(weekday)) return true;
	}
	return false;
}

function timeBasedMultiplier(schedule: TimeBasedCost | undefined, timestamp: number | undefined): number {
	if (!schedule || timestamp === undefined) return 1;
	return isPeakPricingPeriod(schedule, timestamp) ? 1 : schedule.offPeakMultiplier;
}

/** The recurring UTC tariff period at `timestamp` (Unix ms, default now), independent of its multiplier. */
export function getTimeBasedPricingPeriod(cost: ModelCost, timestamp?: number): "peak" | "off-peak" | undefined {
	const schedule = cost.timeBased;
	if (!schedule) return undefined;
	return isPeakPricingPeriod(schedule, timestamp ?? Date.now()) ? "peak" : "off-peak";
}

/** The next actual peak/off-peak change strictly after `timestamp` (Unix ms, default now). */
export function getNextTimeBasedPricingTransition(cost: ModelCost, timestamp?: number): number | undefined {
	const schedule = cost.timeBased;
	if (!schedule) return undefined;
	const now = timestamp ?? Date.now();
	const firstDay = Math.floor(now / 86_400_000);
	const horizon = now + 7 * 86_400_000;
	let next = Infinity;
	// Every change happens at a window edge; one UTC week covers the whole recurrence.
	for (let offset = 0; offset <= 7; offset++) {
		const day = firstDay + offset;
		const weekday = (((day + 4) % 7) + 7) % 7;
		for (const window of schedule.peakWindows) {
			if (!window.weekdays.includes(weekday)) continue;
			for (const minute of [window.startMinute, window.endMinute]) {
				const candidate = day * 86_400_000 + minute * 60_000;
				if (candidate <= now || candidate > horizon || candidate >= next) continue;
				// Overlapping or touching windows can hide an edge, including at midnight.
				if (isPeakPricingPeriod(schedule, candidate - 1) !== isPeakPricingPeriod(schedule, candidate)) {
					next = candidate;
				}
			}
		}
	}
	return next === Infinity ? undefined : next;
}

/** Price a fully uncached prompt at its request timestamp (Unix ms); scheduled prices default to now. */
export function calculateUncachedInputCost(cost: ModelCost, promptInputTokens: number, timestamp?: number): number {
	const pricingTimestamp = cost.timeBased ? (timestamp ?? Date.now()) : undefined;
	const rates = resolveTokenCost(cost, promptInputTokens, pricingTimestamp);
	return (rates.input / 1_000_000) * promptInputTokens * timeBasedMultiplier(cost.timeBased, pricingTimestamp);
}

/** Price usage at its request timestamp (Unix ms); only scheduled prices default to now. */
export function calculateUsageCost(cost: ModelCost, usage: Usage, timestamp?: number): Usage["cost"] {
	const orchestration = usage.orchestration;
	const promptInputTokens =
		usage.input + usage.cacheRead + usage.cacheWrite + (orchestration?.input ?? 0) + (orchestration?.cacheRead ?? 0);
	const pricingTimestamp = cost.timeBased ? (timestamp ?? Date.now()) : undefined;
	const rates = resolveTokenCost(cost, promptInputTokens, pricingTimestamp);
	const multiplier = timeBasedMultiplier(cost.timeBased, pricingTimestamp);
	usage.cost.input = (rates.input / 1000000) * (usage.input + (orchestration?.input ?? 0)) * multiplier;
	usage.cost.output = (rates.output / 1000000) * (usage.output + (orchestration?.output ?? 0)) * multiplier;
	usage.cost.cacheRead =
		(rates.cacheRead / 1000000) * (usage.cacheRead + (orchestration?.cacheRead ?? 0)) * multiplier;
	usage.cost.cacheWrite = cacheWriteCost(rates, usage) * multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/** Price usage at its request timestamp (Unix ms); preserve the resulting monetary amounts for display. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage, timestamp?: number): Usage["cost"] {
	return calculateUsageCost(model.cost, usage, timestamp);
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
