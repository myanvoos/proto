import { buildModel } from "./build";
import { applyCatalogMetrics, CatalogMetricsIndex } from "./identity/metrics";
import { readModelCache, writeModelCache } from "./model-cache";
import { type GeneratedProvider, getBundledModels } from "./models";
import { isTimeBasedCost } from "./pricing";
import { toModelSpec } from "./provider-models/bundled-references";
import type { Api, Model, ModelCost, ModelSpec, Provider, TokenCost } from "./types";
import { isRecord } from "./utils";
import { collapseBuiltModelVariants } from "./variant-collapse";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

const VENICE_GPT_WIRE_VERSION_ALIASES: Readonly<Record<string, string>> = {
	"52": "5.2",
	"53": "5.3",
	"54": "5.4",
	"55": "5.5",
	"56": "5.6",
};
const VENICE_GPT_WIRE_ID_PATTERN = /^openai-gpt-(\d{2})(?=$|-)/;

export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
	fetch(): Promise<TPayload>;

	map(payload: TPayload, providerId: Provider): readonly ModelSpec<TApi>[];

	/** Mapped rows may add model ids but never replace bundled/static metadata. */
	additiveOnly?: boolean;
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
	/**
	 * Rebuild omitted request headers from local configuration when no trusted static source remains; undefined keeps
	 * the row unavailable. Must not do I/O: attach `resolveHeaders` for credentials that should wait for a request.
	 */
	restoreCachedHeaders?: (model: Readonly<Model>) => Pick<Model, "headers" | "resolveHeaders"> | undefined;

	fetchDynamicModels?: () => Promise<readonly ModelSpec<TApi>[] | null>;

	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;

	now?: () => number;
}

/** Catalog source that most recently refreshed the resolved provider snapshot. */
export type ModelResolutionSource = "bundled" | "cache" | "models.dev" | "provider";

/**
 * `stale` is false when the resolved catalog is authoritative for the provider: a provider endpoint
 * fetch succeeded this call (an empty catalog still counts, so downstream pruning runs), a models.dev
 * fetch succeeded for a provider without endpoint discovery, a fresh authoritative cache was reused
 * in `online-if-uncached` mode, or no remote fetcher is configured.
 */
export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
	source: ModelResolutionSource;
	updatedAt?: number;
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

function normalizeProviderModelSpec<TApi extends Api>(spec: ModelSpec<TApi>): ModelSpec<TApi> {
	if (spec.provider !== "venice") return spec;
	const match = VENICE_GPT_WIRE_ID_PATTERN.exec(spec.id);
	const canonicalVersion = match ? VENICE_GPT_WIRE_VERSION_ALIASES[match[1]] : undefined;
	if (!match || !canonicalVersion) return spec;

	const { thinking: _staleThinking, ...unclassified } = spec;
	return {
		...unclassified,
		id: `openai-gpt-${canonicalVersion}${spec.id.slice(match[0].length)}`,
		requestModelId: spec.requestModelId ?? spec.id,
	};
}

function buildProviderModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	return buildModel(normalizeProviderModelSpec(spec));
}

function normalizeBundledModels<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	return models.map(model => {
		const normalized = normalizeProviderModelSpec(toModelSpec(model));
		return normalized.id === model.id ? model : buildModel(normalized);
	});
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
		out.push(buildProviderModel(item as ModelSpec<TApi>));
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
	restoreCachedHeaders: ModelManagerOptions<TApi>["restoreCachedHeaders"],
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
		if (!staticModel?.headers && !staticModel?.resolveHeaders) {
			if (!unrestorable && restorableHeaderFallback) {
				return { ...model, headers: { ...restorableHeaderFallback } };
			}
			const configured = restoreCachedHeaders?.(model);
			if (configured?.headers || configured?.resolveHeaders) return { ...model, ...configured };
			unresolvedModelIds.add(model.id);
			return model;
		}
		return { ...model, headers: staticModel.headers, resolveHeaders: staticModel.resolveHeaders };
	});
	return { models: restored, unresolvedModelIds };
}

/**
 * Resolves provider models with source precedence: static -> cached fallback -> models.dev -> dynamic.
 * Later sources override earlier ones by model id. Cached rows participate only when at least one
 * configured remote source did not refresh successfully.
 */
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
		: normalizeBundledModels(getBundledModels(options.providerId as GeneratedProvider) as Model<TApi>[]);
	const additiveStaticModelIds =
		options.modelsDev?.additiveOnly && staticModels.length > 0
			? new Set(staticModels.map(model => model.id))
			: undefined;
	// Additive shared-catalog rows may only introduce ids; the boundary also applies to cache
	// fallback, including snapshots written before additive semantics existed.
	const withoutStaticIds = (models: Model<TApi>[]): Model<TApi>[] =>
		additiveStaticModelIds ? models.filter(model => !additiveStaticModelIds.has(model.id)) : models;
	const cache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
	const restoredCache = restoreCachedModelHeaders(
		cache?.models ?? [],
		staticModels,
		cache?.headerOmittedModelIds ?? [],
		cache?.unrestorableHeaderModelIds ?? [],
		cache?.legacyHeaderRestoreMarkers ?? false,
		restorableHeaderFallback,
		options.restoreCachedHeaders,
	);
	const usableCachedModels = restoredCache.models.filter(model => !restoredCache.unresolvedModelIds.has(model.id));
	const cacheHasUnresolvedHeaders = restoredCache.unresolvedModelIds.size > 0;
	const dynamicModelsAuthoritative = options.dynamicModelsAuthoritative ?? false;
	const cacheDropIds = options.dropCachedModelIdsOnStaticMismatch;
	const staticCatalogFingerprint = fingerprintStaticModels(staticModels, dynamicModelsAuthoritative);

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
	const hasModelsDevFetcher = options.modelsDev !== undefined;
	const hasRemoteFetcher = hasDynamicFetcher || hasModelsDevFetcher;
	const hasAuthoritativeCache = ((cache?.authoritative ?? false) && hasUsableFreshCache) || !hasRemoteFetcher;
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;
	const shouldFetchFromNetwork =
		hasRemoteFetcher && shouldFetchRemoteSources(strategy, hasUsableFreshCache, hasAuthoritativeCache, cacheAgeMs);

	if (
		!shouldFetchFromNetwork &&
		cache?.fresh &&
		hasAuthoritativeCache &&
		cacheFingerprintMatches &&
		!cacheHasUnresolvedHeaders
	) {
		const cacheContribution = withoutStaticIds(restoredCache.models);
		const cachedModels = additiveStaticModelIds
			? mergeCatalogMetrics(mergeDynamicModels(staticModels, cacheContribution), restoredCache.models)
			: restoredCache.models;
		const source: ModelResolutionSource = cacheContribution.length > 0 ? "cache" : "bundled";
		return {
			models: collapseBuiltModelVariants(cachedModels),
			stale: false,
			source,
			...(source === "cache" ? { updatedAt: cache.updatedAt } : {}),
		};
	}

	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await Promise.all([fetchModelsDev(options), dynamicFetcher ? fetchDynamicModels(dynamicFetcher) : null])
		: [null, null];
	const modelsDevFetchSucceeded = fetchedModelsDevModels !== null;
	const modelsDevModels = withoutStaticIds(fetchedModelsDevModels ?? []);
	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && hasUsableFreshCache && hasAuthoritativeCache;
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	const anyRemoteFetchSucceeded = modelsDevFetchSucceeded || dynamicFetchSucceeded;
	const allConfiguredRemoteFetchesSucceeded =
		hasRemoteFetcher &&
		(!hasModelsDevFetcher || modelsDevFetchSucceeded) &&
		(!hasDynamicFetcher || dynamicFetchSucceeded);
	const authoritativeDynamicFetchSucceeded = dynamicModelsAuthoritative && dynamicFetchSucceeded;
	const remoteResolutionComplete = authoritativeDynamicFetchSucceeded || allConfiguredRemoteFetchesSucceeded;
	const preparedCacheModels = remoteResolutionComplete
		? []
		: prepareCacheModelsForStaticMismatch(
				usableCachedModels,
				staticModels,
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
	const cacheModels = withoutStaticIds(preparedCacheModels);
	const dynamicModels = fetchedDynamicModels ?? [];
	// A successful empty endpoint result stays authoritative for THIS cycle (so an intentional
	// catalog emptying still prunes removed models downstream) but is not pinned into the cache as
	// authoritative, which would suppress the short retry that recovers a transient empty response.
	// Shared models.dev snapshots may be empty for one provider and remain authoritative.
	const cacheAuthoritative = hasDynamicFetcher
		? dynamicFetchSucceeded &&
			dynamicModels.length > 0 &&
			(dynamicModelsAuthoritative || !hasModelsDevFetcher || modelsDevFetchSucceeded)
		: modelsDevFetchSucceeded;
	const mergedWithCache = mergeDynamicModels(staticModels, cacheModels);
	const mergedWithModelsDev = mergeDynamicModels(mergedWithCache, modelsDevModels);
	// Additive shared-catalog rows cannot replace bundled ids, but their scores still enrich them.
	const mergedWithCatalogMetrics = additiveStaticModelIds
		? mergeCatalogMetrics(mergedWithModelsDev, modelsDevFetchSucceeded ? fetchedModelsDevModels : preparedCacheModels)
		: mergedWithModelsDev;
	const mergedModels = mergeDynamicModels(mergedWithCatalogMetrics, dynamicModels);
	const models = collapseBuiltModelVariants(
		authoritativeDynamicFetchSucceeded ? retainModelIds(mergedModels, dynamicModels) : mergedModels,
	);
	const resolutionAuthoritative = !hasRemoteFetcher || remoteResolutionComplete || shouldUseFreshCacheAsAuthoritative;
	const remoteUpdatedAt = anyRemoteFetchSucceeded ? now() : undefined;
	if (shouldFetchFromNetwork) {
		if (remoteUpdatedAt !== undefined) {
			writeModelCache(
				cacheProviderId,
				remoteUpdatedAt,
				models,
				cacheAuthoritative,
				staticFingerprint,
				dbPath,
				staticModels,
				restorableHeaderFallback,
			);
		} else {
			// Remote fetch failed: re-persist any prior catalog as a non-authoritative snapshot so stale
			// state stays visible while the retry backoff applies. With no prior cache and nothing to
			// preserve (a discovery-only provider's first failed fetch), leave the row absent: an empty
			// non-authoritative row reads back as fresh and would hide every discovery-only model for
			// NON_AUTHORITATIVE_RETRY_MS instead of retrying on the next launch.
			const latestCache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
			const latestRestoredCache = restoreCachedModelHeaders(
				latestCache?.models ?? cache?.models ?? [],
				staticModels,
				latestCache?.headerOmittedModelIds ?? cache?.headerOmittedModelIds ?? [],
				latestCache?.unrestorableHeaderModelIds ?? cache?.unrestorableHeaderModelIds ?? [],
				latestCache?.legacyHeaderRestoreMarkers ?? cache?.legacyHeaderRestoreMarkers ?? false,
				restorableHeaderFallback,
				options.restoreCachedHeaders,
			);
			const latestUsableCacheModels = latestRestoredCache.models.filter(
				model => !latestRestoredCache.unresolvedModelIds.has(model.id),
			);
			const latestCacheModels = withoutStaticIds(
				prepareCacheModelsForStaticMismatch(
					latestUsableCacheModels,
					staticModels,
					cacheFingerprintMatches,
					options.dropCachedModelIdsOnStaticMismatch,
				),
			);
			const fallbackSnapshotModels = collapseBuiltModelVariants(
				mergeDynamicModels(mergeDynamicModels(staticModels, latestCacheModels), modelsDevModels),
			);
			if (fallbackSnapshotModels.length > 0 || latestCache !== null || cache !== null) {
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
	}
	const cacheContributed = cacheModels.length > 0;
	const source: ModelResolutionSource = dynamicFetchSucceeded
		? "provider"
		: modelsDevFetchSucceeded
			? "models.dev"
			: cacheContributed
				? "cache"
				: "bundled";
	return {
		models,
		stale: !resolutionAuthoritative,
		source,
		...(remoteUpdatedAt !== undefined
			? { updatedAt: remoteUpdatedAt }
			: cacheContributed && cache
				? { updatedAt: cache.updatedAt }
				: {}),
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

function mergeCatalogMetrics<TApi extends Api>(
	models: Model<TApi>[],
	catalogModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (models.length === 0 || catalogModels.length === 0) return models;
	return applyCatalogMetrics(models, new CatalogMetricsIndex(catalogModels));
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

const MODEL_CACHE_FINGERPRINT_VERSION = "merge-v4";
const kStaticFingerprint = Symbol("model-manager.staticFingerprint");
type ModelArrayWithFingerprint = readonly (ModelSpec<Api> | Model<Api>)[] & { [kStaticFingerprint]?: string };

/**
 * Versioned, low-collision model-cache identity for a static provider slice. Cached by array
 * reference so repeat cold-start paths skip the JSON serialization and hash.
 */
export function fingerprintStaticModels<TApi extends Api>(
	models: readonly (ModelSpec<TApi> | Model<TApi>)[],
	dynamicModelsAuthoritative = false,
): string {
	if (models.length === 0) return `${MODEL_CACHE_FINGERPRINT_VERSION}:empty`;
	if (dynamicModelsAuthoritative)
		return `${MODEL_CACHE_FINGERPRINT_VERSION}:authoritative:${fingerprintStaticModels(models)}`;
	const tagged = models as ModelArrayWithFingerprint;
	const cached = tagged[kStaticFingerprint];
	if (cached !== undefined) return cached;

	const fingerprint = `${MODEL_CACHE_FINGERPRINT_VERSION}:${Bun.hash(JSON.stringify(models)).toString(36)}`;
	tagged[kStaticFingerprint] = fingerprint;
	return fingerprint;
}

function mergeDynamicModel<TApi extends Api>(existingModel: Model<TApi>, dynamicModel: Model<TApi>): Model<TApi> {
	const endpointChanged = existingModel.baseUrl !== dynamicModel.baseUrl;
	// DeepInfra's `vision`/`vlm` tags are its whole modality truth on one shared endpoint: a model that
	// dropped them must not keep the bundled reference's image support.
	const dynamicInputAuthoritative =
		endpointChanged ||
		(existingModel.provider === "github-copilot" && dynamicModel.provider === "github-copilot") ||
		(existingModel.provider === "deepinfra" && dynamicModel.provider === "deepinfra");
	const supportsImage = dynamicInputAuthoritative
		? dynamicModel.input.includes("image")
		: existingModel.input.includes("image") || dynamicModel.input.includes("image");

	const dynamicReasoningAuthoritative =
		existingModel.provider === "synthetic" && dynamicModel.provider === "synthetic";
	const reasoning = dynamicReasoningAuthoritative
		? dynamicModel.reasoning
		: existingModel.reasoning || dynamicModel.reasoning;
	const longContextCost = dynamicModel.cost.longContext ?? existingModel.cost.longContext;
	const timeBasedCost = dynamicModel.cost.timeBased ?? existingModel.cost.timeBased;
	// Static compat overrides are transport-scoped: a bundled chat-completions row must not
	// follow an id whose discovered route moved (Copilot's `supportsReasoningEffort: false`
	// would strip the effort dial once the id is pinned to Responses).
	const compat =
		dynamicModel.compatConfig ?? (dynamicModel.api === existingModel.api ? existingModel.compatConfig : undefined);
	// A resolver on either side makes the merged headers request-time; distinct sources layer dynamic over existing.
	const existingHeaders = existingModel.resolveHeaders ?? existingModel.headers;
	const dynamicHeaders = dynamicModel.resolveHeaders ?? dynamicModel.headers;
	let resolveHeaders = dynamicModel.resolveHeaders ?? existingModel.resolveHeaders;
	if (resolveHeaders && existingHeaders && dynamicHeaders && existingHeaders !== dynamicHeaders) {
		resolveHeaders = async signal => {
			const previous = typeof existingHeaders === "function" ? await existingHeaders(signal) : existingHeaders;
			const next = typeof dynamicHeaders === "function" ? await dynamicHeaders(signal) : dynamicHeaders;
			return { ...previous, ...next };
		};
	}

	return buildProviderModel({
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
			...(timeBasedCost ? { timeBased: timeBasedCost } : {}),
		},
		contextWindow: preferDiscoveryLimit(dynamicModel.contextWindow, existingModel.contextWindow),
		maxTokens: preferDiscoveryLimit(dynamicModel.maxTokens, existingModel.maxTokens),
		headers: resolveHeaders
			? undefined
			: dynamicModel.headers
				? { ...existingModel.headers, ...dynamicModel.headers }
				: existingModel.headers,
		resolveHeaders,
		compat,
		contextPromotionTarget: dynamicModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
	} as ModelSpec<TApi>);
}

function preferDiscoveryCost(discoveryCost: number | null | undefined, fallbackCost: number): number {
	if (discoveryCost === null || discoveryCost === undefined) return fallbackCost;
	return Number.isFinite(discoveryCost) && discoveryCost >= 0 ? discoveryCost : fallbackCost;
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
			models.push(buildProviderModel(item as ModelSpec<TApi>));
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

function isModelInputArray(value: unknown): value is ("text" | "image" | "video")[] {
	if (!Array.isArray(value) || value.length === 0) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (item !== "text" && item !== "image" && item !== "video") {
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
	const cost = value as TokenCost & { longContext?: unknown; timeBased?: unknown };
	if (cost.timeBased !== undefined && !isTimeBasedCost(cost.timeBased)) return false;
	const longContext = cost.longContext;
	if (longContext === undefined) return true;
	if (!isTokenCost(longContext) || !isRecord(longContext)) return false;
	const threshold = longContext.inputThreshold;
	return typeof threshold === "number" && threshold > 0 && threshold < Infinity;
}
