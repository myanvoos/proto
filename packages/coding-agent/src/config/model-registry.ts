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
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	createModelManager,
	type ModelManagerOptions,
	type ModelRefreshStrategy,
} from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	isCredentialScopedModelCacheProvider,
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
	type CommandApiKeyResolution,
	createLiveConfigHeaders,
	isCommandConfigValue,
	resolveConfigHeaders,
	resolveConfigValue,
} from "./model-config-values";
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
	normalizeLiteLLMDiscoveryBaseUrl,
	normalizeLlamaCppBaseUrl,
} from "./model-discovery";
import {
	AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS,
	applyModelOverride,
	applyModelPatch,
	dropProviderModels,
	type ModelPatch,
	mergeByModelKey,
	mergeCompat,
	mergeDiscoveredModel,
	mergeProviderRemoteCompactionConfig,
	mergeRemoteCompactionConfig,
	type ProviderOverride,
	providersWithAuthoritativeProjectCatalog,
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
	withRuntimeDynamicModelsTimeout,
} from "./model-provider-discovery";

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

function isExtendedContextEnabledFromSettings(settingsInstance?: Settings): boolean {
	try {
		return (settingsInstance ?? settings).get("extendedContext");
	} catch {
		return true;
	}
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
	#unprojectedModels: Model<Api>[] = [];
	#hasFullSnapshot = false;
	#cachedStandardModels: Model<Api>[] = [];
	#cachedDiscoverableModels: Model<Api>[] = [];
	#cachedAuthoritativeProviders: Set<string> = new Set();
	#internedStaticModels: Map<string, Model<Api>> = new Map();
	#providerLookupSnapshots: Map<string, Model<Api>[]> = new Map();
	#customProviderApiKeys: Map<string, string> = new Map();
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
	#credentialScopedCacheHydration?: Promise<void>;
	#policyReapply?: Promise<void>;
	#lastDiscoveryWarnings: Map<string, string> = new Map();

	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();

	#runtimeModelModifiers: Map<string, ModifyModelsHook> = new Map();
	#lastModelModifierWarnings: Map<string, string> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();

	#runtimeModelManagers: Map<string, { options: ModelManagerOptions<Api>; sourceId: string }> = new Map();
	#ignoreLocalModelConfig: boolean;
	#fetch: FetchImpl;
	#settings: Settings | undefined;

	#resolveCommandBackedApiKey(provider: string, options?: { forceCommandRefresh?: boolean }): CommandApiKeyResolution {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		if (!isCommandConfigValue(keyConfig)) return { configured: false };
		const value = resolveConfigValue(keyConfig, options);
		if (value) {
			this.authStorage.setConfigApiKey(provider, value);
			return { configured: true, value };
		}
		this.authStorage.removeConfigApiKey(provider);
		return { configured: true };
	}

	#installProviderApiKey(provider: string, keyConfig: string): void {
		this.#customProviderApiKeys.set(provider, keyConfig);
		const resolved = resolveConfigValue(keyConfig);
		if (resolved) {
			this.authStorage.setConfigApiKey(provider, resolved);
		} else if (isCommandConfigValue(keyConfig)) {
			this.authStorage.removeConfigApiKey(provider);
		}
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

		this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			if (!keyConfig) return undefined;
			return resolveConfigValue(keyConfig);
		});

		this.#loadModels();
	}

	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		this.#reloadStaticModels();
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
			});
		this.#backgroundRefresh = refreshPromise;
	}

	async awaitBackgroundRefresh(): Promise<void> {
		if (this.#backgroundRefresh) {
			await this.#backgroundRefresh;
		}
	}

	async refreshProvider(providerId: string, strategy: ModelRefreshStrategy = "online"): Promise<void> {
		this.#reloadStaticModels();
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
		const runtimeMetadata =
			discoveryConfig.discovery.type === "lm-studio"
				? await discoverLmStudioModelRuntimeMetadata(
						model,
						this.#nonResolvingDiscoveryContext(),
						discoveryConfig.discovery.timeoutMs,
					)
				: await discoverLlamaCppModelRuntimeMetadata(
						model,
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
			this.#models = this.#applyRuntimeModelModifiers(this.#unprojectedModels);
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
		const cachedStandardResult = this.#loadCachedStandardProviderModels();
		this.#cachedStandardModels = this.#applyHardcodedModelPolicies(cachedStandardResult.models);
		this.#cachedDiscoverableModels = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());

		this.#cachedAuthoritativeProviders = new Set<string>();
		for (const provider of providersWithAuthoritativeProjectCatalog(this.#cachedStandardModels)) {
			if (cachedStandardResult.authoritativeFreshProviders.has(provider)) {
				this.#cachedAuthoritativeProviders.add(provider);
			}
		}
		for (const provider of cachedStandardResult.authoritativeFreshProviders) {
			if (AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS.has(provider)) {
				this.#cachedAuthoritativeProviders.add(provider);
			}
		}
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
		for (const model of this.#cachedStandardModels) providers.add(model.provider);
		for (const model of this.#cachedDiscoverableModels) providers.add(model.provider);
		for (const model of this.#customModelOverlays) providers.add(model.provider);
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
				projected = modifyModels(structuredClone(projected), credential);
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
		const select = <T extends { provider: string }>(models: readonly T[]): T[] =>
			providerFilter ? models.filter(model => providerFilter.has(model.provider)) : [...models];
		let builtInModels = this.#applyHardcodedModelPolicies(
			this.#loadBuiltInModels(this.#providerOverrides, providerFilter),
		);
		if (this.#cachedAuthoritativeProviders.size > 0) {
			builtInModels = dropProviderModels(builtInModels, this.#cachedAuthoritativeProviders);
		}
		const resolvedDefaults = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, select(this.#cachedStandardModels)),
			select(this.#cachedDiscoverableModels),
		);
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, select(this.#customModelOverlays));
		const combined = this.#mergeCustomModels(withConfigModels, select(this.#runtimeModelOverlays));
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		return this.#applyLlamaCppModelFixups(this.#applyRuntimeProviderOverrides(withModelOverrides));
	}

	#composeStaticModels(providerFilter?: ReadonlySet<string>): Model<Api>[] {
		const projectFullCatalog = providerFilter !== undefined && this.#runtimeModelModifiers.size > 0;
		const unprojected = this.#composeUnprojectedStaticModels(projectFullCatalog ? undefined : providerFilter);
		const projected = this.#applyRuntimeModelModifiers(unprojected);
		const selected = projectFullCatalog ? projected.filter(model => providerFilter.has(model.provider)) : projected;
		return this.#internStaticModels(selected);
	}

	#ensureFullSnapshot(): Model<Api>[] {
		if (!this.#hasFullSnapshot) {
			this.#unprojectedModels = this.#composeUnprojectedStaticModels();
			this.#models = this.#internStaticModels(this.#applyRuntimeModelModifiers(this.#unprojectedModels));
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
			if (!existingModel) return finalizeCustomModel(customModel, { useDefaults: true });

			return applyModelPatch(
				{
					...existingModel,
					id: customModel.id,
					provider: customModel.provider,
					api: customModel.api,
					baseUrl: customModel.baseUrl,
				},
				customModel,
				"replace",
			);
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

	#loadCachedStandardProviderModels(): { models: Model<Api>[]; authoritativeFreshProviders: Set<string> } {
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(provider => provider.provider));
		const cachedModels: Model<Api>[] = [];
		const authoritativeFreshProviders = new Set<string>();
		for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
			if (configuredDiscoveryProviders.has(providerId) || isCredentialScopedModelCacheProvider(providerId)) {
				continue;
			}
			const cacheProviderId = this.#resolveStartupModelCacheProviderId(providerId);
			const cache = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			if (!cache) {
				continue;
			}
			if (cache.fresh && cache.authoritative) {
				authoritativeFreshProviders.add(providerId);
			}

			const omittedHeaderIds = new Set(cache.headerOmittedModelIds);
			const unrestorableHeaderIds = new Set(cache.unrestorableHeaderModelIds);
			const bundledById =
				omittedHeaderIds.size > 0
					? new Map(
							(getBundledModels(providerId as Parameters<typeof getBundledModels>[0]) as Model<Api>[]).map(
								bundledModel => [bundledModel.id, bundledModel],
							),
						)
					: undefined;
			const models: ModelSpec<Api>[] = [];
			for (const cachedModel of cache.models) {
				const spec = cachedModel.provider === providerId ? cachedModel : { ...cachedModel, provider: providerId };
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
			cachedModels.push(...this.#applyProviderModelOverrides(providerId, withCompat));
		}
		return { models: cachedModels, authoritativeFreshProviders };
	}

	#configuredDiscoveryHeaderFallback(providerId: string): Record<string, string> | undefined {
		const override = this.#providerOverrides.get(providerId);
		if (override?.authHeader !== true || !override.apiKey) return undefined;
		const headers = mergeAuthHeaderSources([override.headers], override.authHeader, override.apiKey);
		return headers?.Authorization ? headers : undefined;
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

			const restorableHeaderFallback = this.#configuredDiscoveryHeaderFallback(providerConfig.provider);
			const omittedHeaderIds = new Set(cache.headerOmittedModelIds);
			const hasUnrestoredHeaders = omittedHeaderIds.size > 0 && !restorableHeaderFallback;
			const usableCacheModels =
				omittedHeaderIds.size === 0
					? cache.models
					: restorableHeaderFallback
						? cache.models.map(model =>
								omittedHeaderIds.has(model.id) ? { ...model, headers: { ...restorableHeaderFallback } } : model,
							)
						: cache.models.filter(model => !omittedHeaderIds.has(model.id));
			if (restorableHeaderFallback && cache.unrestorableHeaderModelIds.length > 0) {
				writeModelCache(
					cacheProviderId,
					cache.updatedAt,
					usableCacheModels.map(model => buildModel(model)),
					cache.authoritative,
					cache.staticFingerprint,
					this.#cacheDbPath,
					[],
					restorableHeaderFallback,
				);
			}
			const models = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(
						providerConfig.compat,
						usableCacheModels.map(model => buildModel(model)),
					),
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
			const resolvedProviderHeaders = resolveConfigHeaders(providerConfig.headers);

			if (
				providerConfig.baseUrl ||
				resolvedProviderHeaders ||
				providerConfig.apiKey ||
				providerConfig.authHeader !== undefined ||
				providerConfig.compat ||
				providerConfig.disableStrictTools ||
				providerConfig.remoteCompaction ||
				providerConfig.transport
			) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				overrides.set(providerName, {
					baseUrl:
						providerConfig.discovery?.type === "litellm"
							? normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl)
							: providerConfig.baseUrl,
					headers: resolvedProviderHeaders,
					apiKey: providerConfig.apiKey,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					remoteCompaction: providerConfig.remoteCompaction,
					transport: providerConfig.transport,
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
					headers: resolvedProviderHeaders,
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
					perModel.set(
						modelId,
						override.headers ? { ...override, headers: resolveConfigHeaders(override.headers) } : override,
					);
				}
				allModelOverrides.set(providerName, perModel);
			}
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
				? Promise.resolve<Model<Api>[]>([])
				: Promise.all(
						selectedDiscoverableProviders.map(provider => this.#discoverProviderModels(provider, strategy)),
					).then(results => results.flat());
		const [configuredDiscovered, builtInDiscovery] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		const discovered = [...configuredDiscovered, ...builtInDiscovery.models];
		if (discovered.length === 0 && builtInDiscovery.authoritativeProviders.size === 0) {
			return;
		}
		this.#ensureFullSnapshot();
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model =>
				mergeDiscoveredModel(
					model,
					resolveProviderModelReference(model.provider, model.id, this.#unprojectedModels),
					this.#providerOverrides.get(model.provider),
				),
			),
		);
		const authoritativeProviders = providersWithAuthoritativeProjectCatalog(discoveredModels);
		for (const provider of builtInDiscovery.authoritativeProviders) {
			authoritativeProviders.add(provider);
		}
		const baseModels =
			authoritativeProviders.size > 0
				? dropProviderModels(this.#unprojectedModels, authoritativeProviders)
				: this.#unprojectedModels;
		const resolved = this.#mergeResolvedModels(baseModels, discoveredModels);
		const withConfigModels = this.#mergeCustomModels(resolved, this.#customModelOverlays);
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		this.#unprojectedModels = this.#applyLlamaCppModelFixups(this.#applyRuntimeProviderOverrides(withModelOverrides));
		this.#models = this.#applyRuntimeModelModifiers(this.#unprojectedModels);
	}

	#configuredDiscoveryCacheProviderId(providerConfig: DiscoveryProviderConfig): string {
		if (providerConfig.discovery.type === "ollama") {
			return resolveOllamaModelCacheProviderId(providerConfig.provider, providerConfig.baseUrl);
		}
		if (providerConfig.discovery.type === "openai-models-list") {
			return `${providerConfig.provider}:openai-models-list-context-v3`;
		}
		if (providerConfig.discovery.type === "litellm") {
			return `${providerConfig.provider}:litellm-rich-v3`;
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
	): Promise<Model<Api>[]> {
		const cacheProviderId = this.#configuredDiscoveryCacheProviderId(providerConfig);
		const cached = readModelCache<Api>(cacheProviderId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
		const cacheOlderThanConfig = cached !== null && this.#isDiscoveryCacheOlderThanModelsConfig(cached.updatedAt);
		const bypassFreshCache = providerConfig.discovery.type === "llama.cpp" && strategy === "online-if-uncached";
		const effectiveStrategy =
			strategy === "online-if-uncached" && (cacheOlderThanConfig || bypassFreshCache) ? "online" : strategy;
		const requiresAuth = !this.#keylessProviders.has(providerConfig.provider);
		if (requiresAuth) {
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
				return cached
					? this.#normalizeDiscoverableModels(
							providerConfig,
							cached.models.map(model => buildModel(model)),
						)
					: [];
			}
		}

		const providerId = providerConfig.provider;
		let discoveryError: string | undefined;
		const fetchDynamicModels = async (): Promise<readonly ModelSpec<Api>[] | null> => {
			try {
				const models = this.#applyProviderModelOverrides(
					providerId,
					await discoverModelsByProviderType(providerConfig, this.#discoveryContext()),
				);
				this.#lastDiscoveryWarnings.delete(providerId);
				return models.map(toModelSpec);
			} catch (error) {
				discoveryError = error instanceof Error ? error.message : String(error);
				return null;
			}
		};

		const manager = createModelManager<Api>({
			providerId,
			staticModels: [],
			cacheDbPath: this.#cacheDbPath,
			cacheProviderId,
			cacheTtlMs: 24 * 60 * 60 * 1000,
			fetchDynamicModels,
			restorableHeaderFallback: this.#configuredDiscoveryHeaderFallback(providerId),
		});
		const result = await manager.refresh(effectiveStrategy);
		const status = discoveryError
			? result.models.length > 0
				? "cached"
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
		return this.#applyProviderModelOverrides(
			providerId,
			this.#normalizeDiscoverableModels(
				providerConfig,
				this.#applyProviderCompat(providerConfig.compat, result.models),
			),
		);
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
			return { models: [], authoritativeProviders: new Set() };
		}
		const discoveries = await Promise.all(
			managerOptions.map(options => this.#discoverWithModelManager(options, strategy)),
		);
		const authoritativeProviders = new Set<string>();
		const models: Model<Api>[] = [];
		for (const discovery of discoveries) {
			models.push(...discovery.models);
			for (const provider of discovery.authoritativeProviders) {
				authoritativeProviders.add(provider);
			}
		}
		return { models, authoritativeProviders };
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
			if (isAuthenticated(apiKey) || descriptor.allowUnauthenticated || hasExplicitVllmConfig) {
				const discoveryConfig = {
					apiKey: isDiscoveryBearerApiKey(apiKey) ? apiKey : undefined,
					baseUrl: this.#descriptorBaseUrl(descriptor.providerId),
					fetch: this.#fetch,
				};
				const preparedConfig =
					getProviderDefinition(descriptor.providerId)?.prepareModelDiscovery?.(discoveryConfig) ??
					discoveryConfig;
				options.push(descriptor.createModelManagerOptions(preparedConfig));
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
			const result = await manager.refresh(strategy);
			const models = result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
			const authoritativeProviders = new Set<string>();
			if (options.dynamicModelsAuthoritative && !result.stale) {
				authoritativeProviders.add(options.providerId);
			}
			return { models, authoritativeProviders };
		} catch (error) {
			logger.warn("model discovery failed for provider", {
				provider: options.providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return { models: [], authoritativeProviders: new Set() };
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
			return applyModelOverride(model, override);
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
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers: override.headers
				? createLiveConfigHeaders([baseOverride?.headers, override.headers])
				: baseOverride?.headers,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			remoteCompaction: mergeRemoteCompactionConfig(baseOverride?.remoteCompaction, override.remoteCompaction),
			transport: override.transport ?? baseOverride?.transport,
		};
	}
	#applyProviderTransportOverride<
		T extends { baseUrl?: string; headers?: Record<string, string>; remoteCompaction?: RemoteCompactionConfig<Api> },
	>(
		entry: T,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "headers" | "authHeader" | "apiKey" | "remoteCompaction" | "transport"
		>,
	): T {
		const headers = mergeAuthHeaderSources(
			override.headers ? [entry.headers, override.headers] : [entry.headers],
			override.authHeader,
			override.apiKey,
		);
		return {
			...entry,
			baseUrl: override.baseUrl ?? entry.baseUrl,
			headers,

			...(override.transport !== undefined ? { transport: override.transport } : {}),
			remoteCompaction: mergeProviderRemoteCompactionConfig(entry.remoteCompaction, override.remoteCompaction),
		};
	}
	#applyProviderTransportOverrideToModel(
		model: Model<Api>,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "headers" | "authHeader" | "apiKey" | "remoteCompaction" | "transport"
		>,
	): Model<Api> {
		return buildModel(this.#applyProviderTransportOverride(toModelSpec(model), override));
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
		if (overrides.size === 0) return models;
		let liveKeys: Set<string> | null = null;
		const hasLiveModel = (provider: string, id: string) => {
			liveKeys ??= new Set(models.map(m => `${m.provider}\u0000${m.id}`));
			return liveKeys.has(`${provider}\u0000${id}`);
		};
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider);
			if (!providerOverrides) return model;
			const override = resolveModelOverrideWithAliases(providerOverrides, model, hasLiveModel);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}
	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		const extendedContext = isExtendedContextEnabledFromSettings(this.#settings);
		return models.map(model => {
			if (!extendedContext) {
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
			const resolvedProviderHeaders = resolveConfigHeaders(providerConfig.headers);
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
					resolvedProviderHeaders,
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
				available =
					!disabledProviders.has(provider) &&
					(this.#keylessProviders.has(provider) || this.authStorage.hasAuth(provider));
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
			isCommandConfigValue(keyConfig) ||
			this.#keylessProviders.has(model.provider) ||
			this.authStorage.hasResolvableAuth(model.provider)
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

	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#modelsForProviderLookup(provider));
	}

	getProviderBaseUrl(provider: string): string | undefined {
		return this.#modelsForProviderLookup(provider).find(m => m.provider === provider && m.baseUrl)?.baseUrl;
	}

	getProviderHeaders(provider: string): Record<string, string> | undefined {
		return createLiveConfigHeaders([
			this.#providerOverrides.get(provider)?.headers,
			this.#runtimeProviderOverrides.get(provider)?.headers,
		]);
	}

	async getApiKey(
		model: Model<Api>,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(model.provider);
		if (commandKey.configured) return commandKey.value;
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
			const headers = this.getProviderHeaders(model.provider);
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
		const commandKey = this.#resolveCommandBackedApiKey(
			provider,
			options?.forceRefresh ? { forceCommandRefresh: true } : undefined,
		);
		if (commandKey.configured) return commandKey.value;
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
		const commandKey = this.#resolveCommandBackedApiKey(provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.peekApiKey(provider);
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.hasOAuth(model.provider);
	}

	#clearRuntimeProviderState(providerName: string): void {
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
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
			this.#unprojectedModels = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverrideToModel(model, runtimeTransportOverride);
					})
				: nextModels;

			if (config.oauth?.modifyModels) {
				this.#runtimeModelModifiers.set(providerName, config.oauth.modifyModels);
			} else {
				this.#runtimeModelModifiers.delete(providerName);
			}
			this.#models = this.#applyRuntimeModelModifiers(this.#unprojectedModels);
			this.#invalidateProviderModelCache(providerName);
			return;
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
					const modelDefs = await withRuntimeDynamicModelsTimeout(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS, () =>
						fetcher(resolvedKey),
					);
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
			this.#models = this.#applyRuntimeModelModifiers(this.#unprojectedModels);
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
		headers?: Record<string, string>;
		compat?: ModelSpec<Api>["compat"];
		contextPromotionTarget?: string;
		compactionModel?: string;
		remoteCompaction?: RemoteCompactionConfig<Api>;
		premiumMultiplier?: number;
	}>;
}
