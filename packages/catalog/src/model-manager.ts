import { buildModel } from "./build";
import { readModelCache, writeModelCache } from "./model-cache";
import { type GeneratedProvider, getBundledModels } from "./models";
import type { Api, Model, ModelCost, ModelSpec, Provider, TokenCost } from "./types";
import { isRecord } from "./utils";
import { collapseBuiltModelVariants } from "./variant-collapse";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
	fetch(): Promise<TPayload>;

	map(payload: TPayload, providerId: Provider): readonly ModelSpec<TApi>[];
}

export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
	providerId: Provider;

	staticModels?: readonly ModelSpec<TApi>[];

	cacheDbPath?: string;

	cacheProviderId?: string;

	cacheTtlMs?: number;

	dynamicModelsAuthoritative?: boolean;

	dropCachedModelIdsOnStaticMismatch?: readonly string[];

	restorableHeaderFallback?: Record<string, string>;

	fetchDynamicModels?: () => Promise<readonly ModelSpec<TApi>[] | null>;

	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;

	now?: () => number;
}

export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
}

export interface ModelManager<TApi extends Api = Api> {
	refresh(strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
}

export function createModelManager<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): ModelManager<TApi> {
	return {
		refresh(strategy: ModelRefreshStrategy = "online-if-uncached") {
			return resolveProviderModels(options, strategy);
		},
	};
}

function passModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: Model<TApi>[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || typeof (item as { id: unknown }).id !== "string") {
			continue;
		}
		out.push(buildModel(item as ModelSpec<TApi>));
	}
	return out;
}
interface CachedHeaderRestoreResult<TApi extends Api> {
	models: Model<TApi>[];
	unresolvedModelIds: ReadonlySet<string>;
}

function restoreCachedModelHeaders<TApi extends Api>(
	cachedModels: readonly ModelSpec<TApi>[],
	staticModels: readonly Model<TApi>[],
	headerOmittedModelIds: readonly string[],
	unrestorableHeaderModelIds: readonly string[],
	legacyHeaderRestoreMarkers: boolean,
	restorableHeaderFallback: Record<string, string> | undefined,
): CachedHeaderRestoreResult<TApi> {
	const models = passModelList<TApi>(cachedModels);
	if (headerOmittedModelIds.length === 0) {
		return { models, unresolvedModelIds: new Set() };
	}
	const omittedIds = new Set(headerOmittedModelIds);
	const unrestorableIds = new Set(unrestorableHeaderModelIds);
	const staticById = new Map(staticModels.map(model => [model.id, model]));
	const unresolvedModelIds = new Set<string>();
	const restored = models.map(model => {
		if (!omittedIds.has(model.id)) return model;
		const unrestorable = unrestorableIds.has(model.id);

		const staticModel = unrestorable
			? legacyHeaderRestoreMarkers && model.requestModelId
				? staticById.get(model.requestModelId)
				: undefined
			: (staticById.get(model.id) ?? (model.requestModelId ? staticById.get(model.requestModelId) : undefined));
		if (!staticModel?.headers) {
			if (!unrestorable && restorableHeaderFallback) {
				return { ...model, headers: { ...restorableHeaderFallback } };
			}
			unresolvedModelIds.add(model.id);
			return model;
		}
		return { ...model, headers: staticModel.headers };
	});
	return { models: restored, unresolvedModelIds };
}

export async function resolveProviderModels<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	strategy: ModelRefreshStrategy = "online-if-uncached",
): Promise<ModelResolutionResult<TApi>> {
	const cacheProviderId = options.cacheProviderId ?? options.providerId;
	const now = options.now ?? Date.now;
	const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const dbPath = options.cacheDbPath;
	const restorableHeaderFallback = options.restorableHeaderFallback;
	const staticModels = options.staticModels
		? passModelList<TApi>(options.staticModels)
		: (getBundledModels(options.providerId as GeneratedProvider) as Model<TApi>[]);
	const cache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
	const restoredCache = restoreCachedModelHeaders(
		cache?.models ?? [],
		staticModels,
		cache?.headerOmittedModelIds ?? [],
		cache?.unrestorableHeaderModelIds ?? [],
		cache?.legacyHeaderRestoreMarkers ?? false,
		restorableHeaderFallback,
	);
	const usableCachedModels = restoredCache.models.filter(model => !restoredCache.unresolvedModelIds.has(model.id));
	const cacheHasUnresolvedHeaders = restoredCache.unresolvedModelIds.size > 0;
	const dynamicModelsAuthoritative = options.dynamicModelsAuthoritative ?? false;
	const cacheDropIds = options.dropCachedModelIdsOnStaticMismatch;
	const staticCatalogFingerprint = fingerprintStatic(staticModels, dynamicModelsAuthoritative);

	const staticFingerprint =
		cacheDropIds && cacheDropIds.length > 0
			? `${staticCatalogFingerprint}:drop:${Bun.hash(cacheDropIds.join("\0")).toString(36)}`
			: staticCatalogFingerprint;
	const cacheFingerprintMatches = cache?.staticFingerprint === staticFingerprint && staticFingerprint.length > 0;
	const cacheNeedsModelMigration =
		!cacheFingerprintMatches &&
		cacheDropIds !== undefined &&
		usableCachedModels.some(model => cacheDropIds.includes(model.id));
	const hasUsableFreshCache =
		(cache?.fresh ?? false) &&
		!cacheHasUnresolvedHeaders &&
		!cacheNeedsModelMigration &&
		(!dynamicModelsAuthoritative || cacheFingerprintMatches);
	const dynamicFetcher = options.fetchDynamicModels;
	const hasDynamicFetcher = typeof dynamicFetcher === "function";
	const hasAuthoritativeCache = ((cache?.authoritative ?? false) && hasUsableFreshCache) || !hasDynamicFetcher;
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;
	const shouldFetchFromNetwork = shouldFetchRemoteSources(
		strategy,
		hasUsableFreshCache,
		hasAuthoritativeCache,
		cacheAgeMs,
	);

	if (
		!shouldFetchFromNetwork &&
		cache?.fresh &&
		hasAuthoritativeCache &&
		cacheFingerprintMatches &&
		!cacheHasUnresolvedHeaders
	) {
		return { models: collapseBuiltModelVariants(restoredCache.models), stale: false };
	}

	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await Promise.all([fetchModelsDev(options), dynamicFetcher ? fetchDynamicModels(dynamicFetcher) : null])
		: [null, null];
	const modelsDevModels = normalizeModelList<TApi>(fetchedModelsDevModels ?? []);
	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && hasUsableFreshCache && hasAuthoritativeCache;
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	const cacheModels = dynamicFetchSucceeded
		? []
		: prepareCacheModelsForStaticMismatch(
				usableCachedModels,
				staticModels,
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
	const dynamicModels = fetchedDynamicModels ?? [];

	const dynamicCacheAuthoritative = dynamicFetchSucceeded && dynamicModels.length > 0;
	const mergedWithCache = mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), cacheModels);
	const mergedModels = mergeDynamicModels(mergedWithCache, dynamicModels);
	const models = collapseBuiltModelVariants(
		dynamicModelsAuthoritative && dynamicFetchSucceeded ? retainModelIds(mergedModels, dynamicModels) : mergedModels,
	);
	const dynamicAuthoritative = !hasDynamicFetcher || dynamicFetchSucceeded || shouldUseFreshCacheAsAuthoritative;
	if (shouldFetchFromNetwork) {
		if (dynamicFetchSucceeded) {
			const mergedSnapshot = mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), dynamicModels);
			const snapshotModels = dynamicModelsAuthoritative
				? retainModelIds(mergedSnapshot, dynamicModels)
				: mergedSnapshot;
			writeModelCache(
				cacheProviderId,
				now(),
				collapseBuiltModelVariants(snapshotModels),
				dynamicCacheAuthoritative,
				staticFingerprint,
				dbPath,
				staticModels,
				restorableHeaderFallback,
			);
		} else {
			const latestCache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
			const latestRestoredCache = restoreCachedModelHeaders(
				latestCache?.models ?? cache?.models ?? [],
				staticModels,
				latestCache?.headerOmittedModelIds ?? cache?.headerOmittedModelIds ?? [],
				latestCache?.unrestorableHeaderModelIds ?? cache?.unrestorableHeaderModelIds ?? [],
				latestCache?.legacyHeaderRestoreMarkers ?? cache?.legacyHeaderRestoreMarkers ?? false,
				restorableHeaderFallback,
			);
			const latestUsableCacheModels = latestRestoredCache.models.filter(
				model => !latestRestoredCache.unresolvedModelIds.has(model.id),
			);
			const fallbackSnapshotModels = collapseBuiltModelVariants(
				mergeDynamicModels(
					mergeModelSources(staticModels, modelsDevModels),
					prepareCacheModelsForStaticMismatch(
						latestUsableCacheModels,
						staticModels,
						cacheFingerprintMatches,
						options.dropCachedModelIdsOnStaticMismatch,
					),
				),
			);
			writeModelCache(
				cacheProviderId,
				now(),
				fallbackSnapshotModels,
				false,
				staticFingerprint,
				dbPath,
				staticModels,
				restorableHeaderFallback,
			);
		}
	}
	return {
		models,
		stale: !dynamicAuthoritative,
	};
}

async function fetchModelsDev<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): Promise<Model<TApi>[] | null> {
	if (!options.modelsDev) {
		return null;
	}

	try {
		const payload = await options.modelsDev.fetch();
		return normalizeModelList<TApi>(options.modelsDev.map(payload, options.providerId));
	} catch {
		return null;
	}
}

async function fetchDynamicModels<TApi extends Api>(
	fetcher: () => Promise<readonly ModelSpec<TApi>[] | null>,
): Promise<Model<TApi>[] | null> {
	try {
		const models = await fetcher();
		if (models === null) {
			return null;
		}
		return normalizeModelList<TApi>(models);
	} catch {
		return null;
	}
}

function shouldFetchRemoteSources(
	strategy: ModelRefreshStrategy,
	hasFreshCache: boolean,
	hasAuthoritativeCache: boolean,
	cacheAgeMs: number,
): boolean {
	if (strategy === "offline") {
		return false;
	}
	if (strategy === "online") {
		return true;
	}

	if (!hasFreshCache) {
		return true;
	}
	if (!hasAuthoritativeCache) {
		return cacheAgeMs >= NON_AUTHORITATIVE_RETRY_MS;
	}
	return false;
}

function prepareCacheModelsForStaticMismatch<TApi extends Api>(
	models: readonly Model<TApi>[],
	staticModels: readonly Model<TApi>[],
	cacheFingerprintMatches: boolean,
	ids: readonly string[] | undefined,
): Model<TApi>[] {
	if (models.length === 0) {
		return [];
	}
	if (cacheFingerprintMatches) {
		return [...models];
	}

	const droppedIds = ids && ids.length > 0 ? new Set(ids) : undefined;
	const staticIds = staticModels.length > 0 ? new Set(staticModels.map(model => model.id)) : undefined;
	const sanitizedModels: Model<TApi>[] = [];
	for (const model of models) {
		if (droppedIds?.has(model.id)) {
			continue;
		}
		sanitizedModels.push(staticIds?.has(model.id) ? { ...model, contextWindow: null, maxTokens: null } : model);
	}
	return sanitizedModels;
}

function mergeModelSources<TApi extends Api>(...sources: readonly (readonly Model<TApi>[])[]): Model<TApi>[] {
	const nonEmpty = sources.filter(source => source.length > 0);
	if (nonEmpty.length === 0) return [];
	if (nonEmpty.length === 1) return [...nonEmpty[0]];
	const merged = new Map<string, Model<TApi>>();
	for (const source of nonEmpty) {
		for (const model of source) {
			if (!model?.id) continue;
			merged.set(model.id, model);
		}
	}
	return Array.from(merged.values());
}

function mergeDynamicModels<TApi extends Api>(
	baseModels: readonly Model<TApi>[],
	dynamicModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (dynamicModels.length === 0) return baseModels.length === 0 ? [] : [...baseModels];
	if (baseModels.length === 0) return [...dynamicModels];
	const merged = new Map<string, Model<TApi>>(baseModels.map(model => [model.id, model]));
	for (const dynamicModel of dynamicModels) {
		if (!dynamicModel?.id) {
			continue;
		}
		const existingModel = merged.get(dynamicModel.id);
		if (!existingModel) {
			merged.set(dynamicModel.id, dynamicModel);
			continue;
		}
		merged.set(dynamicModel.id, mergeDynamicModel(existingModel, dynamicModel));
	}
	return Array.from(merged.values());
}

function retainModelIds<TApi extends Api>(
	models: readonly Model<TApi>[],
	retainedModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (retainedModels.length === 0 || models.length === 0) return [];
	const retainedIds = new Set(retainedModels.map(model => model.id));
	return models.filter(model => retainedIds.has(model.id));
}

const MODEL_CACHE_FINGERPRINT_VERSION = "merge-v3";
const kStaticFingerprint = Symbol("model-manager.staticFingerprint");
type ModelArrayWithFingerprint = readonly Model<Api>[] & { [kStaticFingerprint]?: string };
function fingerprintStatic<TApi extends Api>(
	models: readonly Model<TApi>[],
	dynamicModelsAuthoritative = false,
): string {
	if (models.length === 0) return `${MODEL_CACHE_FINGERPRINT_VERSION}:empty`;
	if (dynamicModelsAuthoritative)
		return `${MODEL_CACHE_FINGERPRINT_VERSION}:authoritative:${fingerprintStatic(models)}`;
	const tagged = models as ModelArrayWithFingerprint;
	const cached = tagged[kStaticFingerprint];
	if (cached !== undefined) return cached;

	const fingerprint = `${MODEL_CACHE_FINGERPRINT_VERSION}:${Bun.hash(JSON.stringify(models)).toString(36)}`;
	tagged[kStaticFingerprint] = fingerprint;
	return fingerprint;
}

function mergeDynamicModel<TApi extends Api>(existingModel: Model<TApi>, dynamicModel: Model<TApi>): Model<TApi> {
	const endpointChanged = existingModel.baseUrl !== dynamicModel.baseUrl;
	const dynamicInputAuthoritative =
		endpointChanged || (existingModel.provider === "github-copilot" && dynamicModel.provider === "github-copilot");
	const supportsImage = dynamicInputAuthoritative
		? dynamicModel.input.includes("image")
		: existingModel.input.includes("image") || dynamicModel.input.includes("image");

	const dynamicReasoningAuthoritative =
		existingModel.provider === "synthetic" && dynamicModel.provider === "synthetic";
	const reasoning = dynamicReasoningAuthoritative
		? dynamicModel.reasoning
		: existingModel.reasoning || dynamicModel.reasoning;
	const longContextCost = dynamicModel.cost.longContext ?? existingModel.cost.longContext;

	return buildModel({
		...existingModel,
		...dynamicModel,
		name: preferDiscoveryName(dynamicModel.name, existingModel.name, dynamicModel.id),
		reasoning,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost: {
			input: preferDiscoveryCost(dynamicModel.cost.input, existingModel.cost.input),
			output: preferDiscoveryCost(dynamicModel.cost.output, existingModel.cost.output),
			cacheRead: preferDiscoveryCost(dynamicModel.cost.cacheRead, existingModel.cost.cacheRead),
			cacheWrite: preferDiscoveryCost(dynamicModel.cost.cacheWrite, existingModel.cost.cacheWrite),
			...(longContextCost ? { longContext: longContextCost } : {}),
		},
		contextWindow: preferDiscoveryLimit(dynamicModel.contextWindow, existingModel.contextWindow),
		maxTokens: preferDiscoveryLimit(dynamicModel.maxTokens, existingModel.maxTokens),
		headers: dynamicModel.headers ? { ...existingModel.headers, ...dynamicModel.headers } : existingModel.headers,
		compat: dynamicModel.compatConfig ?? existingModel.compatConfig,
		contextPromotionTarget: dynamicModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
	} as ModelSpec<TApi>);
}

function preferDiscoveryCost(discoveryCost: number, fallbackCost: number): number {
	if (Number.isFinite(discoveryCost) && discoveryCost > 0) {
		return discoveryCost;
	}
	return fallbackCost;
}

function preferDiscoveryName(discoveryName: string, fallbackName: string, modelId: string): string {
	const normalizedDiscoveryName = discoveryName.trim();
	if (normalizedDiscoveryName.length === 0) {
		return fallbackName;
	}
	if (normalizedDiscoveryName === modelId && fallbackName !== modelId) {
		return fallbackName;
	}
	return normalizedDiscoveryName;
}

function preferDiscoveryLimit(discoveryLimit: number, fallbackLimit: number): number;
function preferDiscoveryLimit(discoveryLimit: number | null, fallbackLimit: number | null): number | null;
function preferDiscoveryLimit(discoveryLimit: number | null, fallbackLimit: number | null): number | null {
	if (discoveryLimit === null || !Number.isFinite(discoveryLimit) || discoveryLimit <= 0) {
		return fallbackLimit;
	}
	if (discoveryLimit === 4096 && fallbackLimit !== null && fallbackLimit > discoveryLimit) {
		return fallbackLimit;
	}
	return discoveryLimit;
}

function normalizeModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const models: Model<TApi>[] = [];
	for (const item of value) {
		if (isModelLike(item)) {
			models.push(buildModel(item as ModelSpec<TApi>));
		}
	}
	return models;
}

function isModelLike(value: unknown): value is ModelSpec<Api> {
	if (!isRecord(value)) {
		return false;
	}
	const v = value as {
		id?: unknown;
		name?: unknown;
		api?: unknown;
		provider?: unknown;
		baseUrl?: unknown;
		reasoning?: unknown;
		input?: unknown;
		cost?: unknown;
		contextWindow?: unknown;
		maxTokens?: unknown;
	};
	if (typeof v.id !== "string" || v.id.length === 0) {
		return false;
	}
	if (typeof v.name !== "string" || v.name.length === 0) {
		return false;
	}
	if (typeof v.api !== "string" || v.api.length === 0) {
		return false;
	}
	if (typeof v.provider !== "string" || v.provider.length === 0) {
		return false;
	}
	if (typeof v.baseUrl !== "string" || v.baseUrl.length === 0) {
		return false;
	}
	if (typeof v.reasoning !== "boolean") {
		return false;
	}
	if (!isModelInputArray(v.input)) {
		return false;
	}
	if (!isModelCost(v.cost)) {
		return false;
	}

	const cw = v.contextWindow;
	if (cw !== null && (typeof cw !== "number" || !(cw > 0 && cw < Infinity))) {
		return false;
	}
	const mt = v.maxTokens;
	if (mt !== null && (typeof mt !== "number" || !(mt > 0 && mt < Infinity))) {
		return false;
	}
	return true;
}

function isModelInputArray(value: unknown): value is ("text" | "image")[] {
	if (!Array.isArray(value) || value.length === 0) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (item !== "text" && item !== "image") {
			return false;
		}
	}
	return true;
}

function isTokenCost(value: unknown): value is TokenCost {
	if (!isRecord(value)) {
		return false;
	}
	const c = value as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
	};

	const ci = c.input;
	if (typeof ci !== "number" || !(ci > -Infinity && ci < Infinity)) {
		return false;
	}
	const co = c.output;
	if (typeof co !== "number" || !(co > -Infinity && co < Infinity)) {
		return false;
	}
	const cr = c.cacheRead;
	if (typeof cr !== "number" || !(cr > -Infinity && cr < Infinity)) {
		return false;
	}
	const cw = c.cacheWrite;
	if (typeof cw !== "number" || !(cw > -Infinity && cw < Infinity)) {
		return false;
	}
	return true;
}

function isModelCost(value: unknown): value is ModelCost {
	if (!isTokenCost(value)) return false;
	const longContext = (value as TokenCost & { longContext?: unknown }).longContext;
	if (longContext === undefined) return true;
	if (!isTokenCost(longContext) || !isRecord(longContext)) return false;
	const threshold = longContext.inputThreshold;
	return typeof threshold === "number" && threshold > 0 && threshold < Infinity;
}
