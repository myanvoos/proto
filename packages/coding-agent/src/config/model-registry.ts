import * as path from "node:path";
import type { ApiKeyResolver, FetchImpl, UsageProvider } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { registerOAuthProvider, unregisterOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type {
	Api,
	Context,
	Model,
	ModelSpec,
	RemoteCompactionConfig,
	SimpleStreamOptions,
	ThinkingConfig,
} from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { materializeModelHeaders } from "@oh-my-pi/pi-ai/utils/model-headers";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	clampContextOverride,
	clampsContextOverride,
	resolveMaxContextWindow,
} from "@oh-my-pi/pi-catalog/context-window";
import { applyCatalogMetrics, CatalogMetricsIndex } from "@oh-my-pi/pi-catalog/identity/metrics";
import { readModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	createModelManager,
	fingerprintStaticModels,
	type ModelManagerOptions,
	type ModelRefreshStrategy,
} from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	isCredentialScopedModelCacheProvider,
	MODELS_DEV_CATALOG_PROVIDER_IDS,
	modelsDevCatalogFallback,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
	resolveModelCacheProviderId,
	resolveOllamaModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { collapseBuiltModelVariants } from "@oh-my-pi/pi-catalog/variant-collapse";
import { getAgentDir, isBunTestRuntime, logger, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { resolveProviderModelReference } from "../config/model-resolver";
import type { AuthStorage } from "../session/auth-storage";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import { generateCodexAttestation } from "./codex-attestation";
import type { ConfigError, ConfigFile } from "./config-file";
import {
	buildCustomModelOverlay,
	type CustomModelDefinitionLike,
	type CustomModelOverlay,
	finalizeCustomModel,
	mergeAuthHeaderSources,
	normalizeSuppressedSelector,
	resolveModelOverrideWithAliases,
} from "./custom-models";
import {
	applyLlamaCppQwenThinking,
	DISCOVERY_DEFAULT_MAX_TOKENS,
	type DiscoveryContext,
	type DiscoveryProviderConfig,
	discoverLlamaCppModelRuntimeMetadata,
	discoverLmStudioModelRuntimeMetadata,
	discoverModelsByProviderType,
	ensureLlamaCppV1BaseUrl,
	getImplicitOllamaBaseUrl,
	getOllamaContextLengthOverride,
	isDiscoveryAuthRejection,
	normalizeBareDiscoveryBaseUrl,
	normalizeLiteLLMDiscoveryBaseUrl,
	normalizeLlamaCppBaseUrl,
} from "./model-discovery";
import {
	AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS,
	applyModelOverride,
	applyModelPatch,
	bedrockProviderFields,
	dropProviderModels,
	type ModelPatch,
	mergeByModelKey,
	mergeCompat,
	mergeDiscoveredModel,
	mergeProviderRemoteCompactionConfig,
	mergeRemoteCompactionConfig,
	type ProviderOverride,
	providersWithAuthoritativeProjectCatalog,
	resolveProviderBaseUrl,
} from "./model-patch";
import {
	BUILT_IN_DISCOVERY_CACHE_TTL_MS,
	BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS,
	type BuiltInDiscoveryResult,
	extractGoogleOAuthProjectId,
	extractGoogleOAuthToken,
	getOAuthCredentialsForProvider,
	isAuthenticated,
	isDiscoveryBearerApiKey,
	kNoAuth,
	type ProviderDiscoveryState,
	RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
	resolveCodexDiscoveryAccounts,
	STARTUP_MODEL_CACHE_PROVIDER_IDS,
	withModelDiscoveryTimeout,
} from "./model-provider-discovery";
import {
	createConfigHeaderResolver,
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
	isCommandConfigValue,
	resolveConfigHeaders,
	resolveConfigValue,
} from "./resolve-config-value";

export { mergeDiscoveredModel } from "./model-patch";
export {
	isAuthenticated,
	kNoAuth,
	type ProviderDiscoveryState,
	type ProviderDiscoveryStatus,
} from "./model-provider-discovery";

import { ModelsConfigFile, type ProviderValidationModel, validateProviderConfiguration } from "./models-config";
import type { ModelOverride, ModelsConfig, ProviderAuthMode } from "./models-config-schema";
import { type Settings, settings } from "./settings";

setCodexAttestationProvider(generateCodexAttestation);

const MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
	Object.fromEntries(MODELS_DEV_CATALOG_PROVIDER_IDS.map(providerId => [providerId, true as const])),
);
// Endpoint-authoritative providers own their catalog; the rest only gain additive shared-catalog ids.
const ADDITIVE_MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
	Object.fromEntries(
		MODELS_DEV_CATALOG_PROVIDER_IDS.filter(
			providerId =>
				!PROVIDER_DESCRIPTORS.some(
					descriptor => descriptor.providerId === providerId && descriptor.dynamicModelsAuthoritative,
				),
		).map(providerId => [providerId, true as const]),
	),
);

interface ConfiguredModelDiscoveryResult {
	models: Model<Api>[];
	/** A successful endpoint refresh replaces the provider's prior discovered and cached slices. */
	replaceRuntimeModels: boolean;
}

interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	error?: ConfigError;
	found: boolean;
}

type ModifyModelsHook = (models: Model<Api>[], credentials: OAuthCredentials) => Model<Api>[];

function getDisabledProviderIdsFromSettings(settingsInstance?: Settings): Set<string> {
	try {
		return new Set((settingsInstance ?? settings).get("disabledProviders"));
	} catch {
		return new Set();
	}
}

// Without a settings source (SDK embedding, early boot) callers get default windows until they opt in.
function isExtendedContextEnabledFromSettings(settingsInstance?: Settings): boolean {
	try {
		return (settingsInstance ?? settings).get("extendedContext");
	} catch {
		return false;
	}
}

// Online discovery never re-runs `!command` credential helpers; only explicit user refreshes (`proto models refresh`,
// model hub F5) pass refreshCommandCredentials to re-mint command-backed keys and headers.
export interface ModelRegistryRefreshOptions {
	refreshCommandCredentials?: boolean;
}

type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };

export class ModelRegistry {
	#models: Model<Api>[] = [];
	/** Intelligence/speed scores captured from built-in discovery, lent to proxy and custom ids. */
	#catalogMetrics = new CatalogMetricsIndex();
	#unprojectedModels: Model<Api>[] = [];
	#hasFullSnapshot = false;
	#cachedStandardModels: Model<Api>[] = [];
	#loadedStandardCacheProviders: Set<string> = new Set();
	#cachedDiscoverableModels: Model<Api>[] = [];
	#cachedAuthoritativeProviders: Set<string> = new Set();
	#internedStaticModels: Map<string, Model<Api>> = new Map();
	#providerLookupSnapshots: Map<string, Model<Api>[]> = new Map();
	#customProviderApiKeys: Map<string, string> = new Map();
	// `!command` apiKey/header values per provider from models.yml, so a 401 retry or explicit refresh can
	// invalidate every command a provider's credentials depend on, not just the apiKey.
	#commandConfigsByProvider: Map<string, Set<string>> = new Map();
	#keylessProviders: Set<string> = new Set();
	#discoverableProviders: DiscoveryProviderConfig[] = [];
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#lastStaticLoadMtime: number | null = null;
	#registeredProviderSources: Set<string> = new Set();
	#providerDiscoveryStates: Map<string, ProviderDiscoveryState> = new Map();
	#cacheDbPath?: string;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	#initialRefreshSettled = false;
	#initialRefreshWaiters = new Set<() => void>();
	#credentialScopedCacheHydration?: Promise<void>;
	// Keyed by config identity: a models.yml reload mid-flight must not coalesce onto the replaced config's request.
	#configuredDiscoveryInFlight: Map<
		DiscoveryProviderConfig,
		Map<ModelRefreshStrategy, Promise<ConfiguredModelDiscoveryResult>>
	> = new Map();
	#policyReapply?: Promise<void>;
	#lastDiscoveryWarnings: Map<string, string> = new Map();

	#runtimeDiscoveredModels: Model<Api>[] = [];
	#runtimeAuthoritativeProviders: Set<string> = new Set();
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	// registerProvider/fetchDynamicModels command values; survives static reloads, unlike #commandConfigsByProvider.
	#runtimeCommandConfigsByProvider: Map<string, Set<string>> = new Map();

	#runtimeModelModifiers: Map<string, ModifyModelsHook> = new Map();
	#lastModelModifierWarnings: Map<string, string> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();

	#runtimeModelManagers: Map<string, { options: ModelManagerOptions<Api>; sourceId: string }> = new Map();
	#ignoreLocalModelConfig: boolean;
	#fetch: FetchImpl;
	#settings: Settings | undefined;

	// The raw config (literal, env name, or `!command`) is resolved by AuthStorage per request, never at load.
	#installProviderApiKey(provider: string, keyConfig: string): void {
		this.#customProviderApiKeys.set(provider, keyConfig);
		this.authStorage.setConfigApiKey(provider, keyConfig);
	}

	#collectCommandConfigValues(
		target: Set<string>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
	): void {
		if (isCommandConfigValue(apiKey)) target.add(apiKey);
		if (!headers) return;
		for (const key in headers) {
			const value = headers[key];
			if (isCommandConfigValue(value)) target.add(value);
		}
	}

	#invalidateProviderCommandConfigs(provider: string): void {
		invalidateCommandConfig(this.#customProviderApiKeys.get(provider));
		for (const configs of [
			this.#commandConfigsByProvider.get(provider),
			this.#runtimeCommandConfigsByProvider.get(provider),
		]) {
			if (!configs) continue;
			for (const config of configs) invalidateCommandConfig(config);
		}
	}

	#recordRuntimeCommandConfigs(
		providerName: string,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		models: readonly { headers?: Record<string, string> }[],
	): void {
		const target = this.#runtimeCommandConfigsByProvider.get(providerName) ?? new Set<string>();
		this.#collectCommandConfigValues(target, apiKey, headers);
		for (const modelDef of models) this.#collectCommandConfigValues(target, undefined, modelDef.headers);
		if (target.size > 0) this.#runtimeCommandConfigsByProvider.set(providerName, target);
		else this.#runtimeCommandConfigsByProvider.delete(providerName);
	}

	#reloadStaticModelsForRefresh(options: ModelRegistryRefreshOptions | undefined, providerId?: string): void {
		if (options?.refreshCommandCredentials) {
			if (providerId) this.#invalidateProviderCommandConfigs(providerId);
			else invalidateAllCommandConfigs();
			// Forced reload re-installs config apiKeys so command-backed keys re-run now.
			this.#lastStaticLoadMtime = null;
		}
		this.#reloadStaticModels();
	}

	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
		options?: {
			ignoreLocalModelConfig?: boolean;

			settings?: Settings;

			cacheDbPath?: string;
			fetch?: FetchImpl;
		},
	) {
		this.#ignoreLocalModelConfig = options?.ignoreLocalModelConfig ?? false;
		this.#settings = options?.settings;
		this.#fetch =
			options?.fetch ??
			(isBunTestRuntime()
				? () => Promise.reject(new Error("network disabled in model-registry runtime test"))
				: wrapFetchForExtraCa(fetch));
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath ?? path.join(getAgentDir(), "models.yml"));
		this.#cacheDbPath =
			options?.cacheDbPath ?? (modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined);

		this.authStorage.setConfigValueResolver(resolveConfigValue);

		this.#loadModels();
	}

	async refresh(
		strategy: ModelRefreshStrategy = "online-if-uncached",
		options?: ModelRegistryRefreshOptions,
	): Promise<void> {
		this.#reloadStaticModelsForRefresh(options);
		this.#suppressedSelectors.clear();
		await this.#refreshRuntimeDiscoveries(strategy);
	}

	async hydrateCredentialScopedModelCaches(): Promise<void> {
		if (!this.#credentialScopedCacheHydration) {
			const providerIds = new Set<string>();
			for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
				if (isCredentialScopedModelCacheProvider(providerId)) providerIds.add(providerId);
			}
			this.#credentialScopedCacheHydration = this.#refreshRuntimeDiscoveries("offline", providerIds).catch(error => {
				logger.debug("credential-scoped model cache hydration failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
		const hydration = this.#credentialScopedCacheHydration;
		try {
			await hydration;
		} finally {
			if (this.#credentialScopedCacheHydration === hydration) {
				this.#credentialScopedCacheHydration = undefined;
			}
		}
	}

	reapplyModelPolicies(): Promise<void> {
		this.#policyReapply ??= this.#runPolicyReapply();
		return this.#policyReapply;
	}

	async #runPolicyReapply(): Promise<void> {
		try {
			this.#lastStaticLoadMtime = null;
			await this.refresh("offline");
		} finally {
			this.#policyReapply = undefined;
		}
	}

	refreshInBackground(strategy: ModelRefreshStrategy = "online-if-uncached"): void {
		if (this.#backgroundRefresh) {
			return;
		}
		const refreshPromise = this.refresh(strategy)
			.catch(error => {
				logger.warn("background model refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.#backgroundRefresh === refreshPromise) {
					this.#backgroundRefresh = undefined;
				}
				this.#markInitialRefreshSettled();
			});
		this.#backgroundRefresh = refreshPromise;
	}

	async awaitBackgroundRefresh(): Promise<void> {
		if (this.#backgroundRefresh) {
			await this.#backgroundRefresh;
		}
	}

	/**
	 * Resolves once the first background refresh settles, even when it has not started yet (the CLI
	 * starts it right after session construction). Stays pending if no background refresh ever runs;
	 * an aborted signal releases the waiter.
	 */
	awaitInitialBackgroundRefresh(signal?: AbortSignal): Promise<void> {
		if (this.#initialRefreshSettled || signal?.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const settle = () => {
			signal?.removeEventListener("abort", settle);
			this.#initialRefreshWaiters.delete(settle);
			resolve();
		};
		this.#initialRefreshWaiters.add(settle);
		signal?.addEventListener("abort", settle, { once: true });
		return promise;
	}

	#markInitialRefreshSettled(): void {
		if (this.#initialRefreshSettled) return;
		this.#initialRefreshSettled = true;
		for (const settle of this.#initialRefreshWaiters) settle();
	}

	/**
	 * Refresh only the named configured discovery providers: no static reload and no restore pass over
	 * other runtime managers, so a scoped caller (session resume) never waits on unrelated providers.
	 */
	async refreshDiscoverableProviders(
		providerIds: Iterable<string>,
		strategy: ModelRefreshStrategy = "online-if-uncached",
	): Promise<void> {
		const filter = new Set(providerIds);
		if (filter.size === 0) return;
		await this.#refreshRuntimeDiscoveries(strategy, filter);
	}

	async refreshProvider(
		providerId: string,
		strategy: ModelRefreshStrategy = "online",
		options?: ModelRegistryRefreshOptions,
	): Promise<void> {
		this.#reloadStaticModelsForRefresh(options, providerId);
		for (const selector of this.#suppressedSelectors.keys()) {
			if (selector.startsWith(`${providerId}/`)) {
				this.#suppressedSelectors.delete(selector);
			}
		}
		await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]));

		const otherRuntimeProviderIds = new Set(
			[...this.#runtimeModelManagers.keys()].filter(runtimeId => runtimeId !== providerId),
		);
		if (otherRuntimeProviderIds.size > 0) {
			await this.#refreshRuntimeDiscoveries("online-if-uncached", otherRuntimeProviderIds);
		}
	}

	hasLazyRuntimeMetadata(provider: string): boolean {
		return this.#findLazyRuntimeDiscovery(provider) !== undefined;
	}

	#findLazyRuntimeDiscovery(provider: string): DiscoveryProviderConfig | undefined {
		return this.#discoverableProviders.find(
			providerConfig =>
				providerConfig.provider === provider &&
				(providerConfig.discovery.type === "llama.cpp" || providerConfig.discovery.type === "lm-studio"),
		);
	}

	async refreshSelectedModelMetadata(model: Model<Api>): Promise<Model<Api>> {
		const discoveryConfig = this.#findLazyRuntimeDiscovery(model.provider);
		if (!discoveryConfig) {
			return model;
		}
		this.#ensureFullSnapshot();
		const requestModel = await materializeModelHeaders(model);
		const runtimeMetadata =
			discoveryConfig.discovery.type === "lm-studio"
				? await discoverLmStudioModelRuntimeMetadata(
						requestModel,
						this.#nonResolvingDiscoveryContext(),
						discoveryConfig.discovery.timeoutMs,
					)
				: await discoverLlamaCppModelRuntimeMetadata(
						requestModel,
						this.#nonResolvingDiscoveryContext(),
						discoveryConfig.discovery.timeoutMs,
					);
		if (runtimeMetadata === undefined) {
			return this.find(model.provider, model.id) ?? model;
		}
		const { contextWindow, maxTokens, input } = runtimeMetadata;
		const current = this.find(model.provider, model.id) ?? model;
		const override = this.#resolveLiveModelOverride(current);
		const customModel = this.#resolveLiveCustomModelOverlay(current);
		const patch: ModelPatch = {};
		if (
			contextWindow !== undefined &&
			override?.contextWindow === undefined &&
			customModel?.contextWindow === undefined &&
			current.contextWindow !== contextWindow
		) {
			patch.contextWindow = contextWindow;
		}
		const effectiveContextWindow =
			override?.contextWindow ??
			customModel?.contextWindow ??
			patch.contextWindow ??
			current.contextWindow ??
			contextWindow;
		if (maxTokens !== undefined && effectiveContextWindow !== undefined) {
			const effectiveMaxTokens = Math.min(maxTokens, effectiveContextWindow);
			if (
				override?.maxTokens === undefined &&
				customModel?.maxTokens === undefined &&
				current.maxTokens !== effectiveMaxTokens
			) {
				patch.maxTokens = effectiveMaxTokens;
			}
		}
		if (
			input !== undefined &&
			override?.input === undefined &&
			customModel?.input === undefined &&
			(current.input.length !== input.length || current.input.some((value, index) => value !== input[index]))
		) {
			patch.input = input;
		}
		if (patch.contextWindow === undefined && patch.maxTokens === undefined && patch.input === undefined) {
			return current;
		}
		const unprojected = resolveProviderModelReference(current.provider, current.id, this.#unprojectedModels);
		if (unprojected) {
			const patchedBase = applyModelPatch(unprojected, patch, "merge");
			this.#unprojectedModels = this.#unprojectedModels.map(candidate =>
				candidate.provider === unprojected.provider && candidate.id === unprojected.id ? patchedBase : candidate,
			);
			this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
			return resolveProviderModelReference(current.provider, current.id, this.#models) ?? patchedBase;
		}
		const patched = applyModelPatch(current, patch, "merge");
		this.#models = this.#models.map(candidate =>
			candidate.provider === current.provider && candidate.id === current.id ? patched : candidate,
		);
		return patched;
	}

	async refreshRuntimeProviders(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		if (this.#runtimeModelManagers.size === 0) {
			return;
		}
		await this.#refreshRuntimeDiscoveries(strategy, new Set(this.#runtimeModelManagers.keys()));
	}

	#reloadStaticModels(): void {
		const currentMtime = this.#modelsConfigFile.getMtimeMs();
		if (currentMtime !== null && currentMtime === this.#lastStaticLoadMtime) {
			return;
		}
		this.#modelsConfigFile.invalidate();
		this.#customProviderApiKeys.clear();
		this.#keylessProviders.clear();
		this.#discoverableProviders = [];

		this.authStorage.clearConfigApiKeys();

		for (const [k, v] of this.#runtimeProviderApiKeys) {
			this.#installProviderApiKey(k, v);
		}
		this.#providerOverrides.clear();
		this.#modelOverrides.clear();
		this.#configError = undefined;
		this.#providerDiscoveryStates.clear();
		this.#loadModels();
	}

	getError(): ConfigError | undefined {
		return this.#configError;
	}

	#loadModels() {
		this.#resetStaticComposition();
		this.#commandConfigsByProvider.clear();

		const {
			models: customModels = [],
			overrides = new Map(),
			modelOverrides = new Map(),
			keylessProviders = new Set(),
			discoverableProviders = [],
			configuredProviders = new Set(),
			error: configError,
		} = this.#loadCustomModels();
		this.#configError = configError;
		this.#keylessProviders = keylessProviders;
		this.#discoverableProviders = discoverableProviders;
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = modelOverrides;

		this.#addImplicitDiscoverableProviders(configuredProviders);
		this.#cachedStandardModels = [];
		this.#loadedStandardCacheProviders.clear();
		this.#cachedAuthoritativeProviders.clear();
		this.#cachedDiscoverableModels = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());
		this.#lastStaticLoadMtime = this.#modelsConfigFile.getMtimeMs();
	}

	#resetStaticComposition(): void {
		this.#models = [];
		this.#unprojectedModels = [];
		this.#hasFullSnapshot = false;
		this.#internedStaticModels.clear();
		this.#providerLookupSnapshots.clear();
	}

	#knownStaticProviders(): string[] {
		const providers = new Set<string>(getBundledProviders());
		for (const provider of STARTUP_MODEL_CACHE_PROVIDER_IDS) providers.add(provider);
		for (const model of this.#cachedStandardModels) providers.add(model.provider);
		for (const model of this.#cachedDiscoverableModels) providers.add(model.provider);
		for (const model of this.#customModelOverlays) providers.add(model.provider);
		for (const model of this.#runtimeDiscoveredModels) providers.add(model.provider);
		for (const model of this.#runtimeModelOverlays) providers.add(model.provider);
		return [...providers];
	}

	#internStaticModels(models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			const key = `${model.provider}\u0000${model.id}`;
			const interned = this.#internedStaticModels.get(key);
			if (interned) return interned;
			this.#internedStaticModels.set(key, model);
			return model;
		});
	}

	#invalidateProviderModelCache(providerName: string): void {
		const prefix = `${providerName}\u0000`;
		for (const key of this.#internedStaticModels.keys()) {
			if (key.startsWith(prefix)) {
				this.#internedStaticModels.delete(key);
			}
		}
		this.#providerLookupSnapshots.delete(providerName);
	}

	#applyRuntimeModelModifiers(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeModelModifiers.size === 0) return models;
		let projected = models;
		for (const [providerName, modifyModels] of this.#runtimeModelModifiers) {
			const credential = this.authStorage.getOAuthCredential(providerName);
			if (!credential) continue;
			try {
				// Clone the mutable catalog data but keep header resolvers as opaque capabilities (structuredClone rejects
				// functions), so a hook can rename rows without losing request-time credentials or resolving them early.
				const snapshot: Model<Api>[] = structuredClone(
					projected.map(({ resolveHeaders: _resolveHeaders, ...model }) => model),
				);
				for (let index = 0; index < snapshot.length; index++) {
					const resolveHeaders = projected[index].resolveHeaders;
					if (resolveHeaders) snapshot[index].resolveHeaders = resolveHeaders;
				}
				// Rebuild the hook's rows for its own provider so compat/thinking exist. Only built rows carry
				// `compatConfig`; a spec-shaped row keeps its sparse override in `compat`, which toModelSpec would drop.
				projected = modifyModels(snapshot, credential).map(model => {
					// A hook that also set plain headers layers them over the kept resolver.
					const withHeaders =
						model.resolveHeaders && model.headers
							? {
									...model,
									headers: undefined,
									resolveHeaders: createConfigHeaderResolver([model.resolveHeaders, model.headers]),
								}
							: model;
					if (withHeaders.provider !== providerName) return withHeaders;
					return buildModel(
						Object.hasOwn(withHeaders, "compatConfig")
							? toModelSpec(withHeaders)
							: (withHeaders as ModelSpec<Api>),
					);
				});
			} catch (error) {
				this.#warnModelModifierFailure(providerName, error instanceof Error ? error.message : String(error));
			}
		}
		return projected;
	}

	#warnModelModifierFailure(provider: string, error: string): void {
		if (this.#lastModelModifierWarnings.get(provider) === error) return;
		this.#lastModelModifierWarnings.set(provider, error);
		logger.warn("extension model projection failed; serving unprojected catalog", { provider, error });
	}

	#composeUnprojectedStaticModels(providerFilter?: ReadonlySet<string>): Model<Api>[] {
		this.#ensureStandardProviderCaches(providerFilter);
		const select = <T extends { provider: string }>(models: readonly T[]): T[] =>
			providerFilter ? models.filter(model => providerFilter.has(model.provider)) : [...models];
		let builtInModels = this.#applyHardcodedModelPolicies(
			this.#loadBuiltInModels(this.#providerOverrides, providerFilter),
		);
		if (this.#cachedAuthoritativeProviders.size > 0) {
			builtInModels = dropProviderModels(builtInModels, this.#cachedAuthoritativeProviders);
		}
		let resolvedDefaults = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, select(this.#cachedStandardModels)),
			select(this.#cachedDiscoverableModels),
		);
		if (this.#runtimeAuthoritativeProviders.size > 0) {
			const authoritativeProviders = providerFilter
				? new Set([...this.#runtimeAuthoritativeProviders].filter(provider => providerFilter.has(provider)))
				: this.#runtimeAuthoritativeProviders;
			resolvedDefaults = dropProviderModels(resolvedDefaults, authoritativeProviders);
		}
		const withDiscoveredModels = this.#mergeResolvedModels(resolvedDefaults, select(this.#runtimeDiscoveredModels));
		const withConfigModels = this.#mergeCustomModels(withDiscoveredModels, select(this.#customModelOverlays));
		const combined = this.#mergeCustomModels(withConfigModels, select(this.#runtimeModelOverlays));
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		const withProviderBedrock = this.#applyProviderBedrockOverrides(withModelOverrides);
		return this.#applyLlamaCppModelFixups(this.#applyRuntimeProviderOverrides(withProviderBedrock));
	}

	#captureCatalogMetrics(models: readonly Model<Api>[], replace: boolean): void {
		if (replace) {
			const incoming = new CatalogMetricsIndex(models);
			if (!incoming.isEmpty) this.#catalogMetrics = incoming;
			return;
		}
		this.#catalogMetrics.add(models);
	}

	#withCatalogMetrics(models: Model<Api>[]): Model<Api>[] {
		return applyCatalogMetrics(models, this.#catalogMetrics);
	}

	#composeStaticModels(providerFilter?: ReadonlySet<string>): Model<Api>[] {
		const projectFullCatalog = providerFilter !== undefined && this.#runtimeModelModifiers.size > 0;
		const unprojected = this.#composeUnprojectedStaticModels(projectFullCatalog ? undefined : providerFilter);
		const projected = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(unprojected));
		const selected = projectFullCatalog ? projected.filter(model => providerFilter.has(model.provider)) : projected;
		return this.#internStaticModels(selected);
	}

	#ensureFullSnapshot(): Model<Api>[] {
		if (!this.#hasFullSnapshot) {
			this.#unprojectedModels = this.#composeUnprojectedStaticModels();
			this.#models = this.#internStaticModels(
				this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels)),
			);
			this.#hasFullSnapshot = true;
			this.#providerLookupSnapshots.clear();
		}
		return this.#models;
	}

	#loadBuiltInModels(overrides: Map<string, ProviderOverride>, providerFilter?: ReadonlySet<string>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			if (providerFilter && !providerFilter.has(provider)) return [];
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = overrides.get(provider);

			return models.map(m => {
				if (!providerOverride) return m;
				const withTransportOverride = this.#applyProviderTransportOverride(toModelSpec(m), providerOverride);
				return buildModel({
					...withTransportOverride,
					compat: mergeCompat(m.compatConfig, providerOverride.compat),
				} as ModelSpec<Api>);
			});
		});
	}

	#mergeResolvedModels(baseModels: Model<Api>[], replacementModels: Model<Api>[]): Model<Api>[] {
		return mergeByModelKey(baseModels, replacementModels, (existing, replacementModel) => {
			if (!existing) return replacementModel;
			const supportsTools = replacementModel.supportsTools ?? existing.supportsTools;
			return {
				...replacementModel,
				contextWindow: replacementModel.contextWindow ?? existing.contextWindow,
				maxTokens: replacementModel.maxTokens ?? existing.maxTokens,
				omitMaxOutputTokens: replacementModel.omitMaxOutputTokens ?? existing.omitMaxOutputTokens,
				...(supportsTools !== undefined ? { supportsTools } : {}),
			};
		});
	}

	#mergeCustomModels(builtInModels: Model<Api>[], customModels: CustomModelOverlay[]): Model<Api>[] {
		return mergeByModelKey(builtInModels, customModels, (existingModel, customModel) => {
			const model = existingModel
				? applyModelPatch(
						{
							...existingModel,
							id: customModel.id,
							provider: customModel.provider,
							api: customModel.api,
							baseUrl: customModel.baseUrl,
						},
						customModel,
						"replace",
					)
				: finalizeCustomModel(customModel, { useDefaults: true });
			// Overlays carry no transport; reapply the provider transport and its gateway URL only.
			const override = this.#providerOverrides.get(model.provider);
			return override?.transport
				? this.#applyProviderTransportOverride(model, { baseUrl: override.baseUrl, transport: override.transport })
				: model;
		});
	}

	#descriptorBaseUrl(providerId: string): string | undefined {
		return (
			this.#runtimeProviderOverrides.get(providerId)?.baseUrl ??
			this.#providerOverrides.get(providerId)?.baseUrl ??
			(this.#hasFullSnapshot ? this.getProviderBaseUrl(providerId) : undefined)
		);
	}

	#resolveStartupModelCacheProviderId(providerId: string): string {
		const baseUrl =
			this.#runtimeProviderOverrides.get(providerId)?.baseUrl ??
			this.#providerOverrides.get(providerId)?.baseUrl ??
			(this.#hasFullSnapshot ? this.getProviderBaseUrl(providerId) : undefined);
		return resolveModelCacheProviderId(providerId, { baseUrl });
	}

	#ensureStandardProviderCaches(providerFilter?: ReadonlySet<string>): void {
		const providersToLoad = new Set(
			STARTUP_MODEL_CACHE_PROVIDER_IDS.filter(
				provider =>
					!this.#loadedStandardCacheProviders.has(provider) && (!providerFilter || providerFilter.has(provider)),
			),
		);
		if (providersToLoad.size === 0) return;

		for (const provider of providersToLoad) this.#loadedStandardCacheProviders.add(provider);
		const cached = this.#loadCachedStandardProviderModels(providersToLoad);
		const cachedModels = this.#applyHardcodedModelPolicies(cached.models);
		this.#cachedStandardModels.push(...cachedModels);
		for (const provider of providersWithAuthoritativeProjectCatalog(cachedModels)) {
			if (cached.authoritativeFreshProviders.has(provider)) this.#cachedAuthoritativeProviders.add(provider);
		}
		for (const provider of cached.authoritativeFreshProviders) {
			if (AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS.has(provider)) this.#cachedAuthoritativeProviders.add(provider);
		}
	}

	#loadCachedStandardProviderModels(providerFilter: ReadonlySet<string>): {
		models: Model<Api>[];
		authoritativeFreshProviders: Set<string>;
	} {
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(provider => provider.provider));
		const cachedModels: Model<Api>[] = [];
		const authoritativeFreshProviders = new Set<string>();
		for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
			if (
				!providerFilter.has(providerId) ||
				configuredDiscoveryProviders.has(providerId) ||
				isCredentialScopedModelCacheProvider(providerId)
			) {
				continue;
			}
			const cacheProviderId = this.#resolveStartupModelCacheProviderId(providerId);
			const cache = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			const sharedCatalogProvider = MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP[providerId] === true;
			const additiveSharedCatalogProvider = ADDITIVE_MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP[providerId] === true;
			if (!cache) {
				// A descriptor provider the user can reach is pending discovery, not absent: report it idle so the model
				// hub shows it awaiting a fetch instead of having no discovery state at all.
				const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
				const discoveryExpected =
					sharedCatalogProvider ||
					(descriptor !== undefined &&
						(this.authStorage.hasAuth(providerId) ||
							descriptor.allowUnauthenticated === true ||
							this.#keylessProviders.has(providerId)));
				if (discoveryExpected) {
					this.#providerDiscoveryStates.set(providerId, {
						provider: providerId,
						status: "idle",
						optional: false,
						stale: false,
						source: "bundled",
						models: [],
					});
				}
				continue;
			}
			if (cache.fresh && cache.authoritative) {
				authoritativeFreshProviders.add(providerId);
			}

			const omittedHeaderIds = new Set(cache.headerOmittedModelIds);
			const unrestorableHeaderIds = new Set(cache.unrestorableHeaderModelIds);
			const bundledModels =
				omittedHeaderIds.size > 0 || sharedCatalogProvider
					? (getBundledModels(providerId as Parameters<typeof getBundledModels>[0]) as Model<Api>[])
					: undefined;
			const bundledFingerprint = bundledModels
				? fingerprintStaticModels(bundledModels, sharedCatalogProvider && !additiveSharedCatalogProvider)
				: undefined;
			// A matching cache may carry provider-endpoint overrides. Strip same-id rows only across a
			// bundled-catalog upgrade, where the additive shared catalog must not replace new bundled metadata.
			const additiveCacheStaticMismatch =
				additiveSharedCatalogProvider &&
				bundledFingerprint !== undefined &&
				cache.staticFingerprint !== bundledFingerprint &&
				!cache.staticFingerprint.startsWith(`${bundledFingerprint}:drop:`);
			const bundledById = bundledModels
				? new Map(bundledModels.map(bundledModel => [bundledModel.id, bundledModel]))
				: undefined;
			const models: ModelSpec<Api>[] = [];
			for (const cachedModel of cache.models) {
				const spec = cachedModel.provider === providerId ? cachedModel : { ...cachedModel, provider: providerId };
				if (additiveCacheStaticMismatch && bundledById?.has(spec.id)) continue;
				if (!omittedHeaderIds.has(spec.id)) {
					models.push(spec);
					continue;
				}

				const unrestorable = unrestorableHeaderIds.has(spec.id);
				const bundledHeaders = (
					unrestorable
						? cache.legacyHeaderRestoreMarkers && spec.requestModelId
							? bundledById?.get(spec.requestModelId)
							: undefined
						: (bundledById?.get(spec.id) ??
							(spec.requestModelId ? bundledById?.get(spec.requestModelId) : undefined))
				)?.headers;
				if (!bundledHeaders) continue;
				models.push({ ...spec, headers: bundledHeaders });
			}
			const providerOverride = this.#providerOverrides.get(providerId);
			const withTransport = providerOverride
				? models.map(model => this.#applyProviderTransportOverride(model, providerOverride))
				: models;
			const withCompat = providerOverride?.compat
				? withTransport.map(model =>
						buildModel({
							...model,
							compat: mergeCompat(model.compat, providerOverride.compat),
						} as ModelSpec<Api>),
					)
				: withTransport.map(model => buildModel(model));
			const providerModels = this.#applyProviderModelOverrides(providerId, withCompat);
			cachedModels.push(...providerModels);
			if (sharedCatalogProvider) {
				const cacheMatchesBundledFingerprint =
					bundledFingerprint !== undefined &&
					(cache.staticFingerprint === bundledFingerprint ||
						cache.staticFingerprint.startsWith(`${bundledFingerprint}:drop:`));
				const cachedSnapshotMatchesBundled =
					bundledModels !== undefined &&
					fingerprintStaticModels(cache.models, !additiveSharedCatalogProvider) ===
						fingerprintStaticModels(bundledModels, !additiveSharedCatalogProvider);
				const cacheContributed = additiveSharedCatalogProvider
					? providerModels.some(model => bundledById?.has(model.id) !== true)
					: !(cacheMatchesBundledFingerprint && cachedSnapshotMatchesBundled);
				const stale = !cache.fresh || !cache.authoritative;
				this.#providerDiscoveryStates.set(providerId, {
					provider: providerId,
					status: cacheContributed ? "cached" : stale ? "unavailable" : "idle",
					optional: false,
					stale,
					...(cacheContributed ? { fetchedAt: cache.updatedAt } : {}),
					source: cacheContributed ? "cache" : "bundled",
					models: providerModels.map(model => model.id),
				});
			}
		}
		return { models: cachedModels, authoritativeFreshProviders };
	}

	// A configured `authHeader` + apiKey is re-derived at the request boundary, so cached discovery rows (which never
	// persist headers) stay usable without baking a credential snapshot into the cache.
	#canRestoreConfiguredDiscoveryHeaders(providerId: string): boolean {
		const override = this.#providerOverrides.get(providerId);
		return override?.authHeader === true && override.apiKey !== undefined;
	}

	#loadCachedDiscoverableModels(): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoverableProviders) {
			const cacheProviderId = this.#configuredDiscoveryCacheProviderId(providerConfig);
			const cache = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			if (!cache) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "idle",
					optional: providerConfig.optional ?? false,
					stale: false,
					models: [],
				});
				continue;
			}
			const configStale = this.#isDiscoveryCacheOlderThanModelsConfig(cache.updatedAt);

			const canRestoreHeaders = this.#canRestoreConfiguredDiscoveryHeaders(providerConfig.provider);
			const omittedHeaderIds = new Set(cache.headerOmittedModelIds);
			const hasUnrestoredHeaders = omittedHeaderIds.size > 0 && !canRestoreHeaders;
			const usableCacheModels =
				omittedHeaderIds.size === 0 || canRestoreHeaders
					? cache.models
					: cache.models.filter(model => !omittedHeaderIds.has(model.id));
			const providerOverride = this.#providerOverrides.get(providerConfig.provider);
			const restoredCacheModels = usableCacheModels.map(spec =>
				providerOverride
					? this.#applyProviderTransportOverrideToModel(buildModel(spec), providerOverride)
					: buildModel(spec),
			);
			const models = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(providerConfig.compat, restoredCacheModels),
				),
			);
			cachedModels.push(...models);
			this.#providerDiscoveryStates.set(providerConfig.provider, {
				provider: providerConfig.provider,
				status: "cached",
				optional: providerConfig.optional ?? false,
				stale:
					providerConfig.discovery.type === "llama.cpp" ||
					!cache.fresh ||
					!cache.authoritative ||
					configStale ||
					hasUnrestoredHeaders,
				fetchedAt: cache.updatedAt,
				models: models.map(model => model.id),
			});
		}
		return cachedModels;
	}

	#applyProviderCompat(compat: ModelSpec<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
		if (!compat) return models;
		return models.map(model =>
			buildModel({ ...model, compat: mergeCompat(model.compatConfig, compat) } as ModelSpec<Api>),
		);
	}

	#normalizeDiscoverableModels(providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		const withDecoderMetadata =
			providerConfig.discovery.type === "ollama" ||
			providerConfig.discovery.type === "llama.cpp" ||
			providerConfig.discovery.type === "lm-studio"
				? models.map(model =>
						buildModel({ ...model, imageInputDecoder: "stb", compat: model.compatConfig } as ModelSpec<Api>),
					)
				: models;

		const withRemoteCompaction = providerConfig.remoteCompaction
			? withDecoderMetadata.map(model =>
					buildModel({
						...model,
						remoteCompaction: mergeProviderRemoteCompactionConfig(
							model.remoteCompaction,
							providerConfig.remoteCompaction,
						),
						compat: model.compatConfig,
					} as ModelSpec<Api>),
				)
			: withDecoderMetadata;

		if (providerConfig.provider !== "ollama" || providerConfig.api !== "openai-responses") {
			return withRemoteCompaction;
		}

		const contextLengthOverride = getOllamaContextLengthOverride();
		return withRemoteCompaction.map(model => {
			const normalized =
				model.api === "openai-completions"
					? buildModel({
							...model,
							api: "openai-responses" as const,
							compat: model.compatConfig,
						} as ModelSpec<Api>)
					: model;
			if (contextLengthOverride === undefined) {
				return normalized;
			}
			return {
				...normalized,
				contextWindow: contextLengthOverride,
				maxTokens: Math.min(contextLengthOverride, DISCOVERY_DEFAULT_MAX_TOKENS),
			};
		});
	}

	#addImplicitDiscoverableProviders(configuredProviders: Set<string>): void {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const hasOllamaEndpointOverride = Boolean(Bun.env.OLLAMA_BASE_URL?.trim() || Bun.env.OLLAMA_HOST?.trim());
		if (!configuredProviders.has("ollama") && !disabledProviders.has("ollama")) {
			this.#discoverableProviders.push({
				provider: "ollama",
				api: "openai-responses",
				baseUrl: getImplicitOllamaBaseUrl(),
				discovery: { type: "ollama" },
				optional: !hasOllamaEndpointOverride,
			});
			this.#keylessProviders.add("ollama");
		}
		if (!configuredProviders.has("llama.cpp") && !disabledProviders.has("llama.cpp")) {
			this.#discoverableProviders.push({
				provider: "llama.cpp",
				api: "openai-responses",
				baseUrl: Bun.env.LLAMA_CPP_BASE_URL || "http://127.0.0.1:8080",
				discovery: { type: "llama.cpp" },
				optional: !Bun.env.LLAMA_CPP_BASE_URL,
			});

			if (!this.authStorage.hasAuth("llama.cpp")) {
				this.#keylessProviders.add("llama.cpp");
			}
		}
		if (!configuredProviders.has("lm-studio") && !disabledProviders.has("lm-studio")) {
			this.#discoverableProviders.push({
				provider: "lm-studio",
				api: "openai-completions",
				baseUrl: Bun.env.LM_STUDIO_BASE_URL || "http://127.0.0.1:1234/v1",
				discovery: { type: "lm-studio" },
				optional: !Bun.env.LM_STUDIO_BASE_URL,
			});
			this.#keylessProviders.add("lm-studio");
		}
	}

	#loadCustomModels(): CustomModelsResult {
		if (this.#ignoreLocalModelConfig) {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				found: false,
			};
		}
		const { value, error, status } = this.#modelsConfigFile.tryLoad();

		if (status === "error") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				error,
				found: true,
			};
		} else if (status === "not-found") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				found: false,
			};
		}

		const overrides = new Map<string, ProviderOverride>();
		const allModelOverrides = new Map<string, Map<string, ModelOverride>>();
		const keylessProviders = new Set<string>();
		const discoverableProviders: DiscoveryProviderConfig[] = [];
		const providerEntries = Object.entries(value.providers ?? {});
		const configuredProviders = new Set(Object.keys(value.providers ?? {}));
		for (const [providerName, providerConfig] of providerEntries) {
			const commandConfigs = new Set<string>();
			this.#collectCommandConfigValues(commandConfigs, providerConfig.apiKey, providerConfig.headers);
			for (const modelDef of providerConfig.models ?? []) {
				this.#collectCommandConfigValues(commandConfigs, undefined, modelDef.headers);
			}
			// The provider baseUrl covers the APIs of custom models inheriting it (or the provider-level api of an
			// override-only config); without that evidence it stays provider-wide.
			const baseUrlApis = new Set<Api>();
			for (const modelDef of providerConfig.models ?? []) {
				if (modelDef.baseUrl) continue;
				const modelApi = modelDef.api ?? providerConfig.api;
				if (modelApi) baseUrlApis.add(modelApi as Api);
			}
			if (providerConfig.api && (providerConfig.models?.length ?? 0) === 0) {
				baseUrlApis.add(providerConfig.api as Api);
			}

			if (
				providerConfig.baseUrl ||
				providerConfig.headers ||
				providerConfig.apiKey ||
				providerConfig.authHeader !== undefined ||
				providerConfig.compat ||
				providerConfig.disableStrictTools ||
				providerConfig.guardrailIdentifier ||
				providerConfig.requestMetadata ||
				providerConfig.remoteCompaction ||
				providerConfig.transport
			) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				overrides.set(providerName, {
					baseUrlApis: baseUrlApis.size > 0 ? [...baseUrlApis] : undefined,
					baseUrl:
						providerConfig.discovery?.type === "litellm"
							? normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl)
							: providerConfig.discovery?.type === "openai-models-list" &&
									providerConfig.discovery.injectV1 === false
								? normalizeBareDiscoveryBaseUrl(providerConfig.baseUrl)
								: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerConfig.apiKey,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					remoteCompaction: providerConfig.remoteCompaction,
					transport: providerConfig.transport,
					guardrailIdentifier: providerConfig.guardrailIdentifier,
					guardrailVersion: providerConfig.guardrailVersion,
					guardrailTrace: providerConfig.guardrailTrace,
					requestMetadata: providerConfig.requestMetadata,
				});
			}

			const authMode = (providerConfig.auth ?? "apiKey") as ProviderAuthMode;
			if (authMode === "none") {
				keylessProviders.add(providerName);
			}

			if (providerConfig.discovery && (providerConfig.api || providerConfig.discovery.type === "proxy")) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				discoverableProviders.push({
					provider: providerName,

					api: (providerConfig.api ?? "openai-completions") as Api,
					baseUrl: providerConfig.baseUrl,
					// Raw (`!command` intact): resolved per discovery request, never at load.
					headers: providerConfig.headers,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					remoteCompaction: providerConfig.remoteCompaction,
					discovery: providerConfig.discovery,
					optional: false,
				});
			}

			if (providerConfig.apiKey) {
				this.#installProviderApiKey(providerName, providerConfig.apiKey);
			}

			if (providerConfig.modelOverrides) {
				const perModel = new Map<string, ModelOverride>();
				for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
					this.#collectCommandConfigValues(commandConfigs, undefined, override.headers);
					perModel.set(modelId, override);
				}
				allModelOverrides.set(providerName, perModel);
			}
			if (commandConfigs.size > 0) this.#commandConfigsByProvider.set(providerName, commandConfigs);
		}

		return {
			models: this.#parseModels(value),
			overrides,
			modelOverrides: allModelOverrides,
			keylessProviders,
			discoverableProviders,
			configuredProviders,
			found: true,
		};
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<void> {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const selectedDiscoverableProviders = (
			providerFilter
				? this.#discoverableProviders.filter(provider => providerFilter.has(provider.provider))
				: this.#discoverableProviders
		).filter(provider => !disabledProviders.has(provider.provider));
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve<Array<ConfiguredModelDiscoveryResult & { provider: DiscoveryProviderConfig }>>([])
				: Promise.all(
						selectedDiscoverableProviders.map(async provider => ({
							provider,
							...(await this.#discoverProviderModelsCoalesced(provider, strategy)),
						})),
					);
		const [configuredDiscoveryResults, builtInDiscovery] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		this.#captureCatalogMetrics(builtInDiscovery.models, providerFilter === undefined);
		// Drop results for providers removed from the config while their discovery was in flight.
		const currentDiscoverableProviders = new Set(this.#discoverableProviders);
		const currentConfiguredResults = configuredDiscoveryResults.filter(result =>
			currentDiscoverableProviders.has(result.provider),
		);
		const configuredDiscovered = currentConfiguredResults.flatMap(result => result.models);
		const replacedProviders = new Set(builtInDiscovery.replaceRuntimeProviders);
		for (const result of currentConfiguredResults) {
			if (result.replaceRuntimeModels) replacedProviders.add(result.provider.provider);
		}
		const discovered = [...configuredDiscovered, ...builtInDiscovery.models];
		if (
			discovered.length === 0 &&
			builtInDiscovery.authoritativeProviders.size === 0 &&
			replacedProviders.size === 0
		) {
			return;
		}
		const discoveredProviders = new Set(discovered.map(model => model.provider));
		for (const provider of builtInDiscovery.authoritativeProviders) discoveredProviders.add(provider);
		for (const provider of replacedProviders) discoveredProviders.add(provider);
		const currentProviderModels =
			discoveredProviders.size > 0 ? this.#composeUnprojectedStaticModels(discoveredProviders) : [];
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model =>
				mergeDiscoveredModel(
					model,
					resolveProviderModelReference(model.provider, model.id, currentProviderModels),
					this.#providerOverrides.get(model.provider),
				),
			),
		);
		const authoritativeProviders = providersWithAuthoritativeProjectCatalog(discoveredModels);
		for (const provider of builtInDiscovery.authoritativeProviders) {
			authoritativeProviders.add(provider);
		}
		if (replacedProviders.size > 0) {
			// A successful endpoint refresh is the provider's whole discovered slice: rows it no longer
			// lists (including an intentionally emptied or filtered catalog) must not survive from the
			// startup cache or an earlier refresh.
			this.#cachedDiscoverableModels = this.#cachedDiscoverableModels.filter(
				model => !replacedProviders.has(model.provider),
			);
			this.#cachedStandardModels = this.#cachedStandardModels.filter(
				model => !replacedProviders.has(model.provider),
			);
			for (const provider of replacedProviders) this.#cachedAuthoritativeProviders.delete(provider);
		}
		const staleRuntimeProviders = new Set([...authoritativeProviders, ...replacedProviders]);
		if (staleRuntimeProviders.size > 0) {
			this.#runtimeDiscoveredModels = this.#runtimeDiscoveredModels.filter(
				model => !staleRuntimeProviders.has(model.provider),
			);
		}
		for (const provider of authoritativeProviders) this.#runtimeAuthoritativeProviders.add(provider);
		this.#runtimeDiscoveredModels = this.#mergeResolvedModels(this.#runtimeDiscoveredModels, discoveredModels);

		const hadFullSnapshot = this.#hasFullSnapshot;
		this.#resetStaticComposition();
		if (hadFullSnapshot) this.#ensureFullSnapshot();
	}

	#discoverProviderModelsCoalesced(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<ConfiguredModelDiscoveryResult> {
		let providerInFlight = this.#configuredDiscoveryInFlight.get(providerConfig);
		const inFlight = providerInFlight?.get(strategy);
		if (inFlight) return inFlight;
		providerInFlight ??= new Map();
		const pending = providerInFlight;
		const discovery = this.#discoverProviderModels(providerConfig, strategy).finally(() => {
			if (pending.get(strategy) !== discovery) return;
			pending.delete(strategy);
			if (pending.size === 0) this.#configuredDiscoveryInFlight.delete(providerConfig);
		});
		pending.set(strategy, discovery);
		this.#configuredDiscoveryInFlight.set(providerConfig, pending);
		return discovery;
	}

	#configuredDiscoveryCacheProviderId(providerConfig: DiscoveryProviderConfig): string {
		if (providerConfig.discovery.type === "ollama") {
			return resolveOllamaModelCacheProviderId(providerConfig.provider, providerConfig.baseUrl);
		}
		if (providerConfig.discovery.type === "openai-models-list") {
			// Rows cached from the `/v1`-injected URL can hold a different model set than a bare root.
			return providerConfig.discovery.injectV1 === false
				? `${providerConfig.provider}:openai-models-list-bare-context-v3`
				: `${providerConfig.provider}:openai-models-list-context-v3`;
		}
		if (providerConfig.discovery.type === "litellm") {
			// Keep in lockstep with the catalog's `litellm:rich-vN` namespace whenever LiteLLM mapping changes.
			return `${providerConfig.provider}:litellm-rich-v5`;
		}
		return providerConfig.provider;
	}

	#isDiscoveryCacheOlderThanModelsConfig(cacheUpdatedAt: number): boolean {
		const configMtime = this.#modelsConfigFile.getMtimeMs();
		return configMtime !== null && cacheUpdatedAt < Math.floor(configMtime);
	}

	async #discoverProviderModels(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<ConfiguredModelDiscoveryResult> {
		const cacheProviderId = this.#configuredDiscoveryCacheProviderId(providerConfig);
		const cached = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
		const cacheOlderThanConfig = cached !== null && this.#isDiscoveryCacheOlderThanModelsConfig(cached.updatedAt);
		const bypassFreshCache = providerConfig.discovery.type === "llama.cpp" && strategy === "online-if-uncached";
		const effectiveStrategy =
			strategy === "online-if-uncached" && (cacheOlderThanConfig || bypassFreshCache) ? "online" : strategy;
		// Only a real fetch needs credentials; peeking would otherwise run `!command` helpers for a cache-only read.
		const willFetch =
			effectiveStrategy === "online" || (effectiveStrategy === "online-if-uncached" && cached === null);
		const requiresAuth = !this.#keylessProviders.has(providerConfig.provider);
		if (requiresAuth && willFetch) {
			const apiKey = await this.#peekApiKeyForProvider(providerConfig.provider);
			if (!isAuthenticated(apiKey)) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "unauthenticated",
					optional: providerConfig.optional ?? false,
					stale: cached !== null,
					fetchedAt: cached?.updatedAt,
					models: cached?.models.map(model => model.id) ?? [],
				});
				this.#lastDiscoveryWarnings.delete(providerConfig.provider);
				return {
					models: cached
						? this.#normalizeDiscoverableModels(
								providerConfig,
								cached.models.map(model => buildModel(model)),
							)
						: [],
					replaceRuntimeModels: false,
				};
			}
		}

		const providerId = providerConfig.provider;
		let discoveryError: string | undefined;
		let discoveryAuthRejected = false;
		const fetchDynamicModels = async (): Promise<readonly ModelSpec<Api>[] | null> => {
			try {
				const requestConfig = { ...providerConfig, headers: await resolveConfigHeaders(providerConfig.headers) };
				const models = this.#applyProviderModelOverrides(
					providerId,
					await discoverModelsByProviderType(requestConfig, this.#discoveryContext()),
				);
				this.#lastDiscoveryWarnings.delete(providerId);
				return models.map(toModelSpec);
			} catch (error) {
				discoveryError = error instanceof Error ? error.message : String(error);
				// A reachable endpoint refusing credentials is a sign-in problem, not an outage.
				discoveryAuthRejected = isDiscoveryAuthRejection(error);
				return null;
			}
		};

		const providerOverride = this.#providerOverrides.get(providerId);
		const cachedHeaderResolver = this.#canRestoreConfiguredDiscoveryHeaders(providerId)
			? createConfigHeaderResolver([providerOverride?.headers], {
					authHeader: providerOverride?.authHeader,
					apiKeyConfig: providerOverride?.apiKey,
				})
			: undefined;
		const manager = createModelManager<Api>({
			providerId,
			staticModels: [],
			cacheDbPath: this.#cacheDbPath,
			cacheProviderId,
			cacheTtlMs: 24 * 60 * 60 * 1000,
			fetchDynamicModels,
			restoreCachedHeaders: cachedHeaderResolver ? () => ({ resolveHeaders: cachedHeaderResolver }) : undefined,
		});
		const result = await manager.refresh(effectiveStrategy);
		const status = discoveryError
			? result.models.length > 0
				? "cached"
				: discoveryAuthRejected
					? "unauthenticated"
					: "unavailable"
			: effectiveStrategy === "offline"
				? cached
					? "cached"
					: "idle"
				: result.models.length > 0
					? "ok"
					: "empty";
		this.#providerDiscoveryStates.set(providerId, {
			provider: providerId,
			status,
			optional: providerConfig.optional ?? false,
			stale: result.stale || status === "cached" || ((cacheOlderThanConfig || bypassFreshCache) && status !== "ok"),
			fetchedAt: discoveryError ? cached?.updatedAt : Date.now(),
			models: result.models.map(model => model.id),
			error: discoveryError,
		});
		if (discoveryError) {
			this.#warnProviderDiscoveryFailure(providerConfig, discoveryError);
		}
		return {
			models: this.#applyProviderModelOverrides(
				providerId,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(providerConfig.compat, result.models),
				),
			),
			replaceRuntimeModels: result.source === "provider",
		};
	}

	#discoveryContext(): DiscoveryContext {
		return {
			fetch: this.#fetch,
			getBearerApiKeyResolver: async provider => {
				const apiKey = await this.getApiKeyForProvider(provider);
				if (!isDiscoveryBearerApiKey(apiKey)) {
					return undefined;
				}
				return this.resolver(provider);
			},
		};
	}

	#nonResolvingDiscoveryContext(): DiscoveryContext {
		return {
			fetch: this.#fetch,
			getBearerApiKeyResolver: async () => undefined,
		};
	}

	#warnProviderDiscoveryFailure(providerConfig: DiscoveryProviderConfig, error: string): void {
		const previous = this.#lastDiscoveryWarnings.get(providerConfig.provider);
		if (previous === error) {
			return;
		}
		this.#lastDiscoveryWarnings.set(providerConfig.provider, error);
		logger.warn("model discovery failed for provider", {
			provider: providerConfig.provider,
			url: providerConfig.baseUrl,
			error,
		});
	}

	async #discoverBuiltInProviderModels(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<BuiltInDiscoveryResult> {
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(p => p.provider));
		const managerOptions = await this.#collectBuiltInModelManagerOptions(
			strategy,
			providerFilter,
			configuredDiscoveryProviders,
		);
		if (managerOptions.length === 0) {
			return { models: [], authoritativeProviders: new Set(), replaceRuntimeProviders: new Set() };
		}
		const discoveries = await Promise.all(
			managerOptions.map(options => this.#discoverWithModelManager(options, strategy)),
		);
		const authoritativeProviders = new Set<string>();
		const replaceRuntimeProviders = new Set<string>();
		const models: Model<Api>[] = [];
		for (const discovery of discoveries) {
			models.push(...discovery.models);
			for (const provider of discovery.authoritativeProviders) authoritativeProviders.add(provider);
			for (const provider of discovery.replaceRuntimeProviders) replaceRuntimeProviders.add(provider);
		}
		return { models, authoritativeProviders, replaceRuntimeProviders };
	}

	async #resolveBuiltInDiscoveryApiKey(
		providerId: string,
		strategy: ModelRefreshStrategy,
		cacheProviderId: string,
		authoritative: boolean,
	): Promise<string | undefined> {
		const peekedKey = await this.#peekApiKeyForProvider(providerId);
		if (isAuthenticated(peekedKey) || strategy === "offline") {
			return peekedKey;
		}
		const oauthCredentials = getOAuthCredentialsForProvider(this.authStorage, providerId);
		if (oauthCredentials.length === 0) {
			return peekedKey;
		}

		if (strategy === "online-if-uncached" && !authoritative) {
			const cache = readModelCache<Api>(
				cacheProviderId,
				BUILT_IN_DISCOVERY_CACHE_TTL_MS,
				Date.now,
				this.#cacheDbPath,
			);
			const cacheAgeMs = cache ? Date.now() - cache.updatedAt : Number.POSITIVE_INFINITY;
			if (cache?.fresh && (cache.authoritative || cacheAgeMs < BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS)) {
				return peekedKey;
			}
		}
		try {
			return await this.getApiKeyForProvider(providerId);
		} catch (error) {
			logger.debug("OAuth refresh failed during model discovery preflight", {
				provider: providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return peekedKey;
		}
	}

	#resolveGeminiCliDiscoveryProjectId(oauthToken: string): string | undefined {
		const credentials = getOAuthCredentialsForProvider(this.authStorage, "google-gemini-cli");
		const projectId = credentials.find(credential => credential.access === oauthToken)?.projectId?.trim();
		return projectId ? projectId : undefined;
	}

	async #collectBuiltInModelManagerOptions(
		strategy: ModelRefreshStrategy,
		providerFilter: ReadonlySet<string> | undefined,
		configuredDiscoveryProviders: ReadonlySet<string>,
	): Promise<ModelManagerOptions<Api>[]> {
		const specialProviderDescriptors: Array<{
			providerId: string;
			authoritative: boolean;
			resolveKey: (value: string | undefined) => string | undefined;
			createOptions: (key: string, raw: string | undefined) => ModelManagerOptions<Api>;
		}> = [
			{
				providerId: "google-antigravity",
				authoritative: false,
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleAntigravityModelManagerOptions({
						oauthToken,
						endpoint: this.#descriptorBaseUrl("google-antigravity"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "google-gemini-cli",
				authoritative: false,
				resolveKey: extractGoogleOAuthToken,
				createOptions: (oauthToken, raw) =>
					googleGeminiCliModelManagerOptions({
						oauthToken,
						projectId: extractGoogleOAuthProjectId(raw) ?? this.#resolveGeminiCliDiscoveryProjectId(oauthToken),
						endpoint: this.#descriptorBaseUrl("google-gemini-cli"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "openai-codex",
				authoritative: true,
				resolveKey: value => value,
				createOptions: accessToken =>
					openaiCodexModelManagerOptions({
						resolveAccounts: () => resolveCodexDiscoveryAccounts(this.authStorage, accessToken),
						fetch: this.#fetch,
					}),
			},
		];
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const standardProviderDescriptors = PROVIDER_DESCRIPTORS.filter(descriptor => {
			if (disabledProviders.has(descriptor.providerId)) return false;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) return false;
			// An extension-registered manager replaces the built-in one for its provider.
			if (this.#runtimeModelManagers.has(descriptor.providerId)) return false;
			return providerFilter ? providerFilter.has(descriptor.providerId) : true;
		});
		const enabledSpecialProviderDescriptors = specialProviderDescriptors.filter(descriptor => {
			if (disabledProviders.has(descriptor.providerId)) return false;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) return false;
			return providerFilter ? providerFilter.has(descriptor.providerId) : true;
		});
		const standardProviderKeys = await Promise.all(
			standardProviderDescriptors.map(descriptor => {
				const cacheProviderId = this.#resolveStartupModelCacheProviderId(descriptor.providerId);
				return this.#resolveBuiltInDiscoveryApiKey(
					descriptor.providerId,
					strategy,
					cacheProviderId,
					descriptor.dynamicModelsAuthoritative ?? false,
				);
			}),
		);
		const specialKeys = await Promise.all(
			enabledSpecialProviderDescriptors.map(descriptor =>
				this.#resolveBuiltInDiscoveryApiKey(
					descriptor.providerId,
					strategy,
					descriptor.providerId,
					descriptor.authoritative,
				),
			),
		);
		const options: ModelManagerOptions<Api>[] = [];
		for (let i = 0; i < standardProviderDescriptors.length; i++) {
			const descriptor = standardProviderDescriptors[i];
			const apiKey = standardProviderKeys[i];
			const hasExplicitVllmConfig =
				descriptor.providerId === "vllm" &&
				(this.#runtimeProviderOverrides.has(descriptor.providerId) ||
					this.#providerOverrides.has(descriptor.providerId) ||
					this.#keylessProviders.has(descriptor.providerId));
			const canUseSharedCatalogWithoutAuth =
				MODELS_DEV_CATALOG_PROVIDER_ID_LOOKUP[descriptor.providerId] === true &&
				!descriptor.dynamicModelsAuthoritative;
			if (
				isAuthenticated(apiKey) ||
				descriptor.allowUnauthenticated ||
				hasExplicitVllmConfig ||
				canUseSharedCatalogWithoutAuth
			) {
				const discoveryConfig = {
					apiKey: isDiscoveryBearerApiKey(apiKey) ? apiKey : undefined,
					baseUrl: this.#descriptorBaseUrl(descriptor.providerId),
					fetch: this.#fetch,
				};
				const preparedConfig =
					getProviderDefinition(descriptor.providerId)?.prepareModelDiscovery?.(discoveryConfig) ??
					discoveryConfig;
				const managerOptions = descriptor.createModelManagerOptions(preparedConfig);
				const modelsDev = managerOptions.modelsDev
					? { ...managerOptions.modelsDev, additiveOnly: true }
					: modelsDevCatalogFallback(descriptor.providerId, this.#fetch);
				options.push(modelsDev ? { ...managerOptions, modelsDev } : managerOptions);
			}
		}

		for (let i = 0; i < enabledSpecialProviderDescriptors.length; i++) {
			const descriptor = enabledSpecialProviderDescriptors[i];
			const key = descriptor.resolveKey(specialKeys[i]);
			if (!isAuthenticated(key)) {
				continue;
			}
			options.push(descriptor.createOptions(key, specialKeys[i]));
		}

		// Catalog-only bundled providers have no endpoint manager; give them the same
		// additive shared-catalog layer so new upstream ids appear without a release.
		const managedProviderIds = new Set<string>([
			...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
			...specialProviderDescriptors.map(descriptor => descriptor.providerId),
		]);
		const bundledProviderIds = new Set<string>(getBundledProviders());
		for (const providerId of MODELS_DEV_CATALOG_PROVIDER_IDS) {
			if (managedProviderIds.has(providerId) || !bundledProviderIds.has(providerId)) continue;
			if (disabledProviders.has(providerId) || configuredDiscoveryProviders.has(providerId)) continue;
			if (providerFilter && !providerFilter.has(providerId)) continue;
			if (this.#runtimeModelManagers.has(providerId)) continue;
			const modelsDev = modelsDevCatalogFallback(providerId, this.#fetch);
			if (!modelsDev) continue;
			options.push({
				providerId,
				cacheProviderId: resolveModelCacheProviderId(providerId, {
					baseUrl: this.#descriptorBaseUrl(providerId),
				}),
				modelsDev,
			});
		}

		for (const { options: managerOpts } of this.#runtimeModelManagers.values()) {
			if (
				!configuredDiscoveryProviders.has(managerOpts.providerId) &&
				(!providerFilter || providerFilter.has(managerOpts.providerId))
			) {
				options.push(managerOpts);
			}
		}
		return options;
	}

	async #discoverWithModelManager(
		options: ModelManagerOptions<Api>,
		strategy: ModelRefreshStrategy,
	): Promise<BuiltInDiscoveryResult> {
		try {
			const manager = createModelManager({ ...options, cacheDbPath: this.#cacheDbPath });
			const result = await withModelDiscoveryTimeout(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS, () =>
				manager.refresh(strategy),
			);
			const models = result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
			const status =
				result.source === "cache"
					? "cached"
					: result.source === "bundled"
						? result.stale
							? "unavailable"
							: "idle"
						: models.length > 0
							? "ok"
							: "empty";
			this.#providerDiscoveryStates.set(options.providerId, {
				provider: options.providerId,
				status,
				optional: false,
				stale: result.stale,
				fetchedAt: result.updatedAt,
				source: result.source,
				models: models.map(model => model.id),
			});
			const authoritativeProviders = new Set<string>();
			if (options.dynamicModelsAuthoritative && !result.stale) {
				authoritativeProviders.add(options.providerId);
			}
			const replaceRuntimeProviders = new Set<string>();
			if (result.source === "provider") replaceRuntimeProviders.add(options.providerId);
			return { models, authoritativeProviders, replaceRuntimeProviders };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const previous = this.#providerDiscoveryStates.get(options.providerId);
			const authRejected = (previous?.models.length ?? 0) === 0 && isDiscoveryAuthRejection(error);
			this.#providerDiscoveryStates.set(options.providerId, {
				provider: options.providerId,
				status: authRejected ? "unauthenticated" : "unavailable",
				optional: previous?.optional ?? false,
				stale: true,
				...(previous?.fetchedAt !== undefined ? { fetchedAt: previous.fetchedAt } : {}),
				...(previous?.source !== undefined ? { source: previous.source } : {}),
				models: previous?.models ?? [],
				error: message,
			});
			logger.warn("model discovery failed for provider", { provider: options.providerId, error: message });
			return { models: [], authoritativeProviders: new Set(), replaceRuntimeProviders: new Set() };
		}
	}

	#applyProviderModelOverrides(provider: string, models: Model<Api>[]): Model<Api>[] {
		const overrides = this.#modelOverrides.get(provider);
		if (!overrides || overrides.size === 0) return models;
		let liveIds: Set<string> | null = null;
		const hasLiveModel = (_provider: string, id: string) => {
			liveIds ??= new Set(models.map(m => m.id));
			return liveIds.has(id);
		};
		return models.map(model => {
			const override = resolveModelOverrideWithAliases(overrides, model, hasLiveModel);
			if (!override) return model;
			return this.#applyModelOverrideWithClamp(model, override);
		});
	}

	#applyLlamaCppModelFixups(models: Model<Api>[]): Model<Api>[] {
		const llamaCppProviders = new Set<string>();
		for (const provider of this.#discoverableProviders) {
			if (provider.discovery.type === "llama.cpp") llamaCppProviders.add(provider.provider);
		}
		if (llamaCppProviders.size === 0) return models;
		return models.map(model => {
			if (!llamaCppProviders.has(model.provider)) return model;
			const withFixups = applyLlamaCppQwenThinking(model);
			if (!withFixups.transport && !withFixups.baseUrl.endsWith("/v1")) {
				return buildModel({
					...withFixups,
					baseUrl: ensureLlamaCppV1BaseUrl(normalizeLlamaCppBaseUrl(withFixups.baseUrl)),
				});
			}
			return withFixups;
		});
	}

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			baseUrlApis: override.baseUrlApis ?? baseOverride?.baseUrlApis,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers:
				override.headers || baseOverride?.headers ? { ...baseOverride?.headers, ...override.headers } : undefined,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			remoteCompaction: mergeRemoteCompactionConfig(baseOverride?.remoteCompaction, override.remoteCompaction),
			transport: override.transport ?? baseOverride?.transport,
		};
	}
	#applyProviderTransportOverride<
		T extends {
			api: Api;
			baseUrl?: string;
			headers?: Record<string, string>;
			resolveHeaders?: Model<Api>["resolveHeaders"];
			remoteCompaction?: RemoteCompactionConfig<Api>;
		},
	>(
		entry: T,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "baseUrlApis" | "headers" | "authHeader" | "apiKey" | "remoteCompaction" | "transport"
		>,
	): T {
		const changesHeaders =
			override.headers !== undefined || (override.authHeader === true && override.apiKey !== undefined);
		const resolveHeaders = changesHeaders
			? mergeAuthHeaderSources(
					override.headers
						? [entry.resolveHeaders ?? entry.headers, override.headers]
						: [entry.resolveHeaders ?? entry.headers],
					override.authHeader,
					override.apiKey,
				)
			: entry.resolveHeaders;
		return {
			...entry,
			baseUrl: resolveProviderBaseUrl(entry.api, entry.baseUrl, override),
			headers: changesHeaders || entry.resolveHeaders ? undefined : entry.headers,
			resolveHeaders,

			...(override.transport !== undefined ? { transport: override.transport } : {}),
			remoteCompaction: mergeProviderRemoteCompactionConfig(entry.remoteCompaction, override.remoteCompaction),
		};
	}
	#applyProviderTransportOverrideToModel(
		model: Model<Api>,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "baseUrlApis" | "headers" | "authHeader" | "apiKey" | "remoteCompaction" | "transport"
		>,
	): Model<Api> {
		return buildModel(this.#applyProviderTransportOverride(toModelSpec(model), override));
	}

	#applyProviderBedrockOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#providerOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#providerOverrides.get(model.provider);
			if (!override) return model;
			const bedrockFields = bedrockProviderFields(override);
			if (bedrockFields === undefined) return model;
			return buildModel({ ...toModelSpec(model), ...bedrockFields } as ModelSpec<Api>);
		});
	}

	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return this.#applyProviderTransportOverrideToModel(model, override);
		});
	}
	#resolveLiveModelOverride(model: Model<Api>): ModelOverride | undefined {
		const providerOverrides = this.#modelOverrides.get(model.provider);
		if (!providerOverrides) return undefined;
		return resolveModelOverrideWithAliases(
			providerOverrides,
			model,
			(provider, id) => this.find(provider, id) !== undefined,
		);
	}

	#resolveLiveCustomModelOverlay(model: Model<Api>): CustomModelOverlay | undefined {
		return (
			this.#customModelOverlays.find(overlay => overlay.provider === model.provider && overlay.id === model.id) ??
			this.#runtimeModelOverlays.find(overlay => overlay.provider === model.provider && overlay.id === model.id)
		);
	}

	#applyModelOverrides(models: Model<Api>[], overrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
		const customWindows = new Map<string, number>();
		for (const overlays of [this.#customModelOverlays, this.#runtimeModelOverlays]) {
			for (const overlay of overlays) {
				if (overlay.maxContextWindow !== undefined) {
					customWindows.set(`${overlay.provider}\u0000${overlay.id}`, overlay.maxContextWindow);
				}
			}
		}
		if (overrides.size === 0 && customWindows.size === 0) return models;
		let liveKeys: Set<string> | null = null;
		const hasLiveModel = (provider: string, id: string) => {
			liveKeys ??= new Set(models.map(m => `${m.provider}\u0000${m.id}`));
			return liveKeys.has(`${provider}\u0000${id}`);
		};
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider);
			const override = providerOverrides
				? resolveModelOverrideWithAliases(providerOverrides, model, hasLiveModel)
				: undefined;
			const overridden = override ? this.#applyModelOverrideWithClamp(model, override) : model;
			// A contextWindow-only override stays fixed in both modes; an unrelated override keeps the custom pair.
			const maximum =
				override?.maxContextWindow ??
				(override?.contextWindow === undefined
					? customWindows.get(`${model.provider}\u0000${model.id}`)
					: undefined);
			return this.#applyConfiguredExtendedWindow(overridden, maximum, model);
		});
	}

	#applyConfiguredExtendedWindow(model: Model<Api>, maximum: number | undefined, baseline: Model<Api>): Model<Api> {
		if (maximum === undefined || !isExtendedContextEnabledFromSettings(this.#settings)) return model;
		const standard = model.contextWindow;
		if (standard === null || maximum <= standard) return model;
		const window = clampsContextOverride(baseline) ? clampContextOverride(baseline, maximum) : maximum;
		return window === standard ? model : applyModelOverride(model, { contextWindow: window });
	}

	// Explicit Codex context-window overrides clamp to the server-honored maximum (codex-rs `with_config_overrides`)
	// instead of widening without bound; `model` is the pre-override row. Shared by the cache-load and composition
	// override passes so the clamp holds on both.
	#applyModelOverrideWithClamp(model: Model<Api>, override: ModelOverride): Model<Api> {
		const overridden = applyModelOverride(model, override);
		if (
			override.contextWindow === undefined ||
			overridden.contextWindow === null ||
			!clampsContextOverride(overridden)
		) {
			return overridden;
		}
		const clamped = clampContextOverride(model, overridden.contextWindow);
		return clamped === overridden.contextWindow
			? overridden
			: applyModelOverride(overridden, { contextWindow: clamped });
	}

	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		const extendedContext = isExtendedContextEnabledFromSettings(this.#settings);
		return models.map(model => {
			if (extendedContext) {
				const maximum = resolveMaxContextWindow(model);
				if (maximum !== undefined && model.contextWindow !== null && maximum > model.contextWindow) {
					model = applyModelOverride(model, { contextWindow: maximum });
				}
			}
			// xai-oauth carries public xAI prices only as API-equivalent estimates; SuperGrok requests stay
			// subscription-backed, so the estimated tier must not cap the runtime context window.
			if (!extendedContext && model.provider !== "xai-oauth") {
				const threshold = model.cost.longContext?.inputThreshold;
				if (threshold !== undefined && model.contextWindow !== null && model.contextWindow > threshold) {
					model = applyModelOverride(model, { contextWindow: threshold });
				}
			}
			if (model.provider === "ollama-cloud" && model.omitMaxOutputTokens !== true) {
				model = applyModelOverride(model, { omitMaxOutputTokens: true });
			}
			if (model.id !== "gpt-5.4" || model.provider === "github-copilot") {
				return model;
			}
			const overrides = this.#modelOverrides.get(model.provider)?.get(model.id);
			if (!overrides) {
				return applyModelOverride(model, { contextWindow: 1_000_000 });
			}
			return applyModelOverride(model, {
				contextWindow: overrides.contextWindow ?? 1_000_000,
				...overrides,
			});
		});
	}

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];
		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue;
			if (providerConfig.apiKey) {
				this.#installProviderApiKey(providerName, providerConfig.apiKey);
			}
			for (const modelDef of modelDefs) {
				const providerCompat = providerConfig.disableStrictTools
					? mergeCompat(providerConfig.compat, { disableStrictTools: true })
					: providerConfig.compat;
				const model = buildCustomModelOverlay(
					providerName,
					providerConfig.baseUrl!,
					providerConfig.api as Api | undefined,
					providerConfig.headers,
					providerConfig.apiKey,
					providerConfig.authHeader,
					providerCompat,
					(providerConfig.auth as ProviderAuthMode | undefined) ?? undefined,
					providerConfig.remoteCompaction,
					modelDef as CustomModelDefinitionLike,
				);
				if (!model) continue;
				models.push(model);
			}
		}
		return models;
	}

	#modelsForProviderLookup(provider: string): Model<Api>[] {
		if (this.#hasFullSnapshot) return this.#models;
		const normalizedProvider = provider.trim().toLowerCase();
		if (!normalizedProvider) return [];
		const cached = this.#providerLookupSnapshots.get(normalizedProvider);
		if (cached) return cached;
		const matchingProviders = new Set(
			this.#knownStaticProviders().filter(candidate => candidate.toLowerCase() === normalizedProvider),
		);
		const models = this.#composeStaticModels(matchingProviders);
		this.#providerLookupSnapshots.set(normalizedProvider, models);
		return models;
	}

	getAll(): Model<Api>[] {
		return this.#ensureFullSnapshot();
	}

	#createProviderAvailabilityCheck(): (provider: string) => boolean {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const byProvider = new Map<string, boolean>();
		return provider => {
			let available = byProvider.get(provider);
			if (available === undefined) {
				// A keyless-marker-only provider (empty paste at an optional-key login) stays usable like `auth: none`.
				available =
					!disabledProviders.has(provider) &&
					(this.#keylessProviders.has(provider) ||
						this.authStorage.hasAuth(provider) ||
						this.authStorage.hasKeylessPlaceholder(provider));
				byProvider.set(provider, available);
			}
			return available;
		};
	}

	getAvailable(): Model<Api>[] {
		const isProviderAvailable = this.#createProviderAvailabilityCheck();
		if (this.#hasFullSnapshot) {
			return this.#models.filter(model => isProviderAvailable(model.provider));
		}
		const availableProviders = new Set(this.#knownStaticProviders().filter(isProviderAvailable));
		return this.#composeStaticModels(availableProviders);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		const keyConfig = this.#customProviderApiKeys.get(model.provider);
		return (
			keyConfig !== undefined ||
			this.#keylessProviders.has(model.provider) ||
			this.authStorage.hasResolvableAuth(model.provider)
		);
	}

	/** Concrete credential (login, command/config/runtime key, keyless endpoint), not an ambient AWS/Vertex source. */
	hasConcreteAuth(provider: string): boolean {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		return (
			keyConfig !== undefined || this.#keylessProviders.has(provider) || this.authStorage.hasConcreteAuth(provider)
		);
	}

	hasCommandBackedApiKey(provider: string): boolean {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		return isCommandConfigValue(keyConfig);
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		return this.#discoverableProviders
			.filter(provider => !disabledProviders.has(provider.provider))
			.map(provider => provider.provider);
	}

	hasProvider(providerId: string): boolean {
		const providerModels = this.#hasFullSnapshot ? this.#models : this.#composeStaticModels(new Set([providerId]));
		if (providerModels.some(model => model.provider === providerId)) return true;
		if (getDisabledProviderIdsFromSettings(this.#settings).has(providerId)) return false;
		return (
			this.#discoverableProviders.some(provider => provider.provider === providerId) ||
			this.#runtimeModelManagers.has(providerId)
		);
	}

	getProviderDiscoveryState(provider: string): ProviderDiscoveryState | undefined {
		return this.#providerDiscoveryStates.get(provider);
	}

	// A config-declared discovery provider still `idle` has not produced a catalog in this process (cold discovery
	// cache), so a selector it will supply only looks unknown until background discovery lands.
	isProviderDiscoveryPending(provider: string): boolean {
		return this.#providerDiscoveryStates.get(provider)?.status === "idle";
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#modelsForProviderLookup(provider));
	}

	getProviderBaseUrl(provider: string): string | undefined {
		// Overrides lead: discovery-only providers have no model to read a URL from until discovery runs,
		// and a cache-cold usage probe would otherwise send a proxy-scoped key to the canonical host.
		return (
			this.#runtimeProviderOverrides.get(provider)?.baseUrl ??
			this.#providerOverrides.get(provider)?.baseUrl ??
			this.#modelsForProviderLookup(provider).find(m => m.provider === provider && m.baseUrl)?.baseUrl
		);
	}

	/** Materialize provider-level config headers for one outbound request; catalog reads never run `!command` values. */
	async getProviderHeaders(provider: string, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
		const resolver = createConfigHeaderResolver([
			this.#providerOverrides.get(provider)?.headers,
			this.#runtimeProviderOverrides.get(provider)?.headers,
		]);
		return await resolver?.(signal);
	}

	/**
	 * Materialize configured headers for a request the caller sends itself instead of through `stream`: the registered
	 * `provider/modelId` row's headers (which already layer provider headers), else the provider-level config headers.
	 * Call per attempt so command-backed values re-mint after an auth-retry invalidation.
	 */
	async getRequestHeaders(
		provider: string,
		modelId: string | undefined,
		signal?: AbortSignal,
	): Promise<Record<string, string> | undefined> {
		const model = modelId ? this.find(provider, modelId) : undefined;
		const modelHeaders = model ? (await materializeModelHeaders(model, signal)).headers : undefined;
		return modelHeaders ?? (await this.getProviderHeaders(provider, signal));
	}

	async getApiKey(
		model: Model<Api>,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<string | undefined> {
		if (this.#keylessProviders.has(model.provider) && !this.authStorage.hasAuth(model.provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(model.provider, sessionId, {
			baseUrl: model.baseUrl,
			modelId: model.id,
			signal: options?.signal,
		});
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const apiKey = await this.getApiKey(model);
			if (apiKey === undefined) {
				return { ok: false, error: `No API key found for "${model.provider}"` };
			}
			const headers = await this.getProviderHeaders(model.provider);
			return { ok: true, apiKey, headers };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined> {
		if (options?.forceRefresh) this.#invalidateProviderCommandConfigs(provider);
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(provider, sessionId, {
			baseUrl: options?.baseUrl,
			modelId: options?.modelId,
			forceRefresh: options?.forceRefresh,
			signal: options?.signal,
		});
	}

	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	resolver(target: string | ApiKeyResolverModel, optionsOrSessionId?: ApiKeyResolverOptions | string): ApiKeyResolver {
		const options = typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : optionsOrSessionId;
		if (typeof target === "string") {
			return createApiKeyResolver(this, target, options);
		}
		return createApiKeyResolver(this, target.provider, {
			...options,
			baseUrl: target.baseUrl,
			modelId: target.id,
		});
	}

	async #peekApiKeyForProvider(provider: string): Promise<string | undefined> {
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.peekApiKey(provider);
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.hasOAuth(model.provider);
	}

	#clearRuntimeProviderState(providerName: string): void {
		// Credential-scoped built-ins (e.g. opencode-go) hydrate their discovered slice from the startup cache, which
		// neither the static reload nor refreshRuntimeProviders restores; dropping it would hide account models.
		if (!isCredentialScopedModelCacheProvider(providerName)) {
			this.#runtimeDiscoveredModels = this.#runtimeDiscoveredModels.filter(model => model.provider !== providerName);
			this.#runtimeAuthoritativeProviders.delete(providerName);
		}
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
		this.#runtimeCommandConfigsByProvider.delete(providerName);
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(overlay => overlay.provider !== providerName);
		this.#runtimeModelManagers.delete(providerName);
		this.#runtimeModelModifiers.delete(providerName);
		this.#lastModelModifierWarnings.delete(providerName);
		this.authStorage.removeConfigApiKey(providerName);
		this.authStorage.removeRuntimeUsageProvider(providerName);
	}

	clearSourceRegistrations(sourceId: string): void {
		unregisterCustomApis(sourceId);
		unregisterOAuthProviders(sourceId);
		const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
		if (!sourceProviders || sourceProviders.size === 0) {
			return;
		}
		this.#ensureFullSnapshot();
		this.#runtimeProvidersBySource.delete(sourceId);
		for (const providerName of sourceProviders) {
			if (this.#runtimeProviderSourceByName.get(providerName) !== sourceId) {
				continue;
			}
			this.#runtimeProviderSourceByName.delete(providerName);
			this.#clearRuntimeProviderState(providerName);
		}
		this.#lastStaticLoadMtime = null;
		this.#reloadStaticModels();
	}

	unregisterProvider(providerName: string): void {
		const sourceId = this.#runtimeProviderSourceByName.get(providerName);
		if (sourceId) {
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
			sourceProviders?.delete(providerName);
			if (sourceProviders?.size === 0) {
				this.#runtimeProvidersBySource.delete(sourceId);
			}
			this.#runtimeProviderSourceByName.delete(providerName);
		}
		unregisterOAuthProvider(providerName);
		this.#ensureFullSnapshot();
		this.#clearRuntimeProviderState(providerName);
		this.#lastStaticLoadMtime = null;
		this.#reloadStaticModels();
	}

	syncExtensionSources(activeSourceIds: string[]): void {
		const activeSources = new Set(activeSourceIds);
		for (const sourceId of this.#registeredProviderSources) {
			if (activeSources.has(sourceId)) {
				continue;
			}
			this.clearSourceRegistrations(sourceId);
			this.#registeredProviderSources.delete(sourceId);
		}
	}

	registerProvider(providerName: string, config: ProviderConfigInput, sourceId?: string): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		validateProviderConfiguration(
			providerName,
			{
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				api: config.api,
				oauthConfigured: Boolean(config.oauth),
				models: (config.models ?? []) as ProviderValidationModel[],
			},
			"runtime-register",
		);

		if (config.streamSimple && config.api) {
			const streamSimple = config.streamSimple;
			registerCustomApi(config.api, streamSimple, sourceId, (model, context, options) =>
				streamSimple(model, context, options as SimpleStreamOptions),
			);
		}

		if (config.oauth) {
			registerOAuthProvider({
				...config.oauth,
				id: providerName,
				sourceId,
			});
		}

		let sourceHandoff = false;
		if (sourceId) {
			this.#registeredProviderSources.add(sourceId);
			const previousSourceId = this.#runtimeProviderSourceByName.get(providerName);
			if (previousSourceId && previousSourceId !== sourceId) {
				const previousProviders = this.#runtimeProvidersBySource.get(previousSourceId);
				previousProviders?.delete(providerName);
				if (previousProviders && previousProviders.size === 0) {
					this.#runtimeProvidersBySource.delete(previousSourceId);
				}
				this.#clearRuntimeProviderState(providerName);
				sourceHandoff = true;
			}
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId) ?? new Set<string>();
			sourceProviders.add(providerName);
			this.#runtimeProvidersBySource.set(sourceId, sourceProviders);
			this.#runtimeProviderSourceByName.set(providerName, sourceId);
		}
		if (sourceHandoff) {
			this.#lastStaticLoadMtime = null;
			this.#reloadStaticModels();
		}

		this.#ensureFullSnapshot();

		if (config.usage) {
			this.authStorage.setRuntimeUsageProvider(providerName, config.usage, config.apiKey);
		}
		if (config.apiKey) {
			this.#installProviderApiKey(providerName, config.apiKey);

			this.#runtimeProviderApiKeys.set(providerName, config.apiKey);
		}
		this.#recordRuntimeCommandConfigs(providerName, config.apiKey, config.headers, config.models ?? []);

		if (config.models && config.models.length > 0) {
			const newOverlays: CustomModelOverlay[] = [];
			for (const modelDef of config.models) {
				const overlay = buildCustomModelOverlay(
					providerName,
					config.baseUrl!,
					config.api,
					config.headers,
					config.apiKey,
					config.authHeader,
					config.compat,
					undefined,
					config.remoteCompaction,
					modelDef as CustomModelDefinitionLike,
				);
				if (!overlay) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
				}
				newOverlays.push(overlay);
			}

			this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(m => m.provider !== providerName);
			this.#runtimeModelOverlays.push(...newOverlays);

			const nextModels = this.#unprojectedModels.filter(model => model.provider !== providerName);
			for (const overlay of newOverlays) {
				nextModels.push(finalizeCustomModel(overlay, { useDefaults: true }));
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const nextModelsWithTransport = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverrideToModel(model, runtimeTransportOverride);
					})
				: nextModels;
			this.#unprojectedModels = this.#applyProviderBedrockOverrides(nextModelsWithTransport);

			if (config.oauth?.modifyModels) {
				this.#runtimeModelModifiers.set(providerName, config.oauth.modifyModels);
			} else {
				this.#runtimeModelModifiers.delete(providerName);
			}
			this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
			this.#invalidateProviderModelCache(providerName);
			if (!config.fetchDynamicModels) return;
		}

		if (config.fetchDynamicModels) {
			const fetcher = config.fetchDynamicModels;
			const providerBaseUrl = config.baseUrl ?? "";
			const providerApi = config.api;
			const providerHeaders = config.headers;
			const providerApiKey = config.apiKey;
			const providerAuthHeader = config.authHeader;
			const providerCompat = config.compat;
			const managerOptions: ModelManagerOptions<Api> = {
				providerId: providerName as Parameters<typeof createModelManager>[0]["providerId"],
				staticModels: [],
				cacheDbPath: this.#cacheDbPath,
				cacheTtlMs: 24 * 60 * 60 * 1000,
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: async () => {
					const apiKey = await this.#peekApiKeyForProvider(providerName);
					const resolvedKey = isAuthenticated(apiKey) ? apiKey : undefined;
					const modelDefs = await withModelDiscoveryTimeout(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS, () =>
						fetcher(resolvedKey),
					);
					// Dynamic rows may carry `!command` headers absent from the registration; track them for F5/401 eviction.
					const target = this.#runtimeCommandConfigsByProvider.get(providerName) ?? new Set<string>();
					for (const modelDef of modelDefs) this.#collectCommandConfigValues(target, undefined, modelDef.headers);
					if (target.size > 0) this.#runtimeCommandConfigsByProvider.set(providerName, target);
					const results: Model<Api>[] = [];
					for (const modelDef of modelDefs) {
						const overlay = buildCustomModelOverlay(
							providerName,
							modelDef.baseUrl ?? providerBaseUrl,
							modelDef.api ?? providerApi,
							providerHeaders,
							providerApiKey,
							providerAuthHeader,
							providerCompat,
							undefined,
							config.remoteCompaction,
							modelDef as CustomModelDefinitionLike,
						);
						if (overlay) results.push(finalizeCustomModel(overlay, { useDefaults: true }));
					}
					return results.map(toModelSpec);
				},
			};
			this.#runtimeModelManagers.set(providerName, { options: managerOptions, sourceId: sourceId ?? "" });
		}

		if (
			config.baseUrl ||
			config.headers ||
			config.apiKey ||
			config.authHeader !== undefined ||
			config.remoteCompaction !== undefined ||
			config.transport !== undefined
		) {
			const transportOverride = {
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				authHeader: config.authHeader,
				remoteCompaction: config.remoteCompaction,
				transport: config.transport,
			};
			const nextRuntimeOverride = this.#mergeProviderOverride(
				this.#runtimeProviderOverrides.get(providerName),
				transportOverride,
			);
			this.#runtimeProviderOverrides.set(providerName, nextRuntimeOverride);
			this.#unprojectedModels = this.#applyLlamaCppModelFixups(
				this.#unprojectedModels.map(model => {
					if (model.provider !== providerName) return model;
					return this.#applyProviderTransportOverrideToModel(model, transportOverride);
				}),
			);
			this.#models = this.#withCatalogMetrics(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
			this.#invalidateProviderModelCache(providerName);
		}
	}

	suppressSelector(selector: string, untilMs: number): void {
		this.#suppressedSelectors.set(
			normalizeSuppressedSelector(selector, (provider, id) => this.find(provider, id) !== undefined),
			untilMs,
		);
	}

	isSelectorSuppressed(selector: string): boolean {
		const normalizedSelector = normalizeSuppressedSelector(
			selector,
			(provider, id) => this.find(provider, id) !== undefined,
		);
		const suppressedUntil = this.#suppressedSelectors.get(normalizedSelector);
		if (!suppressedUntil) return false;
		if (suppressedUntil <= Date.now()) {
			this.#suppressedSelectors.delete(normalizedSelector);
			return false;
		}
		return true;
	}

	clearSuppressedSelector(selector: string): void {
		this.#suppressedSelectors.delete(
			normalizeSuppressedSelector(selector, (provider, id) => this.find(provider, id) !== undefined),
		);
	}

	clearSuppressedSelectors(): void {
		this.#suppressedSelectors.clear();
	}
}

export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	authHeader?: boolean;

	transport?: Model<Api>["transport"];

	usage?: UsageProvider;
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};

	fetchDynamicModels?: (
		apiKey: string | undefined,
	) => Promise<readonly NonNullable<ProviderConfigInput["models"]>[number][]>;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinking?: ThinkingConfig;
		input: ("text" | "image" | "video")[];
		supportsTools?: boolean;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		/** Whether Codex requests should prefer the WebSocket transport. */
		preferWebsockets?: boolean;
		headers?: Record<string, string>;
		compat?: ModelSpec<Api>["compat"];
		contextPromotionTarget?: string;
		compactionModel?: string;
		remoteCompaction?: RemoteCompactionConfig<Api>;
		premiumMultiplier?: number;
	}>;
}
