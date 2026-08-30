import type { Api, Model, ModelSpec, RemoteCompactionConfig, ThinkingConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isVertexExpressOpenAIUrl } from "@oh-my-pi/pi-catalog/hosts";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelOverride } from "./models-config-schema";

export interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	authHeader?: boolean;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	transport?: Model<Api>["transport"];
}

export function mergeDiscoveredModel<TApi extends Api>(
	model: Model<TApi>,
	existing: Model<Api> | undefined,
	providerOverride?: Pick<ProviderOverride, "baseUrl" | "compat" | "headers" | "remoteCompaction" | "transport">,
): Model<TApi> {
	if (existing) {
		const supportsTools = model.supportsTools ?? existing.supportsTools;
		return buildModel({
			...toModelSpec(model),
			baseUrl: providerOverride?.baseUrl ?? model.baseUrl ?? existing.baseUrl,
			headers: existing.headers ? { ...existing.headers, ...model.headers } : model.headers,
			transport: providerOverride?.transport ?? existing.transport ?? model.transport,
			remoteCompaction: mergeProviderRemoteCompactionConfig(
				mergeRemoteCompactionConfig(existing.remoteCompaction, model.remoteCompaction),
				providerOverride?.remoteCompaction,
			),
			...(supportsTools !== undefined ? { supportsTools } : {}),
			compat: mergeCompat(model.compatConfig, providerOverride?.compat),
		} as ModelSpec<TApi>);
	}
	if (providerOverride) {
		return buildModel({
			...toModelSpec(model),
			baseUrl: providerOverride.baseUrl ?? model.baseUrl,
			headers: providerOverride.headers ? { ...model.headers, ...providerOverride.headers } : model.headers,
			...(providerOverride.transport !== undefined ? { transport: providerOverride.transport } : {}),
			remoteCompaction: mergeProviderRemoteCompactionConfig(
				model.remoteCompaction,
				providerOverride.remoteCompaction,
			),
			compat: mergeCompat(model.compatConfig, providerOverride.compat),
		} as ModelSpec<TApi>);
	}
	return model;
}

export const AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS = new Set<string>(
	PROVIDER_DESCRIPTORS.filter(descriptor => descriptor.dynamicModelsAuthoritative).map(
		descriptor => descriptor.providerId,
	),
);

function isAuthoritativeProjectCatalogModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		model.api === "openai-completions" &&
		isVertexExpressOpenAIUrl(model.baseUrl)
	);
}

export function providersWithAuthoritativeProjectCatalog(models: readonly Model<Api>[]): Set<string> {
	const providers = new Set<string>();
	for (const model of models) {
		if (isAuthoritativeProjectCatalogModel(model)) {
			providers.add(model.provider);
		}
	}
	return providers;
}

export function dropProviderModels(models: readonly Model<Api>[], providers: ReadonlySet<string>): Model<Api>[] {
	return models.filter(model => !providers.has(model.provider));
}

export function mergeByModelKey<T extends { provider: string; id: string }>(
	base: readonly Model<Api>[],
	incoming: readonly T[],
	combine: (existing: Model<Api> | undefined, entry: T) => Model<Api>,
): Model<Api>[] {
	const merged = [...base];
	const indexByKey = new Map<string, number>();
	for (let i = 0; i < merged.length; i += 1) {
		indexByKey.set(`${merged[i].provider}\u0000${merged[i].id}`, i);
	}
	for (const entry of incoming) {
		const key = `${entry.provider}\u0000${entry.id}`;
		const existingIndex = indexByKey.get(key);
		if (existingIndex !== undefined) {
			merged[existingIndex] = combine(merged[existingIndex], entry);
		} else {
			merged.push(combine(undefined, entry));
			indexByKey.set(key, merged.length - 1);
		}
	}
	return merged;
}
export function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isRecord(baseValue) && isRecord(overrideValue) ? mergeCompat(baseValue, overrideValue) : overrideValue;
	}
	return merged as TBase & TOverride;
}

export function mergeRemoteCompactionConfig(
	baseConfig: RemoteCompactionConfig<Api> | undefined,
	overrideConfig: RemoteCompactionConfig<Api> | undefined,
): RemoteCompactionConfig<Api> | undefined {
	if (!baseConfig) return overrideConfig;
	if (!overrideConfig) return baseConfig;
	return { ...baseConfig, ...overrideConfig };
}

export function mergeProviderRemoteCompactionConfig(
	modelConfig: RemoteCompactionConfig<Api> | undefined,
	providerConfig: RemoteCompactionConfig<Api> | undefined,
): RemoteCompactionConfig<Api> | undefined {
	return mergeRemoteCompactionConfig(providerConfig, modelConfig);
}

export interface ModelPatch {
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image" | "video")[];
	imageInputDecoder?: Model<Api>["imageInputDecoder"];
	tokenizer?: Model<Api>["tokenizer"];
	supportsTools?: boolean;
	cost?: Partial<Model<Api>["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	contextPromotionTarget?: string;
	compactionModel?: string;
	remoteCompaction?: RemoteCompactionConfig<Api>;
	premiumMultiplier?: number;
}

type ModelTransportPolicy = "merge" | "replace";
export function applyModelPatch(base: Model<Api>, patch: ModelPatch, transport: ModelTransportPolicy): Model<Api> {
	const result = { ...base };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.thinking !== undefined) result.thinking = patch.thinking;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.tokenizer !== undefined) result.tokenizer = patch.tokenizer;
	if (patch.imageInputDecoder !== undefined) result.imageInputDecoder = patch.imageInputDecoder;
	if (patch.supportsTools !== undefined) result.supportsTools = patch.supportsTools;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.omitMaxOutputTokens !== undefined) result.omitMaxOutputTokens = patch.omitMaxOutputTokens;
	if (patch.contextPromotionTarget !== undefined) result.contextPromotionTarget = patch.contextPromotionTarget;
	if (patch.compactionModel !== undefined) result.compactionModel = patch.compactionModel;
	if (patch.remoteCompaction !== undefined) {
		result.remoteCompaction = mergeRemoteCompactionConfig(base.remoteCompaction, patch.remoteCompaction);
	}
	if (patch.premiumMultiplier !== undefined) result.premiumMultiplier = patch.premiumMultiplier;
	if (patch.cost) {
		const longContext = patch.cost.longContext ?? base.cost.longContext;
		result.cost = {
			input: patch.cost.input ?? base.cost.input,
			output: patch.cost.output ?? base.cost.output,
			cacheRead: patch.cost.cacheRead ?? base.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? base.cost.cacheWrite,
			...(longContext ? { longContext } : {}),
		};
	}
	let compat: ModelSpec<Api>["compat"];
	if (transport === "merge") {
		if (patch.headers) {
			result.headers = { ...base.headers, ...patch.headers };
		}
		compat = mergeCompat(base.compatConfig, patch.compat);
	} else {
		result.headers = patch.headers;
		compat = patch.compat;
	}
	const built = buildModel({ ...toModelSpec(result), compat } as ModelSpec<Api>);
	if (patch.thinking !== undefined && built.thinking !== undefined) {
		built.thinking = patch.thinking;
	}
	return built;
}

export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return applyModelPatch(model, override as ModelPatch, "merge");
}
